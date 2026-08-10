using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using Microsoft.Win32;

namespace Nacho.Agent;

public sealed record RegistryValueView(
    [property: JsonPropertyName("valueName")] string ValueName,
    [property: JsonPropertyName("valueKind")] string ValueKind,
    [property: JsonPropertyName("value")] object Value,
    [property: JsonPropertyName("sizeBytes")] int SizeBytes);

public interface IRegistryPlatform
{
    IReadOnlyList<RegistryValueView> List(string hive, string view, string subKey);
    RegistryValueView? Read(string hive, string view, string subKey, string valueName);
    void Write(string hive, string view, string subKey, RegistryValueView value);
    void Delete(string hive, string view, string subKey, string valueName);
}

public sealed class WindowsRegistryPlatform : IRegistryPlatform
{
    public IReadOnlyList<RegistryValueView> List(string hive, string view, string subKey)
    {
        using var root = OpenRoot(hive, view);
        using var key = root.OpenSubKey(subKey, writable: false);
        if (key is null) return [];
        return key.GetValueNames()
            .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(name => name, StringComparer.Ordinal)
            .Select(name => ReadValue(key, name))
            .ToArray();
    }

    public RegistryValueView? Read(string hive, string view, string subKey, string valueName)
    {
        using var root = OpenRoot(hive, view);
        using var key = root.OpenSubKey(subKey, writable: false);
        if (key is null || !key.GetValueNames().Contains(valueName, StringComparer.OrdinalIgnoreCase)) return null;
        var actual = key.GetValueNames().First(name => string.Equals(name, valueName, StringComparison.OrdinalIgnoreCase));
        return ReadValue(key, actual);
    }

    public void Write(string hive, string view, string subKey, RegistryValueView value)
    {
        using var root = OpenRoot(hive, view);
        using var key = root.CreateSubKey(subKey, writable: true) ?? throw new InvalidOperationException("Registry key creation returned no key.");
        var (nativeValue, nativeKind) = ToNative(value);
        key.SetValue(value.ValueName, nativeValue, nativeKind);
    }

    public void Delete(string hive, string view, string subKey, string valueName)
    {
        using var root = OpenRoot(hive, view);
        using var key = root.OpenSubKey(subKey, writable: true);
        if (key is null) return;
        var actual = key.GetValueNames().FirstOrDefault(name => string.Equals(name, valueName, StringComparison.OrdinalIgnoreCase));
        if (actual is not null) key.DeleteValue(actual, throwOnMissingValue: false);
    }

    private static RegistryKey OpenRoot(string hive, string view) => RegistryKey.OpenBaseKey(
        hive == "HKLM" ? RegistryHive.LocalMachine : RegistryHive.Users,
        view == "registry64" ? RegistryView.Registry64 : RegistryView.Registry32);

    private static RegistryValueView ReadValue(RegistryKey key, string name)
    {
        var kind = key.GetValueKind(name);
        var native = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames)
            ?? throw new InvalidDataException("Registry value returned null.");
        return kind switch
        {
            RegistryValueKind.String => View(name, "string", (string)native),
            RegistryValueKind.ExpandString => View(name, "expandString", (string)native),
            RegistryValueKind.DWord => View(name, "dword", (long)unchecked((uint)(int)native), 4),
            RegistryValueKind.QWord when (long)native >= 0 => View(name, "qword", ((long)native).ToString(System.Globalization.CultureInfo.InvariantCulture), 8),
            RegistryValueKind.MultiString => View(name, "multiString", (string[])native),
            RegistryValueKind.Binary => View(name, "binary", Convert.ToBase64String((byte[])native), ((byte[])native).Length),
            _ => throw new InvalidDataException($"Unsupported registry value kind: {kind}.")
        };
    }

    private static RegistryValueView View(string name, string kind, object value, int? size = null) =>
        new(name, kind, value, size ?? Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(value)));

    private static (object Value, RegistryValueKind Kind) ToNative(RegistryValueView value) => value.ValueKind switch
    {
        "string" => ((string)value.Value, RegistryValueKind.String),
        "expandString" => ((string)value.Value, RegistryValueKind.ExpandString),
        "dword" => (unchecked((int)Convert.ToUInt32(value.Value, System.Globalization.CultureInfo.InvariantCulture)), RegistryValueKind.DWord),
        "qword" => (long.Parse((string)value.Value, System.Globalization.CultureInfo.InvariantCulture), RegistryValueKind.QWord),
        "multiString" => ((string[])value.Value, RegistryValueKind.MultiString),
        "binary" => (Convert.FromBase64String((string)value.Value), RegistryValueKind.Binary),
        _ => throw new InvalidDataException("Unsupported registry valueKind."),
    };
}

