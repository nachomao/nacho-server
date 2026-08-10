using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public interface IManagedArtifactDownloader
{
    Task<long> DownloadManagedArtifactAsync(
        string artifactId,
        string commandId,
        string destination,
        long expectedSize,
        CancellationToken cancellationToken);
}

public sealed record PackageProcessStarted(int ProcessId, string ExecutablePath, DateTimeOffset StartedAt);
public sealed record PackageRunResult(int? ExitCode, bool TimedOut, int ProcessId);

public interface IPackageInstallerRunner
{
    Task<PackageRunResult> RunAsync(
        string executablePath,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        int timeoutSeconds,
        Func<PackageProcessStarted, CancellationToken, Task> onStarted,
        CancellationToken cancellationToken);

    Task<PackageRunResult?> ResumeAsync(
        int processId,
        string executablePath,
        DateTimeOffset startedAt,
        int timeoutSeconds,
        CancellationToken cancellationToken);
}

public sealed class PackageInstallerRunner : IPackageInstallerRunner
{
    public async Task<PackageRunResult> RunAsync(
        string executablePath,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        int timeoutSeconds,
        Func<PackageProcessStarted, CancellationToken, Task> onStarted,
        CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executablePath,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);
        using var process = new Process { StartInfo = startInfo };
        if (!process.Start()) throw new InvalidOperationException("Installer process failed to start.");
        var startedAt = process.StartTime.ToUniversalTime();
        await onStarted(new PackageProcessStarted(process.Id, Path.GetFullPath(executablePath), startedAt), cancellationToken);
        return await WaitAsync(process, timeoutSeconds, cancellationToken);
    }

    public async Task<PackageRunResult?> ResumeAsync(
        int processId,
        string executablePath,
        DateTimeOffset startedAt,
        int timeoutSeconds,
        CancellationToken cancellationToken)
    {
        Process process;
        try { process = Process.GetProcessById(processId); }
        catch (ArgumentException) { return null; }
        using (process)
        {
            try
            {
                if (process.HasExited) return null;
                var actualPath = process.MainModule?.FileName;
                if (actualPath is null || !string.Equals(Path.GetFullPath(actualPath), Path.GetFullPath(executablePath), StringComparison.OrdinalIgnoreCase)) return null;
                if (Math.Abs((process.StartTime.ToUniversalTime() - startedAt.UtcDateTime).TotalSeconds) > 2) return null;
            }
            catch (InvalidOperationException) { return null; }

            var elapsed = Math.Max(0, (DateTimeOffset.UtcNow - startedAt).TotalSeconds);
            var remaining = Math.Max(1, timeoutSeconds - (int)Math.Floor(elapsed));
            return await WaitAsync(process, remaining, cancellationToken);
        }
    }

    private static async Task<PackageRunResult> WaitAsync(Process process, int timeoutSeconds, CancellationToken cancellationToken)
    {
        var exitTask = process.WaitForExitAsync(CancellationToken.None);
        var timeoutTask = Task.Delay(TimeSpan.FromSeconds(timeoutSeconds), CancellationToken.None);
        var canceledTask = Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        var completed = await Task.WhenAny(exitTask, timeoutTask, canceledTask);
        if (completed == canceledTask) throw new OperationCanceledException(cancellationToken);
        if (completed == timeoutTask)
        {
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            await process.WaitForExitAsync(CancellationToken.None);
            return new PackageRunResult(process.HasExited ? process.ExitCode : null, true, process.Id);
        }
        await exitTask;
        return new PackageRunResult(process.ExitCode, false, process.Id);
    }
}

