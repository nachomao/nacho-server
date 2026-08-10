using System.Text.Json;

namespace Nacho.Agent.Tests;

public sealed class AgentPolicyMigratorTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "nacho-policy-migration-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void Enables_existing_closed_policy_once_and_preserves_other_fields()
    {
        var paths = Paths("""
            {
              "serverUrl": "https://control.example.test",
              "name": "fixture-agent",
              "allowMessagePush": false,
              "customField": { "preserved": true }
            }
            """);

        var first = AgentPolicyMigrator.EnsureMessagePushEnabled(paths);

        Assert.True(first.Applied);
        Assert.True(first.Changed);
        Assert.False(first.BeforePolicy);
        Assert.True(first.AfterPolicy);
        Assert.True(File.Exists(paths.MessagePushPolicyBackupFile));
        Assert.True(File.Exists(paths.MessagePushPolicyMigrationFile));
        using var current = JsonDocument.Parse(File.ReadAllText(paths.ConfigFile));
        Assert.True(current.RootElement.GetProperty("allowMessagePush").GetBoolean());
        Assert.Equal("fixture-agent", current.RootElement.GetProperty("name").GetString());
        Assert.True(current.RootElement.GetProperty("customField").GetProperty("preserved").GetBoolean());
        using var backup = JsonDocument.Parse(File.ReadAllText(paths.MessagePushPolicyBackupFile));
        Assert.False(backup.RootElement.GetProperty("allowMessagePush").GetBoolean());

        var second = AgentPolicyMigrator.EnsureMessagePushEnabled(paths);
        Assert.False(second.Applied);
        Assert.False(second.Changed);
        Assert.True(second.BeforePolicy);
    }

    [Fact]
    public void Existing_enabled_policy_gets_marker_without_unnecessary_backup()
    {
        var paths = Paths("""{"serverUrl":"https://control.example.test","allowMessagePush":true}""");

        var result = AgentPolicyMigrator.EnsureMessagePushEnabled(paths);

        Assert.True(result.Applied);
        Assert.False(result.Changed);
        Assert.True(result.BeforePolicy);
        Assert.True(File.Exists(paths.MessagePushPolicyMigrationFile));
        Assert.False(File.Exists(paths.MessagePushPolicyBackupFile));
    }

    [Fact]
    public void Migration_marker_preserves_later_administrator_override()
    {
        var paths = Paths("""{"serverUrl":"https://control.example.test","allowMessagePush":false}""");
        AgentPolicyMigrator.EnsureMessagePushEnabled(paths);
        File.WriteAllText(paths.ConfigFile, """{"serverUrl":"https://control.example.test","allowMessagePush":false}""");

        var result = AgentPolicyMigrator.EnsureMessagePushEnabled(paths);

        Assert.False(result.Applied);
        Assert.False(result.Changed);
        Assert.False(result.BeforePolicy);
        using var current = JsonDocument.Parse(File.ReadAllText(paths.ConfigFile));
        Assert.False(current.RootElement.GetProperty("allowMessagePush").GetBoolean());
    }

    [Fact]
    public void Removes_legacy_open_url_policy_once_and_preserves_other_fields()
    {
        var paths = Paths("""
            {
              "serverUrl": "https://control.example.test",
              "allowOpenUrl": false,
              "allowedUrlSchemes": ["https"],
              "allowedUrlHosts": ["example.test"],
              "customField": { "preserved": true }
            }
            """);

        var first = AgentPolicyMigrator.RemoveOpenUrlPolicy(paths);

        Assert.True(first.Applied);
        Assert.True(first.Changed);
        Assert.True(File.Exists(paths.OpenUrlPolicyBackupFile));
        Assert.True(File.Exists(paths.OpenUrlPolicyRemovalFile));
        using var current = JsonDocument.Parse(File.ReadAllText(paths.ConfigFile));
        Assert.False(current.RootElement.TryGetProperty("allowOpenUrl", out _));
        Assert.False(current.RootElement.TryGetProperty("allowedUrlSchemes", out _));
        Assert.False(current.RootElement.TryGetProperty("allowedUrlHosts", out _));
        Assert.True(current.RootElement.GetProperty("customField").GetProperty("preserved").GetBoolean());
        using var backup = JsonDocument.Parse(File.ReadAllText(paths.OpenUrlPolicyBackupFile));
        Assert.True(backup.RootElement.TryGetProperty("allowOpenUrl", out _));

        var second = AgentPolicyMigrator.RemoveOpenUrlPolicy(paths);
        Assert.False(second.Applied);
        Assert.False(second.Changed);
    }

    [Fact]
    public void Missing_open_url_policy_writes_marker_without_backup()
    {
        var paths = Paths("""{"serverUrl":"https://control.example.test","allowMessagePush":true}""");

        var result = AgentPolicyMigrator.RemoveOpenUrlPolicy(paths);

        Assert.True(result.Applied);
        Assert.False(result.Changed);
        Assert.True(File.Exists(paths.OpenUrlPolicyRemovalFile));
        Assert.False(File.Exists(paths.OpenUrlPolicyBackupFile));
    }

    [Fact]
    public void Enables_all_policy_bypass_once_and_preserves_original_configuration()
    {
        var paths = Paths("""{"serverUrl":"https://control.example.test","disableAllPolicies":false,"custom":true}""");

        var first = AgentPolicyMigrator.EnsureAllPoliciesDisabled(paths);

        Assert.True(first.Applied);
        Assert.True(first.Changed);
        Assert.True(File.Exists(paths.AllPoliciesDisabledBackupFile));
        Assert.True(File.Exists(paths.AllPoliciesDisabledFile));
        using var current = JsonDocument.Parse(File.ReadAllText(paths.ConfigFile));
        Assert.True(current.RootElement.GetProperty("disableAllPolicies").GetBoolean());
        using var backup = JsonDocument.Parse(File.ReadAllText(paths.AllPoliciesDisabledBackupFile));
        Assert.False(backup.RootElement.GetProperty("disableAllPolicies").GetBoolean());

        var second = AgentPolicyMigrator.EnsureAllPoliciesDisabled(paths);
        Assert.False(second.Applied);
        Assert.False(second.Changed);
    }

    [Fact]
    public void Existing_all_policy_bypass_gets_marker_without_backup()
    {
        var paths = Paths("""{"serverUrl":"https://control.example.test","disableAllPolicies":true}""");

        var result = AgentPolicyMigrator.EnsureAllPoliciesDisabled(paths);

        Assert.True(result.Applied);
        Assert.False(result.Changed);
        Assert.True(File.Exists(paths.AllPoliciesDisabledFile));
        Assert.False(File.Exists(paths.AllPoliciesDisabledBackupFile));
    }

    [Fact]
    public void Invalid_configuration_does_not_create_migration_artifacts()
    {
        var paths = Paths("not-json");

        Assert.ThrowsAny<JsonException>(() => AgentPolicyMigrator.EnsureMessagePushEnabled(paths));
        Assert.False(File.Exists(paths.MessagePushPolicyBackupFile));
        Assert.False(File.Exists(paths.MessagePushPolicyMigrationFile));
    }

    private AgentPaths Paths(string config)
    {
        Directory.CreateDirectory(_dir);
        var paths = new AgentPaths(_dir);
        File.WriteAllText(paths.ConfigFile, config);
        return paths;
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }
}
