using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public sealed record WindowsProcessSnapshot(
    int ProcessId,
    string ProcessName,
    string? ExecutablePath,
    DateTimeOffset? StartedAtUtc,
    int? SessionId,
    bool CommandLineAvailable,
    bool? EfficiencyMode,
    bool CanSetEfficiency);

public interface IWindowsProcessInventory
{
    IReadOnlyList<WindowsProcessSnapshot> List();
}

public sealed class WindowsProcessInventory(IWindowsProcessActionPlatform actions) : IWindowsProcessInventory
{
    public IReadOnlyList<WindowsProcessSnapshot> List()
    {
        var processes = Process.GetProcesses();
        try
        {
            var snapshots = new List<WindowsProcessSnapshot>(processes.Length);
            foreach (var process in processes)
            {
                try
                {
                    var processId = process.Id;
                    var captured = actions.Capture(processId);
                    snapshots.Add(new WindowsProcessSnapshot(
                        processId,
                        captured.ProcessName,
                        captured.ExecutablePath,
                        captured.StartedAtUtc,
                        captured.SessionId,
                        !string.IsNullOrWhiteSpace(captured.CommandLine),
                        captured.EfficiencyMode,
                        captured.CanSetEfficiency));
                }
                catch (Exception ex) when (ex is InvalidOperationException or ArgumentException or Win32Exception or NotSupportedException)
                {
                    // 进程可能在枚举期间退出；该单行不影响其他进程的快照。
                }
            }
            return snapshots;
        }
        finally
        {
            foreach (var process in processes) process.Dispose();
        }
    }

}