public sealed class PackageInstallManager(
    AgentPaths paths,
    IManagedArtifactDownloader downloader,
    IPackageInstallerRunner runner,
    IOptions<AgentOptions> options,
    ILogger<PackageInstallManager> logger)
{
    public const long MaximumPackageBytes = 1024L * 1024 * 1024;
    private static readonly Regex ArtifactIdPattern = new("^artifact-[a-f0-9]{12}$", RegexOptions.CultureInvariant);
    private static readonly Regex Sha256Pattern = new("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex MsiPropertyPattern = new("^[A-Za-z_][A-Za-z0-9_]*=.+$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> AllowedFields = new(StringComparer.Ordinal)
    {
        "artifactId", "fileName", "sha256", "sizeBytes", "installerType", "arguments", "successExitCodes", "timeoutSeconds",
    };

    public async Task<ExecutionResult> ExecuteAsync(
        string commandId,
        JsonElement payload,
        Func<string, CancellationToken, Task> reportProgress,
        CancellationToken cancellationToken)
    {
        PackageInstallRequest request;
        try { request = ParsePayload(payload); }
        catch (Exception ex) when (ex is InvalidDataException or OverflowException)
        {
            return Failed(null, "validation", 0, false, null, false, 0, ex.Message);
        }
        if (!options.Value.DisableAllPolicies && !options.Value.AllowPackageInstall)
            return Failed(request, "policy", 0, false, null, false, 0, "Package installation is disabled by local policy.");

        var intentPath = paths.PackageInstallIntentFile(commandId);
        if (File.Exists(intentPath)) return await ResumeAsync(commandId, payload, reportProgress, cancellationToken);

        var directory = Path.GetDirectoryName(intentPath)!;
        Directory.CreateDirectory(directory);
        EnsureFreeSpace(directory, request.SizeBytes);
        var packagePath = Path.Combine(directory, request.FileName);
        var intent = NewIntent(commandId, request, packagePath);
        WriteIntent(intentPath, intent);
        var started = Stopwatch.StartNew();
        try
        {
            await reportProgress(Result(request, "downloading", 0, false, null, false, started.ElapsedMilliseconds, null), cancellationToken);
            var downloaded = await downloader.DownloadManagedArtifactAsync(request.ArtifactId, commandId, packagePath, request.SizeBytes, cancellationToken);
            intent.DownloadedBytes = downloaded;
            if (downloaded != request.SizeBytes) throw new InvalidDataException("Downloaded byte count does not match sizeBytes.");
            intent.Phase = "verifying";
            intent.UpdatedAt = DateTimeOffset.UtcNow;
            WriteIntent(intentPath, intent);

            await using (var stream = File.OpenRead(packagePath))
            {
                var actual = await SHA256.HashDataAsync(stream, cancellationToken);
                if (!CryptographicOperations.FixedTimeEquals(actual, Convert.FromHexString(request.Sha256)))
                    throw new InvalidDataException("Downloaded package SHA-256 mismatch.");
            }
            intent.HashVerified = true;
            intent.Phase = "verified";
            intent.UpdatedAt = DateTimeOffset.UtcNow;
            WriteIntent(intentPath, intent);
            await reportProgress(Result(request, "verified", downloaded, true, null, false, started.ElapsedMilliseconds, null), cancellationToken);

            var launch = BuildLaunch(request, packagePath);
            intent.Phase = "starting";
            intent.ProcessPath = launch.ExecutablePath;
            intent.UpdatedAt = DateTimeOffset.UtcNow;
            WriteIntent(intentPath, intent);
            var run = await runner.RunAsync(
                launch.ExecutablePath,
                launch.Arguments,
                directory,
                request.TimeoutSeconds,
                async (process, token) =>
                {
                    intent.ProcessId = process.ProcessId;
                    intent.ProcessPath = process.ExecutablePath;
                    intent.ProcessStartedAt = process.StartedAt;
                    intent.Phase = "installing";
                    intent.UpdatedAt = DateTimeOffset.UtcNow;
                    WriteIntent(intentPath, intent);
                    await reportProgress(Result(request, "installing", downloaded, true, null, false, started.ElapsedMilliseconds, null), token);
                },
                cancellationToken);
            return Complete(intentPath, intent, request, run, started.ElapsedMilliseconds);
        }
        catch (OperationCanceledException)
        {
            intent.DurationMs = started.ElapsedMilliseconds;
            intent.UpdatedAt = DateTimeOffset.UtcNow;
            WriteIntent(intentPath, intent);
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Package installation {CommandId} failed", commandId);
            intent.Phase = "failed";
            intent.Error = SanitizeError(ex.Message);
            intent.DurationMs = started.ElapsedMilliseconds;
            intent.UpdatedAt = DateTimeOffset.UtcNow;
            WriteIntent(intentPath, intent);
            var result = Failed(request, intent.Phase, intent.DownloadedBytes, intent.HashVerified, null, false, intent.DurationMs, intent.Error);
            Cleanup(directory);
            return result;
        }
    }

    public async Task<ExecutionResult> ResumeAsync(
        string commandId,
        JsonElement payload,
        Func<string, CancellationToken, Task> reportProgress,
        CancellationToken cancellationToken)
    {
        PackageInstallRequest request;
        try { request = ParsePayload(payload); }
        catch (Exception ex) when (ex is InvalidDataException or OverflowException)
        {
            return Failed(null, "validation", 0, false, null, false, 0, ex.Message);
        }
        var intentPath = paths.PackageInstallIntentFile(commandId);
        if (!File.Exists(intentPath))
            return Failed(request, "unknown", 0, false, null, false, 0, "Package installation state is unknown after Agent restart.");
        PackageInstallIntent intent;
        try { intent = ReadIntent(intentPath); }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or IOException)
        {
            return Failed(request, "unknown", 0, false, null, false, 0, $"Package installation intent is invalid: {SanitizeError(ex.Message)}");
        }
        if (!string.Equals(intent.CommandId, commandId, StringComparison.Ordinal) || !IntentMatches(intent, request))
            return Failed(request, "unknown", intent.DownloadedBytes, intent.HashVerified, null, false, intent.DurationMs, "Package installation intent does not match the command.");

        var directory = Path.GetDirectoryName(intentPath)!;
        if (intent.Phase is "downloading" or "verifying" or "verified")
        {
            Cleanup(directory);
            return await ExecuteAsync(commandId, payload, reportProgress, cancellationToken);
        }
        if (intent.Phase is "success" or "failed")
        {
            var status = intent.Phase == "success" ? "success" : "failed";
            var result = new ExecutionResult(status, Result(request, intent.Phase, intent.DownloadedBytes, intent.HashVerified, intent.ExitCode, intent.TimedOut, intent.DurationMs, intent.Error, intent.RebootRequired), intent.ExitCode);
            Cleanup(directory);
            return result;
        }
        if (intent.Phase is not "installing" || intent.ProcessId is null || intent.ProcessPath is null || intent.ProcessStartedAt is null)
        {
            var result = Failed(request, "unknown", intent.DownloadedBytes, intent.HashVerified, null, false, intent.DurationMs, "Package installation state is unknown after Agent restart.");
            Cleanup(directory);
            return result;
        }

        await reportProgress(Result(request, "installing", intent.DownloadedBytes, true, null, false, intent.DurationMs, null), cancellationToken);
        var run = await runner.ResumeAsync(intent.ProcessId.Value, intent.ProcessPath, intent.ProcessStartedAt.Value, request.TimeoutSeconds, cancellationToken);
        if (run is null)
        {
            var unknown = Failed(request, "unknown", intent.DownloadedBytes, intent.HashVerified, null, false, intent.DurationMs, "Installer process is no longer available; installation state is unknown.");
            Cleanup(directory);
            return unknown;
        }
        return Complete(intentPath, intent, request, run, Math.Max(intent.DurationMs, (long)(DateTimeOffset.UtcNow - intent.CreatedAt).TotalMilliseconds));
    }

    public static PackageInstallRequest ParsePayload(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Payload must be an object.");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in payload.EnumerateObject())
        {
            if (!AllowedFields.Contains(property.Name) || !seen.Add(property.Name))
                throw new InvalidDataException($"Payload contains unsupported or duplicate field: {property.Name}.");
        }
        if (seen.Count != AllowedFields.Count) throw new InvalidDataException("Payload fields are incomplete.");
        var artifactId = RequiredString(payload, "artifactId");
        var fileName = RequiredString(payload, "fileName");
        var sha256 = RequiredString(payload, "sha256");
        var installerType = RequiredString(payload, "installerType").ToLowerInvariant();
        if (!ArtifactIdPattern.IsMatch(artifactId)) throw new InvalidDataException("artifactId is invalid.");
        if (fileName != Path.GetFileName(fileName) || fileName.Length > 255 || fileName.Any(IsUnsafeControl)) throw new InvalidDataException("fileName is unsafe.");
        if (installerType is not ("msi" or "exe") || !fileName.EndsWith($".{installerType}", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("installerType and fileName do not match.");
        if (!Sha256Pattern.IsMatch(sha256)) throw new InvalidDataException("sha256 must contain 64 lowercase hexadecimal characters.");
        if (!payload.TryGetProperty("sizeBytes", out var sizeElement) || !sizeElement.TryGetInt64(out var sizeBytes) || sizeBytes <= 0 || sizeBytes > MaximumPackageBytes) throw new InvalidDataException("sizeBytes is invalid.");
        if (!payload.TryGetProperty("timeoutSeconds", out var timeoutElement) || !timeoutElement.TryGetInt32(out var timeoutSeconds) || timeoutSeconds is < 60 or > 7200) throw new InvalidDataException("timeoutSeconds must be from 60 to 7200.");
        var arguments = ReadStringArray(payload, "arguments", 64, 4096);
        if (installerType == "msi" && arguments.Any(argument => !MsiPropertyPattern.IsMatch(argument))) throw new InvalidDataException("MSI arguments must use PROPERTY=value form.");
        var successExitCodes = ReadExitCodes(payload);
        if (!successExitCodes.Contains(0)) throw new InvalidDataException("successExitCodes must include 0.");
        if (installerType == "msi" && !successExitCodes.Contains(3010)) throw new InvalidDataException("MSI successExitCodes must include 3010.");
        return new PackageInstallRequest(artifactId, fileName, sha256, sizeBytes, installerType, arguments, successExitCodes, timeoutSeconds);
    }

    public static string ErrorJson(JsonElement payload, string error)
    {
        try { return Failed(ParsePayload(payload), "unknown", 0, false, null, false, 0, error).Result; }
        catch { return Failed(null, "unknown", 0, false, null, false, 0, error).Result; }
    }

    private static ExecutionResult Complete(string intentPath, PackageInstallIntent intent, PackageInstallRequest request, PackageRunResult run, long durationMs)
    {
        var successful = !run.TimedOut && run.ExitCode is int exitCode && request.SuccessExitCodes.Contains(exitCode);
        intent.ExitCode = run.ExitCode;
        intent.TimedOut = run.TimedOut;
        intent.RebootRequired = request.InstallerType == "msi" && run.ExitCode == 3010;
        intent.Error = successful ? null : run.TimedOut ? "Installer timed out." : $"Installer exited with code {run.ExitCode?.ToString() ?? "unknown"}.";
        intent.Phase = successful ? "success" : "failed";
        intent.DurationMs = durationMs;
        intent.UpdatedAt = DateTimeOffset.UtcNow;
        WriteIntent(intentPath, intent);
        var result = new ExecutionResult(successful ? "success" : "failed", Result(request, intent.Phase, intent.DownloadedBytes, intent.HashVerified, run.ExitCode, run.TimedOut, durationMs, intent.Error, intent.RebootRequired), run.ExitCode);
        Cleanup(Path.GetDirectoryName(intentPath)!);
        return result;
    }

    private static PackageInstallIntent NewIntent(string commandId, PackageInstallRequest request, string packagePath) => new()
    {
        CommandId = commandId,
        ArtifactId = request.ArtifactId,
        FileName = request.FileName,
        Sha256 = request.Sha256,
        SizeBytes = request.SizeBytes,
        InstallerType = request.InstallerType,
        Arguments = request.Arguments,
        SuccessExitCodes = request.SuccessExitCodes,
        TimeoutSeconds = request.TimeoutSeconds,
        PackagePath = packagePath,
        Phase = "downloading",
    };

    private static bool IntentMatches(PackageInstallIntent intent, PackageInstallRequest request) =>
        intent.ArtifactId == request.ArtifactId && intent.FileName == request.FileName && intent.Sha256 == request.Sha256 &&
        intent.SizeBytes == request.SizeBytes && intent.InstallerType == request.InstallerType && intent.TimeoutSeconds == request.TimeoutSeconds &&
        intent.Arguments.SequenceEqual(request.Arguments) && intent.SuccessExitCodes.SequenceEqual(request.SuccessExitCodes);

    private static PackageLaunch BuildLaunch(PackageInstallRequest request, string packagePath)
    {
        if (request.InstallerType == "msi")
        {
            var executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "msiexec.exe");
            return new PackageLaunch(executable, ["/i", packagePath, "/qn", "/norestart", .. request.Arguments]);
        }
        return new PackageLaunch(packagePath, request.Arguments);
    }

    private static void EnsureFreeSpace(string directory, long sizeBytes)
    {
        var root = Path.GetPathRoot(Path.GetFullPath(directory)) ?? throw new InvalidDataException("Package path has no drive root.");
        if (new DriveInfo(root).AvailableFreeSpace < checked(sizeBytes * 2 + 100L * 1024 * 1024))
            throw new IOException("Insufficient free space for package installation.");
    }

    private static PackageInstallIntent ReadIntent(string path) => JsonSerializer.Deserialize(File.ReadAllText(path), AgentJsonContext.Default.PackageInstallIntent)
        ?? throw new InvalidDataException("Package installation intent is empty.");
    private static void WriteIntent(string path, PackageInstallIntent intent) => AgentUpdater.WriteAtomic(path, intent, AgentJsonContext.Default.PackageInstallIntent);
    private static void Cleanup(string directory) { try { if (Directory.Exists(directory)) Directory.Delete(directory, true); } catch { } }
    private static string RequiredString(JsonElement payload, string name) => payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
        ? value.GetString()! : throw new InvalidDataException($"{name} is required.");
    private static bool IsUnsafeControl(char value) => value == '\0' || char.IsControl(value);
    private static string[] ReadStringArray(JsonElement payload, string name, int maximumItems, int maximumLength)
    {
        if (!payload.TryGetProperty(name, out var element) || element.ValueKind != JsonValueKind.Array) throw new InvalidDataException($"{name} must be an array.");
        var values = new List<string>();
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String) throw new InvalidDataException($"{name} must contain strings.");
            var value = item.GetString() ?? "";
            if (value.Length > maximumLength || value.Any(IsUnsafeControl)) throw new InvalidDataException($"{name} contains an invalid value.");
            values.Add(value);
            if (values.Count > maximumItems) throw new InvalidDataException($"{name} contains too many items.");
        }
        return [.. values];
    }
    private static int[] ReadExitCodes(JsonElement payload)
    {
        if (!payload.TryGetProperty("successExitCodes", out var element) || element.ValueKind != JsonValueKind.Array) throw new InvalidDataException("successExitCodes must be an array.");
        var values = new List<int>();
        foreach (var item in element.EnumerateArray())
        {
            if (!item.TryGetInt32(out var value) || value is < 0 or > 65_535) throw new InvalidDataException("successExitCodes contains an invalid value.");
            if (!values.Contains(value)) values.Add(value); else throw new InvalidDataException("successExitCodes must be unique.");
            if (values.Count > 32) throw new InvalidDataException("successExitCodes contains too many values.");
        }
        if (values.Count == 0) throw new InvalidDataException("successExitCodes must not be empty.");
        return [.. values];
    }
    private static string SanitizeError(string value) => new(value.Where(character => character is '\r' or '\n' or '\t' || !char.IsControl(character)).Take(1024).ToArray());
    private static ExecutionResult Failed(PackageInstallRequest? request, string phase, long downloadedBytes, bool hashVerified, int? exitCode, bool timedOut, long durationMs, string error) =>
        new("failed", Result(request, phase, downloadedBytes, hashVerified, exitCode, timedOut, durationMs, SanitizeError(error)), exitCode);
    private static string Result(PackageInstallRequest? request, string phase, long downloadedBytes, bool hashVerified, int? exitCode, bool timedOut, long durationMs, string? error, bool rebootRequired = false) =>
        JsonSerializer.Serialize(new { phase, downloadedBytes, hashVerified, installerType = request?.InstallerType, exitCode, rebootRequired, durationMs, timedOut, error });

    private sealed record PackageLaunch(string ExecutablePath, string[] Arguments);
    public sealed record PackageInstallRequest(string ArtifactId, string FileName, string Sha256, long SizeBytes, string InstallerType, string[] Arguments, int[] SuccessExitCodes, int TimeoutSeconds);
}
