using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Nacho.Agent;

namespace Nacho.Agent.Tests;

public sealed class WindowsProcessInventoryManagerTests
{
    [Fact]
    public async Task Lists_every_visible_process_with_resources_policy_and_stable_order()
    {
        const string allowedPath = "C:\\Fixtures\\worker.exe";
        var inventory = new FakeInventory([
            Snapshot(42, "Zulu", allowedPath),
            Snapshot(43, "alpha", null),
            Snapshot(900, "Nacho Agent", "C:\\Program Files\\Nacho\\Agent\\nacho-agent.exe"),
            Snapshot(4, "System", null, sessionId: 0),
        ]);
        var resources = new FakeResourceReader(new Dictionary<int, Queue<ProcessResourcePoint?>>
        {
            [42] = new([
                new ProcessResourcePoint(TimeSpan.FromMilliseconds(100), 1000, 800),
                new ProcessResourcePoint(TimeSpan.FromMilliseconds(200), 1200, 900),
            ]),
            [43] = new([null, null]),
            [900] = new([null, null]),
            [4] = new([null, null]),
        });
        var result = await Create([allowedPath], inventory, resources, currentProcessId: 900)
            .ExecuteAsync(EmptyPayload(), CancellationToken.None);
        var json = Result(result);
        var rows = json.GetProperty("processes").EnumerateArray().ToArray();
        var byId = rows.ToDictionary(row => row.GetProperty("processId").GetInt32());

        Assert.Equal("success", result.Status);
        Assert.Equal(4, json.GetProperty("total").GetInt32());
        Assert.Equal(["alpha", "Nacho Agent", "System", "Zulu"], rows.Select(row => row.GetProperty("processName").GetString()!).ToArray());
        Assert.True(byId[42].GetProperty("canTerminate").GetBoolean());
        Assert.True(byId[42].GetProperty("canRestart").GetBoolean());
        Assert.True(byId[42].GetProperty("canSetEfficiency").GetBoolean());
        Assert.Equal(JsonValueKind.Null, byId[42].GetProperty("terminationRestriction").ValueKind);
        Assert.Equal(1200, byId[42].GetProperty("resources").GetProperty("workingSetBytes").GetInt64());
        Assert.Equal("path-unavailable", byId[43].GetProperty("terminationRestriction").GetString());
        Assert.Equal("agent-self", byId[900].GetProperty("terminationRestriction").GetString());
        Assert.Equal("system", byId[4].GetProperty("terminationRestriction").GetString());
        Assert.Equal(JsonValueKind.Null, byId[43].GetProperty("resources").ValueKind);
    }

    [Fact]
    public async Task Disable_all_policies_marks_path_backed_process_as_terminable()
    {
        var manager = Create(
            [],
            new FakeInventory([Snapshot(77, "Fixture", "C:\\Fixtures\\fixture.exe")]),
            disableAllPolicies: true);

        var result = Result(await manager.ExecuteAsync(EmptyPayload(), CancellationToken.None));
        var row = result.GetProperty("processes")[0];

        Assert.True(row.GetProperty("canTerminate").GetBoolean());
        Assert.Equal(JsonValueKind.Null, row.GetProperty("terminationRestriction").ValueKind);
    }

    [Fact]
    public async Task Non_allowlisted_path_is_returned_as_selectable_inventory_data()
    {
        var result = Result(await Create(
            [],
            new FakeInventory([Snapshot(78, "Fixture", "C:\\Fixtures\\fixture.exe")]))
            .ExecuteAsync(EmptyPayload(), CancellationToken.None));
        var row = result.GetProperty("processes")[0];

        Assert.Equal("C:\\Fixtures\\fixture.exe", row.GetProperty("executablePath").GetString());
        Assert.False(row.GetProperty("canTerminate").GetBoolean());
        Assert.Equal("not-allowlisted", row.GetProperty("terminationRestriction").GetString());
    }

    [Fact]
    public async Task Rejects_non_empty_payload_with_list_shaped_failure()
    {
        using var document = JsonDocument.Parse("{\"extra\":true}");
        var result = await Create([], new FakeInventory([])).ExecuteAsync(document.RootElement, CancellationToken.None);
        var json = Result(result);

        Assert.Equal("failed", result.Status);
        Assert.Empty(json.GetProperty("processes").EnumerateArray());
        Assert.Contains("empty object", json.GetProperty("error").GetString());
    }

    [Fact]
    public async Task Result_is_utf8_bounded_and_reports_truncation()
    {
        var processes = Enumerable.Range(1, 5000)
            .Select(index => Snapshot(index + 10, new string('进', 240) + index, $"C:\\Fixtures\\{index}\\worker.exe"))
            .ToArray();
        var result = await Create([], new FakeInventory(processes)).ExecuteAsync(EmptyPayload(), CancellationToken.None);
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
        var result = Result(new ExecutionResult("failed", WindowsProcessInventoryManager.ErrorJson("restarted"), null));
        Assert.Equal(0, result.GetProperty("total").GetInt32());
        Assert.Empty(result.GetProperty("processes").EnumerateArray());
        Assert.Equal("restarted", result.GetProperty("error").GetString());
    }

    [Fact]
    public async Task Propagates_host_cancellation_during_resource_sample()
    {
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Create(
            [],
            new FakeInventory([Snapshot(88, "Fixture", "C:\\Fixtures\\fixture.exe")]))
            .ExecuteAsync(EmptyPayload(), cancellation.Token));
    }

    private static WindowsProcessInventoryManager Create(
        string[] allowed,
        IWindowsProcessInventory inventory,
        IProcessResourceReader? resources = null,
        int currentProcessId = 900,
        bool disableAllPolicies = false) => new(
            Options.Create(new AgentOptions
            {
                ServerUrl = "http://127.0.0.1",
                AllowedProcessPaths = allowed,
                DisableAllPolicies = disableAllPolicies,
            }),
            inventory,
            resources ?? new FakeResourceReader(),
            new FakeProcessController(currentProcessId),
            new ActiveUserSessionResolver(new FakeSessionPlatform()));

    private static WindowsProcessSnapshot Snapshot(int processId, string name, string? path, int? sessionId = 1) =>
        new(processId, name, path, DateTimeOffset.Parse("2026-08-25T01:00:00Z"), sessionId, true, false, true);

    private static JsonElement EmptyPayload()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }

    private static JsonElement Result(ExecutionResult result) => JsonDocument.Parse(result.Result).RootElement.Clone();

    private sealed class FakeInventory(IReadOnlyList<WindowsProcessSnapshot> processes) : IWindowsProcessInventory
    {
        public IReadOnlyList<WindowsProcessSnapshot> List() => processes;
    }

    private sealed class FakeResourceReader(Dictionary<int, Queue<ProcessResourcePoint?>>? values = null) : IProcessResourceReader
    {
        private readonly Dictionary<int, Queue<ProcessResourcePoint?>> _values = values ?? [];
        public ProcessResourcePoint? Read(int processId) =>
            _values.TryGetValue(processId, out var queue) && queue.Count > 0 ? queue.Dequeue() : null;
    }

    private sealed class FakeProcessController(int currentProcessId) : IWindowsProcessController
    {
        public int CurrentProcessId { get; } = currentProcessId;
        public IWindowsProcessHandle Open(int processId) => throw new NotSupportedException();
    }

    private sealed class FakeSessionPlatform : IUserSessionPlatform
    {
        public uint ActiveConsoleSessionId => 1;
        public IReadOnlyList<UserSession> ListSessions() => [new(1, "Console", true)];
    }
}
