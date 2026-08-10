using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public sealed record LocalUserView(
    [property: JsonPropertyName("userName")] string UserName,
    [property: JsonPropertyName("sid")] string Sid,
    [property: JsonPropertyName("enabled")] bool Enabled,
    [property: JsonPropertyName("builtIn")] bool BuiltIn,
    [property: JsonPropertyName("groups")] string[] Groups);

public interface ILocalUserPlatform
{
    IReadOnlyList<LocalUserView> List();
    LocalUserView? Find(string userName);
    void SetEnabled(string userName, bool enabled);
    void AddToGroup(string userName, string groupName);
    void RemoveFromGroup(string userName, string groupName);
    void Delete(string userName);
}

public sealed class LocalUserPlatform : ILocalUserPlatform
{
    public IReadOnlyList<LocalUserView> List()
    {
        var names = EnumerateUserNames();
        return names.Select(Find)
            .Where(user => user is not null)
            .Cast<LocalUserView>()
            .OrderBy(user => user.UserName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(user => user.UserName, StringComparer.Ordinal)
            .ToArray();
    }

    public LocalUserView? Find(string userName)
    {
        var status = LocalUserNativeMethods.NetUserGetInfo(null, userName, 4, out var buffer);
        if (status == LocalUserNativeMethods.NERR_UserNotFound) return null;
        ThrowOnError(status, "NetUserGetInfo");
        try
        {
            var info = Marshal.PtrToStructure<LocalUserNativeMethods.USER_INFO_4>(buffer);
            var sid = LocalUserNativeMethods.SidToString(info.usri4_user_sid);
            return new LocalUserView(
                info.usri4_name,
                sid,
                (info.usri4_flags & LocalUserNativeMethods.UF_ACCOUNTDISABLE) == 0,
                IsProtectedSid(sid),
                EnumerateGroups(info.usri4_name));
        }
        finally { LocalUserNativeMethods.NetApiBufferFree(buffer); }
    }

    public void SetEnabled(string userName, bool enabled)
    {
        var current = Find(userName) ?? throw new LocalUserPlatformException("USER_NOT_FOUND", LocalUserNativeMethods.NERR_UserNotFound, "Local account does not exist.");
        var status = LocalUserNativeMethods.NetUserGetInfo(null, userName, 4, out var buffer);
        ThrowOnError(status, "NetUserGetInfo");
        try
        {
            var info = Marshal.PtrToStructure<LocalUserNativeMethods.USER_INFO_4>(buffer);
            var flags = enabled ? info.usri4_flags & ~LocalUserNativeMethods.UF_ACCOUNTDISABLE : info.usri4_flags | LocalUserNativeMethods.UF_ACCOUNTDISABLE;
            if (current.Enabled == enabled) return;
            var update = new LocalUserNativeMethods.USER_INFO_1008 { usri1008_flags = flags };
            status = LocalUserNativeMethods.NetUserSetInfo(null, userName, 1008, ref update, out _);
            ThrowOnError(status, "NetUserSetInfo");
        }
        finally { LocalUserNativeMethods.NetApiBufferFree(buffer); }
    }

    public void AddToGroup(string userName, string groupName)
    {
        var member = new LocalUserNativeMethods.LOCALGROUP_MEMBERS_INFO_3 { lgrmi3_domainandname = $"{Environment.MachineName}\\{userName}" };
        var status = LocalUserNativeMethods.NetLocalGroupAddMembers(null, groupName, 3, ref member, 1);
        if (status == LocalUserNativeMethods.ERROR_MEMBER_IN_ALIAS) return;
        ThrowOnError(status, "NetLocalGroupAddMembers");
    }

    public void RemoveFromGroup(string userName, string groupName)
    {
        var member = new LocalUserNativeMethods.LOCALGROUP_MEMBERS_INFO_3 { lgrmi3_domainandname = $"{Environment.MachineName}\\{userName}" };
        var status = LocalUserNativeMethods.NetLocalGroupDelMembers(null, groupName, 3, ref member, 1);
        if (status == LocalUserNativeMethods.ERROR_NO_SUCH_MEMBER) return;
        ThrowOnError(status, "NetLocalGroupDelMembers");
    }

    public void Delete(string userName)
    {
        var status = LocalUserNativeMethods.NetUserDel(null, userName);
        if (status == LocalUserNativeMethods.NERR_UserNotFound) return;
        ThrowOnError(status, "NetUserDel");
    }

    private static string[] EnumerateUserNames()
    {
        var names = new List<string>();
        nuint resume = 0;
        do
        {
            var status = LocalUserNativeMethods.NetUserEnum(null, 0, LocalUserNativeMethods.FILTER_NORMAL_ACCOUNT, out var buffer,
                LocalUserNativeMethods.MAX_PREFERRED_LENGTH, out var read, out _, ref resume);
            if (status is not (LocalUserNativeMethods.NERR_Success or LocalUserNativeMethods.ERROR_MORE_DATA)) ThrowOnError(status, "NetUserEnum");
            try
            {
                var size = Marshal.SizeOf<LocalUserNativeMethods.USER_INFO_0>();
                for (var index = 0; index < read; index++)
                {
                    var item = Marshal.PtrToStructure<LocalUserNativeMethods.USER_INFO_0>(IntPtr.Add(buffer, index * size));
                    if (!string.IsNullOrWhiteSpace(item.usri0_name)) names.Add(item.usri0_name);
                }
            }
            finally { if (buffer != IntPtr.Zero) LocalUserNativeMethods.NetApiBufferFree(buffer); }
            if (status != LocalUserNativeMethods.ERROR_MORE_DATA) break;
        } while (true);
        return names.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static string[] EnumerateGroups(string userName)
    {
        var status = LocalUserNativeMethods.NetUserGetLocalGroups(null, userName, 0, LocalUserNativeMethods.LG_INCLUDE_INDIRECT,
            out var buffer, LocalUserNativeMethods.MAX_PREFERRED_LENGTH, out var read, out _);
        if (status == LocalUserNativeMethods.NERR_UserNotFound) return [];
        ThrowOnError(status, "NetUserGetLocalGroups");
        try
        {
            var groups = new string[read];
            var size = Marshal.SizeOf<LocalUserNativeMethods.LOCALGROUP_USERS_INFO_0>();
            for (var index = 0; index < read; index++)
                groups[index] = Marshal.PtrToStructure<LocalUserNativeMethods.LOCALGROUP_USERS_INFO_0>(IntPtr.Add(buffer, index * size)).lgrui0_name;
            return groups.OrderBy(group => group, StringComparer.OrdinalIgnoreCase).ThenBy(group => group, StringComparer.Ordinal).ToArray();
        }
        finally { if (buffer != IntPtr.Zero) LocalUserNativeMethods.NetApiBufferFree(buffer); }
    }

    internal static bool IsProtectedSid(string sid)
    {
        var last = sid.LastIndexOf('-');
        return last >= 0 && uint.TryParse(sid[(last + 1)..], out var rid) && rid is 500 or 501 or 503 or 504;
    }

    private static void ThrowOnError(uint status, string operation)
    {
        if (status == LocalUserNativeMethods.NERR_Success) return;
        var message = new Win32Exception(unchecked((int)status)).Message;
        throw new LocalUserPlatformException("WIN32_ERROR", status, $"{operation} failed ({status}): {message}");
    }
}

public sealed class LocalUserPlatformException(string code, uint nativeCode, string message) : Exception(message)
{
    public string Code { get; } = code;
    public uint NativeCode { get; } = nativeCode;
}

public sealed class LocalUserManager(IOptions<AgentOptions> options, ILocalUserPlatform platform)
{
    private readonly AgentOptions _options = options.Value;
    private static readonly HashSet<string> Actions = new(["list", "enable", "disable", "delete", "add-to-group", "remove-from-group"], StringComparer.Ordinal);

    public Task<ExecutionResult> ExecuteAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string action = "list";
        try
        {
            var request = Parse(payload);
            action = request.Action;
            if (action == "list") return Task.FromResult(ListResult());
            EnsurePolicy(request);
            var before = platform.Find(request.UserName!);
            if (before?.BuiltIn == true || (before is not null && LocalUserPlatform.IsProtectedSid(before.Sid)))
                return Task.FromResult(Failed(action, "BUILT_IN_ACCOUNT", "Built-in and system accounts are protected."));

            var changed = action switch
            {
                "enable" => SetEnabled(request.UserName!, before, true),
                "disable" => SetEnabled(request.UserName!, before, false),
                "add-to-group" => ChangeGroup(request.UserName!, request.GroupName!, before, true),
                "remove-from-group" => ChangeGroup(request.UserName!, request.GroupName!, before, false),
                "delete" => Delete(request.UserName!, before),
                _ => false,
            };
            var target = action == "delete" ? platform.Find(request.UserName!) : platform.Find(request.UserName!);
            return Task.FromResult(Success(action, changed, target));
        }
        catch (InvalidDataException ex) { return Task.FromResult(Failed(action, "INVALID_PAYLOAD", ex.Message)); }
        catch (LocalUserPlatformException ex) { return Task.FromResult(Failed(action, ex.Code, ex.Message)); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return Task.FromResult(Failed(action, "LOCAL_USER_ERROR", Sanitize(ex.Message)));
        }
    }

    public static string ErrorJson(JsonElement payload, string message)
    {
        var action = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("action", out var value) && value.ValueKind == JsonValueKind.String && Actions.Contains(value.GetString() ?? "")
            ? value.GetString()!
            : "list";
        return action == "list"
            ? JsonSerializer.Serialize(new { action, changed = false, accounts = Array.Empty<LocalUserView>(), error = new { code = "AGENT_RESTARTED", message = Sanitize(message) } })
            : JsonSerializer.Serialize(new { action, changed = false, target = (LocalUserView?)null, error = new { code = "AGENT_RESTARTED", message = Sanitize(message) } });
    }

    private ExecutionResult ListResult()
    {
        var accounts = platform.List().OrderBy(user => user.UserName, StringComparer.OrdinalIgnoreCase).ThenBy(user => user.UserName, StringComparer.Ordinal).ToArray();
        var result = JsonSerializer.Serialize(new { action = "list", changed = false, accounts, error = (object?)null });
        if (Encoding.UTF8.GetByteCount(result) > 512 * 1024) return Failed("list", "RESULT_TOO_LARGE", "Local account result exceeds 512 KiB.");
        return new ExecutionResult("success", result, null);
    }

    private void EnsurePolicy(Request request)
    {
        if (!_options.DisableAllPolicies && !_options.AllowLocalUserManagement) throw new LocalUserPlatformException("POLICY_DISABLED", 0, "Local user management is disabled by local policy.");
        if (!_options.DisableAllPolicies && !_options.AllowedLocalUsers.Contains(request.UserName!, StringComparer.OrdinalIgnoreCase))
            throw new LocalUserPlatformException("USER_NOT_ALLOWED", 0, "Local account is not in allowedLocalUsers.");
        if (!_options.DisableAllPolicies && request.GroupName is not null && !_options.AllowedLocalGroups.Contains(request.GroupName, StringComparer.OrdinalIgnoreCase))
            throw new LocalUserPlatformException("GROUP_NOT_ALLOWED", 0, "Local group is not in allowedLocalGroups.");
    }

    private bool SetEnabled(string userName, LocalUserView? before, bool enabled)
    {
        if (before is null) return false;
        if (before.Enabled == enabled) return false;
        platform.SetEnabled(userName, enabled);
        return true;
    }

    private bool ChangeGroup(string userName, string groupName, LocalUserView? before, bool add)
    {
        if (before is null) return false;
        var member = before.Groups.Contains(groupName, StringComparer.OrdinalIgnoreCase);
        if (member == add) return false;
        if (add) platform.AddToGroup(userName, groupName); else platform.RemoveFromGroup(userName, groupName);
        return true;
    }

    private bool Delete(string userName, LocalUserView? before)
    {
        if (before is null) return false;
        platform.Delete(userName);
        return true;
    }

    private static Request Parse(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Payload must be an object.");
        var seen = payload.EnumerateObject().Select(property => property.Name).ToArray();
        if (seen.Length != 3 || seen.Distinct(StringComparer.Ordinal).Count() != 3 || !new[] { "action", "userName", "groupName" }.All(seen.Contains))
            throw new InvalidDataException("Payload must contain only action, userName and groupName.");
        var actionElement = payload.GetProperty("action");
        if (actionElement.ValueKind != JsonValueKind.String || !Actions.Contains(actionElement.GetString() ?? "")) throw new InvalidDataException("Unsupported action.");
        var action = actionElement.GetString()!;
        var userName = ReadNullable(payload.GetProperty("userName"), "userName");
        var groupName = ReadNullable(payload.GetProperty("groupName"), "groupName");
        if (action == "list")
        {
            if (userName is not null || groupName is not null) throw new InvalidDataException("list requires null userName and groupName.");
        }
        else
        {
            ValidateName(userName, 20, "userName");
            if (action is "add-to-group" or "remove-from-group") ValidateName(groupName, 256, "groupName");
            else if (groupName is not null) throw new InvalidDataException($"{action} requires null groupName.");
        }
        return new Request(action, userName, groupName);
    }

    private static string? ReadNullable(JsonElement element, string field) => element.ValueKind switch
    {
        JsonValueKind.Null => null,
        JsonValueKind.String => element.GetString(),
        _ => throw new InvalidDataException($"{field} must be a string or null."),
    };

    private static void ValidateName(string? value, int maximum, string field)
    {
        if (string.IsNullOrEmpty(value) || value.Length > maximum || value != value.Trim() || value is "." or ".." || value.EndsWith('.') || value.Any(character => character < 32 || character == 127 || "\"/\\[]:;|=,+*?<>@".Contains(character)))
            throw new InvalidDataException($"{field} is not a valid local Windows name.");
    }

    private static ExecutionResult Success(string action, bool changed, LocalUserView? target) =>
        new("success", JsonSerializer.Serialize(new { action, changed, target, error = (object?)null }), null);

    private static ExecutionResult Failed(string action, string code, string message)
    {
        var error = new { code, message = Sanitize(message) };
        var json = action == "list"
            ? JsonSerializer.Serialize(new { action, changed = false, accounts = Array.Empty<LocalUserView>(), error })
            : JsonSerializer.Serialize(new { action, changed = false, target = (LocalUserView?)null, error });
        return new ExecutionResult("failed", json, null);
    }

    private static string Sanitize(string value) => new(value.Where(character => character >= 32 && character != 127).Take(512).ToArray());
    private sealed record Request(string Action, string? UserName, string? GroupName);
}

internal static class LocalUserNativeMethods
{
    internal const uint NERR_Success = 0;
    internal const uint ERROR_MORE_DATA = 234;
    internal const uint NERR_UserNotFound = 2221;
    internal const uint ERROR_MEMBER_IN_ALIAS = 1378;
    internal const uint ERROR_NO_SUCH_MEMBER = 1387;
    internal const uint FILTER_NORMAL_ACCOUNT = 2;
    internal const uint LG_INCLUDE_INDIRECT = 1;
    internal const uint MAX_PREFERRED_LENGTH = uint.MaxValue;
    internal const uint UF_ACCOUNTDISABLE = 0x0002;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct USER_INFO_0 { [MarshalAs(UnmanagedType.LPWStr)] public string usri0_name; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct LOCALGROUP_USERS_INFO_0 { [MarshalAs(UnmanagedType.LPWStr)] public string lgrui0_name; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct LOCALGROUP_MEMBERS_INFO_3 { [MarshalAs(UnmanagedType.LPWStr)] public string lgrmi3_domainandname; }
    [StructLayout(LayoutKind.Sequential)] internal struct USER_INFO_1008 { public uint usri1008_flags; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct USER_INFO_4
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string usri4_name;
        [MarshalAs(UnmanagedType.LPWStr)] public string usri4_password;
        public uint usri4_password_age; public uint usri4_priv;
        [MarshalAs(UnmanagedType.LPWStr)] public string usri4_home_dir;
        [MarshalAs(UnmanagedType.LPWStr)] public string usri4_comment;
        public uint usri4_flags;
        [MarshalAs(UnmanagedType.LPWStr)] public string usri4_script_path;
        public uint usri4_auth_flags;
        [MarshalAs(UnmanagedType.LPWStr)] public string usri4_full_name;
        [MarshalAs(UnmanagedType.LPWStr)] public string usri4_usr_comment;
        [MarshalAs(UnmanagedType.LPWStr)] public string usri4_parms;
        [MarshalAs(UnmanagedType.LPWStr)] public string usri4_workstations;
        public uint usri4_last_logon; public uint usri4_last_logoff; public uint usri4_acct_expires; public uint usri4_max_storage; public uint usri4_units_per_week;
        public IntPtr usri4_logon_hours;
        public uint usri4_bad_pw_count; public uint usri4_num_logons;
        [MarshalAs(UnmanagedType.LPWStr)] public string usri4_logon_server;
        public uint usri4_country_code; public uint usri4_code_page;
        public IntPtr usri4_user_sid; public uint usri4_primary_group_id;
        [MarshalAs(UnmanagedType.LPWStr)] public string usri4_profile;
        [MarshalAs(UnmanagedType.LPWStr)] public string usri4_home_dir_drive;
        public uint usri4_password_expired;
    }

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)] internal static extern uint NetUserEnum(string? servername, uint level, uint filter, out IntPtr bufptr, uint prefmaxlen, out int entriesread, out int totalentries, ref nuint resume_handle);
    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)] internal static extern uint NetUserGetInfo(string? servername, string username, uint level, out IntPtr bufptr);
    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)] internal static extern uint NetUserSetInfo(string? servername, string username, uint level, ref USER_INFO_1008 buf, out uint parm_err);
    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)] internal static extern uint NetUserGetLocalGroups(string? servername, string username, uint level, uint flags, out IntPtr bufptr, uint prefmaxlen, out int entriesread, out int totalentries);
    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)] internal static extern uint NetLocalGroupAddMembers(string? servername, string groupname, uint level, ref LOCALGROUP_MEMBERS_INFO_3 buf, uint totalentries);
    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)] internal static extern uint NetLocalGroupDelMembers(string? servername, string groupname, uint level, ref LOCALGROUP_MEMBERS_INFO_3 buf, uint totalentries);
    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)] internal static extern uint NetUserDel(string? servername, string username);
    [DllImport("Netapi32.dll")] internal static extern uint NetApiBufferFree(IntPtr buffer);
    [DllImport("Advapi32.dll", EntryPoint = "ConvertSidToStringSidW", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);
    [DllImport("Kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

    internal static string SidToString(IntPtr sid)
    {
        if (sid == IntPtr.Zero || !ConvertSidToStringSid(sid, out var value)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { return Marshal.PtrToStringUni(value) ?? throw new InvalidDataException("SID conversion returned an empty value."); }
        finally { LocalFree(value); }
    }
}

