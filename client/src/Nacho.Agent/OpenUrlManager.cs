using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Nacho.Agent;

public sealed record UserProcessLaunchResult(bool Succeeded, int ProcessId, int ErrorCode);

public interface IUserProcessLauncher
{
    UserProcessLaunchResult Start(uint sessionId, string applicationPath, IReadOnlyList<string> arguments);
}

public sealed class WindowsUserProcessLauncher : IUserProcessLauncher
{
    public UserProcessLaunchResult Start(uint sessionId, string applicationPath, IReadOnlyList<string> arguments)
    {
        IntPtr userToken = IntPtr.Zero;
        IntPtr primaryToken = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        try
        {
            if (!OpenUrlNativeMethods.WTSQueryUserToken(sessionId, out userToken))
                return new(false, 0, Marshal.GetLastWin32Error());
            if (!OpenUrlNativeMethods.DuplicateTokenEx(userToken, OpenUrlNativeMethods.TokenAllAccess, IntPtr.Zero,
                    OpenUrlNativeMethods.SecurityImpersonation, OpenUrlNativeMethods.TokenPrimary, out primaryToken))
                return new(false, 0, Marshal.GetLastWin32Error());
            if (!OpenUrlNativeMethods.CreateEnvironmentBlock(out environment, primaryToken, false))
                return new(false, 0, Marshal.GetLastWin32Error());

            var startup = new OpenUrlNativeMethods.StartupInfo
            {
                Cb = Marshal.SizeOf<OpenUrlNativeMethods.StartupInfo>(),
                Desktop = "winsta0\\default",
            };
            var commandLine = new StringBuilder(QuoteArgument(applicationPath));
            foreach (var argument in arguments) commandLine.Append(' ').Append(QuoteArgument(argument));
            var workingDirectory = Path.GetDirectoryName(applicationPath);
            if (!OpenUrlNativeMethods.CreateProcessAsUser(primaryToken, applicationPath, commandLine, IntPtr.Zero, IntPtr.Zero,
                    false, OpenUrlNativeMethods.CreateUnicodeEnvironment, environment, workingDirectory, ref startup, out var process))
                return new(false, 0, Marshal.GetLastWin32Error());
            try { return new(true, checked((int)process.ProcessId), 0); }
            finally
            {
                if (process.Thread != IntPtr.Zero) OpenUrlNativeMethods.CloseHandle(process.Thread);
                if (process.Process != IntPtr.Zero) OpenUrlNativeMethods.CloseHandle(process.Process);
            }
        }
        finally
        {
            if (environment != IntPtr.Zero) OpenUrlNativeMethods.DestroyEnvironmentBlock(environment);
            if (primaryToken != IntPtr.Zero) OpenUrlNativeMethods.CloseHandle(primaryToken);
            if (userToken != IntPtr.Zero) OpenUrlNativeMethods.CloseHandle(userToken);
        }
    }

    internal static string QuoteArgument(string value)
    {
        var builder = new StringBuilder("\"");
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                builder.Append('\\', slashes * 2 + 1).Append('"');
                slashes = 0;
                continue;
            }
            builder.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        builder.Append('\\', slashes * 2).Append('"');
        return builder.ToString();
    }
}

