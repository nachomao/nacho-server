using System.Buffers;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Microsoft.Win32;

namespace Nacho.Agent;

public interface IBootIdentityProvider
{
    string GetCurrentBootId();
}

public interface IWindowsRestartController
{
    bool IsSupported { get; }
    void RequestRestart(int delaySeconds, string? reason);
}

public sealed class WindowsBootIdentityProvider : IBootIdentityProvider
{
    private const string BootIdKey = @"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters";

    public string GetCurrentBootId()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(BootIdKey, writable: false);
            var value = key?.GetValue("BootId");
            if (value is int signed) return $"registry:{unchecked((uint)signed).ToString(CultureInfo.InvariantCulture)}";
            if (value is uint unsigned) return $"registry:{unsigned.ToString(CultureInfo.InvariantCulture)}";
        }
        catch (Exception ex) when (ex is SecurityException or UnauthorizedAccessException or IOException)
        {
            // Fall through to the native boot timestamp.
        }

        var info = new SystemTimeOfDayInformation();
        var status = NtQuerySystemInformation(3, ref info, Marshal.SizeOf<SystemTimeOfDayInformation>(), out _);
        if (status != 0 || info.BootTime <= 0) throw new InvalidOperationException("Windows boot identity is unavailable.");
        return $"native:{info.BootTime.ToString(CultureInfo.InvariantCulture)}";
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SystemTimeOfDayInformation
    {
        public long BootTime;
        public long CurrentTime;
        public long TimeZoneBias;
        public uint TimeZoneId;
        public uint Reserved;
        public ulong BootTimeBias;
        public ulong SleepTimeBias;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(
        int informationClass,
        ref SystemTimeOfDayInformation information,
        int informationLength,
        out int returnLength);
}

public sealed class WindowsRestartController : IWindowsRestartController
{
    private const uint TokenQuery = 0x0008;
    private const uint TokenAdjustPrivileges = 0x0020;
    private const uint SePrivilegeEnabled = 0x00000002;
    private const int ErrorNotAllAssigned = 1300;
    private const uint ShutdownReason = 0x80040001; // Planned application maintenance.

    public bool IsSupported => OperatingSystem.IsWindows();

    public void RequestRestart(int delaySeconds, string? reason)
    {
        if (!IsSupported) throw new PlatformNotSupportedException();
        if (!NativeMethods.OpenProcessToken(
                Process.GetCurrentProcess().Handle,
                TokenQuery | TokenAdjustPrivileges,
                out var token))
            throw new Win32Exception(Marshal.GetLastPInvokeError());

        try
        {
            if (!NativeMethods.LookupPrivilegeValueW(null, "SeShutdownPrivilege", out var luid))
                throw new Win32Exception(Marshal.GetLastPInvokeError());

            var requested = new TokenPrivileges
            {
                PrivilegeCount = 1,
                Luid = luid,
                Attributes = SePrivilegeEnabled,
            };
            if (!NativeMethods.AdjustTokenPrivileges(
                    token,
                    false,
                    ref requested,
                    Marshal.SizeOf<TokenPrivileges>(),
                    out var previous,
                    out _))
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            var privilegeError = Marshal.GetLastPInvokeError();
            if (privilegeError == ErrorNotAllAssigned) throw new UnauthorizedAccessException("Shutdown privilege is unavailable.");

            try
            {
                if (!NativeMethods.InitiateSystemShutdownExW(
                        null,
                        reason,
                        checked((uint)delaySeconds),
                        false,
                        true,
                        ShutdownReason))
                    throw new Win32Exception(Marshal.GetLastPInvokeError());
            }
            finally
            {
                _ = NativeMethods.AdjustTokenPrivileges(
                    token,
                    false,
                    ref previous,
                    0,
                    out _,
                    out _);
            }
        }
        finally
        {
            _ = NativeMethods.CloseHandle(token);
        }
    }
}

