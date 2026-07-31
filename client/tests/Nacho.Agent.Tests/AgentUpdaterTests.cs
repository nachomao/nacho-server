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
}
