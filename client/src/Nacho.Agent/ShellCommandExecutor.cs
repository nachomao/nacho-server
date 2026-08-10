using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public sealed class ShellCommandExecutor(
    IOptions<AgentOptions> options,
    AgentPaths paths,
    ILogger<ShellCommandExecutor> logger)
{
    private const int MaximumScriptRunes = 32_768;
    private const int MaximumTimeoutSeconds = 900;
    // JSON can expand control characters to six bytes. This cap keeps the complete result below 512 KiB.
    private const int MaximumCapturedUtf8Bytes = 64 * 1024;
    private static readonly HashSet<string> AllowedFields = new(StringComparer.Ordinal)
    {
        "shell", "script", "timeoutSeconds",
    };
    private readonly AgentOptions _options = options.Value;

    public async Task<ExecutionResult> ExecuteAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var started = Stopwatch.GetTimestamp();
        var validation = Validate(payload);
        if (validation.Error is not null)
            return Failed(validation.Shell, started, validation.Error);
        if (!_options.DisableAllPolicies && validation.Shell == "cmd" && !_options.AllowCmdExecution)
            return Failed(validation.Shell, started, "CMD execution is disabled by local policy.");
        if (!_options.DisableAllPolicies && validation.Shell == "powershell" && !_options.AllowPowerShellExecution)
            return Failed(validation.Shell, started, "PowerShell execution is disabled by local policy.");
        if (!OperatingSystem.IsWindows())
            return Failed(validation.Shell, started, "Shell execution is supported only on Windows.");

        Directory.CreateDirectory(paths.WorkDirectory);
        var extension = validation.Shell == "cmd" ? ".cmd" : ".ps1";
        var scriptPath = Path.Combine(paths.WorkDirectory, $"shell-{Guid.NewGuid():N}{extension}");
        Process? process = null;
        try
        {
            var script = validation.Shell == "cmd"
                ? "@echo off\r\n@chcp 65001 >nul\r\n" + validation.Script
                : "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\r\n" + validation.Script;
            await File.WriteAllTextAsync(
                scriptPath,
                script,
                validation.Shell == "powershell" ? new UTF8Encoding(true) : new UTF8Encoding(false),
                cancellationToken);

            var systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
            var startInfo = new ProcessStartInfo
            {
                FileName = Path.Combine(systemDirectory, validation.Shell == "cmd" ? "cmd.exe" : @"WindowsPowerShell\v1.0\powershell.exe"),
                WorkingDirectory = paths.WorkDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false),
            };
            if (validation.Shell == "cmd")
            {
                startInfo.ArgumentList.Add("/d");
                startInfo.ArgumentList.Add("/q");
                startInfo.ArgumentList.Add("/s");
                startInfo.ArgumentList.Add("/c");
                startInfo.ArgumentList.Add(scriptPath);
            }
            else
            {
                startInfo.ArgumentList.Add("-NoLogo");
                startInfo.ArgumentList.Add("-NoProfile");
                startInfo.ArgumentList.Add("-NonInteractive");
                startInfo.ArgumentList.Add("-ExecutionPolicy");
                startInfo.ArgumentList.Add("Bypass");
                startInfo.ArgumentList.Add("-File");
                startInfo.ArgumentList.Add(scriptPath);
            }

            process = new Process { StartInfo = startInfo };
            if (!process.Start()) return Failed(validation.Shell, started, "Shell process failed to start.");

            var output = new BoundedOutput(MaximumCapturedUtf8Bytes);
            var stdoutTask = ReadAsync(process.StandardOutput, output, error: false, cancellationToken);
            var stderrTask = ReadAsync(process.StandardError, output, error: true, cancellationToken);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(validation.TimeoutSeconds));
            var timedOut = false;
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                timedOut = true;
                try { process.Kill(entireProcessTree: true); }
                catch (Exception ex) { logger.LogWarning(ex, "Failed to terminate timed out shell process"); }
                await process.WaitForExitAsync(CancellationToken.None);
            }
            await Task.WhenAll(stdoutTask, stderrTask);
            var exitCode = process.ExitCode;
            var error = timedOut ? "Shell execution timed out." : null;
            var result = ResultJson(validation.Shell, output.Stdout, output.Stderr, exitCode,
                Stopwatch.GetElapsedTime(started).TotalMilliseconds, timedOut, output.Truncated, error);
            return new ExecutionResult(timedOut || exitCode != 0 ? "failed" : "success", result, exitCode);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            try { if (process is { HasExited: false }) process.Kill(entireProcessTree: true); } catch { }
            throw;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return Failed(validation.Shell, started, "Windows shell execution failed.");
        }
        finally
        {
            process?.Dispose();
            try { File.Delete(scriptPath); }
            catch (Exception ex) { logger.LogWarning(ex, "Failed to remove temporary shell script"); }
        }
    }

    private static Validation Validate(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object)
            return new("", "", 0, "Payload must be an object.");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in payload.EnumerateObject())
        {
            if (!seen.Add(property.Name) || !AllowedFields.Contains(property.Name))
                return new(ReadString(payload, "shell"), "", 0, "Payload contains an unsupported or duplicate field.");
        }
        var shell = ReadString(payload, "shell");
        if (shell is not ("cmd" or "powershell"))
            return new(shell, "", 0, "shell must be cmd or powershell.");
        if (!payload.TryGetProperty("script", out var scriptElement) || scriptElement.ValueKind != JsonValueKind.String)
            return new(shell, "", 0, "script must be a string.");
        var script = scriptElement.GetString() ?? "";
        var runeCount = script.EnumerateRunes().Count();
        if (runeCount is < 1 or > MaximumScriptRunes || string.IsNullOrWhiteSpace(script) || script.Any(ch => ch == '\0' || (char.IsControl(ch) && ch is not ('\r' or '\n' or '\t'))))
            return new(shell, script, 0, $"script must contain from 1 to {MaximumScriptRunes} printable characters.");
        if (!payload.TryGetProperty("timeoutSeconds", out var timeoutElement) ||
            timeoutElement.ValueKind != JsonValueKind.Number ||
            !timeoutElement.TryGetInt32(out var timeoutSeconds) ||
            timeoutSeconds is < 1 or > MaximumTimeoutSeconds)
            return new(shell, script, 0, $"timeoutSeconds must be an integer from 1 to {MaximumTimeoutSeconds}.");
        return new(shell, script, timeoutSeconds, null);
    }

    private static string ReadString(JsonElement payload, string name) =>
        payload.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.String
            ? element.GetString()?.Trim() ?? ""
            : "";

    private static async Task ReadAsync(StreamReader reader, BoundedOutput output, bool error, CancellationToken cancellationToken)
    {
        var buffer = new char[4096];
        int count;
        while ((count = await reader.ReadAsync(buffer.AsMemory(), cancellationToken)) > 0)
            output.Append(buffer.AsSpan(0, count), error);
    }

    private static ExecutionResult Failed(string shell, long started, string error) =>
        new("failed", ResultJson(shell, "", "", null, Stopwatch.GetElapsedTime(started).TotalMilliseconds, false, false, error), null);

    public static string ErrorJson(JsonElement payload, string error) =>
        ResultJson(ReadString(payload, "shell"), "", "", null, 0, false, false, error);

    private static string ResultJson(string shell, string stdout, string stderr, int? exitCode, double durationMs, bool timedOut, bool truncated, string? error) =>
        JsonSerializer.Serialize(new
        {
            shell,
            stdout,
            stderr,
            exitCode,
            durationMs = Math.Max(0L, (long)durationMs),
            timedOut,
            truncated,
            error,
        });

    private sealed record Validation(string Shell, string Script, int TimeoutSeconds, string? Error);

    private sealed class BoundedOutput(int maximumBytes)
    {
        private readonly object _gate = new();
        private readonly StringBuilder _stdout = new();
        private readonly StringBuilder _stderr = new();
        private int _bytes;
        public string Stdout => _stdout.ToString();
        public string Stderr => _stderr.ToString();
        public bool Truncated { get; private set; }

        public void Append(ReadOnlySpan<char> chars, bool error)
        {
            lock (_gate)
            {
                if (_bytes >= maximumBytes) { Truncated = true; return; }
                var text = chars.ToString();
                var available = maximumBytes - _bytes;
                var low = 0;
                var high = text.Length;
                while (low < high)
                {
                    var middle = (low + high + 1) / 2;
                    if (Encoding.UTF8.GetByteCount(text.AsSpan(0, middle)) <= available) low = middle;
                    else high = middle - 1;
                }
                if (low > 0) (error ? _stderr : _stdout).Append(text.AsSpan(0, low));
                _bytes += Encoding.UTF8.GetByteCount(text.AsSpan(0, low));
                if (low < text.Length) Truncated = true;
            }
        }
    }
}
