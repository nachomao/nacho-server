using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Nacho.Agent;

public sealed class CommandProcessor(
    CommandJournal journal,
    AgentApiClient api,
    ProgramExecutor executor,
    ShellCommandExecutor shellExecutor,
    PackageInstallManager packageInstallManager,
    FileDeploymentManager fileDeploymentManager,
    WindowsServiceManager serviceManager,
    WindowsProcessInventoryManager processInventoryManager,
    WindowsProcessActionManager processActionManager,
    WindowsProcessTerminator processTerminator,
    SystemRestartManager restartManager,
    LogCollectionManager logCollectionManager,
    LocalUserManager localUserManager,
    RegistryManager registryManager,
    MessagePushManager messagePushManager,
    OpenUrlManager openUrlManager,
    AgentUpdater agentUpdater,
    ILogger<CommandProcessor> logger) : BackgroundService
{
    private readonly Channel<JournalEntry> _queue = Channel.CreateUnbounded<JournalEntry>(new UnboundedChannelOptions { SingleReader = true });
    private readonly ConcurrentDictionary<string, byte> _queued = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _resumeRestarts = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _resumeUpdates = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _resumePackageInstalls = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _resumeFileDeployments = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _resumeProcessRestarts = new(StringComparer.Ordinal);

    public async Task AcceptAsync(AgentCommand command, CancellationToken cancellationToken)
    {
        var entry = await journal.GetOrCreateAsync(command, cancellationToken);
        if (entry.State == "completed")
        {
            if (!entry.Reported) await TryReportAsync(entry, cancellationToken);
            return;
        }
        if (command.Type == "restart-system" && !restartManager.TryReserve(command.Id))
        {
            await CompleteRejectedRestartAsync(entry, "Another system restart intent is already active.", cancellationToken);
            return;
        }
        if (_queued.TryAdd(command.Id, 0)) await _queue.Writer.WriteAsync(entry, cancellationToken);
    }

    public async Task RecoverAsync(CancellationToken cancellationToken)
    {
        var entries = (await journal.ListAsync(cancellationToken)).OrderBy(entry => entry.Command.CreatedAt).ToArray();
        string? persistedRestartId = null;
        var persistedIntentInvalid = false;
        try { persistedRestartId = await restartManager.GetPersistedCommandIdAsync(cancellationToken); }
        catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidDataException or IOException)
        {
            persistedIntentInvalid = true;
        }

        foreach (var entry in entries.Where(item => item.State == "running"))
        {
            if (entry.Command.Type == "restart-system")
            {
                if (persistedIntentInvalid ||
                    (persistedRestartId is not null && !string.Equals(persistedRestartId, entry.Command.Id, StringComparison.Ordinal)) ||
                    !restartManager.TryReserve(entry.Command.Id))
                {
                    await CompleteRejectedRestartAsync(entry, "Restart intent state is invalid or conflicts with another command.", cancellationToken);
                    continue;
                }
                _resumeRestarts.TryAdd(entry.Command.Id, 0);
                if (_queued.TryAdd(entry.Command.Id, 0)) await _queue.Writer.WriteAsync(entry, cancellationToken);
                continue;
            }

            if (entry.Command.Type == "update-agent")
            {
                _resumeUpdates.TryAdd(entry.Command.Id, 0);
                if (_queued.TryAdd(entry.Command.Id, 0)) await _queue.Writer.WriteAsync(entry, cancellationToken);
                continue;
            }

            if (entry.Command.Type == "install-package")
            {
                _resumePackageInstalls.TryAdd(entry.Command.Id, 0);
                if (_queued.TryAdd(entry.Command.Id, 0)) await _queue.Writer.WriteAsync(entry, cancellationToken);
                continue;
            }

            if (entry.Command.Type is "deploy-file" or "rollback-file-deploy")
            {
                _resumeFileDeployments.TryAdd(entry.Command.Id, 0);
                if (_queued.TryAdd(entry.Command.Id, 0)) await _queue.Writer.WriteAsync(entry, cancellationToken);
                continue;
            }

            if (entry.Command.Type == "restart-process" && processActionManager.HasRestartIntent(entry.Command.Id))
            {
                _resumeProcessRestarts.TryAdd(entry.Command.Id, 0);
                if (_queued.TryAdd(entry.Command.Id, 0)) await _queue.Writer.WriteAsync(entry, cancellationToken);
                continue;
            }

            entry.State = "completed";
            entry.FinalStatus = "failed";
            entry.Result = entry.Command.Type switch
            {
                "manage-service" => WindowsServiceManager.ErrorJson(entry.Command.Payload, "Agent restarted while the command was running."),
                "list-processes" => WindowsProcessInventoryManager.ErrorJson("Agent restarted while the command was running."),
                "terminate-process" => WindowsProcessTerminator.ErrorJson(entry.Command.Payload, "Agent restarted while the command was running."),
                "restart-process" => WindowsProcessActionManager.RestartErrorJson(entry.Command.Payload, "Agent restarted without a recoverable restart intent."),
                "set-process-efficiency" => WindowsProcessActionManager.EfficiencyErrorJson(entry.Command.Payload, "Agent restarted while the efficiency command was running."),
                "collect-logs" => LogCollectionManager.ErrorJson(entry.Command.Payload, "Agent restarted while the command was running."),
                "run-shell" => ShellCommandExecutor.ErrorJson(entry.Command.Payload, "Agent restarted while the command was running."),
                "manage-local-user" => LocalUserManager.ErrorJson(entry.Command.Payload, "Agent restarted while the command was running; the operation was not replayed."),
                "manage-registry" => RegistryManager.ErrorJson(entry.Command.Payload, "Agent restarted while the command was running; the operation was not replayed."),
                "show-message" => MessagePushManager.ErrorJson("Agent restarted while the message command was running; delivery was not repeated."),
                "open-url" => OpenUrlManager.ErrorJson("Agent restarted while the URL command was running; browser launch was not repeated."),
                "install-package" => PackageInstallManager.ErrorJson(entry.Command.Payload, "Package installation state is unknown after Agent restart."),
                _ => ProgramExecutor.ErrorJson("Agent restarted while the command was running."),
            };
            entry.ExitCode = null;
            entry.Reported = false;
            await journal.SaveAsync(entry, cancellationToken);
        }

        foreach (var entry in entries)
        {
            if (entry.State == "received") await AcceptAsync(entry.Command, cancellationToken);
            else if (entry.State == "completed" && !entry.Reported) await TryReportAsync(entry, cancellationToken);
        }
    }

    public async Task RetryReportsAsync(CancellationToken cancellationToken)
    {
        foreach (var entry in await journal.ListAsync(cancellationToken))
        {
            if (entry.State == "received") await AcceptAsync(entry.Command, cancellationToken);
            else if (entry.State == "completed" && !entry.Reported) await TryReportAsync(entry, cancellationToken);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var entry in _queue.Reader.ReadAllAsync(stoppingToken))
        {
            try { await ProcessAsync(entry, stoppingToken); }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogError(ex, "Command {CommandId} processing failed", entry.Command.Id); }
            finally { _queued.TryRemove(entry.Command.Id, out _); }
        }
    }

    private async Task ProcessAsync(JournalEntry entry, CancellationToken cancellationToken)
    {
        var resumingRestart = _resumeRestarts.TryRemove(entry.Command.Id, out _);
        var resumingUpdate = _resumeUpdates.TryRemove(entry.Command.Id, out _);
        var resumingPackageInstall = _resumePackageInstalls.TryRemove(entry.Command.Id, out _);
        var resumingFileDeployment = _resumeFileDeployments.TryRemove(entry.Command.Id, out _);
        var resumingProcessRestart = _resumeProcessRestarts.TryRemove(entry.Command.Id, out _);
        if (!resumingRestart && !resumingUpdate && !resumingPackageInstall && !resumingFileDeployment && !resumingProcessRestart)
        {
            await api.AcknowledgeAsync(entry.Command.Id, cancellationToken);
            entry.State = "running";
            await journal.SaveAsync(entry, cancellationToken);
            try { await api.ReportAsync(entry.Command.Id, "running", null, null, cancellationToken); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Running report for {CommandId} failed; final result will still be delivered", entry.Command.Id);
            }
        }

        var execution = entry.Command.Type switch
        {
            "run-program" => await executor.ExecuteAsync(entry.Command.Payload, cancellationToken),
            "run-shell" => await shellExecutor.ExecuteAsync(entry.Command.Payload, cancellationToken),
            "install-package" when resumingPackageInstall => await packageInstallManager.ResumeAsync(
                entry.Command.Id,
                entry.Command.Payload,
                (result, token) => TryReportProgressAsync(entry.Command.Id, result, token),
                cancellationToken),
            "install-package" => await packageInstallManager.ExecuteAsync(
                entry.Command.Id,
                entry.Command.Payload,
                (result, token) => TryReportProgressAsync(entry.Command.Id, result, token),
                cancellationToken),
            "deploy-file" when resumingFileDeployment => await fileDeploymentManager.ResumeAsync(
                entry.Command.Id,
                entry.Command.Payload,
                (result, token) => TryReportProgressAsync(entry.Command.Id, result, token),
                cancellationToken),
            "deploy-file" => await fileDeploymentManager.ExecuteAsync(
                entry.Command.Id,
                entry.Command.Payload,
                (result, token) => TryReportProgressAsync(entry.Command.Id, result, token),
                cancellationToken),
            "rollback-file-deploy" => await fileDeploymentManager.RollbackAsync(entry.Command.Id, entry.Command.Payload, cancellationToken),
            "manage-service" => await serviceManager.ExecuteAsync(entry.Command.Payload, cancellationToken),
            "list-processes" => await processInventoryManager.ExecuteAsync(entry.Command.Payload, cancellationToken),
            "terminate-process" => await processTerminator.ExecuteAsync(entry.Command.Payload, cancellationToken),
            "restart-process" when resumingProcessRestart => await processActionManager.ResumeRestartAsync(entry.Command.Id, entry.Command.Payload, cancellationToken),
            "restart-process" => await processActionManager.RestartAsync(entry.Command.Id, entry.Command.Payload, cancellationToken),
            "set-process-efficiency" => processActionManager.SetEfficiency(entry.Command.Payload),
            "restart-system" when resumingRestart => await restartManager.ResumeAsync(
                entry.Command.Id,
                entry.Command.Payload,
                (result, token) => TryReportProgressAsync(entry.Command.Id, result, token),
                cancellationToken),
            "restart-system" => await restartManager.ExecuteAsync(
                entry.Command.Id,
                entry.Command.Payload,
                (result, token) => TryReportProgressAsync(entry.Command.Id, result, token),
                cancellationToken),
            "collect-logs" => await logCollectionManager.ExecuteAsync(entry.Command.Payload, cancellationToken),
            "manage-local-user" => await localUserManager.ExecuteAsync(entry.Command.Payload, cancellationToken),
            "manage-registry" => await registryManager.ExecuteAsync(entry.Command.Payload, cancellationToken),
            "show-message" => await messagePushManager.ExecuteAsync(entry.Command.Id, entry.Command.Payload, cancellationToken),
            "open-url" => await openUrlManager.ExecuteAsync(entry.Command.Id, entry.Command.Payload, cancellationToken),
            "update-agent" => await agentUpdater.ExecuteAsync(
                entry.Command.Id,
                entry.Command.Payload,
                (result, token) => TryReportProgressAsync(entry.Command.Id, result, token),
                cancellationToken),
            _ => new ExecutionResult("failed", ProgramExecutor.ErrorJson($"Unsupported command type: {entry.Command.Type}"), null),
        };

        entry.State = "completed";
        entry.FinalStatus = execution.Status;
        entry.Result = execution.Result;
        entry.ExitCode = execution.ExitCode;
        entry.Reported = false;
        await journal.SaveAsync(entry, cancellationToken);
        await TryReportAsync(entry, cancellationToken);
        if (entry.Command.Type == "restart-system") restartManager.Release(entry.Command.Id);
    }

    private async Task CompleteRejectedRestartAsync(JournalEntry entry, string error, CancellationToken cancellationToken)
    {
        try { await api.AcknowledgeAsync(entry.Command.Id, cancellationToken); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Restart conflict acknowledgement for {CommandId} failed", entry.Command.Id);
        }
        entry.State = "completed";
        entry.FinalStatus = "failed";
        entry.Result = SystemRestartManager.ErrorJson(entry.Command.Payload, error);
        entry.ExitCode = null;
        entry.Reported = false;
        await journal.SaveAsync(entry, cancellationToken);
        await TryReportAsync(entry, cancellationToken);
    }

    private async Task TryReportProgressAsync(string commandId, string result, CancellationToken cancellationToken)
    {
        try { await api.ReportAsync(commandId, "running", result, null, cancellationToken); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Command progress report for {CommandId} failed; final result will still be delivered", commandId);
        }
    }

    private async Task TryReportAsync(JournalEntry entry, CancellationToken cancellationToken)
    {
        try
        {
            await api.ReportAsync(entry.Command.Id, entry.FinalStatus!, entry.Result, entry.ExitCode, cancellationToken);
            entry.Reported = true;
            await journal.SaveAsync(entry, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Result report for {CommandId} will be retried", entry.Command.Id); }
    }
}
