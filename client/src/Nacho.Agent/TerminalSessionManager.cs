using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

/// <summary>
/// WebSSH 持久终端会话：
/// 收到服务端 terminal-open 后，以设备令牌连接会话通道，启动一个常驻 shell，
/// 把 stdin 输入写入进程、把 stdout/stderr 分块回传。
/// 采用行级交互（每次输入执行一行），带空闲/时长/输出上限与本地策略校验。
/// </summary>
public sealed class TerminalSessionManager(
    AgentApiClient api,
    IOptions<AgentOptions> options,
    ILogger<TerminalSessionManager> logger)
{
    internal const int MaxConcurrentSessions = 2;
    internal const int MaxOutputBytes = 4 * 1024 * 1024;
    internal const int MaxInputBytes = 8 * 1024;
    internal const int OutputChunkChars = 8 * 1024;
    internal static readonly TimeSpan IdleTimeout = TimeSpan.FromMinutes(15);
    internal static readonly TimeSpan MaxDuration = TimeSpan.FromMinutes(60);
    internal const string PowerShellLoopScript =
        "$ErrorActionPreference='Continue'\n" +
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n" +
        "$OutputEncoding=[Text.UTF8Encoding]::new($false)\n" +
        "try { [Console]::InputEncoding=[Text.UTF8Encoding]::new($false) } catch { }\n" +
        "while ($true) {\n" +
        "  $line = [Console]::In.ReadLine()\n" +
        "  if ($null -eq $line) { break }\n" +
        "  if ($line.Trim() -eq 'exit') { exit 0 }\n" +
        "  try { Invoke-Expression $line } catch { [Console]::Error.WriteLine('PowerShell: ' + $_.Exception.Message) }\n" +
        "}\n";

    private readonly ConcurrentDictionary<string, TerminalSessionState> _sessions = new(StringComparer.Ordinal);
    private readonly AgentOptions _options = options.Value;

    internal sealed record TerminalOpenRequest(string SessionId, string Ticket, string Shell, int Cols, int Rows);

    public void HandleOpen(JsonElement message, CancellationToken stoppingToken)
    {
        if (!TryParseOpen(message, out var request))
        {
            logger.LogWarning("Rejected terminal-open message: invalid payload");
            return;
        }
        if (_sessions.Count >= MaxConcurrentSessions)
        {
            logger.LogWarning("Rejected terminal session {SessionId}: too many active sessions", request.SessionId);
            return;
        }
        var state = new TerminalSessionState(request.SessionId, DateTimeOffset.UtcNow);
        if (!_sessions.TryAdd(request.SessionId, state)) return;
        _ = Task.Run(() => RunAsync(request, state, stoppingToken), CancellationToken.None);
    }

    internal static bool TryParseOpen(JsonElement message, out TerminalOpenRequest request)
    {
        request = null!;
        if (message.ValueKind != JsonValueKind.Object) return false;
        var sessionId = WebSshJson.ReadString(message, "sessionId");
        var ticket = WebSshJson.ReadString(message, "ticket");
        var shell = WebSshJson.ReadString(message, "shell");
        if (sessionId.Length is < 1 or > 128 || ticket.Length is < 8 or > 512) return false;
        if (shell is not ("powershell" or "cmd")) return false;
        if (!message.TryGetProperty("cols", out var colsElement) || colsElement.ValueKind != JsonValueKind.Number || !colsElement.TryGetInt32(out var cols)) return false;
        if (!message.TryGetProperty("rows", out var rowsElement) || rowsElement.ValueKind != JsonValueKind.Number || !rowsElement.TryGetInt32(out var rows)) return false;
        var size = ClampSize(cols, rows);
        request = new TerminalOpenRequest(sessionId, ticket, shell, size.Cols, size.Rows);
        return true;
    }

    internal static (int Cols, int Rows) ClampSize(int cols, int rows) =>
        (Math.Clamp(cols, 20, 240), Math.Clamp(rows, 5, 100));

    internal static ProcessStartInfo BuildStartInfo(string shell, int cols, int rows, string? workingDirectory = null)
    {
        var system = Environment.GetFolderPath(Environment.SpecialFolder.System);
        var isCmd = shell == "cmd";
        var encoding = isCmd ? OemEncoding() : new UTF8Encoding(false);
        var info = new ProcessStartInfo
        {
            FileName = isCmd
                ? Path.Combine(system, "cmd.exe")
                : Path.Combine(system, @"WindowsPowerShell\v1.0\powershell.exe"),
            WorkingDirectory = workingDirectory ?? Path.GetPathRoot(Environment.SystemDirectory) ?? "C:\\",
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardInputEncoding = encoding,
            StandardOutputEncoding = encoding,
            StandardErrorEncoding = encoding,
        };
        if (isCmd)
        {
            info.ArgumentList.Add("/d");
            info.ArgumentList.Add("/q");
            info.ArgumentList.Add("/k");
        }
        else
        {
            info.ArgumentList.Add("-NoLogo");
            info.ArgumentList.Add("-NoProfile");
            info.ArgumentList.Add("-ExecutionPolicy");
            info.ArgumentList.Add("Bypass");
            info.ArgumentList.Add("-Command");
            info.ArgumentList.Add(PowerShellLoopScript);
        }
        info.Environment["TERM"] = "windows";
        info.Environment["COLUMNS"] = cols.ToString(CultureInfo.InvariantCulture);
        info.Environment["LINES"] = rows.ToString(CultureInfo.InvariantCulture);
        return info;
    }

    private static Encoding OemEncoding()
    {
        try { return Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage); }
        catch (ArgumentException) { return new UTF8Encoding(false); }
        catch (NotSupportedException) { return new UTF8Encoding(false); }
    }

    private async Task RunAsync(TerminalOpenRequest open, TerminalSessionState state, CancellationToken stoppingToken)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        try
        {
            await using var channel = await AgentSessionSocket.ConnectAsync(
                api,
                $"/agent/terminal?session={Uri.EscapeDataString(open.SessionId)}&ticket={Uri.EscapeDataString(open.Ticket)}",
                lifetime.Token);
            if (!TryStartShell(open, out var process, out var error) || process is null)
            {
                logger.LogWarning("Terminal session {SessionId} shell start failed: {Error}", open.SessionId, error);
                await TrySendAsync(channel, new { kind = "error", code = "SHELL_START_FAILED", message = error ?? "Shell process failed to start." });
                return;
            }
            using (process)
            {
                state.Process = process;
                var size = ClampSize(open.Cols, open.Rows);
                logger.LogInformation("WebSSH terminal started: session={SessionId}, shell={Shell}, pid={Pid}, size={Cols}x{Rows}", open.SessionId, open.Shell, process.Id, size.Cols, size.Rows);
                await channel.SendJsonAsync(new
                {
                    kind = "ready",
                    shell = open.Shell,
                    pid = process.Id,
                    cwd = process.StartInfo.WorkingDirectory,
                    cols = size.Cols,
                    rows = size.Rows,
                }, lifetime.Token);

                using var outputLimit = new CancellationTokenSource();
                var outputTask = PumpOutputAsync(process, channel, state, outputLimit, lifetime.Token);
                var receiveTask = ReceiveAsync(channel, process, state, lifetime);
                var limitHit = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                var monitorTask = MonitorAsync(state, limitHit, lifetime.Token);
                var stopSignal = Task.Delay(Timeout.Infinite, lifetime.Token);

                var completed = await Task.WhenAny(outputTask, receiveTask, limitHit.Task, stopSignal);
                string? reason = null;
                if (limitHit.Task.IsCompletedSuccessfully) reason = limitHit.Task.Result;
                else if (completed == outputTask) reason = state.OutputTruncated ? "output-limit" : null;
                else if (completed == receiveTask) reason = state.CloseRequested ? "closed" : "channel-closed";
                else if (stoppingToken.IsCancellationRequested) reason = "agent-stopping";

                try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { /* 已退出 */ }
                lifetime.Cancel();
                await AwaitQuietly(outputTask, receiveTask, monitorTask);
                int? exitCode = null;
                try { if (process.HasExited) exitCode = process.ExitCode; } catch { /* 已释放 */ }
                logger.LogInformation("WebSSH terminal ended: session={SessionId}, reason={Reason}, exitCode={ExitCode}, outputBytes={OutputBytes}", open.SessionId, reason ?? "shell-exit", exitCode, state.OutputBytes);
                await TrySendAsync(channel, new
                {
                    kind = "exit",
                    code = exitCode,
                    reason,
                    truncated = state.OutputTruncated ? true : (bool?)null,
                });
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) when (ex is WebSocketException or IOException or InvalidDataException or JsonException)
        {
            logger.LogWarning(ex, "Terminal session {SessionId} channel ended with error", open.SessionId);
        }
        finally
        {
            state.Dispose();
            _sessions.TryRemove(open.SessionId, out _);
        }
    }

    private bool TryStartShell(TerminalOpenRequest open, out Process? process, out string? error)
    {
        process = null;
        error = null;
        if (!OperatingSystem.IsWindows())
        {
            error = "WebSSH is supported only on Windows.";
            return false;
        }
        if (!_options.DisableAllPolicies)
        {
            if (open.Shell == "cmd" && !_options.AllowCmdExecution)
            {
                error = "CMD execution is disabled by local policy.";
                return false;
            }
            if (open.Shell == "powershell" && !_options.AllowPowerShellExecution)
            {
                error = "PowerShell execution is disabled by local policy.";
                return false;
            }
        }
        try
        {
            var info = BuildStartInfo(open.Shell, open.Cols, open.Rows);
            var child = new Process { StartInfo = info };
            if (!child.Start())
            {
                child.Dispose();
                error = "Shell process failed to start.";
                return false;
            }
            process = child;
            return true;
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException)
        {
            logger.LogWarning(ex, "Failed to start WebSSH shell");
            error = "Shell process failed to start.";
            return false;
        }
    }

    private async Task ReceiveAsync(
        AgentSessionSocket channel,
        Process process,
        TerminalSessionState state,
        CancellationTokenSource lifetime)
    {
        try
        {
            await channel.ReceiveAsync(async (message, cancellationToken) =>
            {
                if (message.ValueKind != JsonValueKind.Object) return;
                var kind = WebSshJson.ReadString(message, "kind");
                switch (kind)
                {
                    case "input": {
                        var data = WebSshJson.ReadString(message, "data");
                        if (data.Length == 0) return;
                        if (Encoding.UTF8.GetByteCount(data) > MaxInputBytes)
                        {
                            await channel.SendJsonAsync(new { kind = "error", code = "INPUT_TOO_LARGE", message = "Input exceeds 8 KiB." }, cancellationToken);
                            return;
                        }
                        state.MarkInput();
                        logger.LogDebug("Terminal session {SessionId} received {Bytes} input bytes", state.Id, Encoding.UTF8.GetByteCount(data));
                        await state.WriteInputAsync(process, data, cancellationToken);
                        return;
                    }
                    case "resize": {
                        if (!message.TryGetProperty("cols", out var colsElement) || colsElement.ValueKind != JsonValueKind.Number || !colsElement.TryGetInt32(out var cols)) return;
                        if (!message.TryGetProperty("rows", out var rowsElement) || rowsElement.ValueKind != JsonValueKind.Number || !rowsElement.TryGetInt32(out var rows)) return;
                        var size = ClampSize(cols, rows);
                        state.Cols = size.Cols;
                        state.Rows = size.Rows;
                        await channel.SendJsonAsync(new { kind = "resize-ack", cols = size.Cols, rows = size.Rows }, cancellationToken);
                        return;
                    }
                    case "close": {
                        state.CloseRequested = true;
                        lifetime.Cancel();
                        return;
                    }
                }
            }, lifetime.Token);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) when (ex is WebSocketException or IOException or JsonException)
        {
            logger.LogDebug(ex, "Terminal session receive loop ended");
        }
    }

    private async Task PumpOutputAsync(
        Process process,
        AgentSessionSocket channel,
        TerminalSessionState state,
        CancellationTokenSource outputLimit,
        CancellationToken cancellationToken)
    {
        var stdout = PumpStreamAsync(process.StandardOutput, process, channel, state, outputLimit, cancellationToken);
        var stderr = PumpStreamAsync(process.StandardError, process, channel, state, outputLimit, cancellationToken);
        await Task.WhenAll(stdout, stderr);
    }

    private async Task PumpStreamAsync(
        StreamReader reader,
        Process process,
        AgentSessionSocket channel,
        TerminalSessionState state,
        CancellationTokenSource outputLimit,
        CancellationToken cancellationToken)
    {
        var buffer = new char[OutputChunkChars];
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var read = await reader.ReadAsync(buffer.AsMemory(), cancellationToken);
                if (read == 0) break;
                // 交互式终端不能等待缓冲区填满，每次读取立即下发。
                await EmitAsync(new string(buffer, 0, read), process, channel, state, outputLimit, cancellationToken);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException) { /* 进程已退出 */ }
    }

    private static async Task<bool> EmitAsync(
        string chunk,
        Process process,
        AgentSessionSocket channel,
        TerminalSessionState state,
        CancellationTokenSource outputLimit,
        CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetByteCount(chunk);
        if (state.AddOutputBytes(bytes) > MaxOutputBytes)
        {
            state.OutputTruncated = true;
            try
            {
                await channel.SendJsonAsync(
                    new { kind = "output", data = "\r\n[输出超过 4 MiB 上限，会话已终止]\r\n" },
                    CancellationToken.None);
            }
            catch { /* 通道可能已断开 */ }
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { /* 已退出 */ }
            outputLimit.Cancel();
            return false;
        }
        await channel.SendJsonAsync(new { kind = "output", data = chunk }, cancellationToken);
        return true;
    }

    private static async Task MonitorAsync(TerminalSessionState state, TaskCompletionSource<string> limitHit, CancellationToken cancellationToken)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                var now = DateTimeOffset.UtcNow;
                if (now - state.LastInputAt > IdleTimeout)
                {
                    limitHit.TrySetResult("idle-timeout");
                    return;
                }
                if (now - state.StartedAt > MaxDuration)
                {
                    limitHit.TrySetResult("max-duration");
                    return;
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    private static async Task AwaitQuietly(params Task[] tasks)
    {
        foreach (var task in tasks)
        {
            try { await task.WaitAsync(TimeSpan.FromSeconds(3)); }
            catch { /* 取消或异常均已在上方记录 */ }
        }
    }

    private static async Task TrySendAsync(AgentSessionSocket channel, object message)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        try { await channel.SendJsonAsync(message, timeout.Token); }
        catch { /* 服务端可能已关闭会话 */ }
    }

    private sealed class TerminalSessionState(string id, DateTimeOffset startedAt) : IDisposable
    {
        private long _lastInputTicks = DateTimeOffset.UtcNow.UtcTicks;

        public string Id { get; } = id;
        public DateTimeOffset StartedAt { get; } = startedAt;
        public DateTimeOffset LastInputAt => new(Interlocked.Read(ref _lastInputTicks), TimeSpan.Zero);
        public int Cols { get; set; }
        public int Rows { get; set; }
        public bool OutputTruncated { get; set; }
        public bool CloseRequested { get; set; }
        public Process? Process { get; set; }
        public SemaphoreSlim InputGate { get; } = new(1, 1);
        private long _outputBytes;

        public void MarkInput() => Interlocked.Exchange(ref _lastInputTicks, DateTimeOffset.UtcNow.UtcTicks);

        public long AddOutputBytes(int bytes) => Interlocked.Add(ref _outputBytes, bytes);

        public long OutputBytes => Interlocked.Read(ref _outputBytes);

        public async Task WriteInputAsync(Process process, string data, CancellationToken cancellationToken)
        {
            await InputGate.WaitAsync(cancellationToken);
            try
            {
                if (process.HasExited) return;
                await process.StandardInput.WriteAsync(data.AsMemory(), cancellationToken);
                await process.StandardInput.FlushAsync(cancellationToken);
            }
            catch (IOException) { /* 进程已退出 */ }
            catch (ObjectDisposedException) { /* 进程已退出 */ }
            finally { InputGate.Release(); }
        }

        public void Dispose() => InputGate.Dispose();
    }
}