public sealed class WindowsProcessInventoryManager(
    IOptions<AgentOptions> options,
    IWindowsProcessInventory inventory,
    IProcessResourceReader processResources,
    IWindowsProcessController processController,
    ActiveUserSessionResolver sessionResolver)
{
    private const int ResourceSampleMilliseconds = 750;
    private const int MaximumListResultBytes = 480 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly AgentOptions _options = options.Value;

    public async Task<ExecutionResult> ExecuteAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any())
            return new ExecutionResult("failed", ErrorJson("Payload must be an empty object."), null);

        var started = Stopwatch.GetTimestamp();
        try
        {
            var snapshots = inventory.List()
                .Where(process => process.ProcessId > 0)
                .Select(NormalizeSnapshot)
                .OrderBy(process => process.ProcessName, StringComparer.OrdinalIgnoreCase)
                .ThenBy(process => process.ProcessName, StringComparer.Ordinal)
                .ThenBy(process => process.ProcessId)
                .ToArray();
            var activeSessionId = sessionResolver.Resolve();
            var processIds = snapshots.Select(process => process.ProcessId).Distinct().ToArray();
            var before = processIds.ToDictionary(processId => processId, processResources.Read);
            await Task.Delay(ResourceSampleMilliseconds, cancellationToken);
            var elapsed = Stopwatch.GetElapsedTime(started);
            var after = processIds.ToDictionary(processId => processId, processResources.Read);

            var rows = snapshots.Select(process =>
            {
                before.TryGetValue(process.ProcessId, out var first);
                after.TryGetValue(process.ProcessId, out var last);
                ProcessResources? resources = null;
                if (last is not null)
                {
                    double? cpuPercent = null;
                    if (first is not null && elapsed.TotalMilliseconds > 0)
                    {
                        var cpuMilliseconds = Math.Max(0, (last.TotalProcessorTime - first.TotalProcessorTime).TotalMilliseconds);
                        cpuPercent = Math.Round(Math.Clamp(
                            cpuMilliseconds / (elapsed.TotalMilliseconds * Math.Max(Environment.ProcessorCount, 1)) * 100,
                            0,
                            100), 2);
                    }
                    resources = new ProcessResources(cpuPercent, last.WorkingSetBytes, last.PrivateMemoryBytes);
                }

                var terminationRestriction = TerminationRestriction(process);
                var baseRestriction = ActionRestriction(process);
                var restartRestriction = baseRestriction ?? (process.SessionId is null or <= 0 || activeSessionId is null || process.SessionId != activeSessionId.Value
                    ? "non-interactive-session"
                    : !process.CommandLineAvailable ? "command-line-unavailable" : null);
                var efficiencyRestriction = baseRestriction ?? (!process.CanSetEfficiency || process.EfficiencyMode is null ? "access-denied" : null);
                return new ProcessListItem(
                    process.ProcessId,
                    process.ProcessName,
                    process.ExecutablePath,
                    process.StartedAtUtc,
                    process.SessionId,
                    terminationRestriction is null,
                    terminationRestriction,
                    restartRestriction is null,
                    restartRestriction,
                    process.EfficiencyMode,
                    efficiencyRestriction is null,
                    efficiencyRestriction,
                    resources);
            }).ToArray();

            var json = SerializeList(rows, rows.Length, truncated: false, elapsed);
            if (Encoding.UTF8.GetByteCount(json) > MaximumListResultBytes)
            {
                var low = 0;
                var high = rows.Length;
                while (low < high)
                {
                    var middle = low + (high - low + 1) / 2;
                    var candidate = SerializeList(rows, middle, truncated: middle < rows.Length, elapsed);
                    if (Encoding.UTF8.GetByteCount(candidate) <= MaximumListResultBytes) low = middle;
                    else high = middle - 1;
                }
                json = SerializeList(rows, low, truncated: low < rows.Length, elapsed);
            }

            return new ExecutionResult("success", json, null);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or SystemException)
        {
            return new ExecutionResult("failed", ErrorJson("Windows process inventory operation failed."), null);
        }
    }

    public static string ErrorJson(string error) => JsonSerializer.Serialize(new ProcessListResult(
        DateTimeOffset.UtcNow,
        0,
        0,
        0,
        false,
        [],
        error), JsonOptions);

    private static WindowsProcessSnapshot NormalizeSnapshot(WindowsProcessSnapshot snapshot)
    {
        var name = string.IsNullOrWhiteSpace(snapshot.ProcessName) ? $"PID-{snapshot.ProcessId}" : snapshot.ProcessName.Trim();
        var path = WindowsProcessTerminator.TryNormalizeExecutablePath(snapshot.ExecutablePath, out var normalized) ? normalized : null;
        return snapshot with { ProcessName = name, ExecutablePath = path };
    }

    private string? TerminationRestriction(WindowsProcessSnapshot process)
    {
        if (process.ProcessId == 4) return "system";
        if (process.ProcessId == processController.CurrentProcessId) return "agent-self";
        if (process.ExecutablePath is null) return "path-unavailable";
        if (_options.DisableAllPolicies || (_options.AllowedProcessPaths ?? []).Any(configuredPath =>
            WindowsProcessTerminator.TryNormalizeExecutablePath(configuredPath, out var normalized) &&
            string.Equals(normalized, process.ExecutablePath, StringComparison.OrdinalIgnoreCase))) return null;
        return "not-allowlisted";
    }

    private string? ActionRestriction(WindowsProcessSnapshot process)
    {
        if (process.ProcessId == 4) return "system";
        if (process.ProcessId == processController.CurrentProcessId) return "agent-self";
        if (process.ExecutablePath is null) return "path-unavailable";
        if (process.StartedAtUtc is null) return "start-time-unavailable";
        if (!_options.DisableAllPolicies && !(_options.AllowedProcessPaths ?? []).Any(configuredPath =>
            WindowsProcessTerminator.TryNormalizeExecutablePath(configuredPath, out var normalized) &&
            string.Equals(normalized, process.ExecutablePath, StringComparison.OrdinalIgnoreCase))) return "not-allowlisted";
        return null;
    }

    private static string SerializeList(ProcessListItem[] rows, int count, bool truncated, TimeSpan elapsed) =>
        JsonSerializer.Serialize(new ProcessListResult(
            DateTimeOffset.UtcNow,
            (long)elapsed.TotalMilliseconds,
            rows.Length,
            count,
            truncated,
            rows.Take(count).ToArray(),
            null), JsonOptions);

    private sealed record ProcessResources(double? CpuPercent, long WorkingSetBytes, long PrivateMemoryBytes);
    private sealed record ProcessListItem(
        int ProcessId,
        string ProcessName,
        string? ExecutablePath,
        DateTimeOffset? StartedAtUtc,
        int? SessionId,
        bool CanTerminate,
        string? TerminationRestriction,
        bool CanRestart,
        string? RestartRestriction,
        bool? EfficiencyMode,
        bool CanSetEfficiency,
        string? EfficiencyRestriction,
        ProcessResources? Resources);
    private sealed record ProcessListResult(
        DateTimeOffset CapturedAtUtc,
        long SampleDurationMs,
        int Total,
        int Returned,
        bool Truncated,
        ProcessListItem[] Processes,
        string? Error);
}
