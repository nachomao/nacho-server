using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public sealed record UserSession(uint SessionId, string StationName, bool Active);

public interface IUserSessionPlatform
{
    uint ActiveConsoleSessionId { get; }
    IReadOnlyList<UserSession> ListSessions();
}

public sealed class ActiveUserSessionResolver(IUserSessionPlatform platform)
{
    public uint? Resolve()
    {
        var active = platform.ListSessions().Where(session => session.Active && session.SessionId > 0).ToArray();
        var consoleId = platform.ActiveConsoleSessionId;
        if (consoleId != uint.MaxValue && active.Any(session => session.SessionId == consoleId)) return consoleId;
        return active.Where(session => session.StationName.StartsWith("RDP-", StringComparison.OrdinalIgnoreCase))
            .OrderBy(session => session.SessionId).Select(session => (uint?)session.SessionId).FirstOrDefault();
    }
}

public interface IWindowsMessageSender
{
    MessageSendResult Send(uint sessionId, string title, string message, string severity, int timeoutSeconds);
}

public sealed record MessageSendResult(bool Succeeded, uint ResponseCode, int ErrorCode);

public interface IMessageClock { DateTimeOffset UtcNow { get; } }
public sealed class SystemMessageClock : IMessageClock { public DateTimeOffset UtcNow => DateTimeOffset.UtcNow; }

public sealed class WindowsUserSessionPlatform : IUserSessionPlatform
{
    public uint ActiveConsoleSessionId => MessageNativeMethods.WTSGetActiveConsoleSessionId();
    public IReadOnlyList<UserSession> ListSessions()
    {
        if (!MessageNativeMethods.WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var buffer, out var count)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var size = Marshal.SizeOf<MessageNativeMethods.WTS_SESSION_INFO>();
            var sessions = new List<UserSession>(count);
            for (var index = 0; index < count; index++)
            {
                var item = Marshal.PtrToStructure<MessageNativeMethods.WTS_SESSION_INFO>(IntPtr.Add(buffer, index * size));
                sessions.Add(new UserSession(unchecked((uint)item.SessionId), Marshal.PtrToStringUni(item.StationName) ?? "", item.State == 0));
            }
            return sessions;
        }
        finally { MessageNativeMethods.WTSFreeMemory(buffer); }
    }
}

public sealed class WindowsMessageSender : IWindowsMessageSender
{
    public MessageSendResult Send(uint sessionId, string title, string message, string severity, int timeoutSeconds)
    {
        var icon = severity switch { "warning" => 0x30u, "error" => 0x10u, _ => 0x40u };
        var succeeded = MessageNativeMethods.WTSSendMessage(IntPtr.Zero, sessionId, title, Encoding.Unicode.GetByteCount(title), message,
            Encoding.Unicode.GetByteCount(message), 0x1u | icon, timeoutSeconds, out var response, true);
        return new MessageSendResult(succeeded, response, succeeded ? 0 : Marshal.GetLastWin32Error());
    }
}

