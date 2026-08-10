using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent.Tests;

public sealed class RegistryManagerTests
{
    [Fact]
    public void Policy_defaults_closed_and_prefix_matching_uses_segment_boundaries()
    {
        Assert.Empty(new AgentOptions { ServerUrl = "http://127.0.0.1" }.AllowedRegistryPaths);
        var allowed = new[] { @"HKLM\SOFTWARE\Nacho\TestFixtures\ABC", @"HKU\S-1-5-21-1\Software\Fixture" };
        Assert.True(RegistryManager.IsAllowedPath("HKLM", @"SOFTWARE\Nacho\TestFixtures\ABC", allowed));
        Assert.True(RegistryManager.IsAllowedPath("HKLM", @"software\nacho\testfixtures\abc\Child", allowed));
        Assert.True(RegistryManager.IsAllowedPath("HKU", @"S-1-5-21-1\Software\Fixture", allowed));
        Assert.False(RegistryManager.IsAllowedPath("HKLM", @"SOFTWARE\Nacho\TestFixtures\ABC2", allowed));
        Assert.False(RegistryManager.IsAllowedPath("HKLM", @"SOFTWARE\Nacho\TestFixtures\..\Outside", allowed));
        Assert.False(RegistryManager.IsAllowedPath("HKCU", @"Software\Fixture", allowed));
        Assert.Null(RegistryManager.NormalizePath(@"HKLM\SOFTWARE\\Nacho"));
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"action\":\"list\",\"hive\":\"HKCU\",\"view\":\"registry64\",\"subKey\":\"Software\",\"valueName\":null,\"valueKind\":null,\"value\":null}")]
    [InlineData("{\"action\":\"get\",\"hive\":\"HKLM\",\"view\":\"registry64\",\"subKey\":\"SOFTWARE\",\"valueName\":\"Name\",\"valueKind\":\"string\",\"value\":null}")]
    [InlineData("{\"action\":\"set\",\"hive\":\"HKLM\",\"view\":\"registry64\",\"subKey\":\"SOFTWARE\",\"valueName\":\"Name\",\"valueKind\":\"dword\",\"value\":-1}")]
    [InlineData("{\"action\":\"delete\",\"hive\":\"HKLM\",\"view\":\"registry64\",\"subKey\":\"SOFTWARE\",\"valueName\":\"Name\",\"valueKind\":null,\"value\":null,\"extra\":true}")]
    public async Task Strict_payload_rejects_unknown_hives_paths_shapes_and_values(string raw)
    {
        using var document = JsonDocument.Parse(raw);
        var result = await Create(new FakePlatform()).ExecuteAsync(document.RootElement, CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Equal("INVALID_PAYLOAD", ErrorCode(result));
    }

    [Fact]
    public async Task Rejects_double_separator_and_parent_escape()
    {
        var manager = Create(new FakePlatform(), @"HKLM\SOFTWARE");
        foreach (var subKey in new[] { @"SOFTWARE\\Bad", @"SOFTWARE\..\Outside" })
        {
            var result = await manager.ExecuteAsync(Payload("list", "HKLM", "registry64", subKey), CancellationToken.None);
            Assert.Equal("INVALID_PAYLOAD", ErrorCode(result));
        }
    }

    [Fact]
    public async Task Path_outside_allowlist_fails_before_platform_access()
    {
        var platform = new FakePlatform();
        var result = await Create(platform, @"HKLM\SOFTWARE\Allowed").ExecuteAsync(Payload("list", "HKLM", "registry64", @"SOFTWARE\Other"), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Equal("PATH_NOT_ALLOWED", ErrorCode(result));
        Assert.Equal(0, platform.ReadCalls + platform.ListCalls);
    }

    [Fact]
    public async Task List_and_get_preserve_hive_view_path_and_stable_values()
    {
        var platform = new FakePlatform();
        platform.Seed("HKU", "registry32", @"S-1-5-21-1\Software\Fixture", View("Zeta", "string", "z"));
        platform.Seed("HKU", "registry32", @"S-1-5-21-1\Software\Fixture", View("Alpha", "dword", 7L, 4));
        var manager = Create(platform, @"HKU\S-1-5-21-1\Software\Fixture");
        var listed = await manager.ExecuteAsync(Payload("list", "HKU", "registry32", @"S-1-5-21-1\Software\Fixture"), CancellationToken.None);
        var json = JsonDocument.Parse(listed.Result).RootElement;
        Assert.Equal("success", listed.Status);
        Assert.Equal("Alpha", json.GetProperty("values")[0].GetProperty("valueName").GetString());
        Assert.Equal("registry32", json.GetProperty("view").GetString());
        var fetched = await manager.ExecuteAsync(Payload("get", "HKU", "registry32", @"S-1-5-21-1\Software\Fixture", "Zeta"), CancellationToken.None);
        Assert.Equal("z", JsonDocument.Parse(fetched.Result).RootElement.GetProperty("current").GetProperty("value").GetString());
    }

    [Theory]
    [InlineData("string", "hello")]
    [InlineData("expandString", "%SystemRoot%")]
    [InlineData("dword", 4294967295L)]
    [InlineData("qword", "9223372036854775807")]
    [InlineData("binary", "AAECAw==")]
    public async Task Set_supports_scalar_kinds_and_is_idempotent(string kind, object value)
    {
        var platform = new FakePlatform();
        var manager = Create(platform);
        var first = await manager.ExecuteAsync(SetPayload(kind, value), CancellationToken.None);
        Assert.Equal("success", first.Status);
        Assert.True(Changed(first));
        Assert.Equal(kind, JsonDocument.Parse(first.Result).RootElement.GetProperty("current").GetProperty("valueKind").GetString());
        var second = await manager.ExecuteAsync(SetPayload(kind, value), CancellationToken.None);
        Assert.Equal("success", second.Status);
        Assert.False(Changed(second));
    }

    [Fact]
    public async Task MultiString_set_returns_previous_and_delete_is_idempotent()
    {
        var platform = new FakePlatform();
        platform.Seed("HKLM", "registry64", @"SOFTWARE\Fixture", View("Name", "string", "old"));
        var manager = Create(platform);
        var set = await manager.ExecuteAsync(SetPayload("multiString", new[] { "one", "two" }), CancellationToken.None);
        var setJson = JsonDocument.Parse(set.Result).RootElement;
        Assert.True(setJson.GetProperty("changed").GetBoolean());
        Assert.Equal("old", setJson.GetProperty("previous").GetProperty("value").GetString());
        Assert.Equal(2, setJson.GetProperty("current").GetProperty("value").GetArrayLength());

        var deleted = await manager.ExecuteAsync(Payload("delete", "HKLM", "registry64", @"SOFTWARE\Fixture", "Name"), CancellationToken.None);
        Assert.True(Changed(deleted));
        Assert.Equal(JsonValueKind.Null, JsonDocument.Parse(deleted.Result).RootElement.GetProperty("current").ValueKind);
        var repeated = await manager.ExecuteAsync(Payload("delete", "HKLM", "registry64", @"SOFTWARE\Fixture", "Name"), CancellationToken.None);
        Assert.False(Changed(repeated));
    }

    [Fact]
    public async Task Serialized_value_boundary_and_restart_failure_are_stable()
    {
        var manager = Create(new FakePlatform());
        var accepted = await manager.ExecuteAsync(SetPayload("binary", Convert.ToBase64String(new byte[49_149])), CancellationToken.None);
        Assert.Equal("success", accepted.Status);
        var rejected = await manager.ExecuteAsync(SetPayload("binary", Convert.ToBase64String(new byte[49_150])), CancellationToken.None);
        Assert.Equal("failed", rejected.Status);
        Assert.Equal("INVALID_PAYLOAD", ErrorCode(rejected));

        var restart = JsonDocument.Parse(RegistryManager.ErrorJson(Payload("delete", "HKLM", "registry64", @"SOFTWARE\Fixture", "Name"), "restarted")).RootElement;
        Assert.Equal("delete", restart.GetProperty("action").GetString());
        Assert.Equal("AGENT_RESTARTED", restart.GetProperty("error").GetProperty("code").GetString());
        Assert.False(restart.GetProperty("changed").GetBoolean());
    }

    private static RegistryManager Create(FakePlatform platform, params string[] allowed) => new(
        Options.Create(new AgentOptions { ServerUrl = "http://127.0.0.1", AllowedRegistryPaths = allowed.Length == 0 ? [@"HKLM\SOFTWARE\Fixture"] : allowed }), platform);
    private static JsonElement Payload(string action, string hive, string view, string subKey, string? name = null) => JsonSerializer.SerializeToElement(new { action, hive, view, subKey, valueName = name, valueKind = (string?)null, value = (object?)null });
    private static JsonElement SetPayload(string kind, object value) => JsonSerializer.SerializeToElement(new { action = "set", hive = "HKLM", view = "registry64", subKey = @"SOFTWARE\Fixture", valueName = "Name", valueKind = kind, value });
    private static RegistryValueView View(string name, string kind, object value, int? size = null) => new(name, kind, value, size ?? System.Text.Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(value)));
    private static bool Changed(ExecutionResult result) => JsonDocument.Parse(result.Result).RootElement.GetProperty("changed").GetBoolean();
    private static string? ErrorCode(ExecutionResult result) => JsonDocument.Parse(result.Result).RootElement.GetProperty("error").GetProperty("code").GetString();

    private sealed class FakePlatform : IRegistryPlatform
    {
        private readonly Dictionary<string, RegistryValueView> _values = new(StringComparer.OrdinalIgnoreCase);
        public int ReadCalls { get; private set; }
        public int ListCalls { get; private set; }
        private static string Key(string hive, string view, string subKey, string name) => $"{hive}|{view}|{subKey}|{name}";
        public void Seed(string hive, string view, string subKey, RegistryValueView value) => _values[Key(hive, view, subKey, value.ValueName)] = value;
        public IReadOnlyList<RegistryValueView> List(string hive, string view, string subKey) { ListCalls++; return _values.Where(pair => pair.Key.StartsWith($"{hive}|{view}|{subKey}|", StringComparison.OrdinalIgnoreCase)).Select(pair => pair.Value).OrderBy(value => value.ValueName, StringComparer.OrdinalIgnoreCase).ToArray(); }
        public RegistryValueView? Read(string hive, string view, string subKey, string valueName) { ReadCalls++; return _values.GetValueOrDefault(Key(hive, view, subKey, valueName)); }
        public void Write(string hive, string view, string subKey, RegistryValueView value) => Seed(hive, view, subKey, value);
        public void Delete(string hive, string view, string subKey, string valueName) => _values.Remove(Key(hive, view, subKey, valueName));
    }
}
