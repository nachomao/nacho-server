using System.Text.Json;

namespace Nacho.Agent.Tests;

public sealed class AgentUpdaterTests
{
    [Theory]
    [InlineData("1.0.0", "1.0.1", -1)]
    [InlineData("2.0.0", "1.9.9", 1)]
    [InlineData("1.2.3", "1.2.3", 0)]
    public void ComparesStrictVersions(string left, string right, int expected) =>
        Assert.Equal(expected, AgentUpdater.CompareVersions(left, right));

    [Theory]
    [InlineData("1.2")]
    [InlineData("01.2.3")]
    [InlineData("1.2.3-beta")]
    public void RejectsNonStrictVersions(string value) => Assert.Null(AgentUpdater.CompareVersions(value, "1.2.3"));

    [Fact]
    public void ParsesTheFixedUpdatePayload()
    {
        using var document = JsonDocument.Parse("""{"targetVersion":"1.1.0","fileName":"nacho-agent-1.1.0-win-x64.exe","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sizeBytes":12345}""");
        var request = AgentUpdater.ParsePayload(document.RootElement);
        Assert.Equal("1.1.0", request.TargetVersion);
        Assert.Equal(12345, request.SizeBytes);
    }

    [Fact]
    public void RejectsTraversalAndOversizedPayloads()
    {
        using var traversal = JsonDocument.Parse("""{"targetVersion":"1.1.0","fileName":"../agent.exe","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sizeBytes":1}""");
        Assert.Throws<InvalidDataException>(() => AgentUpdater.ParsePayload(traversal.RootElement));
        using var oversized = JsonDocument.Parse($$"""{"targetVersion":"1.1.0","fileName":"agent.exe","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sizeBytes":{{AgentUpdater.MaximumArtifactBytes + 1}}}""");
        Assert.Throws<InvalidDataException>(() => AgentUpdater.ParsePayload(oversized.RootElement));
    }

    [Fact]
    public void CleansHistoricalBackupsByCountAndCapacity()
    {
        var root = Path.Combine(Path.GetTempPath(), "nacho-backups-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            CreateBackup(root, "update-old", 4, DateTime.UtcNow.AddDays(-3));
            CreateBackup(root, "failed-update-middle", 4, DateTime.UtcNow.AddDays(-2));
            CreateBackup(root, "update-new", 4, DateTime.UtcNow.AddDays(-1));
            Directory.CreateDirectory(Path.Combine(root, "unrelated"));
            File.WriteAllBytes(Path.Combine(root, "unrelated", "keep.bin"), new byte[32]);

            var result = AgentUpdater.CleanupHistoricalBackups(root, retentionCount: 2, maxBytes: 7);

            Assert.Equal(3, result.Candidates);
            Assert.Equal(1, result.Kept);
            Assert.Equal(2, result.Deleted);
            Assert.Equal(4, result.RemainingBytes);
            Assert.True(Directory.Exists(Path.Combine(root, "update-new")));
            Assert.True(Directory.Exists(Path.Combine(root, "unrelated")));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public void ResolvesProgramFilesBackupDirectory()
    {
        var path = Path.Combine("C:\\Program Files", "Nacho", "Agent", "nacho-agent.exe");
        Assert.Equal(Path.Combine("C:\\Program Files", "NachoAgentBackups"), AgentUpdater.ResolveHistoricalBackupDirectory(path));
    }

    private static void CreateBackup(string root, string name, int bytes, DateTime lastWriteUtc)
    {
        var directory = Directory.CreateDirectory(Path.Combine(root, name));
        var file = Path.Combine(directory.FullName, "agent.exe");
        File.WriteAllBytes(file, new byte[bytes]);
        Directory.SetLastWriteTimeUtc(directory.FullName, lastWriteUtc);
        File.SetLastWriteTimeUtc(file, lastWriteUtc);
    }
}
