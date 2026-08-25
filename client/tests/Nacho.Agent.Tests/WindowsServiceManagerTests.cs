using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Nacho.Agent;

namespace Nacho.Agent.Tests;

public sealed class WindowsServiceManagerTests
{
    [Fact]
    public void Allowed_services_default_to_empty()
    {
        var options = new AgentOptions { ServerUrl = "http://127.0.0.1" };
        Assert.Empty(options.AllowedServices);
    }

    [Fact]
    public void Allowed_services_bind_from_agent_configuration()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ServerUrl"] = "http://127.0.0.1",
            ["AllowedServices:0"] = "Spooler",
            ["AllowedServices:1"] = "ExampleService",
        }).Build();

        var options = configuration.Get<AgentOptions>();
        Assert.NotNull(options);
        Assert.Equal(["Spooler", "ExampleService"], options!.AllowedServices);
    }

    [Fact]
    public async Task Allowlist_matching_is_case_insensitive()
    {
        var controller = new FakeServiceController(ServiceControllerStatus.Running);
        var result = await Create(["ExampleService"], controller)
            .ExecuteAsync(Payload("exampleservice", "query"), CancellationToken.None);

        Assert.Equal("success", result.Status);
        Assert.Equal("running", Result(result).GetProperty("finalStatus").GetString());
    }

    [Fact]
    public async Task Rejects_missing_service_name_and_non_allowlisted_mutation()
    {
        using var emptyPayload = JsonDocument.Parse("{}");
        var manager = Create(["ExampleService"], new FakeServiceController(ServiceControllerStatus.Running));

        var missing = await manager.ExecuteAsync(emptyPayload.RootElement, CancellationToken.None);
        var blocked = await manager.ExecuteAsync(Payload("OtherService", "stop"), CancellationToken.None);

        Assert.Equal("failed", missing.Status);
        Assert.Contains("serviceName", missing.Result);
        Assert.Equal("failed", blocked.Status);
        Assert.Contains("allowlist", blocked.Result);
    }

    [Fact]
    public async Task Rejects_self_service_even_when_allowlisted()
    {
        var result = await Create(["NachoAgent"], new FakeServiceController(ServiceControllerStatus.Running))
            .ExecuteAsync(Payload("nachoagent", "stop"), CancellationToken.None);

        Assert.Equal("failed", result.Status);
        Assert.Contains("cannot control itself", Result(result).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Query_is_read_only_for_non_allowlisted_services_and_agent_self()
    {
        var controller = new FakeServiceController(ServiceControllerStatus.Running);
        var manager = Create([], controller);

        var ordinary = await manager.ExecuteAsync(Payload("OtherService", "query"), CancellationToken.None);
        var agent = await manager.ExecuteAsync(Payload("NachoAgent", "query"), CancellationToken.None);

        Assert.Equal("success", ordinary.Status);
        Assert.Equal("success", agent.Status);
        Assert.Equal(0, controller.StartCalls + controller.StopCalls);
    }

    [Fact]
    public async Task Global_policy_bypass_does_not_bypass_the_service_allowlist()
    {
        var controller = new FakeServiceController(ServiceControllerStatus.Running);
        var manager = Create([], controller, disableAllPolicies: true);
        var result = await manager.ExecuteAsync(Payload("OtherService", "stop"), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains("allowlist", result.Result);
        Assert.Equal(0, controller.StopCalls);
    }

    [Fact]
    public async Task Lists_services_with_policy_shared_process_and_resource_snapshot()
    {
        var inventory = new FakeServiceInventory([
            new("AllowedService", "Allowed service", ServiceControllerStatus.Running, 42),
            new("ReadOnlyService", "Read only service", ServiceControllerStatus.Running, 42),
            new("NachoAgent", "Nacho Agent", ServiceControllerStatus.Running, 43),
            new("StoppedService", "Stopped service", ServiceControllerStatus.Stopped, null),
        ]);
        var resources = new FakeProcessResourceReader(new Dictionary<int, Queue<ProcessResourcePoint?>>
        {
            [42] = new([
                new ProcessResourcePoint(TimeSpan.FromMilliseconds(100), 1000, 800),
                new ProcessResourcePoint(TimeSpan.FromMilliseconds(200), 1200, 900),
            ]),
            [43] = new([
                new ProcessResourcePoint(TimeSpan.FromMilliseconds(50), 2000, 1500),
                new ProcessResourcePoint(TimeSpan.FromMilliseconds(50), 2100, 1600),
            ]),
        });
        var manager = Create(["AllowedService"], new FakeServiceController(ServiceControllerStatus.Running), inventory, resources);

        var result = await manager.ExecuteAsync(Payload("list"), CancellationToken.None);
        var json = Result(result);
        var rows = json.GetProperty("services").EnumerateArray().ToDictionary(row => row.GetProperty("serviceName").GetString()!);

        Assert.Equal("success", result.Status);
        Assert.Equal(4, json.GetProperty("total").GetInt32());
        Assert.False(json.GetProperty("truncated").GetBoolean());
        Assert.True(rows["AllowedService"].GetProperty("canControl").GetBoolean());
        Assert.True(rows["AllowedService"].GetProperty("sharedProcess").GetBoolean());
        Assert.Equal(2, rows["AllowedService"].GetProperty("sharedServiceCount").GetInt32());
        Assert.Equal(1200, rows["AllowedService"].GetProperty("resources").GetProperty("workingSetBytes").GetInt64());
        Assert.False(rows["ReadOnlyService"].GetProperty("canControl").GetBoolean());
        Assert.Equal("not-allowlisted", rows["ReadOnlyService"].GetProperty("controlRestriction").GetString());
        Assert.Equal("agent-self", rows["NachoAgent"].GetProperty("controlRestriction").GetString());
        Assert.Equal(JsonValueKind.Null, rows["StoppedService"].GetProperty("resources").ValueKind);
    }

    [Fact]
    public async Task List_result_is_utf8_bounded_and_reports_truncation()
    {
        var services = Enumerable.Range(0, 5000)
            .Select(index => new WindowsServiceSnapshot($"Service{index:D5}", new string('服', 240), ServiceControllerStatus.Stopped, null))
            .ToArray();
        var manager = Create([], new FakeServiceController(ServiceControllerStatus.Stopped), new FakeServiceInventory(services));

        var result = await manager.ExecuteAsync(Payload("list"), CancellationToken.None);
        var json = Result(result);

        Assert.Equal("success", result.Status);
        Assert.True(json.GetProperty("truncated").GetBoolean());
        Assert.Equal(5000, json.GetProperty("total").GetInt32());
        Assert.True(json.GetProperty("returned").GetInt32() < 5000);
        Assert.True(Encoding.UTF8.GetByteCount(result.Result) <= 480 * 1024);
    }

    [Fact]
    public void Restart_recovery_returns_list_shaped_failure()
    {
        var result = Result(new ExecutionResult("failed", WindowsServiceManager.ErrorJson(Payload("list"), "restarted"), null));
        Assert.Equal("list", result.GetProperty("action").GetString());
        Assert.Empty(result.GetProperty("services").EnumerateArray());
        Assert.Equal("restarted", result.GetProperty("error").GetString());
    }

    [Theory]
    [InlineData("pause")]
    [InlineData("")]
    public async Task Rejects_invalid_actions(string action)
    {
        var result = await Create(["ExampleService"], new FakeServiceController(ServiceControllerStatus.Running))
            .ExecuteAsync(Payload("ExampleService", action), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains("Action", result.Result);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(121)]
    public async Task Rejects_invalid_timeouts(int timeoutSeconds)
    {
        var result = await Create(["ExampleService"], new FakeServiceController(ServiceControllerStatus.Running))
            .ExecuteAsync(Payload("ExampleService", "query", timeoutSeconds), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains("1 to 120", result.Result);
    }

    [Fact]
    public async Task Reports_a_missing_service_without_system_details()
    {
        var controller = new FakeServiceController(ServiceControllerStatus.Stopped) { Missing = true };
        var result = await Create(["ExampleService"], controller)
            .ExecuteAsync(Payload("ExampleService", "query"), CancellationToken.None);

        Assert.Equal("failed", result.Status);
        Assert.Equal("Service does not exist or is unavailable.", Result(result).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Sanitizes_windows_api_errors()
    {
        var controller = new FakeServiceController(ServiceControllerStatus.Stopped) { AccessDenied = true };
        var result = await Create(["ExampleService"], controller)
            .ExecuteAsync(Payload("ExampleService", "query"), CancellationToken.None);

        Assert.Equal("failed", result.Status);
        Assert.Equal("Windows service API operation failed.", Result(result).GetProperty("error").GetString());
        Assert.DoesNotContain("Sensitive", result.Result);
    }

    [Theory]
    [InlineData("start", ServiceControllerStatus.Running)]
    [InlineData("stop", ServiceControllerStatus.Stopped)]
    public async Task Target_state_is_idempotent(string action, ServiceControllerStatus initial)
    {
        var controller = new FakeServiceController(initial);
        var result = await Create(["ExampleService"], controller)
            .ExecuteAsync(Payload("ExampleService", action), CancellationToken.None);

        Assert.Equal("success", result.Status);
        Assert.Equal(0, controller.StartCalls + controller.StopCalls);
    }

    [Theory]
    [InlineData("start", ServiceControllerStatus.Stopped, "running", 1, 0)]
    [InlineData("stop", ServiceControllerStatus.Running, "stopped", 0, 1)]
    [InlineData("restart", ServiceControllerStatus.Running, "running", 1, 1)]
    [InlineData("restart", ServiceControllerStatus.Stopped, "running", 1, 0)]
    public async Task Executes_service_state_transitions(
        string action,
        ServiceControllerStatus initial,
        string expectedFinal,
        int starts,
        int stops)
    {
        var controller = new FakeServiceController(initial);
        var result = await Create(["ExampleService"], controller)
            .ExecuteAsync(Payload("ExampleService", action), CancellationToken.None);

        Assert.Equal("success", result.Status);
        Assert.Equal(expectedFinal, Result(result).GetProperty("finalStatus").GetString());
        Assert.Equal(starts, controller.StartCalls);
        Assert.Equal(stops, controller.StopCalls);
    }

    [Fact]
    public async Task Marks_a_stalled_operation_as_timed_out()
    {
        var controller = new FakeServiceController(ServiceControllerStatus.Stopped) { CompleteTransitions = false };
        var result = await Create(["ExampleService"], controller)
            .ExecuteAsync(Payload("ExampleService", "start", 1), CancellationToken.None);

        Assert.Equal("failed", result.Status);
        Assert.True(Result(result).GetProperty("timedOut").GetBoolean());
        Assert.Null(result.ExitCode);
    }

    [Fact]
    public async Task Propagates_host_cancellation()
    {
        var controller = new FakeServiceController(ServiceControllerStatus.Stopped) { CompleteTransitions = false };
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Create(["ExampleService"], controller)
            .ExecuteAsync(Payload("ExampleService", "start", 10), cancellation.Token));
    }

    [Theory]
    [InlineData(ServiceControllerStatus.Stopped, "stopped")]
    [InlineData(ServiceControllerStatus.StartPending, "start-pending")]
    [InlineData(ServiceControllerStatus.StopPending, "stop-pending")]
    [InlineData(ServiceControllerStatus.Running, "running")]
    [InlineData(ServiceControllerStatus.ContinuePending, "continue-pending")]
    [InlineData(ServiceControllerStatus.PausePending, "pause-pending")]
    [InlineData(ServiceControllerStatus.Paused, "paused")]
    public void Maps_all_service_statuses(ServiceControllerStatus status, string expected)
    {
        Assert.Equal(expected, WindowsServiceManager.StatusName(status));
    }

    private static WindowsServiceManager Create(
        string[] allowed,
        IWindowsServiceController controller,
        IWindowsServiceInventory? inventory = null,
        IProcessResourceReader? resources = null,
        bool disableAllPolicies = false) =>
        new(
            Options.Create(new AgentOptions { ServerUrl = "http://127.0.0.1", AllowedServices = allowed, DisableAllPolicies = disableAllPolicies }),
            controller,
            inventory ?? new FakeServiceInventory([]),
            resources ?? new FakeProcessResourceReader());

    private static JsonElement Payload(string action)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(new { action }));
        return document.RootElement.Clone();
    }

    private static JsonElement Payload(string serviceName, string action, int? timeoutSeconds = null)
    {
        if (!timeoutSeconds.HasValue)
        {
            using var withoutTimeout = JsonDocument.Parse(JsonSerializer.Serialize(new { serviceName, action }));
            return withoutTimeout.RootElement.Clone();
        }
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(new { serviceName, action, timeoutSeconds = timeoutSeconds.Value }));
        return document.RootElement.Clone();
    }

    private static JsonElement Result(ExecutionResult result) => JsonDocument.Parse(result.Result).RootElement.Clone();

    private sealed class FakeServiceController(ServiceControllerStatus initial) : IWindowsServiceController
    {
        private ServiceControllerStatus _status = initial;
        public bool Missing { get; init; }
        public bool AccessDenied { get; init; }
        public bool CompleteTransitions { get; init; } = true;
        public int StartCalls { get; private set; }
        public int StopCalls { get; private set; }

        public ServiceControllerStatus GetStatus(string serviceName)
        {
            if (Missing) throw new InvalidOperationException("Sensitive machine detail");
            if (AccessDenied) throw new System.ComponentModel.Win32Exception(5, "Sensitive access detail");
            return _status;
        }

        public void Start(string serviceName)
        {
            StartCalls++;
            _status = CompleteTransitions ? ServiceControllerStatus.Running : ServiceControllerStatus.StartPending;
        }

        public void Stop(string serviceName)
        {
            StopCalls++;
            _status = CompleteTransitions ? ServiceControllerStatus.Stopped : ServiceControllerStatus.StopPending;
        }
    }

    private sealed class FakeServiceInventory(IReadOnlyList<WindowsServiceSnapshot> services) : IWindowsServiceInventory
    {
        public IReadOnlyList<WindowsServiceSnapshot> List() => services;
    }

    private sealed class FakeProcessResourceReader(Dictionary<int, Queue<ProcessResourcePoint?>>? values = null) : IProcessResourceReader
    {
        private readonly Dictionary<int, Queue<ProcessResourcePoint?>> _values = values ?? [];
        public ProcessResourcePoint? Read(int processId) =>
            _values.TryGetValue(processId, out var queue) && queue.Count > 0 ? queue.Dequeue() : null;
    }
}
