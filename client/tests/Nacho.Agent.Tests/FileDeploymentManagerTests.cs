using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Nacho.Agent.Tests;

public sealed class FileDeploymentManagerTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"nacho-file-tests-{Guid.NewGuid():N}");
    private readonly string _allowedRoot;

    public FileDeploymentManagerTests()
    {
        Directory.CreateDirectory(_directory);
        _allowedRoot = Path.Combine(_directory, "allowed");
        Directory.CreateDirectory(_allowedRoot);
    }

    [Fact]
    public void Policy_defaults_to_disabled_and_payload_is_strict()
    {
        Assert.Empty(new AgentOptions { ServerUrl = "http://127.0.0.1" }.AllowedDeployRoots);
        var payload = DeployPayload("config.json", [1, 2, 3], Path.Combine(_allowedRoot, "config.json"));
        Assert.Throws<InvalidDataException>(() => FileDeploymentManager.ParsePayload(JsonSerializer.SerializeToElement(new { payload, extra = true })));
        Assert.Equal("relative", FileDeploymentManager.ParsePayload(JsonSerializer.SerializeToElement(new { artifactId = "artifact-0123456789ab", fileName = "config.json", sha256 = "a".PadRight(64, 'a'), sizeBytes = 1, destinationPath = "relative", conflictPolicy = "fail", createDirectories = false })).DestinationPath);
        Assert.Throws<InvalidDataException>(() => FileDeploymentManager.ParseRollbackPayload(JsonSerializer.SerializeToElement(new { originalCommandId = "cmd-0123456789ab", extra = true })));
    }

    [Fact]
    public async Task New_file_requires_create_directories_and_writes_verified_content()
    {
        var content = new byte[] { 1, 3, 5, 7 };
        var destination = Path.Combine(_allowedRoot, "nested", "config.json");
        var manager = Create(new FakeDownloader(content));
        var noDirectories = await manager.ExecuteAsync("cmd-0123456789ab", DeployPayload("config.json", content, destination, createDirectories: false), (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.Equal("failed", noDirectories.Status);
        Assert.Contains("directory", JsonDocument.Parse(noDirectories.Result).RootElement.GetProperty("error").GetString(), StringComparison.OrdinalIgnoreCase);

        var result = await manager.ExecuteAsync("cmd-abcdef012345", DeployPayload("config.json", content, destination, createDirectories: true), (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.True(result.Status == "success", result.Result);
        Assert.Equal(content, await File.ReadAllBytesAsync(destination));
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.True(json.GetProperty("hashVerified").GetBoolean());
        Assert.False(json.GetProperty("backupValid").GetBoolean());
        Assert.Equal(Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant(), json.GetProperty("finalSha256").GetString());
        Assert.True(File.Exists(new AgentPaths(_directory).FileDeployIntentFile("cmd-abcdef012345")));
    }

    [Fact]
    public async Task Fail_policy_does_not_overwrite_existing_file()
    {
        var destination = Path.Combine(_allowedRoot, "existing.txt");
        await File.WriteAllTextAsync(destination, "old");
        var manager = Create(new FakeDownloader([9, 9]));
        var result = await manager.ExecuteAsync("cmd-012345abcdef", DeployPayload("existing.txt", [9, 9], destination), (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Equal("old", await File.ReadAllTextAsync(destination));
        Assert.Contains("already exists", JsonDocument.Parse(result.Result).RootElement.GetProperty("error").GetString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Replace_creates_backup_and_rollback_refuses_changed_destination_then_restores()
    {
        var destination = Path.Combine(_allowedRoot, "replace.txt");
        await File.WriteAllTextAsync(destination, "old-content");
        var content = System.Text.Encoding.UTF8.GetBytes("new-content");
        var manager = Create(new FakeDownloader(content));
        var deploy = await manager.ExecuteAsync("cmd-fedcba654321", DeployPayload("replace.txt", content, destination, "replace"), (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.True(deploy.Status == "success", deploy.Result);
        Assert.Equal("new-content", await File.ReadAllTextAsync(destination));
        var deployJson = JsonDocument.Parse(deploy.Result).RootElement;
        Assert.True(deployJson.GetProperty("backupValid").GetBoolean());

        await File.WriteAllTextAsync(destination, "human-change");
        var conflict = await manager.RollbackAsync("cmd-rollback-0001", RollbackPayload("cmd-fedcba654321"), CancellationToken.None);
        Assert.Equal("failed", conflict.Status);
        Assert.Equal("human-change", await File.ReadAllTextAsync(destination));

        await File.WriteAllTextAsync(destination, "new-content");
        var rollback = await manager.RollbackAsync("cmd-rollback-0002", RollbackPayload("cmd-fedcba654321"), CancellationToken.None);
        Assert.True(rollback.Status == "success", rollback.Result);
        Assert.Equal("old-content", await File.ReadAllTextAsync(destination));
        Assert.False(JsonDocument.Parse(rollback.Result).RootElement.GetProperty("backupValid").GetBoolean());
    }

    [Theory]
    [InlineData("relative.txt")]
    [InlineData("\\\\server\\share\\file.txt")]
    [InlineData("C:\\allowed\\file.txt:stream")]
    [InlineData("C:\\allowed\\*.txt")]
    public async Task Rejects_unsafe_or_outside_paths(string destination)
    {
        var manager = Create(new FakeDownloader([1]));
        var result = await manager.ExecuteAsync("cmd-111111111111", DeployPayload("file.txt", [1], destination), (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains("path", JsonDocument.Parse(result.Result).RootElement.GetProperty("error").GetString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Downloaded_hash_mismatch_never_writes_destination()
    {
        var destination = Path.Combine(_allowedRoot, "hash.txt");
        var manager = Create(new FakeDownloader([4, 4]));
        var payload = JsonSerializer.SerializeToElement(new { artifactId = "artifact-0123456789ab", fileName = "hash.txt", sha256 = new string('a', 64), sizeBytes = 2L, destinationPath = destination, conflictPolicy = "fail", createDirectories = false });
        var result = await manager.ExecuteAsync("cmd-222222222222", payload, (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.False(File.Exists(destination));
    }

    [Fact]
    public async Task Allowed_root_prefix_sibling_is_rejected()
    {
        var sibling = _allowedRoot + "2";
        Directory.CreateDirectory(sibling);
        var result = await Create(new FakeDownloader([1])).ExecuteAsync("cmd-333333333333", DeployPayload("file.txt", [1], Path.Combine(sibling, "file.txt")), (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains("outside", JsonDocument.Parse(result.Result).RootElement.GetProperty("error").GetString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Interrupted_rollback_resumes_without_reapplying_deployment()
    {
        var destination = Path.Combine(_allowedRoot, "resume.txt");
        await File.WriteAllTextAsync(destination, "old");
        var content = System.Text.Encoding.UTF8.GetBytes("new");
        var manager = Create(new FakeDownloader(content));
        Assert.Equal("success", (await manager.ExecuteAsync("cmd-444444444444", DeployPayload("resume.txt", content, destination, "replace"), (_, _) => Task.CompletedTask, CancellationToken.None)).Status);

        var paths = new AgentPaths(_directory);
        var intentPath = paths.FileDeployIntentFile("cmd-444444444444");
        var intent = JsonSerializer.Deserialize(File.ReadAllText(intentPath), AgentJsonContext.Default.FileDeployIntent)!;
        intent.RollbackCommandId = "cmd-rollback-resume";
        intent.RollbackPhase = "started";
        AgentUpdater.WriteAtomic(intentPath, intent, AgentJsonContext.Default.FileDeployIntent);
        var temporaryCurrent = intent.BackupPath + ".rollback-current";
        File.Move(destination, temporaryCurrent, true);

        var result = await manager.RollbackAsync("cmd-rollback-resume", RollbackPayload("cmd-444444444444"), CancellationToken.None);
        Assert.True(result.Status == "success", result.Result);
        Assert.Equal("old", await File.ReadAllTextAsync(destination));
        Assert.False(File.Exists(temporaryCurrent));
    }

    private FileDeploymentManager Create(FakeDownloader downloader) => new(
        new AgentPaths(_directory),
        downloader,
        Options.Create(new AgentOptions { ServerUrl = "http://127.0.0.1", AllowedDeployRoots = [_allowedRoot], FileDeployBackupRetentionDays = 7 }),
        NullLogger<FileDeploymentManager>.Instance);

    private static JsonElement DeployPayload(string fileName, byte[] content, string destination, string conflictPolicy = "fail", bool createDirectories = false) => JsonSerializer.SerializeToElement(new
    {
        artifactId = "artifact-0123456789ab",
        fileName,
        sha256 = Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant(),
        sizeBytes = content.LongLength,
        destinationPath = destination,
        conflictPolicy,
        createDirectories,
    });

    private static JsonElement RollbackPayload(string commandId) => JsonSerializer.SerializeToElement(new { originalCommandId = commandId });

    public void Dispose()
    {
        try { Directory.Delete(_directory, true); } catch { }
    }

    private sealed class FakeDownloader(byte[] content) : IManagedArtifactDownloader
    {
        public Task<long> DownloadManagedArtifactAsync(string artifactId, string commandId, string destination, long expectedSize, CancellationToken cancellationToken)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.WriteAllBytes(destination, content);
            return Task.FromResult(content.LongLength);
        }
    }
}
