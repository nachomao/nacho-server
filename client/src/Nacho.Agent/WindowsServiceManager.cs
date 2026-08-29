using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public interface IWindowsServiceController
{
    ServiceControllerStatus GetStatus(string serviceName);
    void Start(string serviceName);
    void Stop(string serviceName);
}

public sealed class WindowsServiceController : IWindowsServiceController
{
    public ServiceControllerStatus GetStatus(string serviceName)
    {
        using var service = new ServiceController(serviceName, ".");
        service.Refresh();
        return service.Status;
    }

    public void Start(string serviceName)
    {
        using var service = new ServiceController(serviceName, ".");
        service.Start();
    }

    public void Stop(string serviceName)
    {
        using var service = new ServiceController(serviceName, ".");
        service.Stop();
    }
}

public sealed record WindowsServiceSnapshot(
    string ServiceName,
    string DisplayName,
    ServiceControllerStatus Status,
    int? ProcessId);

public interface IWindowsServiceInventory
{
    IReadOnlyList<WindowsServiceSnapshot> List();
}

public sealed class WindowsServiceInventory : IWindowsServiceInventory
{
    public IReadOnlyList<WindowsServiceSnapshot> List()
    {
        var services = ServiceController.GetServices();
        try
        {
            return services.Select(service =>
            {
                try
                {
                    service.Refresh();
                    return new WindowsServiceSnapshot(
                        service.ServiceName,
                        service.DisplayName,
                        service.Status,
                        WindowsServiceNativeMethods.TryGetProcessId(service.ServiceName));
                }
                catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
                {
                    return new WindowsServiceSnapshot(service.ServiceName, service.DisplayName, service.Status, null);
                }
            }).ToArray();
        }
        finally
        {
            foreach (var service in services) service.Dispose();
        }
    }
}

public sealed record ProcessResourcePoint(TimeSpan TotalProcessorTime, long WorkingSetBytes, long PrivateMemoryBytes);

public interface IProcessResourceReader
{
    ProcessResourcePoint? Read(int processId);
}

public sealed class WindowsProcessResourceReader : IProcessResourceReader
{
    public ProcessResourcePoint? Read(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            process.Refresh();
            if (process.HasExited) return null;
            return new ProcessResourcePoint(process.TotalProcessorTime, process.WorkingSet64, process.PrivateMemorySize64);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or Win32Exception or NotSupportedException)
        {
            return null;
        }
    }
}

