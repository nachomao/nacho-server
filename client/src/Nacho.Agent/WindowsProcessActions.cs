using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public sealed record ProcessActionSnapshot(
    int ProcessId,
    string ProcessName,
    string? ExecutablePath,
    DateTimeOffset? StartedAtUtc,
    int? SessionId,
    string? CommandLine,
    string? Priority,
    bool? EfficiencyMode,
    bool CanSetEfficiency);

public sealed record EfficiencyMutationResult(
    bool? InitialEnabled,
    bool? FinalEnabled,
    string? InitialPriority,
    string? FinalPriority,
    bool PriorityRestored,
    int ErrorCode);

public interface IWindowsProcessActionPlatform
{
    ProcessActionSnapshot Capture(int processId);
    Task<bool> TerminateTreeAsync(int processId, TimeSpan timeout, CancellationToken cancellationToken);
    EfficiencyMutationResult SetEfficiency(int processId, bool enabled, string? restorePriority);
}

public sealed class WindowsProcessActionPlatform : IWindowsProcessActionPlatform
{
    public ProcessActionSnapshot Capture(int processId)
    {
        using var process = Process.GetProcessById(processId);
        process.Refresh();
        if (process.HasExited) throw new InvalidOperationException("Process has exited.");
        var name = Safe(() => process.ProcessName) ?? $"PID-{processId}";
        var rawPath = Safe(() => process.MainModule?.FileName);
        var path = WindowsProcessTerminator.TryNormalizeExecutablePath(rawPath, out var normalized) ? normalized : null;
        var started = Safe<DateTimeOffset?>(() => new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero));
        var session = Safe<int?>(() => process.SessionId);
        var priority = Safe(() => PriorityName(process.PriorityClass));
        var commandLine = WindowsProcessActionNativeMethods.TryReadCommandLine(processId);
        var power = WindowsProcessActionNativeMethods.TryReadEfficiency(processId, out var canSet);
        return new(processId, name, path, started, session, commandLine, priority, power, canSet);
    }

    public async Task<bool> TerminateTreeAsync(int processId, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var process = Process.GetProcessById(processId);
        if (process.HasExited) return true;
        process.Kill(entireProcessTree: true);
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(timeout);
        try { await process.WaitForExitAsync(timeoutCts.Token); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { return process.HasExited; }
        return process.HasExited;
    }

    public EfficiencyMutationResult SetEfficiency(int processId, bool enabled, string? restorePriority) =>
        WindowsProcessActionNativeMethods.SetEfficiency(processId, enabled, restorePriority);

    private static T? Safe<T>(Func<T> reader)
    {
        try { return reader(); }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException or Win32Exception or NotSupportedException) { return default; }
    }

    internal static string PriorityName(ProcessPriorityClass priority) => priority switch
    {
        ProcessPriorityClass.Idle => "idle",
        ProcessPriorityClass.BelowNormal => "below-normal",
        ProcessPriorityClass.Normal => "normal",
        ProcessPriorityClass.AboveNormal => "above-normal",
        ProcessPriorityClass.High => "high",
        ProcessPriorityClass.RealTime => "real-time",
        _ => "normal",
    };
}

