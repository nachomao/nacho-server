using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nacho.Agent;

public sealed record MessagePushPolicyMigrationResult(bool Applied, bool Changed, bool BeforePolicy, bool AfterPolicy);
public sealed record OpenUrlPolicyRemovalResult(bool Applied, bool Changed);
public sealed record AllPoliciesDisabledResult(bool Applied, bool Changed);

public static class AgentPolicyMigrator
{
    private static readonly string[] OpenUrlPolicyFields = ["allowOpenUrl", "allowedUrlSchemes", "allowedUrlHosts"];

    public static MessagePushPolicyMigrationResult EnsureMessagePushEnabled(AgentPaths paths)
    {
        if (File.Exists(paths.MessagePushPolicyMigrationFile))
            return new(false, false, ReadPolicy(paths.ConfigFile), ReadPolicy(paths.ConfigFile));

        var originalBytes = File.ReadAllBytes(paths.ConfigFile);
        var root = JsonNode.Parse(originalBytes)?.AsObject()
            ?? throw new InvalidDataException("Agent configuration must contain a JSON object.");
        var before = root["allowMessagePush"]?.GetValue<bool>() ?? false;
        if (!before && !File.Exists(paths.MessagePushPolicyBackupFile))
            File.WriteAllBytes(paths.MessagePushPolicyBackupFile, originalBytes);

        var changed = !before;
        if (changed)
        {
            root["allowMessagePush"] = true;
            WriteAtomic(paths.ConfigFile, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            if (!ReadPolicy(paths.ConfigFile))
                throw new InvalidDataException("Message push policy migration did not persist the enabled value.");
        }

        var marker = new
        {
            version = 1,
            changed,
            beforePolicy = before,
            afterPolicy = true,
            beforeSha256 = Hash(originalBytes),
            afterSha256 = Hash(File.ReadAllBytes(paths.ConfigFile)),
            appliedAt = DateTimeOffset.UtcNow,
        };
        WriteAtomic(paths.MessagePushPolicyMigrationFile, JsonSerializer.Serialize(marker));
        return new(true, changed, before, true);
    }

    public static OpenUrlPolicyRemovalResult RemoveOpenUrlPolicy(AgentPaths paths)
    {
        if (File.Exists(paths.OpenUrlPolicyRemovalFile)) return new(false, false);

        var originalBytes = File.ReadAllBytes(paths.ConfigFile);
        var root = JsonNode.Parse(originalBytes)?.AsObject()
            ?? throw new InvalidDataException("Agent configuration must contain a JSON object.");
        var changed = OpenUrlPolicyFields.Aggregate(false, (removed, field) => root.Remove(field) || removed);
        if (changed)
        {
            if (!File.Exists(paths.OpenUrlPolicyBackupFile)) File.WriteAllBytes(paths.OpenUrlPolicyBackupFile, originalBytes);
            WriteAtomic(paths.ConfigFile, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }

        var marker = new
        {
            version = 1,
            changed,
            removedFieldCount = changed ? OpenUrlPolicyFields.Length : 0,
            beforeSha256 = Hash(originalBytes),
            afterSha256 = Hash(File.ReadAllBytes(paths.ConfigFile)),
            appliedAt = DateTimeOffset.UtcNow,
        };
        WriteAtomic(paths.OpenUrlPolicyRemovalFile, JsonSerializer.Serialize(marker));
        return new(true, changed);
    }

    public static AllPoliciesDisabledResult EnsureAllPoliciesDisabled(AgentPaths paths)
    {
        if (File.Exists(paths.AllPoliciesDisabledFile)) return new(false, false);
        var originalBytes = File.ReadAllBytes(paths.ConfigFile);
        var root = JsonNode.Parse(originalBytes)?.AsObject()
            ?? throw new InvalidDataException("Agent configuration must contain a JSON object.");
        var before = root["disableAllPolicies"]?.GetValue<bool>() ?? false;
        if (!before && !File.Exists(paths.AllPoliciesDisabledBackupFile))
            File.WriteAllBytes(paths.AllPoliciesDisabledBackupFile, originalBytes);
        if (!before)
        {
            root["disableAllPolicies"] = true;
            WriteAtomic(paths.ConfigFile, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
        WriteAtomic(paths.AllPoliciesDisabledFile, JsonSerializer.Serialize(new
        {
            version = 1,
            changed = !before,
            beforeSha256 = Hash(originalBytes),
            afterSha256 = Hash(File.ReadAllBytes(paths.ConfigFile)),
            appliedAt = DateTimeOffset.UtcNow,
        }));
        return new(true, !before);
    }

    private static bool ReadPolicy(string configFile)
    {
        var root = JsonNode.Parse(File.ReadAllBytes(configFile))?.AsObject()
            ?? throw new InvalidDataException("Agent configuration must contain a JSON object.");
        return root["allowMessagePush"]?.GetValue<bool>() ?? false;
    }

    private static string Hash(byte[] value) => Convert.ToHexStringLower(SHA256.HashData(value));

    private static void WriteAtomic(string path, string content)
    {
        var temporary = path + ".tmp";
        try
        {
            File.WriteAllText(temporary, content, new UTF8Encoding(false));
            File.Move(temporary, path, true);
        }
        finally
        {
            try { File.Delete(temporary); } catch { }
        }
    }
}