public sealed class WindowsServiceManager(
    IOptions<AgentOptions> options,
    IWindowsServiceController controller,
    IWindowsServiceInventory inventory,
    IProcessResourceReader processResources)
{
    private const int DefaultTimeoutSeconds = 30;
    private const int MaxTimeoutSeconds = 120;
    private const int ResourceSampleMilliseconds = 750;
    private const int MaximumListResultBytes = 480 * 1024;
    private const string AgentServiceName = "NachoAgent";
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(200);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly AgentOptions _options = options.Value;

    public async Task<ExecutionResult> ExecuteAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var started = Stopwatch.GetTimestamp();
        var serviceName = ReadString(payload, "serviceName");
        var action = ReadString(payload, "action");
        var initialStatus = "unknown";
        var finalStatus = "unknown";

        if (payload.ValueKind == JsonValueKind.Object && action == "list")
            return await ListAsync(cancellationToken);

        ExecutionResult Failed(string error, bool timedOut = false) => new(
            "failed",
            ResultJson(serviceName, action, initialStatus, finalStatus, started, timedOut, error),
            null);

        if (payload.ValueKind != JsonValueKind.Object || string.IsNullOrWhiteSpace(serviceName))
            return Failed("Payload must contain a serviceName.");
        if (action is not ("query" or "start" or "stop" or "restart"))
            return Failed("Action must be list, query, start, stop, or restart.");

        var mutatesService = action is "start" or "stop" or "restart";
        if (mutatesService && string.Equals(serviceName, AgentServiceName, StringComparison.OrdinalIgnoreCase))
            return Failed("The NachoAgent service cannot control itself.");
        if (mutatesService && !CanControl(serviceName))
            return Failed("Service is not in the local allowlist.");

        var timeoutSeconds = DefaultTimeoutSeconds;
        if (payload.TryGetProperty("timeoutSeconds", out var timeoutElement))
        {
            if (!timeoutElement.TryGetInt32(out timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MaxTimeoutSeconds)
                return Failed("timeoutSeconds must be an integer from 1 to 120.");
        }

        try
        {
            initialStatus = StatusName(controller.GetStatus(serviceName));
            finalStatus = initialStatus;
            if (action == "query")
                return Success(serviceName, action, initialStatus, finalStatus, started);

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
            try
            {
                switch (action)
                {
                    case "start":
                        if (initialStatus == "start-pending")
                        {
                            finalStatus = await WaitForStatusAsync(serviceName, ServiceControllerStatus.Running, timeoutCts.Token);
                        }
                        else if (initialStatus != "running")
                        {
                            if (initialStatus == "stop-pending")
                                await WaitForStatusAsync(serviceName, ServiceControllerStatus.Stopped, timeoutCts.Token);
                            controller.Start(serviceName);
                            finalStatus = await WaitForStatusAsync(serviceName, ServiceControllerStatus.Running, timeoutCts.Token);
                        }
                        break;
                    case "stop":
                        if (initialStatus == "stop-pending")
                        {
                            finalStatus = await WaitForStatusAsync(serviceName, ServiceControllerStatus.Stopped, timeoutCts.Token);
                        }
                        else if (initialStatus != "stopped")
                        {
                            if (initialStatus == "start-pending")
                                await WaitForStatusAsync(serviceName, ServiceControllerStatus.Running, timeoutCts.Token);
                            controller.Stop(serviceName);
                            finalStatus = await WaitForStatusAsync(serviceName, ServiceControllerStatus.Stopped, timeoutCts.Token);
                        }
                        break;
                    case "restart":
                        if (initialStatus != "stopped")
                        {
                            if (initialStatus == "stop-pending")
                            {
                                await WaitForStatusAsync(serviceName, ServiceControllerStatus.Stopped, timeoutCts.Token);
                            }
                            else
                            {
                                if (initialStatus == "start-pending")
                                    await WaitForStatusAsync(serviceName, ServiceControllerStatus.Running, timeoutCts.Token);
                                controller.Stop(serviceName);
                            }
                            await WaitForStatusAsync(serviceName, ServiceControllerStatus.Stopped, timeoutCts.Token);
                        }
                        controller.Start(serviceName);
                        finalStatus = await WaitForStatusAsync(serviceName, ServiceControllerStatus.Running, timeoutCts.Token);
                        break;
                }
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                finalStatus = TryGetStatus(serviceName, finalStatus);
                return Failed("Service operation timed out.", timedOut: true);
            }

            finalStatus = TryGetStatus(serviceName, finalStatus);
            return Success(serviceName, action, initialStatus, finalStatus, started);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (InvalidOperationException)
        {
            finalStatus = TryGetStatus(serviceName, finalStatus);
            return Failed("Service does not exist or is unavailable.");
        }
        catch (Exception ex) when (ex is Win32Exception or SystemException)
        {
            finalStatus = TryGetStatus(serviceName, finalStatus);
            return Failed("Windows service API operation failed.");
        }
    }

    private async Task<ExecutionResult> ListAsync(CancellationToken cancellationToken)
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            var services = inventory.List()
                .OrderBy(service => service.ServiceName, StringComparer.OrdinalIgnoreCase)
                .ThenBy(service => service.ServiceName, StringComparer.Ordinal)
                .ToArray();
            var processIds = services
                .Where(service => service.ProcessId is > 0)
                .Select(service => service.ProcessId!.Value)
                .Distinct()
                .ToArray();
            var sharedCounts = services
                .Where(service => service.ProcessId is > 0)
                .GroupBy(service => service.ProcessId!.Value)
                .ToDictionary(group => group.Key, group => group.Count());
            var before = processIds.ToDictionary(processId => processId, processResources.Read);
            await Task.Delay(ResourceSampleMilliseconds, cancellationToken);
            var elapsed = Stopwatch.GetElapsedTime(started);
            var after = processIds.ToDictionary(processId => processId, processResources.Read);

            var rows = services.Select(service =>
            {
                var processId = service.ProcessId is > 0 ? service.ProcessId : null;
                before.TryGetValue(processId ?? -1, out var first);
                after.TryGetValue(processId ?? -1, out var last);
                double? cpuPercent = null;
                if (first is not null && last is not null && elapsed.TotalMilliseconds > 0)
                {
                    var cpuMilliseconds = Math.Max(0, (last.TotalProcessorTime - first.TotalProcessorTime).TotalMilliseconds);
                    cpuPercent = Math.Round(Math.Clamp(
                        cpuMilliseconds / (elapsed.TotalMilliseconds * Math.Max(Environment.ProcessorCount, 1)) * 100,
                        0,
                        100), 2);
                }

                var canControl = CanControl(service.ServiceName) &&
                    !string.Equals(service.ServiceName, AgentServiceName, StringComparison.OrdinalIgnoreCase);
                var restriction = canControl
                    ? null
                    : string.Equals(service.ServiceName, AgentServiceName, StringComparison.OrdinalIgnoreCase)
                        ? "agent-self"
                        : "not-allowlisted";
                var sharedServiceCount = processId is int id && sharedCounts.TryGetValue(id, out var count) ? count : 0;
                return new ServiceListItem(
                    service.ServiceName,
                    service.DisplayName,
                    StatusName(service.Status),
                    processId,
                    canControl,
                    restriction,
                    sharedServiceCount > 1,
                    sharedServiceCount,
                    last is null ? null : new ServiceResources(cpuPercent, last.WorkingSetBytes, last.PrivateMemoryBytes));
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
            return new ExecutionResult("failed", ListErrorJson("Windows service inventory operation failed."), null);
        }
    }

    private string SerializeList(ServiceListItem[] rows, int count, bool truncated, TimeSpan elapsed) =>
        JsonSerializer.Serialize(new ServiceListResult(
            "list",
            DateTimeOffset.UtcNow,
            (long)elapsed.TotalMilliseconds,
            rows.Length,
            count,
            truncated,
            rows.Take(count).ToArray(),
            null), JsonOptions);

    // 服务变更始终要求独立允许列表，避免全局策略开关扩大系统服务控制范围。
    private bool CanControl(string serviceName) => (_options.AllowedServices ?? []).Any(item =>
        !string.IsNullOrWhiteSpace(item) && string.Equals(item, serviceName, StringComparison.OrdinalIgnoreCase));

    private async Task<string> WaitForStatusAsync(
        string serviceName,
        ServiceControllerStatus target,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            var current = controller.GetStatus(serviceName);
            if (current == target) return StatusName(current);
            await Task.Delay(PollInterval, cancellationToken);
        }
    }

    private string TryGetStatus(string serviceName, string fallback)
    {
        try { return StatusName(controller.GetStatus(serviceName)); }
        catch { return fallback; }
    }

    private static ExecutionResult Success(
        string serviceName,
        string action,
        string initialStatus,
        string finalStatus,
        long started) => new(
            "success",
            ResultJson(serviceName, action, initialStatus, finalStatus, started, false, null),
            null);

    public static string ErrorJson(JsonElement payload, string error)
    {
        var action = ReadString(payload, "action");
        return action == "list"
            ? ListErrorJson(error)
            : ErrorJson(ReadString(payload, "serviceName"), action, error);
    }

    public static string ErrorJson(string serviceName, string action, string error) => JsonSerializer.Serialize(new
    {
        serviceName,
        action,
        initialStatus = "unknown",
        finalStatus = "unknown",
        durationMs = 0L,
        timedOut = false,
        error,
    });

    private static string ListErrorJson(string error) => JsonSerializer.Serialize(new ServiceListResult(
        "list",
        DateTimeOffset.UtcNow,
        0,
        0,
        0,
        false,
        [],
        error), JsonOptions);

    private static string ResultJson(
        string serviceName,
        string action,
        string initialStatus,
        string finalStatus,
        long started,
        bool timedOut,
        string? error) => JsonSerializer.Serialize(new
        {
            serviceName,
            action,
            initialStatus,
            finalStatus,
            durationMs = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds,
            timedOut,
            error,
        });

    private static string ReadString(JsonElement payload, string property) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty(property, out var element) &&
        element.ValueKind == JsonValueKind.String
            ? element.GetString()?.Trim() ?? ""
            : "";

    public static string StatusName(ServiceControllerStatus status) => status switch
    {
        ServiceControllerStatus.Stopped => "stopped",
        ServiceControllerStatus.StartPending => "start-pending",
        ServiceControllerStatus.StopPending => "stop-pending",
        ServiceControllerStatus.Running => "running",
        ServiceControllerStatus.ContinuePending => "continue-pending",
        ServiceControllerStatus.PausePending => "pause-pending",
        ServiceControllerStatus.Paused => "paused",
        _ => "unknown",
    };

    private sealed record ServiceResources(double? CpuPercent, long WorkingSetBytes, long PrivateMemoryBytes);
    private sealed record ServiceListItem(
        string ServiceName,
        string DisplayName,
        string Status,
        int? ProcessId,
        bool CanControl,
        string? ControlRestriction,
        bool SharedProcess,
        int SharedServiceCount,
        ServiceResources? Resources);
    private sealed record ServiceListResult(
        string Action,
        DateTimeOffset CapturedAtUtc,
        long SampleDurationMs,
        int Total,
        int Returned,
        bool Truncated,
        ServiceListItem[] Services,
        string? Error);
}

