using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public sealed record ProcessIdentity(int ProcessId, DateTime StartTimeUtc, string ImagePath);

public interface IWindowsProcessHandle : IDisposable
{
    int ProcessId { get; }
    bool HasExited { get; }
    ProcessIdentity ReadIdentity();
    void Kill(bool entireProcessTree);
    Task WaitForExitAsync(CancellationToken cancellationToken);
}

public interface IWindowsProcessController
{
    int CurrentProcessId { get; }
    IWindowsProcessHandle Open(int processId);
}

public sealed class WindowsProcessController : IWindowsProcessController
{
    public int CurrentProcessId => Environment.ProcessId;

    public IWindowsProcessHandle Open(int processId) => new WindowsProcessHandle(Process.GetProcessById(processId));

    private sealed class WindowsProcessHandle : IWindowsProcessHandle
    {
        private readonly Process _process;

        public WindowsProcessHandle(Process process)
        {
            _process = process;
            _ = process.SafeHandle;
        }

        public int ProcessId => _process.Id;
        public bool HasExited => _process.HasExited;

        public ProcessIdentity ReadIdentity()
        {
            _process.Refresh();
            if (_process.HasExited) throw new InvalidOperationException("Process has exited.");
            var imagePath = _process.MainModule?.FileName;
            if (string.IsNullOrWhiteSpace(imagePath)) throw new InvalidOperationException("Process image path is unavailable.");
            return new ProcessIdentity(_process.Id, _process.StartTime.ToUniversalTime(), imagePath);
        }

        public void Kill(bool entireProcessTree) => _process.Kill(entireProcessTree);
        public Task WaitForExitAsync(CancellationToken cancellationToken) => _process.WaitForExitAsync(cancellationToken);
        public void Dispose() => _process.Dispose();
    }
}

