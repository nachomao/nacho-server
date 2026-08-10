using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent.Tests;

public sealed class MessagePushManagerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "nacho-message-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void Resolver_prefers_active_console_then_lowest_active_rdp()
    {
        Assert.Equal(7u, new ActiveUserSessionResolver(new Sessions(7, [new(9, "RDP-Tcp#2", true), new(7, "Console", true)])).Resolve());
        Assert.Equal(4u, new ActiveUserSessionResolver(new Sessions(uint.MaxValue, [new(8, "RDP-Tcp#5", true), new(4, "RDP-Tcp#1", true), new(3, "Console", false)])).Resolve());
        Assert.Null(new ActiveUserSessionResolver(new Sessions(uint.MaxValue, [new(0, "Services", true), new(3, "RDP-Tcp#1", false)])).Resolve());
    }

    [Fact]
    public async Task Deployment_default_is_enabled_while_explicit_disable_and_expiry_still_block()
    {
        Assert.True(new AgentOptions { ServerUrl = "http://127.0.0.1" }.AllowMessagePush);
        var sender = new Sender(true, 1);
        var disabled = await Create(sender: sender).ExecuteAsync("cmd-disabled", Payload(), CancellationToken.None);
        Assert.Equal("POLICY_DISABLED", ErrorCode(disabled));
        var expired = await Create(enabled: true, sender: sender).ExecuteAsync("cmd-expired", Payload(expires: DateTimeOffset.UtcNow.AddSeconds(-1)), CancellationToken.None);
        Assert.Equal("EXPIRED", ErrorCode(expired));
        Assert.Equal("expired", JsonDocument.Parse(expired.Result).RootElement.GetProperty("deliveryStatus").GetString());
        Assert.Equal(0, sender.Calls);
    }

    [Fact]
    public async Task No_active_session_is_structured_failure()
    {
        var result = await Create(enabled: true, sessions: new Sessions(uint.MaxValue, [])).ExecuteAsync("cmd-none", Payload(), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Equal("NO_ACTIVE_SESSION", ErrorCode(result));
        Assert.Equal(JsonValueKind.Null, JsonDocument.Parse(result.Result).RootElement.GetProperty("sessionId").ValueKind);
    }

    [Theory]
    [InlineData(1u, "confirmed", false)]
    [InlineData(2u, "canceled", false)]
    [InlineData(32000u, "timed-out", true)]
    public async Task Maps_confirmation_cancel_and_timeout_without_user_identity(uint response, string status, bool timedOut)
    {
        var sender = new Sender(true, response);
        var result = await Create(enabled: true, sender: sender).ExecuteAsync("cmd-response-" + response, Payload(), CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal("success", result.Status);
        Assert.Equal(12u, json.GetProperty("sessionId").GetUInt32());
        Assert.Equal(status, json.GetProperty("deliveryStatus").GetString());
        Assert.Equal(timedOut, json.GetProperty("timedOut").GetBoolean());
        Assert.False(json.TryGetProperty("userName", out _));
    }

    [Fact]
    public async Task Win32_failure_and_existing_intent_do_not_repeat_delivery()
    {
        var failed = await Create(enabled: true, sender: new Sender(false, 0, 5)).ExecuteAsync("cmd-win32", Payload(), CancellationToken.None);
        Assert.Equal("WIN32_ERROR", ErrorCode(failed));
        var sender = new Sender(true, 1);
        var manager = Create(enabled: true, sender: sender);
        Assert.Equal("success", (await manager.ExecuteAsync("cmd-once", Payload(), CancellationToken.None)).Status);
        var repeated = await manager.ExecuteAsync("cmd-once", Payload(), CancellationToken.None);
        Assert.Equal("ALREADY_ATTEMPTED", ErrorCode(repeated));
        Assert.Equal(1, sender.Calls);
        Assert.Contains("AGENT_RESTARTED", MessagePushManager.ErrorJson("restart"), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("", "message")]
    [InlineData("title", "")]
    [InlineData("bad\u0001", "message")]
    public async Task Rejects_empty_and_control_character_text(string title, string message)
    {
        var result = await Create(enabled: true).ExecuteAsync("cmd-invalid-" + Guid.NewGuid().ToString("N"), Payload(title, message), CancellationToken.None);
        Assert.Equal("INVALID_PAYLOAD", ErrorCode(result));
    }

    private MessagePushManager Create(bool enabled = false, Sessions? sessions = null, Sender? sender = null) => new(
        Options.Create(new AgentOptions { ServerUrl = "http://127.0.0.1", AllowMessagePush = enabled }),
        new ActiveUserSessionResolver(sessions ?? new Sessions(12, [new(12, "Console", true)])), sender ?? new Sender(true, 1),
        new Clock(DateTimeOffset.UtcNow), new AgentPaths(_dir));
    private static JsonElement Payload(string title = "Stage 6 test", string message = "Synthetic fixture message", DateTimeOffset? expires = null) => JsonSerializer.SerializeToElement(new { title, message, severity = "warning", timeoutSeconds = 5, expiresAt = (expires ?? DateTimeOffset.UtcNow.AddMinutes(5)).ToString("O") });
    private static string? ErrorCode(ExecutionResult result) => JsonDocument.Parse(result.Result).RootElement.GetProperty("error").GetProperty("code").GetString();
    public void Dispose() { if (Directory.Exists(_dir)) Directory.Delete(_dir, true); }
    private sealed class Sessions(uint console, IReadOnlyList<UserSession> sessions) : IUserSessionPlatform { public uint ActiveConsoleSessionId => console; public IReadOnlyList<UserSession> ListSessions() => sessions; }
    private sealed class Sender(bool ok, uint response, int error = 0) : IWindowsMessageSender { public int Calls { get; private set; } public MessageSendResult Send(uint sessionId, string title, string message, string severity, int timeoutSeconds) { Calls++; return new(ok, response, error); } }
    private sealed class Clock(DateTimeOffset now) : IMessageClock { public DateTimeOffset UtcNow => now; }
}
