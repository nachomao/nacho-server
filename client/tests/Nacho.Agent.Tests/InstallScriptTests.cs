namespace Nacho.Agent.Tests;

public sealed class InstallScriptTests
{
    [Fact]
    public void ServiceStartsAutomaticallyAndRecoversNonCrashFailures()
    {
        var repositoryRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."));
        var script = File.ReadAllText(Path.Combine(repositoryRoot, "deploy", "windows", "nacho.ps1"));

        Assert.Contains("start= auto", script, StringComparison.Ordinal);
        Assert.DoesNotContain("start= delayed-auto", script, StringComparison.Ordinal);
        Assert.Contains("sc.exe failureflag $ServiceName 1", script, StringComparison.Ordinal);
    }
}
