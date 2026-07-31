using System.ComponentModel;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Nacho.Agent;

namespace Nacho.Agent.Tests;

public sealed class SystemRestartManagerTests
{
    [Fact]
    public void Restart_policy_defaults_to_disabled_and_binds_from_configuration()
    {
        Assert.False(new AgentOptions { ServerUrl = "http://127.0.0.1" }.AllowSystemRestart);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ServerUrl"] = "http://127.0.0.1",
            ["AllowSystemRestart"] = "true",
        }).Build();
        Assert.True(configuration.Get<AgentOptions>()!.AllowSystemRestart);
    }

    [Theory]
    [InlineData("{}", "0 to 300")]
    [InlineData("{\"delaySeconds\":-1}", "0 to 300")]
    [InlineData("{\"delaySeconds\":301}", "0 to 300")]
    [InlineData("{\"delaySeconds\":1.5}", "0 to 300")]
    [InlineData("{\"delaySeconds\":1,\"machineName\":\"remote\"}", "unsupported field")]
    [InlineData("{\"delaySeconds\":1,\"reason\":42}", "reason must be")]
    public async Task Rejects_invalid_payloads_without_calling_windows(string json, string expectedError)
    {
        using var scope = new TestScope();
        using var document = JsonDocument.Parse(json);
        var result = await scope.Create(enabled: true).ExecuteAsync("cmd-1", document.RootElement, NoProgress, CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains(expectedError, result.Result);
        Assert.Equal(0, scope.Controller.Calls);
        Assert.Null(result.ExitCode);
    }

    [Fact]
    public async Task Rejects_control_characters_and_more_than_256_unicode_scalars()
    {
        using var scope = new TestScope();
        var control = await scope.Create(true).ExecuteAsync("cmd-1", Payload(0, "line\nbreak"), NoProgress, CancellationToken.None);
        var oversized = await scope.Create(true).ExecuteAsync("cmd-2", Payload(0, string.Concat(Enumerable.Repeat("😀", 257))), NoProgress, CancellationToken.None);
        Assert.Equal("failed", control.Status);
        Assert.Equal("failed", oversized.Status);
        Assert.DoesNotContain("\n", Result(control).GetProperty("reason").GetString());
        Assert.Equal(256, Result(oversized).GetProperty("reason").GetString()!.EnumerateRunes().Count());
    }

    [Fact]
    public async Task Accepts_zero_and_300_second_boundaries_before_platform_execution()
    {
        using var scope = new TestScope();
        scope.Controller.Error = new Win32Exception(5, "sensitive machine detail");
        var zero = await scope.Create(true).ExecuteAsync("cmd-zero", Payload(0), NoProgress, CancellationToken.None);
        var max = await scope.Create(true).ExecuteAsync("cmd-max", Payload(300), NoProgress, CancellationToken.None);
        Assert.Equal(0, Result(zero).GetProperty("delaySeconds").GetInt32());
        Assert.Equal(300, Result(max).GetProperty("delaySeconds").GetInt32());
        Assert.DoesNotContain("sensitive", zero.Result, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Enforces_policy_and_platform_before_persisting_an_intent()
    {
        using var scope = new TestScope();
        var disabled = await scope.Create(false).ExecuteAsync("cmd-1", Payload(0), NoProgress, CancellationToken.None);
        scope.Controller.IsSupported = false;
        var unsupported = await scope.Create(true).ExecuteAsync("cmd-2", Payload(0), NoProgress, CancellationToken.None);
        Assert.Contains("local policy", disabled.Result);
        Assert.Contains("only on Windows", unsupported.Result);
        Assert.False(File.Exists(scope.Paths.RestartIntentFile));
    }

    [Fact]
    public async Task Persists_requested_intent_before_calling_the_system_api()
    {
        using var scope = new TestScope();
        scope.Controller.OnRequest = () =>
        {
            using var document = JsonDocument.Parse(File.ReadAllText(scope.Paths.RestartIntentFile));
            Assert.Equal("requested", document.RootElement.GetProperty("phase").GetString());
            Assert.Equal("cmd-request", document.RootElement.GetProperty("commandId").GetString());
        };
        using var cancellation = new CancellationTokenSource();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => scope.Create(true).ExecuteAsync(
            "cmd-request",
            Payload(0, "  planned restart  "),
            (result, _) =>
            {
                Assert.Equal("requested", Result(result).GetProperty("phase").GetString());
                cancellation.Cancel();
                return Task.CompletedTask;
            },
            cancellation.Token));
        Assert.Equal(1, scope.Controller.Calls);
        Assert.Equal("planned restart", scope.Controller.Reason);
    }

    [Fact]
    public async Task Marks_api_failure_without_leaking_the_native_error()
    {
        using var scope = new TestScope();
        scope.Controller.Error = new Win32Exception(1314, "sensitive privilege detail");
        var result = await scope.Create(true).ExecuteAsync("cmd-fail", Payload(0), NoProgress, CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Equal("failed", Result(result).GetProperty("phase").GetString());
        Assert.Equal("Windows restart request was rejected.", Result(result).GetProperty("error").GetString());
        Assert.DoesNotContain("sensitive", result.Result, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Resume_verifies_a_changed_boot_identity_without_requesting_again()
    {
        using var scope = new TestScope();
        await scope.WriteIntentAsync(new RestartIntent
        {
            CommandId = "cmd-resume",
            RequestedAt = DateTimeOffset.UtcNow.AddSeconds(-5),
            ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(30),
            PreviousBootId = "boot-old",
            DelaySeconds = 0,
            Reason = null,
            Phase = "requested",
        });
        scope.Boot.BootId = "boot-new";
        var result = await scope.Create(true).ResumeAsync("cmd-resume", Payload(0), NoProgress, CancellationToken.None);
        Assert.Equal("success", result.Status);
        Assert.True(Result(result).GetProperty("verifiedAfterRestart").GetBoolean());
        Assert.Equal("boot-new", Result(result).GetProperty("currentBootId").GetString());
        Assert.Equal(0, scope.Controller.Calls);
    }

    [Fact]
    public async Task Resume_fails_prepared_expired_and_corrupt_intents()
    {
        using var preparedScope = new TestScope();
        await preparedScope.WriteIntentAsync(Intent("cmd-prepared", "prepared", DateTimeOffset.UtcNow.AddMinutes(1)));
        var prepared = await preparedScope.Create(true).ResumeAsync("cmd-prepared", Payload(0), NoProgress, CancellationToken.None);
        Assert.Equal("failed", prepared.Status);

        using var expiredScope = new TestScope();
        await expiredScope.WriteIntentAsync(Intent("cmd-expired", "requested", DateTimeOffset.UtcNow.AddSeconds(-1)));
        var expired = await expiredScope.Create(true).ResumeAsync("cmd-expired", Payload(0), NoProgress, CancellationToken.None);
        Assert.Contains("verification deadline", expired.Result);

        using var corruptScope = new TestScope();
        await File.WriteAllTextAsync(corruptScope.Paths.RestartIntentFile, "not-json");
        var corrupt = await corruptScope.Create(true).ResumeAsync("cmd-corrupt", Payload(0), NoProgress, CancellationToken.None);
        Assert.Contains("state is invalid", corrupt.Result);
    }

    [Fact]
    public void Reservation_is_idempotent_for_one_command_and_rejects_another()
    {
        using var scope = new TestScope();
        var manager = scope.Create(true);
        Assert.True(manager.TryReserve("cmd-1"));
        Assert.True(manager.TryReserve("cmd-1"));
        Assert.False(manager.TryReserve("cmd-2"));
        manager.Release("cmd-1");
        Assert.True(manager.TryReserve("cmd-2"));
    }

    [Fact]
    public void Production_boot_identity_is_stable_on_windows()
    {
        if (!OperatingSystem.IsWindows()) return;
        var provider = new WindowsBootIdentityProvider();
        var first = provider.GetCurrentBootId();
        var second = provider.GetCurrentBootId();
        Assert.Equal(first, second);
        Assert.True(first.StartsWith("registry:", StringComparison.Ordinal) || first.StartsWith("native:", StringComparison.Ordinal));
    }

    private static RestartIntent Intent(string id, string phase, DateTimeOffset expiresAt) => new()
    {
        CommandId = id,
        RequestedAt = DateTimeOffset.UtcNow.AddMinutes(-1),
        ExpiresAt = expiresAt,
        PreviousBootId = "boot-old",
        DelaySeconds = 0,
        Phase = phase,
    };

    private static Task NoProgress(string _, CancellationToken __) => Task.CompletedTask;

    private static JsonElement Payload(int delaySeconds, string? reason = null)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(new { delaySeconds, reason }));
        return document.RootElement.Clone();
    }

    private static JsonElement Result(ExecutionResult result) => Result(result.Result);
    private static JsonElement Result(string result) => JsonDocument.Parse(result).RootElement.Clone();

    private sealed class TestScope : IDisposable
    {
        private readonly string _directory = Path.Combine(Path.GetTempPath(), "nacho-restart-tests", Guid.NewGuid().ToString("N"));
        public AgentPaths Paths { get; }
        public FakeBootIdentity Boot { get; } = new();
        public FakeRestartController Controller { get; } = new();

        public TestScope()
        {
            Directory.CreateDirectory(_directory);
            Paths = new AgentPaths(_directory);
        }

        public SystemRestartManager Create(bool enabled) => new(
            Options.Create(new AgentOptions { ServerUrl = "http://127.0.0.1", AllowSystemRestart = enabled }),
            Paths,
            Boot,
            Controller);

        public async Task WriteIntentAsync(RestartIntent intent)
        {
            await File.WriteAllTextAsync(Paths.RestartIntentFile, JsonSerializer.Serialize(intent, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            }));
        }

        public void Dispose()
        {
            try { Directory.Delete(_directory, true); }
            catch { }
        }
    }

    private sealed class FakeBootIdentity : IBootIdentityProvider
    {
        public string BootId { get; set; } = "boot-old";
        public string GetCurrentBootId() => BootId;
    }

    private sealed class FakeRestartController : IWindowsRestartController
    {
        public bool IsSupported { get; set; } = true;
        public Exception? Error { get; set; }
        public Action? OnRequest { get; set; }
        public int Calls { get; private set; }
        public string? Reason { get; private set; }

        public void RequestRestart(int delaySeconds, string? reason)
        {
            Calls++;
            Reason = reason;
            OnRequest?.Invoke();
            if (Error is not null) throw Error;
        }
    }
}
