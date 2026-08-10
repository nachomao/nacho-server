using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent.Tests;

public sealed class LocalUserManagerTests
{
    [Fact]
    public void Policies_default_to_closed_and_builtin_rids_are_protected()
    {
        var options = new AgentOptions { ServerUrl = "http://127.0.0.1" };
        Assert.False(options.AllowLocalUserManagement);
        Assert.Empty(options.AllowedLocalUsers);
        Assert.Empty(options.AllowedLocalGroups);
        Assert.True(LocalUserPlatform.IsProtectedSid("S-1-5-21-1-2-3-500"));
        Assert.True(LocalUserPlatform.IsProtectedSid("S-1-5-21-1-2-3-501"));
        Assert.True(LocalUserPlatform.IsProtectedSid("S-1-5-21-1-2-3-503"));
        Assert.True(LocalUserPlatform.IsProtectedSid("S-1-5-21-1-2-3-504"));
        Assert.False(LocalUserPlatform.IsProtectedSid("S-1-5-21-1-2-3-1001"));
    }

    [Fact]
    public async Task List_is_stable_and_does_not_require_write_policy()
    {
        var platform = new FakePlatform([
            User("zeta", 1002, true, ["Users"]),
            User("Alpha", 1001, false, ["Remote Desktop Users", "Users"]),
        ]);
        var result = await Create(platform).ExecuteAsync(Payload("list", null, null), CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal("success", result.Status);
        Assert.Equal("Alpha", json.GetProperty("accounts")[0].GetProperty("userName").GetString());
        Assert.False(json.GetProperty("accounts")[0].GetProperty("enabled").GetBoolean());
        Assert.Equal("S-1-5-21-1-2-3-1001", json.GetProperty("accounts")[0].GetProperty("sid").GetString());
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"action\":\"list\",\"userName\":null,\"groupName\":null,\"extra\":true}")]
    [InlineData("{\"action\":\"enable\",\"userName\":null,\"groupName\":null}")]
    [InlineData("{\"action\":\"enable\",\"userName\":\"domain\\\\user\",\"groupName\":null}")]
    [InlineData("{\"action\":\"add-to-group\",\"userName\":\"fixture\",\"groupName\":null}")]
    public async Task Strict_payload_rejects_missing_extra_and_ambiguous_fields(string raw)
    {
        using var document = JsonDocument.Parse(raw);
        var result = await Create(new FakePlatform([]), enabled: true).ExecuteAsync(document.RootElement, CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Equal("INVALID_PAYLOAD", JsonDocument.Parse(result.Result).RootElement.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Writes_require_case_insensitive_user_and_group_allowlists()
    {
        var platform = new FakePlatform([User("FixtureUser", 1001, true, [])]);
        var disabled = await Create(platform).ExecuteAsync(Payload("disable", "FixtureUser", null), CancellationToken.None);
        Assert.Equal("POLICY_DISABLED", ErrorCode(disabled));

        var denied = await Create(platform, true, ["other"], ["FixtureGroup"]).ExecuteAsync(Payload("disable", "FixtureUser", null), CancellationToken.None);
        Assert.Equal("USER_NOT_ALLOWED", ErrorCode(denied));

        var allowed = Create(platform, true, ["fixtureuser"], ["fixturegroup"]);
        Assert.Equal("success", (await allowed.ExecuteAsync(Payload("disable", "FixtureUser", null), CancellationToken.None)).Status);
        Assert.False(platform.Find("FixtureUser")!.Enabled);
        Assert.Equal("success", (await allowed.ExecuteAsync(Payload("add-to-group", "FixtureUser", "FixtureGroup"), CancellationToken.None)).Status);
        Assert.Contains("FixtureGroup", platform.Find("FixtureUser")!.Groups);
    }

    [Fact]
    public async Task Enable_disable_and_group_changes_are_idempotent()
    {
        var platform = new FakePlatform([User("fixture", 1001, true, ["FixtureGroup"])]);
        var manager = Create(platform, true, ["fixture"], ["FixtureGroup"]);
        Assert.False(Changed(await manager.ExecuteAsync(Payload("enable", "fixture", null), CancellationToken.None)));
        Assert.False(Changed(await manager.ExecuteAsync(Payload("add-to-group", "fixture", "FixtureGroup"), CancellationToken.None)));
        Assert.True(Changed(await manager.ExecuteAsync(Payload("remove-from-group", "fixture", "FixtureGroup"), CancellationToken.None)));
        Assert.False(Changed(await manager.ExecuteAsync(Payload("remove-from-group", "fixture", "FixtureGroup"), CancellationToken.None)));
        Assert.True(Changed(await manager.ExecuteAsync(Payload("disable", "fixture", null), CancellationToken.None)));
        Assert.False(Changed(await manager.ExecuteAsync(Payload("disable", "fixture", null), CancellationToken.None)));
    }

    [Fact]
    public async Task Delete_missing_is_stable_and_builtin_accounts_are_never_changed()
    {
        var builtin = User("renamed-admin", 500, true, ["Administrators"]);
        var platform = new FakePlatform([builtin]);
        var manager = Create(platform, true, ["renamed-admin", "missing"], ["Administrators"]);
        var protectedResult = await manager.ExecuteAsync(Payload("delete", "renamed-admin", null), CancellationToken.None);
        Assert.Equal("BUILT_IN_ACCOUNT", ErrorCode(protectedResult));
        Assert.NotNull(platform.Find("renamed-admin"));
        var missing = await manager.ExecuteAsync(Payload("delete", "missing", null), CancellationToken.None);
        Assert.Equal("success", missing.Status);
        Assert.False(Changed(missing));
    }

    [Fact]
    public async Task Platform_errors_are_mapped_and_restart_result_prevents_non_idempotent_replay()
    {
        var platform = new FakePlatform([User("fixture", 1001, true, [])]) { Failure = new LocalUserPlatformException("WIN32_ERROR", 5, "access denied") };
        var result = await Create(platform, true, ["fixture"]).ExecuteAsync(Payload("disable", "fixture", null), CancellationToken.None);
        Assert.Equal("WIN32_ERROR", ErrorCode(result));

        var restart = JsonDocument.Parse(LocalUserManager.ErrorJson(Payload("delete", "fixture", null), "restarted")).RootElement;
        Assert.Equal("delete", restart.GetProperty("action").GetString());
        Assert.False(restart.GetProperty("changed").GetBoolean());
        Assert.Equal("AGENT_RESTARTED", restart.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, platform.DeleteCalls);
    }

    private static LocalUserManager Create(FakePlatform platform, bool enabled = false, string[]? users = null, string[]? groups = null) => new(
        Options.Create(new AgentOptions
        {
            ServerUrl = "http://127.0.0.1",
            AllowLocalUserManagement = enabled,
            AllowedLocalUsers = users ?? [],
            AllowedLocalGroups = groups ?? [],
        }),
        platform);

    private static JsonElement Payload(string action, string? userName, string? groupName) => JsonSerializer.SerializeToElement(new { action, userName, groupName });
    private static LocalUserView User(string name, uint rid, bool enabled, string[] groups) => new(name, $"S-1-5-21-1-2-3-{rid}", enabled, rid is 500 or 501 or 503 or 504, groups);
    private static string? ErrorCode(ExecutionResult result) => JsonDocument.Parse(result.Result).RootElement.GetProperty("error").GetProperty("code").GetString();
    private static bool Changed(ExecutionResult result) => JsonDocument.Parse(result.Result).RootElement.GetProperty("changed").GetBoolean();

    private sealed class FakePlatform(IEnumerable<LocalUserView> users) : ILocalUserPlatform
    {
        private readonly Dictionary<string, LocalUserView> _users = users.ToDictionary(user => user.UserName, StringComparer.OrdinalIgnoreCase);
        public LocalUserPlatformException? Failure { get; init; }
        public int DeleteCalls { get; private set; }
        public IReadOnlyList<LocalUserView> List() => _users.Values.ToArray();
        public LocalUserView? Find(string userName) => _users.GetValueOrDefault(userName);
        public void SetEnabled(string userName, bool enabled)
        {
            if (Failure is not null) throw Failure;
            _users[userName] = _users[userName] with { Enabled = enabled };
        }
        public void AddToGroup(string userName, string groupName) => _users[userName] = _users[userName] with { Groups = [.. _users[userName].Groups, groupName] };
        public void RemoveFromGroup(string userName, string groupName) => _users[userName] = _users[userName] with { Groups = _users[userName].Groups.Where(group => !string.Equals(group, groupName, StringComparison.OrdinalIgnoreCase)).ToArray() };
        public void Delete(string userName) { DeleteCalls++; _users.Remove(userName); }
    }
}
