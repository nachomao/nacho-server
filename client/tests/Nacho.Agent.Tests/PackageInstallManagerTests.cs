using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Nacho.Agent.Tests;

public sealed class PackageInstallManagerTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"nacho-package-tests-{Guid.NewGuid():N}");

    public PackageInstallManagerTests() => Directory.CreateDirectory(_directory);

    [Fact]
    public void Policy_defaults_to_disabled()
    {
        Assert.False(new AgentOptions { ServerUrl = "http://127.0.0.1" }.AllowPackageInstall);
    }

    [Theory]
    [InlineData("{}", "incomplete")]
    [InlineData("{\"artifactId\":\"artifact-0123456789ab\",\"fileName\":\"x.zip\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"sizeBytes\":1,\"installerType\":\"exe\",\"arguments\":[],\"successExitCodes\":[0],\"timeoutSeconds\":60}", "do not match")]
    [InlineData("{\"artifactId\":\"artifact-0123456789ab\",\"fileName\":\"x.exe\",\"sha256\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"sizeBytes\":1,\"installerType\":\"exe\",\"arguments\":[],\"successExitCodes\":[0],\"timeoutSeconds\":60}", "lowercase")]
    [InlineData("{\"artifactId\":\"artifact-0123456789ab\",\"fileName\":\"x.msi\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"sizeBytes\":1,\"installerType\":\"msi\",\"arguments\":[\"/quiet\"],\"successExitCodes\":[0,3010],\"timeoutSeconds\":60}", "PROPERTY=value")]
    [InlineData("{\"artifactId\":\"artifact-0123456789ab\",\"fileName\":\"x.exe\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"sizeBytes\":1,\"installerType\":\"exe\",\"arguments\":[],\"successExitCodes\":[0],\"timeoutSeconds\":59}", "60 to 7200")]
    public void Rejects_invalid_payloads(string raw, string expected)
    {
        using var document = JsonDocument.Parse(raw);
        var error = Assert.Throws<InvalidDataException>(() => PackageInstallManager.ParsePayload(document.RootElement));
        Assert.Contains(expected, error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Rejects_duplicate_payload_fields()
    {
        var raw = "{\"artifactId\":\"artifact-0123456789ab\",\"artifactId\":\"artifact-0123456789ab\",\"fileName\":\"x.exe\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"sizeBytes\":1,\"installerType\":\"exe\",\"arguments\":[],\"successExitCodes\":[0],\"timeoutSeconds\":60}";
        using var document = JsonDocument.Parse(raw);
        Assert.Throws<InvalidDataException>(() => PackageInstallManager.ParsePayload(document.RootElement));
    }

    [Fact]
    public async Task Disabled_policy_returns_structured_failure_without_downloading()
    {
        var downloader = new FakeDownloader([1, 2, 3]);
        var runner = new FakeRunner(new PackageRunResult(0, false, 42));
        var manager = Create(downloader, runner, enabled: false);
        var result = await manager.ExecuteAsync("cmd-policy", Payload("exe", [1, 2, 3]), (_, _) => Task.CompletedTask, CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal("failed", result.Status);
        Assert.Equal("policy", json.GetProperty("phase").GetString());
        Assert.Contains("disabled", json.GetProperty("error").GetString(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, downloader.Calls);
        Assert.Equal(0, runner.RunCalls);
    }

    [Fact]
    public async Task Msi_uses_fixed_silent_arguments_and_3010_requires_reboot()
    {
        byte[] content = [5, 4, 3, 2, 1];
        var downloader = new FakeDownloader(content);
        var runner = new FakeRunner(new PackageRunResult(3010, false, 42));
        var manager = Create(downloader, runner);
        var phases = new List<string>();
        var result = await manager.ExecuteAsync(
            "cmd-msi",
            Payload("msi", content, ["PROPERTY=value"], [0, 3010]),
            (raw, _) => { phases.Add(JsonDocument.Parse(raw).RootElement.GetProperty("phase").GetString()!); return Task.CompletedTask; },
            CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal("success", result.Status);
        Assert.Equal(3010, result.ExitCode);
        Assert.True(json.GetProperty("rebootRequired").GetBoolean());
        Assert.True(json.GetProperty("hashVerified").GetBoolean());
        Assert.EndsWith("msiexec.exe", runner.ExecutablePath, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("/i", runner.Arguments[0]);
        Assert.EndsWith("fixture.msi", runner.Arguments[1], StringComparison.OrdinalIgnoreCase);
        Assert.Equal(["/qn", "/norestart", "PROPERTY=value"], runner.Arguments.Skip(2));
        Assert.Equal(["downloading", "verified", "installing"], phases);
        Assert.False(Directory.Exists(Path.Combine(_directory, "packages", "cmd-msi")));
    }

    [Fact]
    public async Task Exe_arguments_are_passed_as_an_array_without_shell_joining()
    {
        byte[] content = [8, 9, 10];
        var runner = new FakeRunner(new PackageRunResult(0, false, 43));
        var manager = Create(new FakeDownloader(content), runner);
        var result = await manager.ExecuteAsync("cmd-exe", Payload("exe", content, ["/S", "value with spaces"]), (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.Equal("success", result.Status);
        Assert.EndsWith("fixture.exe", runner.ExecutablePath, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(["/S", "value with spaces"], runner.Arguments);
    }

    [Fact]
    public async Task Hash_mismatch_fails_before_starting_installer_and_cleans_staging()
    {
        byte[] content = [1, 1, 2, 3];
        var runner = new FakeRunner(new PackageRunResult(0, false, 44));
        var manager = Create(new FakeDownloader(content), runner);
        var payload = Payload("exe", [9, 9, 9, 9]);
        var result = await manager.ExecuteAsync("cmd-hash", payload, (_, _) => Task.CompletedTask, CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal("failed", result.Status);
        Assert.Contains("SHA-256", json.GetProperty("error").GetString(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, runner.RunCalls);
        Assert.False(Directory.Exists(Path.Combine(_directory, "packages", "cmd-hash")));
    }

    [Theory]
    [InlineData(7, false, "failed")]
    [InlineData(0, true, "failed")]
    public async Task Reports_non_success_exit_and_timeout(int exitCode, bool timedOut, string expectedStatus)
    {
        byte[] content = [7, 7, 7];
        var manager = Create(new FakeDownloader(content), new FakeRunner(new PackageRunResult(exitCode, timedOut, 45)));
        var result = await manager.ExecuteAsync($"cmd-{exitCode}-{timedOut}", Payload("exe", content), (_, _) => Task.CompletedTask, CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal(expectedStatus, result.Status);
        Assert.Equal(timedOut, json.GetProperty("timedOut").GetBoolean());
        Assert.Equal(exitCode, json.GetProperty("exitCode").GetInt32());
    }

    [Fact]
    public async Task Download_phase_is_safely_restarted_after_agent_recovery()
    {
        byte[] content = [2, 4, 6, 8];
        var downloader = new FakeDownloader(content);
        var runner = new FakeRunner(new PackageRunResult(0, false, 46));
        var manager = Create(downloader, runner);
        var request = PackageInstallManager.ParsePayload(Payload("exe", content));
        WriteIntent("cmd-resume-download", request, "downloading", null);
        var result = await manager.ResumeAsync("cmd-resume-download", Payload("exe", content), (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.Equal("success", result.Status);
        Assert.Equal(1, downloader.Calls);
        Assert.Equal(1, runner.RunCalls);
    }

    [Fact]
    public async Task Missing_installer_process_returns_unknown_without_restarting_it()
    {
        byte[] content = [3, 1, 4];
        var downloader = new FakeDownloader(content);
        var runner = new FakeRunner(new PackageRunResult(0, false, 47)) { ResumeResult = null };
        var manager = Create(downloader, runner);
        var request = PackageInstallManager.ParsePayload(Payload("exe", content));
        WriteIntent("cmd-resume-install", request, "installing", 999_999);
        var result = await manager.ResumeAsync("cmd-resume-install", Payload("exe", content), (_, _) => Task.CompletedTask, CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal("failed", result.Status);
        Assert.Equal("unknown", json.GetProperty("phase").GetString());
        Assert.Equal(0, downloader.Calls);
        Assert.Equal(0, runner.RunCalls);
        Assert.Equal(1, runner.ResumeCalls);
    }

    [Fact]
    public async Task Real_runner_preserves_argument_boundaries_and_kills_timeout_process_tree()
    {
        var executable = TestInstallerPath();
        var runner = new PackageInstallerRunner();
        var marker = Path.Combine(_directory, "marker with spaces.txt");
        var completed = await runner.RunAsync(
            executable,
            ["--marker", marker, "--exit-code", "7"],
            Path.GetDirectoryName(executable)!,
            10,
            (_, _) => Task.CompletedTask,
            CancellationToken.None);
        Assert.Equal(7, completed.ExitCode);
        Assert.False(completed.TimedOut);
        Assert.Equal("nacho-test-installer", await File.ReadAllTextAsync(marker));

        var childPidFile = Path.Combine(_directory, "child.pid");
        var timedOut = await runner.RunAsync(
            executable,
            ["--spawn-child", "--child-pid-file", childPidFile, "--sleep-seconds", "30"],
            Path.GetDirectoryName(executable)!,
            1,
            (_, _) => Task.CompletedTask,
            CancellationToken.None);
        Assert.True(timedOut.TimedOut);
        Assert.True(File.Exists(childPidFile));
        var childId = int.Parse(await File.ReadAllTextAsync(childPidFile));
        await Task.Delay(100);
        Assert.False(IsRunning(childId));
    }

    private PackageInstallManager Create(FakeDownloader downloader, FakeRunner runner, bool enabled = true) => new(
        new AgentPaths(_directory),
        downloader,
        runner,
        Options.Create(new AgentOptions { ServerUrl = "http://127.0.0.1", AllowPackageInstall = enabled }),
        NullLogger<PackageInstallManager>.Instance);

    private static JsonElement Payload(
        string installerType,
        byte[] content,
        string[]? arguments = null,
        int[]? successCodes = null)
    {
        var fileName = $"fixture.{installerType}";
        return JsonSerializer.SerializeToElement(new
        {
            artifactId = "artifact-0123456789ab",
            fileName,
            sha256 = Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant(),
            sizeBytes = content.LongLength,
            installerType,
            arguments = arguments ?? [],
            successExitCodes = successCodes ?? (installerType == "msi" ? [0, 3010] : [0]),
            timeoutSeconds = 60,
        });
    }

    private void WriteIntent(string commandId, PackageInstallManager.PackageInstallRequest request, string phase, int? processId)
    {
        var paths = new AgentPaths(_directory);
        var packagePath = Path.Combine(paths.PackagesDirectory, commandId, request.FileName);
        var intent = new PackageInstallIntent
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
            Phase = phase,
            ProcessId = processId,
            ProcessPath = processId is null ? null : packagePath,
            ProcessStartedAt = processId is null ? null : DateTimeOffset.UtcNow,
        };
        AgentUpdater.WriteAtomic(paths.PackageInstallIntentFile(commandId), intent, AgentJsonContext.Default.PackageInstallIntent);
    }

    private static string TestInstallerPath()
    {
        var configuration = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).Parent!.Name;
        var executable = Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory,
            "..", "..", "..", "..",
            "Nacho.Agent.TestInstaller", "bin", configuration, "net10.0-windows", "nacho-agent-test-installer.exe"));
        Assert.True(File.Exists(executable), $"Test installer was not built: {executable}");
        return executable;
    }

    private static bool IsRunning(int processId)
    {
        try { using var process = System.Diagnostics.Process.GetProcessById(processId); return !process.HasExited; }
        catch (ArgumentException) { return false; }
    }

    public void Dispose()
    {
        try { Directory.Delete(_directory, true); } catch { }
    }

    private sealed class FakeDownloader(byte[] content) : IManagedArtifactDownloader
    {
        public int Calls { get; private set; }
        public Task<long> DownloadManagedArtifactAsync(string artifactId, string commandId, string destination, long expectedSize, CancellationToken cancellationToken)
        {
            Calls++;
            File.WriteAllBytes(destination, content);
            return Task.FromResult(content.LongLength);
        }
    }

    private sealed class FakeRunner : IPackageInstallerRunner
    {
        private readonly PackageRunResult _result;
        public int RunCalls { get; private set; }
        public int ResumeCalls { get; private set; }
        public string ExecutablePath { get; private set; } = "";
        public string[] Arguments { get; private set; } = [];
        public PackageRunResult? ResumeResult { get; set; }

        public FakeRunner(PackageRunResult result)
        {
            _result = result;
            ResumeResult = result;
        }

        public async Task<PackageRunResult> RunAsync(string executablePath, IReadOnlyList<string> arguments, string workingDirectory, int timeoutSeconds, Func<PackageProcessStarted, CancellationToken, Task> onStarted, CancellationToken cancellationToken)
        {
            RunCalls++;
            ExecutablePath = executablePath;
            Arguments = [.. arguments];
            await onStarted(new PackageProcessStarted(_result.ProcessId, executablePath, DateTimeOffset.UtcNow), cancellationToken);
            return _result;
        }

        public Task<PackageRunResult?> ResumeAsync(int processId, string executablePath, DateTimeOffset startedAt, int timeoutSeconds, CancellationToken cancellationToken)
        {
            ResumeCalls++;
            return Task.FromResult(ResumeResult);
        }
    }
}
