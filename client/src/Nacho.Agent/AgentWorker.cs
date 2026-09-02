using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public sealed class AgentWorker(
    AgentApiClient api,
    CommandProcessor processor,
    WindowsMetrics metrics,
    AgentPaths paths,
    IOptions<AgentOptions> options,
    ILogger<AgentWorker> logger) : BackgroundService
{
    private readonly AgentOptions _options = options.Value;
    private volatile bool _webSocketConnected;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        CleanupHistoricalBackups();
        await EnrollWithRetryAsync(stoppingToken);
        await processor.RecoverAsync(stoppingToken);

        await Task.WhenAll(
            WebSocketLoopAsync(stoppingToken),
            HeartbeatLoopAsync(stoppingToken),
            PollLoopAsync(stoppingToken),
            ReportRetryLoopAsync(stoppingToken));
    }

    private void CleanupHistoricalBackups()
    {
        try
        {
            var installPath = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(installPath)) return;
            var backupRoot = AgentUpdater.ResolveHistoricalBackupDirectory(installPath);
            var result = AgentUpdater.CleanupHistoricalBackups(backupRoot, _options.UpdateBackupRetentionCount, _options.UpdateBackupMaxBytes);
            if (result.Deleted > 0)
                logger.LogInformation("Historical update backups cleaned: {Deleted} directories, {RemainingBytes} bytes remain", result.Deleted, result.RemainingBytes);
        }
        catch (Exception ex) { logger.LogWarning(ex, "Historical update backup cleanup failed"); }
    }

    private async Task EnrollWithRetryAsync(CancellationToken cancellationToken)
    {
        var delay = TimeSpan.FromSeconds(1);
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var state = await api.EnsureEnrolledAsync(cancellationToken);
                logger.LogInformation("Agent enrolled as {ClientId}", state.ClientId);
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Enrollment failed; retrying in {Delay}", delay);
                await Task.Delay(delay, cancellationToken);
                delay = TimeSpan.FromSeconds(Math.Min(delay.TotalSeconds * 2, 60));
            }
        }
    }

    private async Task WebSocketLoopAsync(CancellationToken cancellationToken)
    {
        var attempt = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            using var socket = api.CreateWebSocket();
            try
            {
                await socket.ConnectAsync(api.WebSocketUri(), cancellationToken);
                _webSocketConnected = true;
                attempt = 0;
                logger.LogInformation("WebSocket connected");
                await ReceiveAsync(socket, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "WebSocket disconnected");
            }
            finally { _webSocketConnected = false; }

            attempt++;
            var cap = Math.Min(Math.Pow(2, Math.Min(attempt, 6)), 60);
            await Task.Delay(TimeSpan.FromSeconds(Random.Shared.NextDouble() * cap + 1), cancellationToken);
        }
    }

    private async Task ReceiveAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            var received = await socket.ReceiveAsync(buffer, cancellationToken);
            if (received.MessageType == WebSocketMessageType.Close) return;
            message.Write(buffer, 0, received.Count);
            if (!received.EndOfMessage) continue;
            if (received.MessageType == WebSocketMessageType.Text)
            {
                using var document = JsonDocument.Parse(message.ToArray());
                var root = document.RootElement;
                if (root.TryGetProperty("kind", out var kind) && kind.GetString() == "command" &&
                    root.TryGetProperty("command", out var commandElement))
                {
                    var command = commandElement.Deserialize(AgentJsonContext.Default.AgentCommand);
                    if (command is not null) await processor.AcceptAsync(command, cancellationToken);
                }
            }
            message.SetLength(0);
        }
    }

    private async Task HeartbeatLoopAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(_options.HeartbeatSeconds, 5)));
        do
        {
            try
            {
                await api.HeartbeatAsync(metrics.Read(), cancellationToken);
                var health = new UpdateHealth(AgentUpdater.CurrentVersion, DateTimeOffset.UtcNow);
                AgentUpdater.WriteAtomic(paths.UpdateHealthFile, health, AgentJsonContext.Default.UpdateHealth);
            }
            catch (HttpRequestException ex) when (ex.Message.Contains("401", StringComparison.OrdinalIgnoreCase) || ex.Message.Contains("访问令牌无效", StringComparison.OrdinalIgnoreCase))
            {
                logger.LogWarning(ex, "Heartbeat rejected; clearing local enrollment state and retrying enrollment");
                try { api.ResetEnrollment(); await EnrollWithRetryAsync(cancellationToken); }
                catch (Exception resetEx) when (resetEx is not OperationCanceledException) { logger.LogError(resetEx, "Automatic re-enrollment failed"); }
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Heartbeat failed"); }
        } while (await timer.WaitForNextTickAsync(cancellationToken));
    }

    private async Task PollLoopAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(_options.PollSeconds, 5)));
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            if (_webSocketConnected) continue;
            try
            {
                foreach (var command in await api.PullPendingAsync(cancellationToken))
                    await processor.AcceptAsync(command, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Command polling failed"); }
        }
    }

    private async Task ReportRetryLoopAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        while (await timer.WaitForNextTickAsync(cancellationToken))
            await processor.RetryReportsAsync(cancellationToken);
    }
}