public sealed class RegistryManager(IOptions<AgentOptions> options, IRegistryPlatform platform)
{
    private readonly AgentOptions _options = options.Value;
    private static readonly HashSet<string> Actions = new(["list", "get", "set", "delete"], StringComparer.Ordinal);
    private static readonly HashSet<string> Kinds = new(["string", "expandString", "dword", "qword", "multiString", "binary"], StringComparer.Ordinal);

    public Task<ExecutionResult> ExecuteAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Request? request = null;
        try
        {
            request = Parse(payload);
            if (!_options.DisableAllPolicies && !IsAllowedPath(request.Hive, request.SubKey, _options.AllowedRegistryPaths))
                return Task.FromResult(Failed(request, "PATH_NOT_ALLOWED", "Registry path is outside allowedRegistryPaths."));

            return Task.FromResult(request.Action switch
            {
                "list" => List(request),
                "get" => Get(request),
                "set" => Set(request),
                "delete" => Delete(request),
                _ => Failed(request, "INVALID_PAYLOAD", "Unsupported registry action."),
            });
        }
        catch (InvalidDataException ex) { return Task.FromResult(Failed(request ?? Fallback(payload), "INVALID_PAYLOAD", ex.Message)); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return Task.FromResult(Failed(request ?? Fallback(payload), "REGISTRY_ERROR", Sanitize(ex.Message)));
        }
    }

    public static string ErrorJson(JsonElement payload, string message)
    {
        var request = Fallback(payload);
        return SerializeResult(request, false, request.Action == "list" ? Array.Empty<RegistryValueView>() : null, null, null,
            new Error("AGENT_RESTARTED", Sanitize(message)));
    }

    public static bool IsAllowedPath(string hive, string subKey, IEnumerable<string> allowedPaths)
    {
        var target = NormalizePath($"{hive}\\{subKey}");
        if (target is null) return false;
        return allowedPaths.Select(NormalizePath).Where(path => path is not null).Any(path =>
            string.Equals(target, path, StringComparison.OrdinalIgnoreCase) || target.StartsWith(path + "\\", StringComparison.OrdinalIgnoreCase));
    }

    internal static string? NormalizePath(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value != value.Trim() || value.StartsWith('\\') || value.EndsWith('\\') || value.Contains("\\\\")) return null;
        var parts = value.Split('\\');
        if (parts.Length < 2 || parts.Any(part => part.Length == 0 || part is "." or ".." || part.Any(character => character < 32 || character == 127))) return null;
        if (parts[0] is not ("HKLM" or "HKU")) return null;
        return string.Join('\\', parts);
    }

    private ExecutionResult List(Request request)
    {
        var values = platform.List(request.Hive, request.View, request.SubKey);
        foreach (var value in values) ValidateView(value);
        return Complete(request, false, values, null, null);
    }

    private ExecutionResult Get(Request request)
    {
        var current = platform.Read(request.Hive, request.View, request.SubKey, request.ValueName!);
        if (current is not null) ValidateView(current);
        return Complete(request, false, null, null, current);
    }

    private ExecutionResult Set(Request request)
    {
        var previous = platform.Read(request.Hive, request.View, request.SubKey, request.ValueName!);
        var desired = request.Value!;
        if (previous is not null) ValidateView(previous);
        var changed = previous is null || !Equivalent(previous, desired);
        if (changed) platform.Write(request.Hive, request.View, request.SubKey, desired);
        var current = platform.Read(request.Hive, request.View, request.SubKey, request.ValueName!) ?? desired;
        ValidateView(current);
        return Complete(request, changed, null, previous, current);
    }

    private ExecutionResult Delete(Request request)
    {
        var previous = platform.Read(request.Hive, request.View, request.SubKey, request.ValueName!);
        if (previous is not null)
        {
            ValidateView(previous);
            platform.Delete(request.Hive, request.View, request.SubKey, request.ValueName!);
        }
        return Complete(request, previous is not null, null, previous, null);
    }

    private static ExecutionResult Complete(Request request, bool changed, object? values, RegistryValueView? previous, RegistryValueView? current)
    {
        var result = SerializeResult(request, changed, values, previous, current, null);
        if (Encoding.UTF8.GetByteCount(result) > 512 * 1024) return Failed(request, "RESULT_TOO_LARGE", "Registry result exceeds 512 KiB.");
        return new ExecutionResult("success", result, null);
    }

    private static ExecutionResult Failed(Request request, string code, string message) =>
        new("failed", SerializeResult(request, false, request.Action == "list" ? Array.Empty<RegistryValueView>() : null, null, null, new Error(code, Sanitize(message))), null);

    private static string SerializeResult(Request request, bool changed, object? values, RegistryValueView? previous, RegistryValueView? current, Error? error) =>
        JsonSerializer.Serialize(new { action = request.Action, hive = request.Hive, view = request.View, subKey = request.SubKey, changed, values, previous, current, error });

    private static Request Parse(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Payload must be an object.");
        var names = payload.EnumerateObject().Select(property => property.Name).ToArray();
        var required = new[] { "action", "hive", "view", "subKey", "valueName", "valueKind", "value" };
        if (names.Length != required.Length || names.Distinct(StringComparer.Ordinal).Count() != required.Length || !required.All(names.Contains))
            throw new InvalidDataException("Payload must contain only action, hive, view, subKey, valueName, valueKind and value.");
        var action = RequiredString(payload, "action");
        var hive = RequiredString(payload, "hive");
        var view = RequiredString(payload, "view");
        var subKey = RequiredString(payload, "subKey");
        if (!Actions.Contains(action) || hive is not ("HKLM" or "HKU") || view is not ("registry32" or "registry64")) throw new InvalidDataException("Unsupported action, hive or view.");
        ValidateSubKey(subKey);
        var valueName = NullableString(payload.GetProperty("valueName"), "valueName");
        var valueKind = NullableString(payload.GetProperty("valueKind"), "valueKind");
        var valueElement = payload.GetProperty("value");
        if (action == "list")
        {
            if (valueName is not null || valueKind is not null || valueElement.ValueKind != JsonValueKind.Null) throw new InvalidDataException("list requires null value fields.");
            return new Request(action, hive, view, subKey, null, null, null);
        }
        ValidateValueName(valueName);
        if (action is "get" or "delete")
        {
            if (valueKind is not null || valueElement.ValueKind != JsonValueKind.Null) throw new InvalidDataException($"{action} requires null valueKind and value.");
            return new Request(action, hive, view, subKey, valueName, null, null);
        }
        if (valueKind is null || !Kinds.Contains(valueKind)) throw new InvalidDataException("set requires a supported valueKind.");
        var value = ParseValue(valueName!, valueKind, valueElement);
        ValidateView(value);
        return new Request(action, hive, view, subKey, valueName, valueKind, value);
    }

    private static RegistryValueView ParseValue(string name, string kind, JsonElement element)
    {
        object value = kind switch
        {
            "string" or "expandString" when element.ValueKind == JsonValueKind.String => element.GetString()!,
            "dword" when element.ValueKind == JsonValueKind.Number && element.TryGetUInt32(out var dword) => (long)dword,
            "qword" when element.ValueKind == JsonValueKind.String && long.TryParse(element.GetString(), out var qword) && qword >= 0 => qword.ToString(System.Globalization.CultureInfo.InvariantCulture),
            "qword" when element.ValueKind == JsonValueKind.Number && element.TryGetInt64(out var qword) && qword >= 0 => qword.ToString(System.Globalization.CultureInfo.InvariantCulture),
            "multiString" when element.ValueKind == JsonValueKind.Array => element.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.String ? item.GetString()! : throw new InvalidDataException("multiString entries must be strings.")).ToArray(),
            "binary" when element.ValueKind == JsonValueKind.String => CanonicalBase64(element.GetString()!),
            _ => throw new InvalidDataException("value does not match valueKind."),
        };
        var size = kind switch
        {
            "dword" => 4,
            "qword" => 8,
            "binary" => Convert.FromBase64String((string)value).Length,
            _ => Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(value)),
        };
        return new RegistryValueView(name, kind, value, size);
    }

    private static string CanonicalBase64(string value)
    {
        try
        {
            var bytes = Convert.FromBase64String(value);
            if (Convert.ToBase64String(bytes) != value) throw new InvalidDataException("binary must use canonical Base64.");
            return value;
        }
        catch (FormatException) { throw new InvalidDataException("binary must use canonical Base64."); }
    }

    private static void ValidateView(RegistryValueView value)
    {
        ValidateValueName(value.ValueName);
        if (!Kinds.Contains(value.ValueKind)) throw new InvalidDataException("Unsupported registry value kind.");
        var serializedBytes = Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(value.Value));
        if (serializedBytes > 65_536 || value.SizeBytes > 65_536) throw new InvalidDataException("Registry value exceeds 64 KiB.");
        if (value.ValueKind is "string" or "expandString" && ((string)value.Value).Any(character => character < 32 || character == 127)) throw new InvalidDataException("Registry string contains control characters.");
        if (value.ValueKind == "multiString" && ((string[])value.Value).Any(item => item.Any(character => character < 32 || character == 127))) throw new InvalidDataException("Registry multiString contains control characters.");
    }

    private static bool Equivalent(RegistryValueView left, RegistryValueView right) => left.ValueKind == right.ValueKind && JsonSerializer.Serialize(left.Value) == JsonSerializer.Serialize(right.Value);
    private static string RequiredString(JsonElement payload, string name) => payload.GetProperty(name).ValueKind == JsonValueKind.String ? payload.GetProperty(name).GetString()! : throw new InvalidDataException($"{name} must be a string.");
    private static string? NullableString(JsonElement element, string name) => element.ValueKind switch { JsonValueKind.Null => null, JsonValueKind.String => element.GetString(), _ => throw new InvalidDataException($"{name} must be string or null.") };
    private static void ValidateSubKey(string value) { if (NormalizePath("HKLM\\" + value) is null || value.Length > 2048) throw new InvalidDataException("subKey is invalid."); }
    private static void ValidateValueName(string? value) { if (value is null || value.Length > 255 || value.Any(character => character < 32 || character == 127)) throw new InvalidDataException("valueName is invalid."); }
    private static string Sanitize(string value) => new(value.Where(character => character >= 32 && character != 127).Take(512).ToArray());
    private static Request Fallback(JsonElement payload)
    {
        string Read(string name, string fallback) => payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()! : fallback;
        var action = Read("action", "get"); if (!Actions.Contains(action)) action = "get";
        var hive = Read("hive", "HKLM"); if (hive is not ("HKLM" or "HKU")) hive = "HKLM";
        var view = Read("view", "registry64"); if (view is not ("registry32" or "registry64")) view = "registry64";
        var subKey = Read("subKey", "SOFTWARE"); if (NormalizePath(hive + "\\" + subKey) is null) subKey = "SOFTWARE";
        return new Request(action, hive, view, subKey, null, null, null);
    }

    private sealed record Request(string Action, string Hive, string View, string SubKey, string? ValueName, string? ValueKind, RegistryValueView? Value);
    private sealed record Error([property: JsonPropertyName("code")] string Code, [property: JsonPropertyName("message")] string Message);
}