public sealed class WindowsProcessTerminator(
    IOptions<AgentOptions> options,
    IWindowsProcessController controller)
{
    private const int DefaultTimeoutSeconds = 30;
    private const int MaxTimeoutSeconds = 120;
    private readonly AgentOptions _options = options.Value;

    public async Task<ExecutionResult> ExecuteAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var started = Stopwatch.GetTimestamp();
        var processId = ReadProcessId(payload);
        var expectedPath = ReadString(payload, "expectedPath");
        DateTimeOffset? expectedStartedAtUtc = null;
        string? actualPath = null;
        var killProcessTree = true;
        var initialStatus = "unknown";
        var finalStatus = "unknown";

        ExecutionResult Failed(string error, bool timedOut = false) => new(
            "failed",
            ResultJson(processId, expectedPath, actualPath, killProcessTree, initialStatus, finalStatus, started, timedOut, error),
            null);

        ExecutionResult Success() => new(
            "success",
            ResultJson(processId, expectedPath, actualPath, killProcessTree, initialStatus, "exited", started, false, null),
            null);

        if (payload.ValueKind != JsonValueKind.Object || processId is null || processId <= 0)
            return Failed("processId must be a positive integer.");
        if (processId == 4)
            return Failed("System process IDs cannot be terminated.");
        if (processId == controller.CurrentProcessId)
            return Failed("The NachoAgent process cannot terminate itself.");

        if (!TryNormalizeExecutablePath(expectedPath, out var normalizedExpectedPath))
            return Failed("expectedPath must be an absolute executable file path without wildcards.");
        expectedPath = normalizedExpectedPath;
        if (!IsAllowed(expectedPath))
            return Failed("Process path is not in the local allowlist.");

        if (payload.TryGetProperty("expectedStartedAtUtc", out var expectedStartedElement))
        {
            if (expectedStartedElement.ValueKind != JsonValueKind.String ||
                !DateTimeOffset.TryParse(expectedStartedElement.GetString(), out var parsedStartedAt))
                return Failed("expectedStartedAtUtc must be a valid timestamp.");
            expectedStartedAtUtc = parsedStartedAt.ToUniversalTime();
        }

        var timeoutSeconds = DefaultTimeoutSeconds;
        if (payload.TryGetProperty("timeoutSeconds", out var timeoutElement) &&
            (timeoutElement.ValueKind != JsonValueKind.Number ||
             !timeoutElement.TryGetInt32(out timeoutSeconds) ||
             timeoutSeconds < 1 || timeoutSeconds > MaxTimeoutSeconds))
            return Failed("timeoutSeconds must be an integer from 1 to 120.");

        if (payload.TryGetProperty("killProcessTree", out var treeElement))
        {
            if (treeElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return Failed("killProcessTree must be a boolean.");
            killProcessTree = treeElement.GetBoolean();
        }

        cancellationToken.ThrowIfCancellationRequested();

        IWindowsProcessHandle target;
        try
        {
            target = controller.Open(processId.Value);
        }
        catch (ArgumentException)
        {
            return Failed("Process does not exist.");
        }
        catch (InvalidOperationException)
        {
            return Failed("Process does not exist.");
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == 5)
        {
            return Failed("Process access was denied.");
        }
        catch (Exception ex) when (ex is Win32Exception or SystemException)
        {
            return Failed("Windows process API operation failed.");
        }

        using (target)
        {
            ProcessIdentity initialIdentity;
            try
            {
                if (target.HasExited) return Failed("Process exited before its identity could be confirmed.");
                initialIdentity = NormalizeIdentity(target.ReadIdentity());
                actualPath = initialIdentity.ImagePath;
            }
            catch (Win32Exception ex) when (ex.NativeErrorCode == 5)
            {
                return Failed("Process access was denied.");
            }
            catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
            {
                return Failed("Process exited before its identity could be confirmed.");
            }
            catch (Exception ex) when (ex is Win32Exception or SystemException)
            {
                return Failed("Windows process API operation failed.");
            }

            if (initialIdentity.ProcessId != processId.Value)
                return Failed("Process identity did not match the requested PID.");
            if (expectedStartedAtUtc is not null && initialIdentity.StartTimeUtc != expectedStartedAtUtc.Value.UtcDateTime)
                return Failed("Process start time did not match the inventory snapshot.");
            if (!string.Equals(initialIdentity.ImagePath, expectedPath, StringComparison.OrdinalIgnoreCase) || !IsAllowed(initialIdentity.ImagePath))
                return Failed("Process image path did not match the expected allowlisted path.");
            initialStatus = "running";
            finalStatus = "running";

            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (target.HasExited) return Success();
                var verifiedIdentity = NormalizeIdentity(target.ReadIdentity());
                actualPath = verifiedIdentity.ImagePath;
                if (verifiedIdentity.ProcessId != initialIdentity.ProcessId ||
                    verifiedIdentity.StartTimeUtc != initialIdentity.StartTimeUtc ||
                    !string.Equals(verifiedIdentity.ImagePath, initialIdentity.ImagePath, StringComparison.OrdinalIgnoreCase))
                    return Failed("Process identity changed before termination.");
                if (target.HasExited) return Success();
                target.Kill(killProcessTree);
            }
            catch (InvalidOperationException)
            {
                if (SafeHasExited(target)) return Success();
                return Failed("Process identity changed before termination.");
            }
            catch (Win32Exception ex) when (ex.NativeErrorCode == 5)
            {
                return Failed("Process access was denied.");
            }
            catch (Exception ex) when (ex is Win32Exception or SystemException)
            {
                return Failed("Windows process API operation failed.");
            }

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
            try
            {
                await target.WaitForExitAsync(timeoutCts.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                if (SafeHasExited(target)) return Success();
                finalStatus = "running";
                return Failed("Process termination timed out.", timedOut: true);
            }

            if (!SafeHasExited(target))
                return Failed("Process did not exit after termination was requested.");
            return Success();
        }
    }

    private bool IsAllowed(string fullPath) => _options.DisableAllPolicies || (_options.AllowedProcessPaths ?? []).Any(configuredPath =>
        TryNormalizeExecutablePath(configuredPath, out var normalized) &&
        string.Equals(normalized, fullPath, StringComparison.OrdinalIgnoreCase));

    private static ProcessIdentity NormalizeIdentity(ProcessIdentity identity)
    {
        if (!TryNormalizeExecutablePath(identity.ImagePath, out var normalized))
            throw new InvalidOperationException("Process image path is invalid.");
        return identity with { StartTimeUtc = identity.StartTimeUtc.ToUniversalTime(), ImagePath = normalized };
    }

    private static bool SafeHasExited(IWindowsProcessHandle target)
    {
        try { return target.HasExited; }
        catch { return false; }
    }

    internal static bool TryNormalizeExecutablePath(string? path, out string normalized)
    {
        normalized = "";
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || path.IndexOfAny(['*', '?']) >= 0)
            return false;
        try
        {
            normalized = Path.GetFullPath(path.Trim());
            var fileName = Path.GetFileName(normalized);
            return !string.IsNullOrWhiteSpace(fileName) &&
                !normalized.EndsWith(Path.DirectorySeparatorChar) &&
                !normalized.EndsWith(Path.AltDirectorySeparatorChar);
        }
        catch
        {
            normalized = "";
            return false;
        }
    }

    private static int? ReadProcessId(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty("processId", out var element) &&
        element.ValueKind == JsonValueKind.Number &&
        element.TryGetInt32(out var processId)
            ? processId
            : null;

    private static string ReadString(JsonElement payload, string property) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty(property, out var element) &&
        element.ValueKind == JsonValueKind.String
            ? element.GetString()?.Trim() ?? ""
            : "";

    public static string ErrorJson(JsonElement payload, string error) => JsonSerializer.Serialize(new
    {
        processId = ReadProcessId(payload) ?? 0,
        expectedPath = ReadString(payload, "expectedPath"),
        actualPath = (string?)null,
        killProcessTree = payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty("killProcessTree", out var treeElement) &&
            treeElement.ValueKind is JsonValueKind.True or JsonValueKind.False
                ? treeElement.GetBoolean()
                : true,
        initialStatus = "unknown",
        finalStatus = "unknown",
        durationMs = 0L,
        timedOut = false,
        error,
    });

    private static string ResultJson(
        int? processId,
        string expectedPath,
        string? actualPath,
        bool killProcessTree,
        string initialStatus,
        string finalStatus,
        long started,
        bool timedOut,
        string? error) => JsonSerializer.Serialize(new
        {
            processId = processId ?? 0,
            expectedPath,
            actualPath,
            killProcessTree,
            initialStatus,
            finalStatus,
            durationMs = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds,
            timedOut,
            error,
        });
}
