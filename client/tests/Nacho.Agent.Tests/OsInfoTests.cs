namespace Nacho.Agent.Tests;

public sealed class OsInfoTests
{
    [Theory]
    [InlineData("Windows 10 Pro", "25H2", 26200, "Windows 11 Pro 25H2")]
    [InlineData("Microsoft Windows 10 Enterprise", "24H2", 26100, "Microsoft Windows 11 Enterprise 24H2")]
    [InlineData("Windows 10 Pro", "22H2", 19045, "Windows 10 Pro 22H2")]
    [InlineData("Windows 11 Pro", null, 22631, "Windows 11 Pro")]
    public void NormalizesWindowsDisplayName(
        string product,
        string? displayVersion,
        int build,
        string expected) =>
        Assert.Equal(expected, OsInfo.NormalizeDisplayName(product, displayVersion, build));

    [Theory]
    [InlineData(null, null, 26200, "Windows 11")]
    [InlineData("  ", "25H2", 19045, "Windows")]
    public void FallsBackToBuildWhenProductNameIsMissing(
        string? product,
        string? displayVersion,
        int build,
        string expected) =>
        Assert.Equal(expected, OsInfo.NormalizeDisplayName(product, displayVersion, build));
}
