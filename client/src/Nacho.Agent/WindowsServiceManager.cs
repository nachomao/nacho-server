using System.Diagnostics;
using System.ServiceProcess;
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

public sealed class WindowsServiceManager(
    IOptions<AgentOptions> options,
    IWindowsServiceController controller)
{
    private const int DefaultTimeoutSeconds = 30;
    private const int MaxTimeoutSeconds = 120;
    private const string AgentServiceName = "NachoAgent";
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(200);
    private readonly AgentOptions _options = options.Value;

    public async Task<ExecutionResult> ExecuteAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var started = Stopwatch.GetTimestamp();
        var serviceName = ReadString(payload, "serviceName");
        var action = ReadString(payload, "action");
        var initialStatus = "unknown";
        var finalStatus = "unknown";

        ExecutionResult Failed(string error, bool timedOut = false) => new(
            "failed",
            ResultJson(serviceName, action, initialStatus, finalStatus, started, timedOut, error),
            null);

        if (payload.ValueKind != JsonValueKind.Object || string.IsNullOrWhiteSpace(serviceName))
            return Failed("Payload must contain a serviceName.");
        if (string.Equals(serviceName, AgentServiceName, StringComparison.OrdinalIgnoreCase))
            return Failed("The NachoAgent service cannot control itself.");
        if (!_options.DisableAllPolicies && !(_options.AllowedServices ?? []).Any(item =>
                !string.IsNullOrWhiteSpace(item) && string.Equals(item, serviceName, StringComparison.OrdinalIgnoreCase)))
            return Failed("Service is not in the local allowlist.");
        if (action is not ("query" or "start" or "stop" or "restart"))
            return Failed("Action must be query, start, stop, or restart.");

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
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or SystemException)
        {
            finalStatus = TryGetStatus(serviceName, finalStatus);
            return Failed("Windows service API operation failed.");
        }
    }

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

    public static string ErrorJson(JsonElement payload, string error) => ErrorJson(
        ReadString(payload, "serviceName"),
        ReadString(payload, "action"),
        error);

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
}