public sealed class OpenUrlManager(
    ActiveUserSessionResolver resolver,
    IUserProcessLauncher launcher,
    IMessageClock clock,
    AgentPaths paths)
{
    public async Task<ExecutionResult> ExecuteAsync(string commandId, JsonElement payload, CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            var request = Parse(payload);
            if (request.ExpiresAt <= clock.UtcNow) return Failed("EXPIRED", "URL command has expired.", stopwatch.ElapsedMilliseconds, expired: true);
            if (await ReadIntentAsync(commandId, cancellationToken) is not null)
                return Failed("ALREADY_ATTEMPTED", "Browser launch was already attempted and will not be repeated.", stopwatch.ElapsedMilliseconds);
            var sessionId = resolver.Resolve();
            if (sessionId is null) return Failed("NO_ACTIVE_SESSION", "No active console or RDP user session is available.", stopwatch.ElapsedMilliseconds);

            var intent = new OpenUrlIntent { CommandId = commandId, Phase = "launching", SessionId = sessionId };
            await SaveIntentAsync(intent, cancellationToken);
            var explorer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
            var launch = launcher.Start(sessionId.Value, explorer, [request.OriginalUrl]);
            intent.Phase = launch.Succeeded ? "started" : "failed";
            intent.ProcessId = launch.Succeeded ? launch.ProcessId : null;
            intent.UpdatedAt = clock.UtcNow;
            await SaveIntentAsync(intent, cancellationToken);
            if (!launch.Succeeded) return Failed("WIN32_ERROR", $"CreateProcessAsUser failed with code {launch.ErrorCode}.", stopwatch.ElapsedMilliseconds, sessionId);
            return Success(sessionId.Value, launch.ProcessId, stopwatch.ElapsedMilliseconds);
        }
        catch (InvalidDataException ex) { return Failed("INVALID_PAYLOAD", ex.Message, stopwatch.ElapsedMilliseconds); }
        catch (Exception ex) when (ex is not OperationCanceledException) { return Failed("OPEN_URL_ERROR", Sanitize(ex.Message), stopwatch.ElapsedMilliseconds); }
    }

    public static string ErrorJson(string message) => JsonSerializer.Serialize(new
    {
        sessionId = (uint?)null,
        processStarted = false,
        pid = (int?)null,
        durationMs = 0L,
        expired = false,
        error = new { code = "AGENT_RESTARTED", message = Sanitize(message) },
    });

    private async Task<OpenUrlIntent?> ReadIntentAsync(string commandId, CancellationToken token)
    {
        var file = paths.OpenUrlIntentFile(commandId);
        if (!File.Exists(file)) return null;
        await using var stream = File.OpenRead(file);
        return await JsonSerializer.DeserializeAsync(stream, AgentJsonContext.Default.OpenUrlIntent, token)
            ?? throw new InvalidDataException("Open URL intent is empty.");
    }

    private async Task SaveIntentAsync(OpenUrlIntent intent, CancellationToken token)
    {
        Directory.CreateDirectory(paths.OpenUrlIntentsDirectory);
        var file = paths.OpenUrlIntentFile(intent.CommandId);
        var temp = file + ".tmp";
        await using (var stream = File.Create(temp))
            await JsonSerializer.SerializeAsync(stream, intent, AgentJsonContext.Default.OpenUrlIntent, token);
        File.Move(temp, file, true);
    }

    private static Request Parse(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Payload must be an object.");
        var required = new[] { "url", "expiresAt" };
        var names = payload.EnumerateObject().Select(item => item.Name).ToArray();
        if (names.Length != required.Length || names.Distinct(StringComparer.Ordinal).Count() != required.Length || !required.All(names.Contains))
            throw new InvalidDataException("Payload fields are invalid.");
        var url = String(payload, "url");
        if (url.Length is < 1 or > 2048 || url.Any(character => character < 32 || character == 127))
            throw new InvalidDataException("URL length or characters are invalid.");
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || string.IsNullOrEmpty(uri.Host) || !string.IsNullOrEmpty(uri.UserInfo))
            throw new InvalidDataException("URL must be an absolute HTTP or HTTPS URL without userinfo.");
        if (!DateTimeOffset.TryParse(String(payload, "expiresAt"), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var expiresAt))
            throw new InvalidDataException("expiresAt is invalid.");
        return new Request(url, expiresAt.ToUniversalTime());
    }

    private static string String(JsonElement payload, string name) => payload.GetProperty(name).ValueKind == JsonValueKind.String
        ? payload.GetProperty(name).GetString()!
        : throw new InvalidDataException($"{name} must be a string.");
    private static ExecutionResult Success(uint sessionId, int pid, long duration) => new("success", JsonSerializer.Serialize(new { sessionId, processStarted = true, pid, durationMs = duration, expired = false, error = (object?)null }), null);
    private static ExecutionResult Failed(string code, string message, long duration, uint? sessionId = null, bool expired = false) => new("failed", JsonSerializer.Serialize(new { sessionId, processStarted = false, pid = (int?)null, durationMs = duration, expired, error = new { code, message = Sanitize(message) } }), null);
    private static string Sanitize(string value) => new(value.Where(character => character >= 32 && character != 127).Take(512).ToArray());
    private sealed record Request(string OriginalUrl, DateTimeOffset ExpiresAt);
}

internal static class OpenUrlNativeMethods
{
    internal const uint TokenAllAccess = 0x000f01ff;
    internal const int SecurityImpersonation = 2;
    internal const int TokenPrimary = 1;
    internal const uint CreateUnicodeEnvironment = 0x00000400;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct StartupInfo
    {
        public int Cb;
        public string? Reserved;
        public string? Desktop;
        public string? Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public int Flags;
        public short ShowWindow;
        public short Reserved2;
        public IntPtr Reserved2Pointer;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public uint ProcessId;
        public uint ThreadId;
    }

    [DllImport("Wtsapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);
    [DllImport("Advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DuplicateTokenEx(IntPtr existingToken, uint desiredAccess, IntPtr attributes, int impersonationLevel, int tokenType, out IntPtr newToken);
    [DllImport("Userenv.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, [MarshalAs(UnmanagedType.Bool)] bool inherit);
    [DllImport("Userenv.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DestroyEnvironmentBlock(IntPtr environment);
    [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcessAsUser(IntPtr token, string applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment,
        string? currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);
    [DllImport("Kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);
}
