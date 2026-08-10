using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public sealed class ProgramExecutor(IOptions<AgentOptions> options, ILogger<ProgramExecutor> logger)
{
    static ProgramExecutor() => Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

    private readonly AgentOptions _options = options.Value;
    private Encoding OutputEncoding => Encoding.GetEncoding(
        _options.OutputCodePage > 0 ? _options.OutputCodePage : (int)GetOEMCP());

    [DllImport("kernel32.dll")]
    private static extern uint GetOEMCP();

    public async Task<ExecutionResult> ExecuteAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        if (!payload.TryGetProperty("program", out var programElement) || programElement.ValueKind != JsonValueKind.String)
            return Failed("Payload must contain a program path.");
        var program = programElement.GetString() ?? "";
        if (!Path.IsPathFullyQualified(program)) return Failed("Program must be an absolute path.");

        string fullPath;
        try { fullPath = Path.GetFullPath(program); }
        catch { return Failed("Program path is invalid."); }
        var allowed = _options.DisableAllPolicies || _options.AllowedPrograms.Any(item => IsAllowed(item, fullPath));
        if (!allowed) return Failed("Program is not in the local allowlist.");
        if (!File.Exists(fullPath)) return Failed("Program does not exist.");

        var arguments = payload.TryGetProperty("args", out var argsElement) && argsElement.ValueKind == JsonValueKind.String
            ? WindowsCommandLine.Split(argsElement.GetString() ?? "")
            : [];
        var requestedTimeout = payload.TryGetProperty("timeoutSeconds", out var timeoutElement) && timeoutElement.TryGetInt32(out var timeout)
            ? timeout : _options.DefaultExecutionSeconds;
        var timeoutSeconds = Math.Clamp(requestedTimeout, 1, Math.Max(_options.MaxExecutionSeconds, 1));
        var process = new Process { StartInfo = new ProcessStartInfo
        {
            FileName = fullPath,
            WorkingDirectory = Path.GetDirectoryName(fullPath)!,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = OutputEncoding,
            StandardErrorEncoding = OutputEncoding,
        }};
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);

        var output = new CappedOutput(_options.MaxOutputBytes);
        var started = Stopwatch.GetTimestamp();
        try
        {
            if (!process.Start()) return Failed("Process failed to start.");
            var stdout = ReadStreamAsync(process.StandardOutput, output, false, cancellationToken);
            var stderr = ReadStreamAsync(process.StandardError, output, true, cancellationToken);
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
            var timedOut = false;
            try { await process.WaitForExitAsync(timeoutCts.Token); }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                timedOut = true;
                try { process.Kill(entireProcessTree: true); } catch (Exception ex) { logger.LogWarning(ex, "Failed to terminate timed out process"); }
                await process.WaitForExitAsync(CancellationToken.None);
            }
            await Task.WhenAll(stdout, stderr);
            var result = JsonSerializer.Serialize(new
            {
                stdout = output.Stdout,
                stderr = output.Stderr,
                durationMs = (long)(Stopwatch.GetElapsedTime(started).TotalMilliseconds),
                timedOut,
                truncated = output.Truncated,
                error = (string?)null,
            });
            return new ExecutionResult(timedOut || process.ExitCode != 0 ? "failed" : "success", result, process.ExitCode);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
            throw;
        }
        catch (Exception ex)
        {
            return Failed(ex.Message);
        }
        finally { process.Dispose(); }
    }

    private static async Task ReadStreamAsync(StreamReader reader, CappedOutput output, bool error, CancellationToken cancellationToken)
    {
        var buffer = new char[4096];
        int count;
        while ((count = await reader.ReadAsync(buffer.AsMemory(), cancellationToken)) > 0)
            output.Append(buffer.AsSpan(0, count), error);
    }

    private static ExecutionResult Failed(string message) => new("failed", ErrorJson(message), null);

    private static bool IsAllowed(string configuredPath, string fullPath)
    {
        try
        {
            return Path.IsPathFullyQualified(configuredPath) &&
                string.Equals(Path.GetFullPath(configuredPath), fullPath, StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    public static string ErrorJson(string message) => JsonSerializer.Serialize(new { stdout = "", stderr = "", durationMs = 0, timedOut = false, truncated = false, error = message });

    private sealed class CappedOutput(int maxBytes)
    {
        private int _bytes;
        private readonly object _sync = new();
        private readonly StringBuilder _stdout = new();
        private readonly StringBuilder _stderr = new();
        public bool Truncated { get; private set; }
        public string Stdout => _stdout.ToString();
        public string Stderr => _stderr.ToString();

        public void Append(ReadOnlySpan<char> chars, bool error)
        {
            lock (_sync)
            {
                if (_bytes >= maxBytes) { Truncated = true; return; }
                var text = chars.ToString();
                var available = maxBytes - _bytes;
                var bytes = Encoding.UTF8.GetBytes(text);
                if (bytes.Length > available)
                {
                    var low = 0;
                    var high = text.Length;
                    while (low < high)
                    {
                        var middle = (low + high + 1) / 2;
                        if (Encoding.UTF8.GetByteCount(text.AsSpan(0, middle)) <= available) low = middle;
                        else high = middle - 1;
                    }
                    var cut = text[..low];
                    (error ? _stderr : _stdout).Append(cut);
                    _bytes = maxBytes;
                    Truncated = true;
                }
                else
                {
                    (error ? _stderr : _stdout).Append(text);
                    _bytes += bytes.Length;
                }
            }
        }
    }
}
