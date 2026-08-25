using System.Text.Json;
using Microsoft.Extensions.Options;
using Nacho.Agent;

namespace Nacho.Agent.Tests;

public sealed class WindowsProcessActionManagerTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "nacho-process-actions-" + Guid.NewGuid().ToString("N"));
    private static readonly DateTimeOffset Started = DateTimeOffset.Parse("2026-08-25T01:00:00Z");
    private const string PathName = "C:\\Fixtures\\worker.exe";

    [Fact]
    public async Task Restarts_an_allowlisted_active_user_process_with_original_arguments()
    {
        var platform = new FakePlatform(Snapshot());
        var launcher = new FakeLauncher { Result = new(true, 84, 0) };
        var manager = Create(platform, launcher);

        var result = await manager.RestartAsync("cmd-restart", RestartPayload(), CancellationToken.None);
        var json = Result(result);

        Assert.Equal("success", result.Status);
        Assert.True(platform.Terminated);
        Assert.Equal((uint)1, launcher.SessionId);
        Assert.Equal(PathName, launcher.ApplicationPath);
        Assert.Equal(["--idle", "unique-token"], launcher.Arguments);
        Assert.Equal(84, json.GetProperty("newProcessId").GetInt32());
        Assert.Equal("verified", json.GetProperty("phase").GetString());
        Assert.True(manager.HasRestartIntent("cmd-restart"));
    }

    [Fact]
    public async Task Rejects_stale_identity_and_non_active_session_before_mutation()
    {
        var stale = Create(new FakePlatform(Snapshot() with { StartedAtUtc = Started.AddSeconds(1) }), new FakeLauncher());
        var staleResult = await stale.RestartAsync("cmd-stale", RestartPayload(), CancellationToken.None);
        Assert.Equal("failed", staleResult.Status);
        Assert.Contains("start time", Result(staleResult).GetProperty("error").GetString());

        var inactive = Create(new FakePlatform(Snapshot() with { SessionId = 2 }), new FakeLauncher());
        var inactiveResult = await inactive.RestartAsync("cmd-inactive", RestartPayload(), CancellationToken.None);
        Assert.Equal("failed", inactiveResult.Status);
        Assert.Contains("active interactive", Result(inactiveResult).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Launching_phase_is_not_repeated_after_agent_restart()
    {
        var platform = new FakePlatform(Snapshot());
        var launcher = new FakeLauncher { Result = new(false, 0, 5) };
        var manager = Create(platform, launcher);
        var first = await manager.RestartAsync("cmd-unknown", RestartPayload(), CancellationToken.None);
        var resumed = await manager.ResumeRestartAsync("cmd-unknown", RestartPayload(), CancellationToken.None);

        Assert.Equal("failed", first.Status);
        Assert.Equal("failed", resumed.Status);
        Assert.Equal(1, launcher.Calls);
        Assert.Contains("not repeated", Result(resumed).GetProperty("error").GetString());
    }

    [Fact]
    public void Enables_then_disables_efficiency_and_restores_recorded_priority()
    {
        var platform = new FakePlatform(Snapshot());
        var manager = Create(platform, new FakeLauncher());

        var enabled = manager.SetEfficiency(EfficiencyPayload(true));
        Assert.Equal("success", enabled.Status);
        Assert.True(Result(enabled).GetProperty("finalEnabled").GetBoolean());
        Assert.Null(platform.LastRestorePriority);

        platform.Snapshot = platform.Snapshot with { EfficiencyMode = true, Priority = "idle" };
        var disabled = manager.SetEfficiency(EfficiencyPayload(false));
        var json = Result(disabled);
        Assert.Equal("success", disabled.Status);
        Assert.Equal("normal", platform.LastRestorePriority);
        Assert.True(json.GetProperty("priorityRestored").GetBoolean());
    }

    [Fact]
    public void Rejects_efficiency_for_process_without_set_information_access()
    {
        var platform = new FakePlatform(Snapshot() with { CanSetEfficiency = false });
        var result = Create(platform, new FakeLauncher()).SetEfficiency(EfficiencyPayload(true));
        Assert.Equal("failed", result.Status);
        Assert.Equal(0, platform.EfficiencyCalls);
    }

    private WindowsProcessActionManager Create(FakePlatform platform, FakeLauncher launcher) => new(
        Options.Create(new AgentOptions { ServerUrl = "http://127.0.0.1", AllowedProcessPaths = [PathName] }),
        platform,
        new ActiveUserSessionResolver(new FakeSessionPlatform()),
        launcher,
        new AgentPaths(_directory));

    private static ProcessActionSnapshot Snapshot() => new(
        42, "worker", PathName, Started, 1,
        "\"C:\\Fixtures\\worker.exe\" --idle unique-token", "normal", false, true);

    private static JsonElement RestartPayload() => JsonSerializer.SerializeToElement(new
    {
        processId = 42, expectedPath = PathName, expectedStartedAtUtc = Started, timeoutSeconds = 30,
    });
    private static JsonElement EfficiencyPayload(bool enabled) => JsonSerializer.SerializeToElement(new
    {
        processId = 42, expectedPath = PathName, expectedStartedAtUtc = Started, enabled,
    });
    private static JsonElement Result(ExecutionResult result) => JsonDocument.Parse(result.Result).RootElement.Clone();

    private sealed class FakePlatform(ProcessActionSnapshot snapshot) : IWindowsProcessActionPlatform
    {
        public ProcessActionSnapshot Snapshot { get; set; } = snapshot;
        public bool Terminated { get; private set; }
        public int EfficiencyCalls { get; private set; }
        public string? LastRestorePriority { get; private set; }
        public ProcessActionSnapshot Capture(int processId) => processId == 84
            ? Snapshot with { ProcessId = 84, StartedAtUtc = Started.AddSeconds(2) }
            : Snapshot;
        public Task<bool> TerminateTreeAsync(int processId, TimeSpan timeout, CancellationToken cancellationToken)
        {
            Terminated = true;
            return Task.FromResult(true);
        }
        public EfficiencyMutationResult SetEfficiency(int processId, bool enabled, string? restorePriority)
        {
            EfficiencyCalls++;
            LastRestorePriority = restorePriority;
            return enabled
                ? new(false, true, "normal", "idle", false, 0)
                : new(true, false, "idle", restorePriority ?? "idle", restorePriority is not null, 0);
        }
    }

    private sealed class FakeLauncher : IUserProcessLauncher
    {
        public UserProcessLaunchResult Result { get; init; } = new(true, 84, 0);
        public int Calls { get; private set; }
        public uint SessionId { get; private set; }
        public string? ApplicationPath { get; private set; }
        public string[] Arguments { get; private set; } = [];
        public UserProcessLaunchResult Start(uint sessionId, string applicationPath, IReadOnlyList<string> arguments)
        {
            Calls++;
            SessionId = sessionId;
            ApplicationPath = applicationPath;
            Arguments = arguments.ToArray();
            return Result;
        }
    }

    private sealed class FakeSessionPlatform : IUserSessionPlatform
    {
        public uint ActiveConsoleSessionId => 1;
        public IReadOnlyList<UserSession> ListSessions() => [new(1, "Console", true)];
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true); } catch { }
    }
}
