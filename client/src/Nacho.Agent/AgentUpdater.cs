using System.Diagnostics;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public sealed class AgentUpdater(AgentPaths paths, AgentApiClient api, IOptions<AgentOptions> options, ILogger<AgentUpdater> logger)
{
    public const long MaximumArtifactBytes = 256L * 1024 * 1024;
    public static string CurrentVersion => typeof(AgentUpdater).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    public async Task<ExecutionResult> ExecuteAsync(
        string commandId,
        JsonElement payload,
        Func<string, CancellationToken, Task> reportProgress,
        CancellationToken cancellationToken)
    {
        if (!options.Value.DisableAllPolicies && !options.Value.AllowAgentUpdate) return Failed(CurrentVersion, null, "Agent updates are disabled by local policy.");
        if (File.Exists(paths.UpdateIntentFile)) return await ResumeAsync(commandId, cancellationToken);

        var started = Stopwatch.StartNew();
        UpdateIntent? intent = null;
        try
        {
            var request = ParsePayload(payload);
            if (CompareVersions(CurrentVersion, request.TargetVersion) is not < 0)
            {
                var phase = CompareVersions(CurrentVersion, request.TargetVersion) == 0 ? "already-current" : "failed";
                return new ExecutionResult(phase == "already-current" ? "success" : "failed",
                    Result(CurrentVersion, request.TargetVersion, phase, 0, started.ElapsedMilliseconds, false, null,
                        phase == "failed" ? "Target version must be newer than the running version." : null), null);
            }

            var updateDirectory = Path.Combine(paths.UpdatesDirectory, commandId);
            Directory.CreateDirectory(updateDirectory);
            EnsureFreeSpace(updateDirectory, request.SizeBytes);
            var stagedPath = Path.Combine(updateDirectory, request.FileName);
            await reportProgress(Result(CurrentVersion, request.TargetVersion, "downloading", 0, started.ElapsedMilliseconds, false, null, null), cancellationToken);
            var downloaded = await api.DownloadArtifactAsync(request.FileName, stagedPath, request.SizeBytes, cancellationToken);
            if (downloaded != request.SizeBytes) throw new InvalidDataException("Downloaded byte count does not match sizeBytes.");

            await using (var stream = File.OpenRead(stagedPath))
            {
                var hash = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
                if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(hash), Convert.FromHexString(request.Sha256)))
                    throw new InvalidDataException("Downloaded artifact SHA-256 mismatch.");
            }
            var metadataVersion = NormalizeFileVersion(FileVersionInfo.GetVersionInfo(stagedPath).FileVersion);
            if (!string.Equals(metadataVersion, request.TargetVersion, StringComparison.Ordinal))
                throw new InvalidDataException($"Artifact file version '{metadataVersion}' does not match targetVersion.");
            await reportProgress(Result(CurrentVersion, request.TargetVersion, "verified", downloaded, started.ElapsedMilliseconds, false, null, null), cancellationToken);

            var installPath = Environment.ProcessPath ?? throw new InvalidOperationException("The current executable path is unavailable.");
            intent = new UpdateIntent
            {
                CommandId = commandId,
                FromVersion = CurrentVersion,
                TargetVersion = request.TargetVersion,
                InstallPath = installPath,
                StagedPath = stagedPath,
                BackupPath = paths.LastKnownGoodFile,
                Sha256 = request.Sha256,
                SizeBytes = request.SizeBytes,
                DownloadedBytes = downloaded,
                Phase = "applying",
            };
            WriteAtomic(paths.UpdateIntentFile, intent, AgentJsonContext.Default.UpdateIntent);
            await reportProgress(Result(intent.FromVersion, intent.TargetVersion, "applying", downloaded, started.ElapsedMilliseconds, false, null, null), cancellationToken);
            _ = Process.Start(new ProcessStartInfo(stagedPath, $"--apply-update --data-dir \"{paths.DataDirectory}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = updateDirectory,
            }) ?? throw new InvalidOperationException("The update helper did not start.");

            while (!cancellationToken.IsCancellationRequested) await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
            throw new OperationCanceledException(cancellationToken);
        }
        catch (OperationCanceledException) when (intent is not null)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Agent update {CommandId} failed before replacement", commandId);
            return Failed(CurrentVersion, intent?.TargetVersion, ex.Message, intent?.DownloadedBytes ?? 0, started.ElapsedMilliseconds);
        }
    }

    private async Task<ExecutionResult> ResumeAsync(string commandId, CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow.AddMinutes(3);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var intent = ReadIntent(paths.UpdateIntentFile);
            if (!string.Equals(intent.CommandId, commandId, StringComparison.Ordinal))
                return Failed(CurrentVersion, intent.TargetVersion, "The persisted update intent belongs to another command.");
            if (intent.Phase == "healthy")
            {
                var result = new ExecutionResult("success", Result(intent.FromVersion, intent.TargetVersion, "healthy", intent.DownloadedBytes, intent.DurationMs, false, null, null), null);
                Cleanup(intent);
                return result;
            }
            if (intent.Phase == "rolled-back")
            {
                var result = new ExecutionResult("failed", Result(intent.FromVersion, intent.TargetVersion, "rolled-back", intent.DownloadedBytes, intent.DurationMs, true, intent.RollbackReason, intent.Error), null);
                Cleanup(intent);
                return result;
            }
            await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
        }
        return Failed(CurrentVersion, null, "Timed out waiting for the update helper result.");
    }

    private void Cleanup(UpdateIntent intent)
    {
        try { if (Directory.Exists(Path.GetDirectoryName(intent.StagedPath))) Directory.Delete(Path.GetDirectoryName(intent.StagedPath)!, true); } catch { }
        try { File.Delete(paths.UpdateIntentFile); } catch { }
    }

    public static async Task<int> ApplyUpdateAsync(AgentPaths paths, CancellationToken cancellationToken)
    {
        var started = Stopwatch.StartNew();
        var intent = ReadIntent(paths.UpdateIntentFile);
        try
        {
            using var service = new ServiceController("NachoAgent");
            if (service.Status != ServiceControllerStatus.Stopped)
            {
                service.Stop();
                service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
            }
            Directory.CreateDirectory(Path.GetDirectoryName(intent.BackupPath)!);
            File.Copy(intent.InstallPath, intent.BackupPath, true);
            var temporary = intent.InstallPath + ".new";
            File.Copy(intent.StagedPath, temporary, true);
            File.Move(temporary, intent.InstallPath, true);
            if (File.Exists(paths.UpdateHealthFile)) File.Delete(paths.UpdateHealthFile);
            service.Start();
            service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));

            var deadline = DateTimeOffset.UtcNow.AddSeconds(90);
            DateTimeOffset? continuouslyRunningSince = null;
            while (DateTimeOffset.UtcNow < deadline)
            {
                cancellationToken.ThrowIfCancellationRequested();
                service.Refresh();
                continuouslyRunningSince = service.Status == ServiceControllerStatus.Running
                    ? continuouslyRunningSince ?? DateTimeOffset.UtcNow
                    : null;
                if (continuouslyRunningSince is not null && DateTimeOffset.UtcNow - continuouslyRunningSince >= TimeSpan.FromSeconds(10) &&
                    File.Exists(paths.UpdateHealthFile))
                {
                    var health = JsonSerializer.Deserialize(File.ReadAllText(paths.UpdateHealthFile), AgentJsonContext.Default.UpdateHealth);
                    if (health?.Version == intent.TargetVersion && health.HeartbeatAt >= intent.CreatedAt)
                    {
                        intent.Phase = "healthy";
                        intent.DurationMs = started.ElapsedMilliseconds;
                        intent.UpdatedAt = DateTimeOffset.UtcNow;
                        WriteAtomic(paths.UpdateIntentFile, intent, AgentJsonContext.Default.UpdateIntent);
                        return 0;
                    }
                }
                await Task.Delay(1000, cancellationToken);
            }
            throw new System.TimeoutException("The replacement did not sustain service health and an authenticated heartbeat within 90 seconds.");
        }
        catch (Exception ex)
        {
            intent.Error = ex.Message;
            intent.RollbackReason = ex.Message;
            intent.RolledBack = true;
            intent.Phase = "rolled-back";
            try
            {
                using var service = new ServiceController("NachoAgent");
                service.Refresh();
                if (service.Status != ServiceControllerStatus.Stopped)
                {
                    service.Stop();
                    service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
                }
                if (File.Exists(intent.BackupPath)) File.Copy(intent.BackupPath, intent.InstallPath, true);
                service.Start();
                service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));
            }
            catch (Exception rollback) { intent.RollbackReason = $"{ex.Message}; rollback error: {rollback.Message}"; }
            intent.DurationMs = started.ElapsedMilliseconds;
            intent.UpdatedAt = DateTimeOffset.UtcNow;
            WriteAtomic(paths.UpdateIntentFile, intent, AgentJsonContext.Default.UpdateIntent);
            return 1;
        }
    }

    public static UpdateRequest ParsePayload(JsonElement payload)
    {
        var targetVersion = RequiredString(payload, "targetVersion");
        var fileName = RequiredString(payload, "fileName");
        var sha256 = RequiredString(payload, "sha256").ToLowerInvariant();
        if (!payload.TryGetProperty("sizeBytes", out var sizeElement) || !sizeElement.TryGetInt64(out var sizeBytes)) throw new InvalidDataException("sizeBytes is required.");
        if (CompareVersions(targetVersion, targetVersion) is null) throw new InvalidDataException("targetVersion must be strict x.y.z.");
        if (fileName != Path.GetFileName(fileName) || fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || !fileName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("fileName is unsafe.");
        if (sha256.Length != 64 || !sha256.All(Uri.IsHexDigit)) throw new InvalidDataException("sha256 must contain 64 hexadecimal characters.");
        if (sizeBytes <= 0 || sizeBytes > MaximumArtifactBytes) throw new InvalidDataException("sizeBytes exceeds the 256 MiB limit.");
        return new UpdateRequest(targetVersion, fileName, sha256, sizeBytes);
    }

    public static int? CompareVersions(string left, string right)
    {
        static int[]? Parse(string value)
        {
            var pieces = value.Split('.');
            if (pieces.Length != 3 || pieces.Any(piece => piece.Length == 0 || !piece.All(char.IsAsciiDigit) || (piece.Length > 1 && piece[0] == '0'))) return null;
            try { return pieces.Select(int.Parse).ToArray(); } catch { return null; }
        }
        var a = Parse(left); var b = Parse(right);
        if (a is null || b is null) return null;
        for (var i = 0; i < 3; i++) if (a[i] != b[i]) return Math.Sign(a[i] - b[i]);
        return 0;
    }

    public static void EnsureFreeSpace(string path, long artifactBytes)
    {
        var root = Path.GetPathRoot(Path.GetFullPath(path)) ?? throw new InvalidDataException("Update path has no drive root.");
        if (new DriveInfo(root).AvailableFreeSpace < checked(artifactBytes * 2 + 100L * 1024 * 1024))
            throw new IOException("Insufficient free space for artifact, backup, and 100 MiB reserve.");
    }

    public static void WriteAtomic<T>(string path, T value, JsonTypeInfo<T> typeInfo)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(value, typeInfo));
        File.Move(temporary, path, true);
    }

    private static UpdateIntent ReadIntent(string path) => JsonSerializer.Deserialize(File.ReadAllText(path), AgentJsonContext.Default.UpdateIntent)
        ?? throw new InvalidDataException("Update intent is empty.");
    private static string RequiredString(JsonElement payload, string name) => payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
        ? value.GetString()! : throw new InvalidDataException($"{name} is required.");
    private static string NormalizeFileVersion(string? version) => version is null ? "" : string.Join('.', version.Split('.').Take(3));
    private static ExecutionResult Failed(string from, string? target, string error, long downloaded = 0, long duration = 0) =>
        new("failed", Result(from, target, "rolled-back", downloaded, duration, false, null, error), null);
    private static string Result(string from, string? target, string phase, long downloaded, long duration, bool rolledBack, string? rollbackReason, string? error) =>
        JsonSerializer.Serialize(new { fromVersion = from, targetVersion = target, phase, downloadedBytes = downloaded, durationMs = duration, rolledBack, rollbackReason, error });

    public sealed record UpdateRequest(string TargetVersion, string FileName, string Sha256, long SizeBytes);
}