public sealed class MessagePushManager(
    IOptions<AgentOptions> options,
    ActiveUserSessionResolver resolver,
    IWindowsMessageSender sender,
    IMessageClock clock,
    AgentPaths paths)
{
    private readonly AgentOptions _options = options.Value;

    public async Task<ExecutionResult> ExecuteAsync(string commandId, JsonElement payload, CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            var request = Parse(payload);
            if (!_options.DisableAllPolicies && !_options.AllowMessagePush) return Failed("POLICY_DISABLED", "Message push is disabled by local policy.", stopwatch.ElapsedMilliseconds);
            if (request.ExpiresAt <= clock.UtcNow) return Failed("EXPIRED", "Message command has expired.", stopwatch.ElapsedMilliseconds, "expired");
            var existing = await ReadIntentAsync(commandId, cancellationToken);
            if (existing is not null && existing.Phase is "delivering" or "delivered") return Failed("ALREADY_ATTEMPTED", "Message delivery was already attempted and will not be repeated.", stopwatch.ElapsedMilliseconds);
            var sessionId = resolver.Resolve();
            if (sessionId is null) return Failed("NO_ACTIVE_SESSION", "No active console or RDP user session is available.", stopwatch.ElapsedMilliseconds);

            var intent = new MessageIntent { CommandId = commandId, Phase = "delivering", SessionId = sessionId };
            await SaveIntentAsync(intent, cancellationToken);
            var sent = sender.Send(sessionId.Value, request.Title, request.Message, request.Severity, request.TimeoutSeconds);
            intent.Phase = "delivered"; intent.ResponseCode = sent.ResponseCode; intent.UpdatedAt = clock.UtcNow;
            await SaveIntentAsync(intent, cancellationToken);
            if (!sent.Succeeded) return Failed("WIN32_ERROR", $"WTSSendMessage failed with code {sent.ErrorCode}.", stopwatch.ElapsedMilliseconds, sessionId: sessionId);
            var status = sent.ResponseCode switch { 2 => "canceled", 32000 => "timed-out", _ => "confirmed" };
            return Success(sessionId.Value, status, sent.ResponseCode, stopwatch.ElapsedMilliseconds);
        }
        catch (InvalidDataException ex) { return Failed("INVALID_PAYLOAD", ex.Message, stopwatch.ElapsedMilliseconds); }
        catch (Exception ex) when (ex is not OperationCanceledException) { return Failed("MESSAGE_ERROR", Sanitize(ex.Message), stopwatch.ElapsedMilliseconds); }
    }

    public static string ErrorJson(string message) => JsonSerializer.Serialize(new { sessionId = (uint?)null, deliveryStatus = "failed", responseCode = (uint?)null, timedOut = false, durationMs = 0L, error = new { code = "AGENT_RESTARTED", message = Sanitize(message) } });

    private async Task<MessageIntent?> ReadIntentAsync(string commandId, CancellationToken token)
    {
        var file = paths.MessageIntentFile(commandId); if (!File.Exists(file)) return null;
        await using var stream = File.OpenRead(file); return await JsonSerializer.DeserializeAsync(stream, AgentJsonContext.Default.MessageIntent, token);
    }

    private async Task SaveIntentAsync(MessageIntent intent, CancellationToken token)
    {
        Directory.CreateDirectory(paths.MessageIntentsDirectory); var file = paths.MessageIntentFile(intent.CommandId); var temp = file + ".tmp";
        await using (var stream = File.Create(temp)) await JsonSerializer.SerializeAsync(stream, intent, AgentJsonContext.Default.MessageIntent, token);
        File.Move(temp, file, true);
    }

    private static Request Parse(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Payload must be an object.");
        var required = new[] { "title", "message", "severity", "timeoutSeconds", "expiresAt" }; var names = payload.EnumerateObject().Select(x => x.Name).ToArray();
        if (names.Length != required.Length || names.Distinct(StringComparer.Ordinal).Count() != required.Length || !required.All(names.Contains)) throw new InvalidDataException("Payload fields are invalid.");
        var title = String(payload, "title"); var message = String(payload, "message"); var severity = String(payload, "severity");
        if (!ValidText(title, 128, false) || !ValidText(message, 2000, true)) throw new InvalidDataException("Title or message scalar boundary is invalid.");
        if (severity is not ("info" or "warning" or "error")) throw new InvalidDataException("severity is invalid.");
        if (!payload.GetProperty("timeoutSeconds").TryGetInt32(out var timeout) || timeout is < 5 or > 300) throw new InvalidDataException("timeoutSeconds is invalid.");
        if (!DateTimeOffset.TryParse(String(payload, "expiresAt"), out var expiresAt)) throw new InvalidDataException("expiresAt is invalid.");
        return new Request(title, message, severity, timeout, expiresAt.ToUniversalTime());
    }

    private static bool ValidText(string value, int max, bool multiline) => value.EnumerateRunes().Count() is var count && count >= 1 && count <= max && !value.Any(c => c == 0 || c == 127 || c < 32 && !(multiline && c is '\r' or '\n' or '\t'));
    private static string String(JsonElement payload, string name) => payload.GetProperty(name).ValueKind == JsonValueKind.String ? payload.GetProperty(name).GetString()! : throw new InvalidDataException($"{name} must be a string.");
    private static ExecutionResult Success(uint sessionId, string status, uint response, long duration) => new("success", JsonSerializer.Serialize(new { sessionId, deliveryStatus = status, responseCode = response, timedOut = status == "timed-out", durationMs = duration, error = (object?)null }), null);
    private static ExecutionResult Failed(string code, string message, long duration, string status = "failed", uint? sessionId = null) => new("failed", JsonSerializer.Serialize(new { sessionId, deliveryStatus = status, responseCode = (uint?)null, timedOut = false, durationMs = duration, error = new { code, message = Sanitize(message) } }), null);
    private static string Sanitize(string value) => new(value.Where(c => c >= 32 && c != 127).Take(512).ToArray());
    private sealed record Request(string Title, string Message, string Severity, int TimeoutSeconds, DateTimeOffset ExpiresAt);
}

internal static class MessageNativeMethods
{
    [StructLayout(LayoutKind.Sequential)] internal struct WTS_SESSION_INFO { public int SessionId; public IntPtr StationName; public int State; }
    [DllImport("Wtsapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr sessions, out int count);
    [DllImport("Wtsapi32.dll")] internal static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("Kernel32.dll")] internal static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("Wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool WTSSendMessage(IntPtr server, uint sessionId, string title, int titleLength, string message, int messageLength, uint style, int timeout, out uint response, [MarshalAs(UnmanagedType.Bool)] bool wait);
}