internal static class WindowsServiceNativeMethods
{
    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceQueryStatus = 0x0004;
    private const int ScStatusProcessInfo = 0;

    internal static int? TryGetProcessId(string serviceName)
    {
        var manager = OpenSCManager(null, null, ScManagerConnect);
        if (manager == IntPtr.Zero) return null;
        try
        {
            var service = OpenService(manager, serviceName, ServiceQueryStatus);
            if (service == IntPtr.Zero) return null;
            try
            {
                var status = new ServiceStatusProcess();
                var size = Marshal.SizeOf<ServiceStatusProcess>();
                return QueryServiceStatusEx(service, ScStatusProcessInfo, ref status, size, out _) && status.ProcessId > 0
                    ? checked((int)status.ProcessId)
                    : null;
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess
    {
        public uint ServiceType;
        public uint CurrentState;
        public uint ControlsAccepted;
        public uint Win32ExitCode;
        public uint ServiceSpecificExitCode;
        public uint CheckPoint;
        public uint WaitHint;
        public uint ProcessId;
        public uint ServiceFlags;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenSCManager(string? machineName, string? databaseName, uint desiredAccess);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenService(IntPtr manager, string serviceName, uint desiredAccess);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceStatusEx(
        IntPtr service,
        int infoLevel,
        ref ServiceStatusProcess buffer,
        int bufferSize,
        out int bytesNeeded);

    [DllImport("advapi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(IntPtr handle);
}