public sealed class WindowsProcessActionManager(
    IOptions<AgentOptions> options,
    IWindowsProcessActionPlatform platform,
    ActiveUserSessionResolver sessionResolver,
    IUserProcessLauncher launcher,
    AgentPaths paths)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly AgentOptions _options = options.Value;

    public async Task<ExecutionResult> RestartAsync(string commandId, JsonElement payload, CancellationToken cancellationToken)
    {
        var started = Stopwatch.GetTimestamp();
        RestartRequest request;
        try { request = ParseRestart(payload); }
        catch (InvalidDataException ex) { return RestartFailed(null, ex.Message, started); }
        try
        {
            var snapshot = platform.Capture(request.ProcessId);
            ValidateIdentity(snapshot, request.ExpectedPath, request.ExpectedStartedAtUtc);
            ValidatePolicy(snapshot);
            var active = sessionResolver.Resolve();
            if (snapshot.SessionId is null or <= 0 || active is null || snapshot.SessionId != active.Value)
                throw new InvalidDataException("Process is not in the active interactive user session.");
            if (string.IsNullOrWhiteSpace(snapshot.CommandLine)) throw new InvalidDataException("Process command line is unavailable.");
            var fullArguments = WindowsCommandLine.SplitFull(snapshot.CommandLine);
            if (fullArguments.Length == 0) throw new InvalidDataException("Process command line is unavailable.");
            var intent = new ProcessRestartIntent
            {
                CommandId = commandId,
                OriginalProcessId = request.ProcessId,
                ExpectedPath = request.ExpectedPath,
                ExpectedStartedAtUtc = request.ExpectedStartedAtUtc,
                SessionId = active.Value,
                Arguments = fullArguments.Skip(1).ToArray(),
                TimeoutSeconds = request.TimeoutSeconds,
                Phase = "prepared",
            };
            SaveIntent(intent);
            return await ContinueRestartAsync(intent, started, cancellationToken);
        }
        catch (Exception ex) when (ex is InvalidDataException or InvalidOperationException or ArgumentException or Win32Exception or SystemException)
        {
            return RestartFailed(request, Sanitize(ex.Message), started);
        }
    }

    public async Task<ExecutionResult> ResumeRestartAsync(string commandId, JsonElement payload, CancellationToken cancellationToken)
    {
        var started = Stopwatch.GetTimestamp();
        var request = ParseRestart(payload);
        var intent = ReadIntent(commandId);
        if (intent is null) return RestartFailed(request, "Restart intent is missing after Agent restart.", started);
        if (intent.Phase == "launching") return RestartFailed(request, "Restart launch state is unknown after Agent restart; launch was not repeated.", started, stopped: true);
        return await ContinueRestartAsync(intent, started, cancellationToken);
    }

    public ExecutionResult SetEfficiency(JsonElement payload)
    {
        var started = Stopwatch.GetTimestamp();
        EfficiencyRequest request;
        try { request = ParseEfficiency(payload); }
        catch (InvalidDataException ex) { return EfficiencyFailed(null, ex.Message, started); }
        try
        {
            var snapshot = platform.Capture(request.ProcessId);
            ValidateIdentity(snapshot, request.ExpectedPath, request.ExpectedStartedAtUtc);
            ValidatePolicy(snapshot);
            if (!snapshot.CanSetEfficiency || snapshot.EfficiencyMode is null) throw new InvalidDataException("Process efficiency state cannot be changed.");
            var states = ReadEfficiencyStates();
            var key = IdentityKey(snapshot);
            string? restorePriority = null;
            if (request.Enabled && !snapshot.EfficiencyMode.Value)
            {
                states[key] = snapshot.Priority ?? "normal";
                WriteEfficiencyStates(states);
            }
            else if (!request.Enabled) states.TryGetValue(key, out restorePriority);

            var mutation = platform.SetEfficiency(request.ProcessId, request.Enabled, restorePriority);
            if (mutation.ErrorCode != 0) throw new Win32Exception(mutation.ErrorCode, "Windows efficiency mode operation failed.");
            if (!request.Enabled && mutation.FinalEnabled == false)
            {
                states.Remove(key);
                WriteEfficiencyStates(states);
            }
            return new("success", JsonSerializer.Serialize(new
            {
                processId = request.ProcessId,
                expectedPath = request.ExpectedPath,
                expectedStartedAtUtc = request.ExpectedStartedAtUtc,
                requestedEnabled = request.Enabled,
                initialEnabled = mutation.InitialEnabled,
                finalEnabled = mutation.FinalEnabled,
                originalPriority = request.Enabled ? mutation.InitialPriority : restorePriority ?? mutation.InitialPriority,
                finalPriority = mutation.FinalPriority,
                priorityRestored = mutation.PriorityRestored,
                durationMs = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds,
                error = (string?)null,
            }), null);
        }
        catch (Exception ex) when (ex is InvalidDataException or InvalidOperationException or ArgumentException or Win32Exception or SystemException)
        {
            return EfficiencyFailed(request, Sanitize(ex.Message), started);
        }
    }

    public bool HasRestartIntent(string commandId) => File.Exists(paths.ProcessRestartIntentFile(commandId));

    public static string RestartErrorJson(JsonElement payload, string error)
    {
        RestartRequest? request = null;
        try { request = ParseRestart(payload); } catch { }
        return RestartFailed(request, error, Stopwatch.GetTimestamp()).Result;
    }

    public static string EfficiencyErrorJson(JsonElement payload, string error)
    {
        EfficiencyRequest? request = null;
        try { request = ParseEfficiency(payload); } catch { }
        return EfficiencyFailed(request, error, Stopwatch.GetTimestamp()).Result;
    }

    private async Task<ExecutionResult> ContinueRestartAsync(ProcessRestartIntent intent, long started, CancellationToken cancellationToken)
    {
        try
        {
            if (intent.Phase == "prepared")
            {
                var snapshot = platform.Capture(intent.OriginalProcessId);
                ValidateIdentity(snapshot, intent.ExpectedPath, intent.ExpectedStartedAtUtc);
                if (!await platform.TerminateTreeAsync(intent.OriginalProcessId, TimeSpan.FromSeconds(intent.TimeoutSeconds), cancellationToken))
                    throw new InvalidOperationException("Process restart timed out while stopping the original process.");
                intent.Phase = "stopped";
                SaveIntent(intent);
            }
            if (intent.Phase == "stopped")
            {
                intent.Phase = "launching";
                SaveIntent(intent);
                var launch = launcher.Start(intent.SessionId, intent.ExpectedPath, intent.Arguments);
                if (!launch.Succeeded) throw new Win32Exception(launch.ErrorCode, "CreateProcessAsUser failed.");
                intent.NewProcessId = launch.ProcessId;
                intent.Phase = "launched";
                SaveIntent(intent);
            }
            if (intent.Phase == "launched")
            {
                var replacement = platform.Capture(intent.NewProcessId ?? throw new InvalidDataException("Restart intent has no new PID."));
                if (!string.Equals(replacement.ExecutablePath, intent.ExpectedPath, StringComparison.OrdinalIgnoreCase) || replacement.SessionId != intent.SessionId)
                    throw new InvalidDataException("Restarted process identity verification failed.");
                intent.Phase = "verified";
                SaveIntent(intent);
            }
            return RestartSuccess(intent, started);
        }
        catch (Exception ex) when (ex is InvalidDataException or InvalidOperationException or ArgumentException or Win32Exception or SystemException)
        {
            return RestartFailed(new(intent.OriginalProcessId, intent.ExpectedPath, intent.ExpectedStartedAtUtc, intent.TimeoutSeconds), Sanitize(ex.Message), started,
                stopped: intent.Phase is "stopped" or "launching" or "launched" or "verified", newProcessId: intent.NewProcessId, sessionId: intent.SessionId);
        }
    }

    private void ValidatePolicy(ProcessActionSnapshot snapshot)
    {
        if (snapshot.ProcessId == 4) throw new InvalidDataException("System process cannot be managed.");
        if (snapshot.ProcessId == Environment.ProcessId) throw new InvalidDataException("NachoAgent cannot manage itself.");
        if (snapshot.ExecutablePath is null) throw new InvalidDataException("Process image path is unavailable.");
        if (!_options.DisableAllPolicies && !(_options.AllowedProcessPaths ?? []).Any(path =>
            WindowsProcessTerminator.TryNormalizeExecutablePath(path, out var normalized) && string.Equals(normalized, snapshot.ExecutablePath, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException("Process path is not in the local allowlist.");
    }

    private static void ValidateIdentity(ProcessActionSnapshot snapshot, string expectedPath, DateTimeOffset expectedStartedAtUtc)
    {
        if (!string.Equals(snapshot.ExecutablePath, expectedPath, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Process image path changed after inventory capture.");
        if (snapshot.StartedAtUtc is null || snapshot.StartedAtUtc.Value.ToUniversalTime() != expectedStartedAtUtc.ToUniversalTime()) throw new InvalidDataException("Process start time changed after inventory capture.");
    }

    private void SaveIntent(ProcessRestartIntent intent)
    {
        Directory.CreateDirectory(paths.ProcessRestartsDirectory);
        var json = JsonSerializer.SerializeToUtf8Bytes(intent, JsonOptions);
        var protectedBytes = ProtectedData.Protect(json, null, DataProtectionScope.LocalMachine);
        var file = paths.ProcessRestartIntentFile(intent.CommandId);
        var temp = file + ".tmp";
        File.WriteAllBytes(temp, protectedBytes);
        File.Move(temp, file, true);
    }

    private ProcessRestartIntent? ReadIntent(string commandId)
    {
        var file = paths.ProcessRestartIntentFile(commandId);
        if (!File.Exists(file)) return null;
        var bytes = ProtectedData.Unprotect(File.ReadAllBytes(file), null, DataProtectionScope.LocalMachine);
        return JsonSerializer.Deserialize<ProcessRestartIntent>(bytes, JsonOptions);
    }

    private Dictionary<string, string> ReadEfficiencyStates()
    {
        if (!File.Exists(paths.ProcessEfficiencyStateFile)) return new(StringComparer.OrdinalIgnoreCase);
        try { return JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(paths.ProcessEfficiencyStateFile), JsonOptions) ?? new(StringComparer.OrdinalIgnoreCase); }
        catch { return new(StringComparer.OrdinalIgnoreCase); }
    }

    private void WriteEfficiencyStates(Dictionary<string, string> states)
    {
        Directory.CreateDirectory(paths.DataDirectory);
        var temp = paths.ProcessEfficiencyStateFile + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(states, JsonOptions));
        File.Move(temp, paths.ProcessEfficiencyStateFile, true);
    }

    private static string IdentityKey(ProcessActionSnapshot snapshot) => $"{snapshot.ProcessId}:{snapshot.StartedAtUtc:O}:{snapshot.ExecutablePath}";

    private static RestartRequest ParseRestart(JsonElement payload)
    {
        var names = RequiredObject(payload, ["processId", "expectedPath", "expectedStartedAtUtc", "timeoutSeconds"]);
        _ = names;
        if (!payload.GetProperty("processId").TryGetInt32(out var processId) || processId <= 0) throw new InvalidDataException("processId is invalid.");
        var path = RequiredString(payload, "expectedPath");
        if (!WindowsProcessTerminator.TryNormalizeExecutablePath(path, out path)) throw new InvalidDataException("expectedPath is invalid.");
        if (!DateTimeOffset.TryParse(RequiredString(payload, "expectedStartedAtUtc"), out var started)) throw new InvalidDataException("expectedStartedAtUtc is invalid.");
        if (!payload.GetProperty("timeoutSeconds").TryGetInt32(out var timeout) || timeout is < 1 or > 120) throw new InvalidDataException("timeoutSeconds is invalid.");
        return new(processId, path, started.ToUniversalTime(), timeout);
    }

    private static EfficiencyRequest ParseEfficiency(JsonElement payload)
    {
        var names = RequiredObject(payload, ["processId", "expectedPath", "expectedStartedAtUtc", "enabled"]);
        _ = names;
        if (!payload.GetProperty("processId").TryGetInt32(out var processId) || processId <= 0) throw new InvalidDataException("processId is invalid.");
        var path = RequiredString(payload, "expectedPath");
        if (!WindowsProcessTerminator.TryNormalizeExecutablePath(path, out path)) throw new InvalidDataException("expectedPath is invalid.");
        if (!DateTimeOffset.TryParse(RequiredString(payload, "expectedStartedAtUtc"), out var started)) throw new InvalidDataException("expectedStartedAtUtc is invalid.");
        var enabledElement = payload.GetProperty("enabled");
        if (enabledElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new InvalidDataException("enabled is invalid.");
        return new(processId, path, started.ToUniversalTime(), enabledElement.GetBoolean());
    }

    private static string[] RequiredObject(JsonElement payload, string[] required)
    {
        if (payload.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Payload must be an object.");
        var names = payload.EnumerateObject().Select(item => item.Name).ToArray();
        if (names.Length != required.Length || names.Distinct(StringComparer.Ordinal).Count() != names.Length || !required.All(names.Contains)) throw new InvalidDataException("Payload fields are invalid.");
        return names;
    }
    private static string RequiredString(JsonElement payload, string name) => payload.GetProperty(name).ValueKind == JsonValueKind.String ? payload.GetProperty(name).GetString() ?? "" : throw new InvalidDataException($"{name} is invalid.");
    private static string Sanitize(string value) => new(value.Where(character => character >= 32 && character != 127).Take(512).ToArray());

    private static ExecutionResult RestartSuccess(ProcessRestartIntent intent, long started) => new("success", JsonSerializer.Serialize(new
    {
        originalProcessId = intent.OriginalProcessId, newProcessId = intent.NewProcessId, expectedPath = intent.ExpectedPath,
        expectedStartedAtUtc = intent.ExpectedStartedAtUtc, sessionId = intent.SessionId, phase = "verified",
        stopped = true, started = true, durationMs = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds, error = (string?)null,
    }), null);
    private static ExecutionResult RestartFailed(RestartRequest? request, string error, long started, bool stopped = false, int? newProcessId = null, uint? sessionId = null) => new("failed", JsonSerializer.Serialize(new
    {
        originalProcessId = request?.ProcessId ?? 1, newProcessId, expectedPath = request?.ExpectedPath ?? "unknown",
        expectedStartedAtUtc = request?.ExpectedStartedAtUtc ?? DateTimeOffset.UnixEpoch, sessionId, phase = "failed",
        stopped, started = newProcessId is not null, durationMs = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds, error = Sanitize(error),
    }), null);
    private static ExecutionResult EfficiencyFailed(EfficiencyRequest? request, string error, long started) => new("failed", JsonSerializer.Serialize(new
    {
        processId = request?.ProcessId ?? 1, expectedPath = request?.ExpectedPath ?? "unknown",
        expectedStartedAtUtc = request?.ExpectedStartedAtUtc ?? DateTimeOffset.UnixEpoch, requestedEnabled = request?.Enabled ?? false,
        initialEnabled = (bool?)null, finalEnabled = (bool?)null, originalPriority = (string?)null, finalPriority = (string?)null,
        priorityRestored = false, durationMs = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds, error = Sanitize(error),
    }), null);

    private sealed record RestartRequest(int ProcessId, string ExpectedPath, DateTimeOffset ExpectedStartedAtUtc, int TimeoutSeconds);
    private sealed record EfficiencyRequest(int ProcessId, string ExpectedPath, DateTimeOffset ExpectedStartedAtUtc, bool Enabled);
}

public sealed class ProcessRestartIntent
{
    public int Version { get; init; } = 1;
    public required string CommandId { get; init; }
    public required int OriginalProcessId { get; init; }
    public required string ExpectedPath { get; init; }
    public required DateTimeOffset ExpectedStartedAtUtc { get; init; }
    public required uint SessionId { get; init; }
    public required string[] Arguments { get; init; }
    public required int TimeoutSeconds { get; init; }
    public required string Phase { get; set; }
    public int? NewProcessId { get; set; }
}

internal static class WindowsProcessActionNativeMethods
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint ProcessSetInformation = 0x0200;
    private const int ProcessCommandLineInformation = 60;
    private const int ProcessPowerThrottling = 4;
    private const uint ExecutionSpeed = 0x1;
    private const uint IdlePriorityClass = 0x40;

    [StructLayout(LayoutKind.Sequential)] private struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] private struct PowerThrottlingState { public uint Version; public uint ControlMask; public uint StateMask; }

    internal static string? TryReadCommandLine(int processId)
    {
        var process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (process == IntPtr.Zero) return null;
        try
        {
            _ = NtQueryInformationProcess(process, ProcessCommandLineInformation, IntPtr.Zero, 0, out var needed);
            if (needed <= 0 || needed > 1_048_576) return null;
            var buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (NtQueryInformationProcess(process, ProcessCommandLineInformation, buffer, needed, out _) < 0) return null;
                var value = Marshal.PtrToStructure<UnicodeString>(buffer);
                return value.Buffer == IntPtr.Zero || value.Length == 0 ? null : Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { CloseHandle(process); }
    }

    internal static bool? TryReadEfficiency(int processId, out bool canSet)
    {
        canSet = false;
        var process = OpenProcess(ProcessQueryLimitedInformation | ProcessSetInformation, false, processId);
        if (process == IntPtr.Zero) process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        else canSet = true;
        if (process == IntPtr.Zero) return null;
        try
        {
            var state = new PowerThrottlingState { Version = 1 };
            if (!GetProcessInformation(process, ProcessPowerThrottling, ref state, Marshal.SizeOf<PowerThrottlingState>())) return null;
            return (state.ControlMask & ExecutionSpeed) != 0 && (state.StateMask & ExecutionSpeed) != 0;
        }
        finally { CloseHandle(process); }
    }

    internal static EfficiencyMutationResult SetEfficiency(int processId, bool enabled, string? restorePriority)
    {
        var process = OpenProcess(ProcessQueryLimitedInformation | ProcessSetInformation, false, processId);
        if (process == IntPtr.Zero) return new(null, null, null, null, false, Marshal.GetLastWin32Error());
        try
        {
            var initialState = new PowerThrottlingState { Version = 1 };
            if (!GetProcessInformation(process, ProcessPowerThrottling, ref initialState, Marshal.SizeOf<PowerThrottlingState>())) return new(null, null, null, null, false, Marshal.GetLastWin32Error());
            var initialEnabled = (initialState.ControlMask & ExecutionSpeed) != 0 && (initialState.StateMask & ExecutionSpeed) != 0;
            var initialPriority = PriorityName(GetPriorityClass(process));
            if (enabled && !SetPriorityClass(process, IdlePriorityClass)) return new(initialEnabled, initialEnabled, initialPriority, initialPriority, false, Marshal.GetLastWin32Error());
            var desired = new PowerThrottlingState { Version = 1, ControlMask = ExecutionSpeed, StateMask = enabled ? ExecutionSpeed : 0 };
            if (!SetProcessInformation(process, ProcessPowerThrottling, ref desired, Marshal.SizeOf<PowerThrottlingState>()))
            {
                var error = Marshal.GetLastWin32Error();
                if (enabled) _ = SetPriorityClass(process, PriorityValue(initialPriority));
                return new(initialEnabled, initialEnabled, initialPriority, initialPriority, false, error);
            }
            var restored = false;
            if (!enabled && restorePriority is not null)
            {
                restored = SetPriorityClass(process, PriorityValue(restorePriority));
                if (!restored)
                {
                    var error = Marshal.GetLastWin32Error();
                    var rollback = new PowerThrottlingState { Version = 1, ControlMask = ExecutionSpeed, StateMask = ExecutionSpeed };
                    _ = SetProcessInformation(process, ProcessPowerThrottling, ref rollback, Marshal.SizeOf<PowerThrottlingState>());
                    return new(initialEnabled, initialEnabled, initialPriority, initialPriority, false, error);
                }
            }
            var finalState = new PowerThrottlingState { Version = 1 };
            var finalEnabled = GetProcessInformation(process, ProcessPowerThrottling, ref finalState, Marshal.SizeOf<PowerThrottlingState>())
                ? (finalState.ControlMask & ExecutionSpeed) != 0 && (finalState.StateMask & ExecutionSpeed) != 0 : (bool?)null;
            return new(initialEnabled, finalEnabled, initialPriority, PriorityName(GetPriorityClass(process)), restored, 0);
        }
        finally { CloseHandle(process); }
    }

    private static string? PriorityName(uint value) => value switch { 0x40 => "idle", 0x4000 => "below-normal", 0x20 => "normal", 0x8000 => "above-normal", 0x80 => "high", 0x100 => "real-time", _ => null };
    private static uint PriorityValue(string? value) => value switch { "idle" => 0x40, "below-normal" => 0x4000, "above-normal" => 0x8000, "high" => 0x80, "real-time" => 0x100, _ => 0x20 };

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process, int processInformationClass, IntPtr processInformation, int processInformationLength, out int returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetProcessInformation(IntPtr process, int informationClass, ref PowerThrottlingState information, int size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetProcessInformation(IntPtr process, int informationClass, ref PowerThrottlingState information, int size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetPriorityClass(IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetPriorityClass(IntPtr process, uint priorityClass);
}
