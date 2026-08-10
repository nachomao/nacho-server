using System.Text.Json;

namespace Nacho.Agent.Tests;

public sealed class OpenUrlManagerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "nacho-open-url-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task Http_and_https_start_without_local_policy()
    {
        var launcher = new Launcher();
        var manager = Create(launcher: launcher);
        Assert.Equal("success", (await manager.ExecuteAsync("cmd-http", Payload("http://127.0.0.1:8080/fixture"), CancellationToken.None)).Status);
        Assert.Equal("success", (await manager.ExecuteAsync("cmd-https", Payload("https://example.com/fixture"), CancellationToken.None)).Status);
        Assert.Equal(2, launcher.Calls);
    }

    [Fact]
    public async Task Starts_explorer_once_in_resolved_session_with_url_as_one_argument()
    {
        const string url = "https://example.com/path?q=one%20two#fixture";
        var launcher = new Launcher();
        var manager = Create(launcher: launcher);
        var result = await manager.ExecuteAsync("cmd-once", Payload(url), CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal("success", result.Status);
        Assert.True(json.GetProperty("processStarted").GetBoolean());
        Assert.Equal(4242, json.GetProperty("pid").GetInt32());
        Assert.Equal(12u, json.GetProperty("sessionId").GetUInt32());
        Assert.False(json.GetProperty("expired").GetBoolean());
        Assert.Equal(1, launcher.Calls);
        Assert.Equal(12u, launcher.SessionId);
        Assert.EndsWith("explorer.exe", launcher.ApplicationPath, StringComparison.OrdinalIgnoreCase);
        Assert.Equal([url], launcher.Arguments);

        Assert.Equal("ALREADY_ATTEMPTED", ErrorCode(await manager.ExecuteAsync("cmd-once", Payload(url), CancellationToken.None)));
        Assert.Equal(1, launcher.Calls);
    }

    [Fact]
    public async Task Rejects_expiry_userinfo_controls_non_http_length_and_unknown_fields()
    {
        var launcher = new Launcher();
        var manager = Create(launcher: launcher);
        Assert.Equal("EXPIRED", ErrorCode(await manager.ExecuteAsync("cmd-expired", Payload(expires: DateTimeOffset.UtcNow.AddSeconds(-1)), CancellationToken.None)));
        foreach (var url in new[] { "file:///tmp/a", "javascript:alert(1)", "https://user:pass@example.com/", "https://example.com/bad\nnext", "https://example.com/" + new string('x', 2049) })
        {
            Assert.Equal("INVALID_PAYLOAD", ErrorCode(await manager.ExecuteAsync("cmd-invalid-" + Guid.NewGuid().ToString("N"), Payload(url), CancellationToken.None)));
        }
        var extra = JsonSerializer.SerializeToElement(new { url = "https://example.com", expiresAt = DateTimeOffset.UtcNow.AddMinutes(5).ToString("O"), extra = true });
        Assert.Equal("INVALID_PAYLOAD", ErrorCode(await manager.ExecuteAsync("cmd-extra", extra, CancellationToken.None)));
        Assert.Equal(0, launcher.Calls);
    }

    [Fact]
    public async Task No_session_and_process_failure_are_structured_and_restart_result_is_stable()
    {
        Assert.Equal("NO_ACTIVE_SESSION", ErrorCode(await Create(sessions: new Sessions(uint.MaxValue, [])).ExecuteAsync("cmd-none", Payload(), CancellationToken.None)));
        var failed = await Create(launcher: new Launcher(false, 0, 1314)).ExecuteAsync("cmd-win32", Payload(), CancellationToken.None);
        var json = JsonDocument.Parse(failed.Result).RootElement;
        Assert.Equal("WIN32_ERROR", json.GetProperty("error").GetProperty("code").GetString());
        Assert.False(json.GetProperty("processStarted").GetBoolean());
        Assert.Equal(JsonValueKind.Null, json.GetProperty("pid").ValueKind);
        Assert.Contains("AGENT_RESTARTED", OpenUrlManager.ErrorJson("restart"), StringComparison.Ordinal);
    }

    private OpenUrlManager Create(Sessions? sessions = null, Launcher? launcher = null) => new(
        new ActiveUserSessionResolver(sessions ?? new Sessions(12, [new(12, "Console", true)])),
        launcher ?? new Launcher(),
        new Clock(DateTimeOffset.UtcNow),
        new AgentPaths(_dir));

    private static JsonElement Payload(string url = "https://example.com/fixture", DateTimeOffset? expires = null) =>
        JsonSerializer.SerializeToElement(new { url, expiresAt = (expires ?? DateTimeOffset.UtcNow.AddMinutes(5)).ToString("O") });
    private static string? ErrorCode(ExecutionResult result) => JsonDocument.Parse(result.Result).RootElement.GetProperty("error").GetProperty("code").GetString();
    public void Dispose() { if (Directory.Exists(_dir)) Directory.Delete(_dir, true); }

    private sealed class Sessions(uint console, IReadOnlyList<UserSession> sessions) : IUserSessionPlatform
    {
        public uint ActiveConsoleSessionId => console;
        public IReadOnlyList<UserSession> ListSessions() => sessions;
    }
    private sealed class Launcher(bool succeeded = true, int pid = 4242, int error = 0) : IUserProcessLauncher
    {
        public int Calls { get; private set; }
        public uint SessionId { get; private set; }
        public string ApplicationPath { get; private set; } = "";
        public IReadOnlyList<string> Arguments { get; private set; } = [];
        public UserProcessLaunchResult Start(uint sessionId, string applicationPath, IReadOnlyList<string> arguments)
        {
            Calls++; SessionId = sessionId; ApplicationPath = applicationPath; Arguments = arguments.ToArray();
            return new(succeeded, pid, error);
        }
    }
    private sealed class Clock(DateTimeOffset now) : IMessageClock { public DateTimeOffset UtcNow => now; }
}