public sealed class SystemRestartManager(
    IOptions<AgentOptions> options,
    AgentPaths paths,
    IBootIdentityProvider bootIdentity,
    IWindowsRestartController restartController)
{
    private static readonly TimeSpan VerificationGrace = TimeSpan.FromSeconds(120);
    private readonly AgentOptions _options = options.Value;
    private readonly SemaphoreSlim _fileGate = new(1, 1);
    private readonly object _reservationGate = new();
    private string? _reservedCommandId;

    public bool TryReserve(string commandId)
    {
        lock (_reservationGate)
        {
            if (_reservedCommandId is null)
            {
                _reservedCommandId = commandId;
                return true;
            }
            return string.Equals(_reservedCommandId, commandId, StringComparison.Ordinal);
        }
    }

    public void Release(string commandId)
    {
        lock (_reservationGate)
        {
            if (string.Equals(_reservedCommandId, commandId, StringComparison.Ordinal)) _reservedCommandId = null;
        }
    }

    public async Task<string?> GetPersistedCommandIdAsync(CancellationToken cancellationToken)
    {
        var intent = await LoadAsync(cancellationToken);
        return intent?.CommandId;
    }

    public async Task<ExecutionResult> ExecuteAsync(
        string commandId,
        JsonElement payload,
        Func<string, CancellationToken, Task> reportRequested,
        CancellationToken cancellationToken)
    {
        var validation = Validate(payload);
        if (validation.Error is not null) return Failed(validation.DelaySeconds, validation.Reason, null, null, null, validation.Error);
        if (!_options.DisableAllPolicies && !_options.AllowSystemRestart)
            return Failed(validation.DelaySeconds, validation.Reason, null, null, null, "System restart is disabled by local policy.");
        if (!restartController.IsSupported)
            return Failed(validation.DelaySeconds, validation.Reason, null, null, null, "System restart is supported only on Windows.");

        string previousBootId;
        try { previousBootId = bootIdentity.GetCurrentBootId(); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return Failed(validation.DelaySeconds, validation.Reason, null, null, null, "System boot identity is unavailable.");
        }

        var requestedAt = DateTimeOffset.UtcNow;
        var intent = new RestartIntent
        {
            CommandId = commandId,
            RequestedAt = requestedAt,
            ExpiresAt = requestedAt.AddSeconds(validation.DelaySeconds!.Value).Add(VerificationGrace),
            PreviousBootId = previousBootId,
            DelaySeconds = validation.DelaySeconds.Value,
            Reason = validation.Reason,
            Phase = "prepared",
        };

        try
        {
            await SaveAsync(intent, cancellationToken);
            intent.Phase = "requested";
            await SaveAsync(intent, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return Failed(intent.DelaySeconds, intent.Reason, requestedAt, previousBootId, previousBootId, "Restart intent could not be persisted.");
        }

        try
        {
            restartController.RequestRestart(intent.DelaySeconds, intent.Reason);
        }
        catch (Exception ex) when (ex is Win32Exception or UnauthorizedAccessException or PlatformNotSupportedException or SystemException)
        {
            return await MarkFailedAsync(intent, "Windows restart request was rejected.", cancellationToken);
        }

        await reportRequested(ResultJson(intent, previousBootId, false, null), cancellationToken);
        return await WaitForVerificationDeadlineAsync(intent, cancellationToken);
    }

    public async Task<ExecutionResult> ResumeAsync(
        string commandId,
        JsonElement payload,
        Func<string, CancellationToken, Task> reportRequested,
        CancellationToken cancellationToken)
    {
        RestartIntent? intent;
        try { intent = await LoadAsync(cancellationToken); }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or IOException)
        {
            return FailedFromPayload(payload, "Restart intent state is invalid.");
        }

        if (intent is null || !string.Equals(intent.CommandId, commandId, StringComparison.Ordinal))
            return FailedFromPayload(payload, "Restart intent state is missing or does not match the command.");
        if (intent.Version != 1)
            return await MarkFailedAsync(intent, "Restart intent version is unsupported.", cancellationToken);
        if (intent.Phase == "verified")
            return new ExecutionResult("success", ResultJson(intent, intent.CurrentBootId, true, null), null);
        if (intent.Phase == "failed")
            return new ExecutionResult("failed", ResultJson(intent, intent.CurrentBootId, false, intent.Error ?? "Restart verification failed."), null);
        if (intent.Phase == "prepared")
            return await MarkFailedAsync(intent, "Restart request was interrupted before the system API call.", cancellationToken);
        if (intent.Phase != "requested")
            return await MarkFailedAsync(intent, "Restart intent phase is invalid.", cancellationToken);

        string currentBootId;
        try { currentBootId = bootIdentity.GetCurrentBootId(); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return await MarkFailedAsync(intent, "System boot identity is unavailable.", cancellationToken);
        }

        if (!string.Equals(currentBootId, intent.PreviousBootId, StringComparison.Ordinal))
        {
            intent.CurrentBootId = currentBootId;
            intent.Phase = "verified";
            intent.Error = null;
            await SaveAsync(intent, cancellationToken);
            return new ExecutionResult("success", ResultJson(intent, currentBootId, true, null), null);
        }
        if (DateTimeOffset.UtcNow >= intent.ExpiresAt)
            return await MarkFailedAsync(intent, "System restart was not observed before the verification deadline.", cancellationToken);

        await reportRequested(ResultJson(intent, currentBootId, false, null), cancellationToken);
        return await WaitForVerificationDeadlineAsync(intent, cancellationToken);
    }

    public static string ErrorJson(JsonElement payload, string error) => FailedFromPayload(payload, error).Result;

    private async Task<ExecutionResult> WaitForVerificationDeadlineAsync(RestartIntent intent, CancellationToken cancellationToken)
    {
        var delay = intent.ExpiresAt - DateTimeOffset.UtcNow;
        if (delay > TimeSpan.Zero) await Task.Delay(delay, cancellationToken);

        string? currentBootId = null;
        try { currentBootId = bootIdentity.GetCurrentBootId(); }
        catch (Exception ex) when (ex is not OperationCanceledException) { }
        if (currentBootId is not null && !string.Equals(currentBootId, intent.PreviousBootId, StringComparison.Ordinal))
        {
            intent.CurrentBootId = currentBootId;
            intent.Phase = "verified";
            intent.Error = null;
            await SaveAsync(intent, cancellationToken);
            return new ExecutionResult("success", ResultJson(intent, currentBootId, true, null), null);
        }
        return await MarkFailedAsync(intent, "System restart was not observed before the verification deadline.", cancellationToken);
    }

    private async Task<ExecutionResult> MarkFailedAsync(RestartIntent intent, string error, CancellationToken cancellationToken)
    {
        intent.Phase = "failed";
        intent.Error = error;
        try { intent.CurrentBootId = bootIdentity.GetCurrentBootId(); }
        catch { intent.CurrentBootId ??= intent.PreviousBootId; }
        try { await SaveAsync(intent, cancellationToken); }
        catch (Exception ex) when (ex is not OperationCanceledException) { }
        return new ExecutionResult("failed", ResultJson(intent, intent.CurrentBootId, false, error), null);
    }

    private async Task<RestartIntent?> LoadAsync(CancellationToken cancellationToken)
    {
        await _fileGate.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(paths.RestartIntentFile)) return null;
            await using var stream = File.OpenRead(paths.RestartIntentFile);
            var intent = await JsonSerializer.DeserializeAsync(stream, AgentJsonContext.Default.RestartIntent, cancellationToken);
            return intent ?? throw new InvalidDataException("Restart intent is empty.");
        }
        finally { _fileGate.Release(); }
    }

    private async Task SaveAsync(RestartIntent intent, CancellationToken cancellationToken)
    {
        await _fileGate.WaitAsync(cancellationToken);
        try
        {
            Directory.CreateDirectory(paths.DataDirectory);
            intent.UpdatedAt = DateTimeOffset.UtcNow;
            var temporary = paths.RestartIntentFile + ".tmp";
            await using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(stream, intent, AgentJsonContext.Default.RestartIntent, cancellationToken);
                await stream.FlushAsync(cancellationToken);
                stream.Flush(true);
            }
            File.Move(temporary, paths.RestartIntentFile, true);
        }
        finally { _fileGate.Release(); }
    }

    private static (int? DelaySeconds, string? Reason, string? Error) Validate(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) return (null, null, "Payload must be an object.");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in payload.EnumerateObject())
        {
            if (!seen.Add(property.Name) || property.Name is not ("delaySeconds" or "reason"))
                return (ReadDelay(payload), ReadReason(payload), "Payload contains an unsupported field.");
        }

        var delay = ReadDelay(payload);
        if (delay is null || delay < 0 || delay > 300)
            return (delay, ReadReason(payload), "delaySeconds must be an integer from 0 to 300.");

        if (!payload.TryGetProperty("reason", out var reasonElement) || reasonElement.ValueKind == JsonValueKind.Null)
            return (delay, null, null);
        if (reasonElement.ValueKind != JsonValueKind.String)
            return (delay, null, "reason must be a string.");
        var reason = reasonElement.GetString()?.Trim();
        if (string.IsNullOrEmpty(reason)) return (delay, null, null);
        if (!IsSafeReason(reason)) return (delay, SafeTruncate(reason), "reason must contain at most 256 printable characters.");
        return (delay, reason, null);
    }

    private static bool IsSafeReason(string reason)
    {
        var count = 0;
        var span = reason.AsSpan();
        while (!span.IsEmpty)
        {
            var status = Rune.DecodeFromUtf16(span, out var rune, out var consumed);
            if (status != OperationStatus.Done) return false;
            var category = Rune.GetUnicodeCategory(rune);
            if (category is UnicodeCategory.Control or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator) return false;
            count++;
            if (count > 256) return false;
            span = span[consumed..];
        }
        return true;
    }

    private static string SafeTruncate(string value)
    {
        var builder = new StringBuilder();
        var count = 0;
        foreach (var rune in value.EnumerateRunes())
        {
            var category = Rune.GetUnicodeCategory(rune);
            if (category is UnicodeCategory.Control or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator) continue;
            if (count++ >= 256) break;
            builder.Append(rune);
        }
        return builder.ToString();
    }

    private static int? ReadDelay(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty("delaySeconds", out var element) &&
        element.ValueKind == JsonValueKind.Number &&
        element.TryGetInt32(out var value)
            ? value
            : null;

    private static string? ReadReason(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty("reason", out var element) &&
        element.ValueKind == JsonValueKind.String
            ? SafeTruncate(element.GetString()?.Trim() ?? "") is { Length: > 0 } reason ? reason : null
            : null;

    private static ExecutionResult FailedFromPayload(JsonElement payload, string error) =>
        Failed(ReadDelay(payload), ReadReason(payload), null, null, null, error);

    private static ExecutionResult Failed(
        int? delaySeconds,
        string? reason,
        DateTimeOffset? requestedAt,
        string? previousBootId,
        string? currentBootId,
        string error) => new(
            "failed",
            JsonSerializer.Serialize(new
            {
                delaySeconds,
                reason,
                requestedAt = requestedAt?.ToString("O"),
                previousBootId,
                currentBootId,
                phase = "failed",
                durationMs = requestedAt.HasValue ? Math.Max(0L, (long)(DateTimeOffset.UtcNow - requestedAt.Value).TotalMilliseconds) : 0L,
                verifiedAfterRestart = false,
                error,
            }),
            null);

    private static string ResultJson(RestartIntent intent, string? currentBootId, bool verified, string? error) =>
        JsonSerializer.Serialize(new
        {
            delaySeconds = intent.DelaySeconds,
            reason = intent.Reason,
            requestedAt = intent.RequestedAt.ToString("O"),
            previousBootId = intent.PreviousBootId,
            currentBootId,
            phase = intent.Phase,
            durationMs = Math.Max(0L, (long)(DateTimeOffset.UtcNow - intent.RequestedAt).TotalMilliseconds),
            verifiedAfterRestart = verified,
            error,
        });
}

internal static class NativeMethods
{
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", EntryPoint = "LookupPrivilegeValueW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool LookupPrivilegeValueW(string? systemName, string name, out Luid luid);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AdjustTokenPrivileges(
        IntPtr tokenHandle,
        [MarshalAs(UnmanagedType.Bool)] bool disableAllPrivileges,
        ref TokenPrivileges newState,
        int bufferLength,
        out TokenPrivileges previousState,
        out int returnLength);

    [DllImport("advapi32.dll", EntryPoint = "InitiateSystemShutdownExW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool InitiateSystemShutdownExW(
        string? machineName,
        string? message,
        uint timeout,
        [MarshalAs(UnmanagedType.Bool)] bool forceAppsClosed,
        [MarshalAs(UnmanagedType.Bool)] bool rebootAfterShutdown,
        uint reason);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);

}

[StructLayout(LayoutKind.Sequential)]
internal struct Luid
{
    public uint LowPart;
    public int HighPart;
}

[StructLayout(LayoutKind.Sequential)]
internal struct TokenPrivileges
{
    public uint PrivilegeCount;
    public Luid Luid;
    public uint Attributes;
}
