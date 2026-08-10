using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public sealed class FileDeploymentManager(
    AgentPaths paths,
    IManagedArtifactDownloader downloader,
    IOptions<AgentOptions> options,
    ILogger<FileDeploymentManager> logger)
{
    public const long MaximumFileBytes = 512L * 1024 * 1024;
    private static readonly Regex ArtifactIdPattern = new("^artifact-[a-f0-9]{12}$", RegexOptions.CultureInvariant);
    private static readonly Regex CommandIdPattern = new("^cmd-[a-f0-9]{12}$", RegexOptions.CultureInvariant);
    private static readonly Regex Sha256Pattern = new("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> DeployFields = new(StringComparer.Ordinal)
    {
        "artifactId", "fileName", "sha256", "sizeBytes", "destinationPath", "conflictPolicy", "createDirectories",
    };
    private static readonly HashSet<string> RollbackFields = new(StringComparer.Ordinal) { "originalCommandId" };

    public async Task<ExecutionResult> ExecuteAsync(
        string commandId,
        JsonElement payload,
        Func<string, CancellationToken, Task> reportProgress,
        CancellationToken cancellationToken)
    {
        FileDeployRequest request;
        try { request = ParsePayload(payload); }
        catch (Exception ex) when (ex is InvalidDataException or OverflowException) { return Failed("validation", null, ex.Message); }
        if (!options.Value.DisableAllPolicies && !options.Value.AllowedDeployRoots.Any()) return Failed("policy", request, "File deployment is disabled because allowedDeployRoots is empty.");
        CleanupExpiredIntents();
        var intentPath = paths.FileDeployIntentFile(commandId);
        if (File.Exists(intentPath)) return await ResumeAsync(commandId, payload, reportProgress, cancellationToken);
        try { ValidateDestination(request.DestinationPath); }
        catch (Exception ex) when (ex is InvalidDataException or IOException) { return Failed("validation", request, ex.Message); }
        return await ExecuteFreshAsync(commandId, request, reportProgress, cancellationToken);
    }

    private async Task<ExecutionResult> ExecuteFreshAsync(
        string commandId,
        FileDeployRequest request,
        Func<string, CancellationToken, Task> reportProgress,
        CancellationToken cancellationToken)
    {
        var started = Stopwatch.StartNew();
        var commandDirectory = Path.Combine(paths.FileDeploymentsDirectory, commandId);
        Directory.CreateDirectory(commandDirectory);
        var stagedPath = Path.Combine(commandDirectory, "staged.bin");
        var backupPath = Path.Combine(commandDirectory, "backup.bin");
        var intentPath = paths.FileDeployIntentFile(commandId);
        var intent = new FileDeployIntent
        {
            CommandId = commandId,
            ArtifactId = request.ArtifactId,
            FileName = request.FileName,
            Sha256 = request.Sha256,
            SizeBytes = request.SizeBytes,
            DestinationPath = request.DestinationPath,
            ConflictPolicy = request.ConflictPolicy,
            CreateDirectories = request.CreateDirectories,
            TemporaryPath = stagedPath,
            BackupPath = request.ConflictPolicy == "replace" ? backupPath : null,
            Phase = "downloading",
        };
        WriteIntent(intentPath, intent);
        try
        {
            if (File.Exists(request.DestinationPath) && request.ConflictPolicy == "fail")
                throw new IOException("Destination file already exists.");
            if (Directory.Exists(request.DestinationPath)) throw new IOException("Destination path is a directory.");
            var parent = Path.GetDirectoryName(request.DestinationPath)!;
            if (!Directory.Exists(parent))
            {
                if (!request.CreateDirectories) throw new DirectoryNotFoundException("Destination directory does not exist.");
                Directory.CreateDirectory(parent);
            }
            EnsureFreeSpace(commandDirectory, request.SizeBytes);
            await reportProgress(Result(intent, "downloading", started.ElapsedMilliseconds, null), cancellationToken);
            var downloaded = await downloader.DownloadManagedArtifactAsync(request.ArtifactId, commandId, stagedPath, request.SizeBytes, cancellationToken);
            intent.DownloadedBytes = downloaded;
            if (downloaded != request.SizeBytes) throw new InvalidDataException("Downloaded byte count does not match sizeBytes.");
            intent.Phase = "verifying";
            WriteIntent(intentPath, intent);
            var actual = await HashFileAsync(stagedPath, cancellationToken);
            if (!CryptographicOperations.FixedTimeEquals(actual, Convert.FromHexString(request.Sha256))) throw new InvalidDataException("Downloaded file SHA-256 mismatch.");
            intent.HashVerified = true;
            intent.Phase = "verified";
            WriteIntent(intentPath, intent);
            await reportProgress(Result(intent, "verified", started.ElapsedMilliseconds, null), cancellationToken);

            if (File.Exists(request.DestinationPath))
            {
                intent.PreviousSha256 = Convert.ToHexString(await HashFileAsync(request.DestinationPath, cancellationToken)).ToLowerInvariant();
                intent.Phase = "backing-up";
                WriteIntent(intentPath, intent);
                File.Move(request.DestinationPath, backupPath);
                intent.Replaced = true;
                intent.BackupValid = true;
                WriteIntent(intentPath, intent);
            }
            intent.Phase = "applying";
            WriteIntent(intentPath, intent);
            File.Move(stagedPath, request.DestinationPath, true);
            intent.FinalSha256 = request.Sha256;
            intent.Phase = "success";
            intent.DurationMs = started.ElapsedMilliseconds;
            intent.UpdatedAt = DateTimeOffset.UtcNow;
            WriteIntent(intentPath, intent);
            return new ExecutionResult("success", Result(intent, "success", intent.DurationMs, null), 0);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            logger.LogError(ex, "File deployment {CommandId} failed", commandId);
            TryRestoreBackup(intent);
            intent.Phase = "failed";
            intent.Error = SanitizeError(ex.Message);
            intent.DurationMs = started.ElapsedMilliseconds;
            intent.UpdatedAt = DateTimeOffset.UtcNow;
            WriteIntent(intentPath, intent);
            TryDelete(stagedPath);
            return new ExecutionResult("failed", Result(intent, "failed", intent.DurationMs, intent.Error), null);
        }
    }

    public async Task<ExecutionResult> ResumeAsync(
        string commandId,
        JsonElement payload,
        Func<string, CancellationToken, Task> reportProgress,
        CancellationToken cancellationToken)
    {
        FileDeployRequest request;
        try { request = ParsePayload(payload); }
        catch (Exception ex) when (ex is InvalidDataException or OverflowException) { return Failed("validation", null, ex.Message); }
        var intentPath = paths.FileDeployIntentFile(commandId);
        if (!File.Exists(intentPath)) return Failed("unknown", request, "File deployment state is unknown after Agent restart.");
        FileDeployIntent intent;
        try { intent = ReadIntent(intentPath); }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or IOException) { return Failed("unknown", request, $"File deployment intent is invalid: {SanitizeError(ex.Message)}"); }
        if (!IntentMatches(intent, request)) return Failed("unknown", request, "File deployment intent does not match the command.");
        if (intent.Phase == "success") return new ExecutionResult("success", Result(intent, "success", intent.DurationMs, null), 0);
        if (intent.Phase == "failed") return new ExecutionResult("failed", Result(intent, "failed", intent.DurationMs, intent.Error), null);
        if (intent.Phase is "downloading" or "verifying" or "verified")
        {
            TryDeleteDirectory(Path.GetDirectoryName(intentPath)!);
            return await ExecuteAsync(commandId, payload, reportProgress, cancellationToken);
        }
        if (intent.Phase is "backing-up" or "applying")
        {
            var current = File.Exists(intent.DestinationPath) ? Convert.ToHexString(await HashFileAsync(intent.DestinationPath, cancellationToken)).ToLowerInvariant() : null;
            if (current == intent.Sha256)
            {
                intent.FinalSha256 = intent.Sha256;
                intent.Phase = "success";
                WriteIntent(intentPath, intent);
                return new ExecutionResult("success", Result(intent, "success", intent.DurationMs, null), 0);
            }
            TryRestoreBackup(intent);
            return new ExecutionResult("failed", Result(intent, "unknown", intent.DurationMs, "File deployment state is unknown after Agent restart."), null);
        }
        return Failed("unknown", request, "File deployment state is unknown after Agent restart.");
    }

    public async Task<ExecutionResult> RollbackAsync(string commandId, JsonElement payload, CancellationToken cancellationToken)
    {
        RollbackRequest request;
        try { request = ParseRollbackPayload(payload); }
        catch (Exception ex) when (ex is InvalidDataException or OverflowException) { return RollbackFailed("validation", null, null, ex.Message); }
        if (!options.Value.DisableAllPolicies && !options.Value.AllowedDeployRoots.Any()) return RollbackFailed("policy", request.OriginalCommandId, null, "File deployment is disabled because allowedDeployRoots is empty.");
        CleanupExpiredIntents();
        var intentPath = paths.FileDeployIntentFile(request.OriginalCommandId);
        if (!File.Exists(intentPath)) return RollbackFailed("unknown", request.OriginalCommandId, null, "Original file deployment intent is missing.");
        FileDeployIntent intent;
        try { intent = ReadIntent(intentPath); }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or IOException) { return RollbackFailed("unknown", request.OriginalCommandId, null, "Original file deployment intent is invalid."); }
        if (intent.Phase == "rolled-back" && intent.RollbackCommandId == commandId && intent.RollbackPhase == "success")
            return new ExecutionResult("success", RollbackResult(intent, "success", null), 0);
        try { ValidateDestination(intent.DestinationPath); }
        catch (Exception ex) when (ex is InvalidDataException or IOException) { return RollbackFailed("validation", request.OriginalCommandId, intent.DestinationPath, ex.Message); }
        var backupPath = intent.BackupPath;
        var temporaryCurrent = (backupPath ?? Path.Combine(Path.GetDirectoryName(intentPath)!, "backup.bin")) + ".rollback-current";
        if (intent.RollbackCommandId == commandId && intent.RollbackPhase == "started")
        {
            var currentHash = File.Exists(intent.DestinationPath)
                ? Convert.ToHexString(await HashFileAsync(intent.DestinationPath, cancellationToken)).ToLowerInvariant()
                : null;
            if (currentHash == intent.PreviousSha256 && (backupPath is null || !File.Exists(backupPath)))
                return CompleteRollback(intentPath, intent, temporaryCurrent, currentHash);
            if (currentHash is null && backupPath is not null && File.Exists(backupPath))
            {
                File.Move(backupPath, intent.DestinationPath, true);
                var restored = Convert.ToHexString(await HashFileAsync(intent.DestinationPath, cancellationToken)).ToLowerInvariant();
                return CompleteRollback(intentPath, intent, temporaryCurrent, restored);
            }
            if (currentHash is null && File.Exists(temporaryCurrent))
            {
                File.Move(temporaryCurrent, intent.DestinationPath, true);
                return RollbackFailed("unknown", request.OriginalCommandId, intent.DestinationPath, "Rollback was interrupted and the deployed file was restored.");
            }
        }
        if (intent.Phase != "success" || !intent.BackupValid || string.IsNullOrWhiteSpace(intent.BackupPath) || !File.Exists(intent.BackupPath))
            return RollbackFailed("validation", request.OriginalCommandId, intent.DestinationPath, "Original file deployment has no valid backup.");
        if (intent.RollbackCommandId is not null && !string.Equals(intent.RollbackCommandId, commandId, StringComparison.Ordinal)) return RollbackFailed("conflict", request.OriginalCommandId, intent.DestinationPath, "Another rollback command owns this backup.");
        try
        {
            var currentHash = File.Exists(intent.DestinationPath)
                ? Convert.ToHexString(await HashFileAsync(intent.DestinationPath, cancellationToken)).ToLowerInvariant()
                : null;
            if (currentHash != intent.FinalSha256) return RollbackFailed("conflict", request.OriginalCommandId, intent.DestinationPath, "Destination file changed after deployment; rollback refused.");
            intent.RollbackCommandId ??= commandId;
            intent.RollbackPhase = "started";
            WriteIntent(intentPath, intent);
            File.Move(intent.DestinationPath, temporaryCurrent, true);
            File.Move(intent.BackupPath, intent.DestinationPath, true);
            var restored = Convert.ToHexString(await HashFileAsync(intent.DestinationPath, cancellationToken)).ToLowerInvariant();
            return CompleteRollback(intentPath, intent, temporaryCurrent, restored);
        }
        catch (Exception ex)
        {
            var currentRestored = File.Exists(intent.DestinationPath);
            if (!currentRestored && File.Exists(temporaryCurrent))
            {
                try { File.Move(temporaryCurrent, intent.DestinationPath, true); currentRestored = true; }
                catch { currentRestored = false; }
            }
            if (currentRestored) intent.RollbackCommandId = null;
            intent.RollbackPhase = "failed";
            intent.Error = SanitizeError(ex.Message);
            WriteIntent(intentPath, intent);
            TryDelete(temporaryCurrent);
            return new ExecutionResult("failed", RollbackResult(intent, "failed", intent.Error), null);
        }
    }

    public static FileDeployRequest ParsePayload(JsonElement payload)
    {
        EnsureFields(payload, DeployFields);
        var artifactId = RequiredString(payload, "artifactId");
        var fileName = RequiredString(payload, "fileName");
        var sha256 = RequiredString(payload, "sha256");
        var destination = RequiredString(payload, "destinationPath");
        var conflict = RequiredString(payload, "conflictPolicy").ToLowerInvariant();
        if (!ArtifactIdPattern.IsMatch(artifactId)) throw new InvalidDataException("artifactId is invalid.");
        if (fileName != Path.GetFileName(fileName) || fileName.Length > 255 || fileName.Any(char.IsControl)) throw new InvalidDataException("fileName is unsafe.");
        if (!Sha256Pattern.IsMatch(sha256)) throw new InvalidDataException("sha256 must contain 64 lowercase hexadecimal characters.");
        if (!payload.TryGetProperty("sizeBytes", out var sizeElement) || !sizeElement.TryGetInt64(out var sizeBytes) || sizeBytes <= 0 || sizeBytes > MaximumFileBytes) throw new InvalidDataException("sizeBytes is invalid.");
        if (!payload.TryGetProperty("createDirectories", out var createElement) || createElement.ValueKind is not JsonValueKind.True and not JsonValueKind.False) throw new InvalidDataException("createDirectories is required.");
        if (conflict is not ("fail" or "replace")) throw new InvalidDataException("conflictPolicy must be fail or replace.");
        return new FileDeployRequest(artifactId, fileName, sha256, sizeBytes, destination, conflict, createElement.GetBoolean());
    }

    public static RollbackRequest ParseRollbackPayload(JsonElement payload)
    {
        EnsureFields(payload, RollbackFields);
        var original = RequiredString(payload, "originalCommandId");
        if (!CommandIdPattern.IsMatch(original)) throw new InvalidDataException("originalCommandId is invalid.");
        return new RollbackRequest(original);
    }

    public static string ErrorJson(JsonElement payload, string error)
    {
        try { var rollback = ParseRollbackPayload(payload); return RollbackFailed("unknown", rollback.OriginalCommandId, null, error).Result; }
        catch { try { return Failed("unknown", ParsePayload(payload), error).Result; } catch { return Failed("unknown", null, error).Result; } }
    }

    private void ValidateDestination(string destination)
    {
        if (destination.Length < 3 || destination.StartsWith("\\\\", StringComparison.Ordinal) || destination.StartsWith("//", StringComparison.Ordinal) || destination.StartsWith("\\\\?\\", StringComparison.Ordinal) || destination.StartsWith("\\\\.\\", StringComparison.Ordinal) || destination.EndsWith('\\') || destination.Contains('*') || destination.Contains('?') || destination[(destination[1] == ':' ? 2 : 0)..].Contains(':') || !Regex.IsMatch(destination, "^[A-Za-z]:\\\\.+$"))
            throw new InvalidDataException("Destination path must be a local absolute file path without wildcards, ADS, UNC, or device prefixes.");
        var full = Path.GetFullPath(destination);
        if (Path.GetPathRoot(full) is null || string.Equals(Path.TrimEndingDirectorySeparator(full), Path.TrimEndingDirectorySeparator(Path.GetPathRoot(full)!), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Destination path cannot be a drive root.");
        if (Directory.Exists(full)) throw new InvalidDataException("Destination path is a directory.");
        if (!options.Value.DisableAllPolicies && !options.Value.AllowedDeployRoots.Any(root => IsWithinRoot(root, full))) throw new InvalidDataException("Destination path is outside allowedDeployRoots.");
    }

    private static bool IsWithinRoot(string root, string destination)
    {
        try
        {
            var normalizedRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
            var normalizedDestination = Path.GetFullPath(destination);
            if (string.Equals(normalizedRoot, normalizedDestination, StringComparison.OrdinalIgnoreCase)) return false;
            var relative = Path.GetRelativePath(normalizedRoot, normalizedDestination);
            return !Path.IsPathRooted(relative) && relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal);
        }
        catch { return false; }
    }

    private void CleanupExpiredIntents()
    {
        if (!Directory.Exists(paths.FileDeploymentsDirectory)) return;
        var days = Math.Clamp(options.Value.FileDeployBackupRetentionDays, 1, 365);
        foreach (var directory in Directory.EnumerateDirectories(paths.FileDeploymentsDirectory))
        {
            var intentPath = Path.Combine(directory, "intent.json");
            try
            {
                if (!File.Exists(intentPath)) { TryDeleteDirectory(directory); continue; }
                var intent = ReadIntent(intentPath);
                if (intent.UpdatedAt < DateTimeOffset.UtcNow.AddDays(-days)) TryDeleteDirectory(directory);
            }
            catch (Exception ex) when (ex is JsonException or InvalidDataException or IOException) { TryDeleteDirectory(directory); }
        }
    }

    private static bool IntentMatches(FileDeployIntent intent, FileDeployRequest request) =>
        intent.ArtifactId == request.ArtifactId && intent.FileName == request.FileName && intent.Sha256 == request.Sha256 && intent.SizeBytes == request.SizeBytes && intent.DestinationPath == request.DestinationPath && intent.ConflictPolicy == request.ConflictPolicy && intent.CreateDirectories == request.CreateDirectories;

    private static async Task<byte[]> HashFileAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = File.OpenRead(path);
        return await SHA256.HashDataAsync(stream, cancellationToken);
    }
    private static void EnsureFreeSpace(string path, long bytes)
    {
        var root = Path.GetPathRoot(Path.GetFullPath(path)) ?? throw new InvalidDataException("Deployment path has no drive root.");
        if (new DriveInfo(root).AvailableFreeSpace < checked(bytes * 2 + 32L * 1024 * 1024)) throw new IOException("Insufficient free space for file deployment.");
    }

    private static void TryRestoreBackup(FileDeployIntent intent)
    {
        try
        {
            if (!File.Exists(intent.DestinationPath) && intent.BackupValid && intent.BackupPath is not null && File.Exists(intent.BackupPath))
            {
                File.Move(intent.BackupPath, intent.DestinationPath, true);
                intent.BackupValid = false;
            }
        }
        catch { }
    }

    private static void EnsureFields(JsonElement payload, HashSet<string> allowed)
    {
        if (payload.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Payload must be an object.");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in payload.EnumerateObject()) if (!allowed.Contains(property.Name) || !seen.Add(property.Name)) throw new InvalidDataException($"Payload contains unsupported or duplicate field: {property.Name}.");
        if (seen.Count != allowed.Count) throw new InvalidDataException("Payload fields are incomplete.");
    }

    private static string RequiredString(JsonElement payload, string name) => payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString()) ? value.GetString()! : throw new InvalidDataException($"{name} is required.");
    private static string SanitizeError(string value) => new(value.Where(character => character is '\r' or '\n' or '\t' || !char.IsControl(character)).Take(1024).ToArray());
    private static ExecutionResult CompleteRollback(string intentPath, FileDeployIntent intent, string temporaryCurrent, string? restored)
    {
        intent.BackupValid = false;
        intent.Phase = "rolled-back";
        intent.RollbackPhase = "success";
        intent.FinalSha256 = restored;
        intent.DurationMs = 0;
        WriteIntent(intentPath, intent);
        TryDelete(temporaryCurrent);
        return new ExecutionResult("success", RollbackResult(intent, "success", null), 0);
    }
    private static ExecutionResult Failed(string phase, FileDeployRequest? request, string error) => new("failed", JsonSerializer.Serialize(new { phase, downloadedBytes = 0L, hashVerified = false, destinationPath = request?.DestinationPath ?? "", conflictPolicy = request?.ConflictPolicy, replaced = false, backupValid = false, backupPath = (string?)null, previousSha256 = (string?)null, finalSha256 = (string?)null, durationMs = 0L, error = SanitizeError(error) }), null);
    private static ExecutionResult RollbackFailed(string phase, string? originalCommandId, string? destinationPath, string error) => new("failed", JsonSerializer.Serialize(new { phase, originalCommandId = originalCommandId ?? "", destinationPath = destinationPath ?? "", backupValid = false, restoredSha256 = (string?)null, error = SanitizeError(error) }), null);
    private static string Result(FileDeployIntent intent, string phase, long durationMs, string? error) => JsonSerializer.Serialize(new { phase, downloadedBytes = intent.DownloadedBytes, hashVerified = intent.HashVerified, destinationPath = intent.DestinationPath, conflictPolicy = intent.ConflictPolicy, replaced = intent.Replaced, backupValid = intent.BackupValid, backupPath = intent.BackupPath, previousSha256 = intent.PreviousSha256, finalSha256 = intent.FinalSha256, durationMs, error = error is null ? null : SanitizeError(error) });
    private static string RollbackResult(FileDeployIntent intent, string phase, string? error) => JsonSerializer.Serialize(new { phase, originalCommandId = intent.CommandId, destinationPath = intent.DestinationPath, backupValid = intent.BackupValid, restoredSha256 = intent.FinalSha256, error = error is null ? null : SanitizeError(error) });
    private static FileDeployIntent ReadIntent(string path) => JsonSerializer.Deserialize(File.ReadAllText(path), AgentJsonContext.Default.FileDeployIntent) ?? throw new InvalidDataException("File deployment intent is empty.");
    private static void WriteIntent(string path, FileDeployIntent value) => AgentUpdater.WriteAtomic(path, value, AgentJsonContext.Default.FileDeployIntent);
    private static void TryDelete(string path) { try { File.Delete(path); } catch { } }
    private static void TryDeleteDirectory(string path) { try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { } }

    public sealed record FileDeployRequest(string ArtifactId, string FileName, string Sha256, long SizeBytes, string DestinationPath, string ConflictPolicy, bool CreateDirectories);
    public sealed record RollbackRequest(string OriginalCommandId);
}
