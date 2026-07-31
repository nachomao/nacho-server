using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Nacho.Agent;

namespace Nacho.Agent.Tests;

public sealed class WindowsProcessIntegrationTests
{
    [Fact]
    public async Task Terminates_a_dedicated_single_process_without_touching_an_unrelated_instance()
    {
        using var target = StartHelper("--idle");
        using var unrelated = StartHelper("--idle");
        try
        {
            var result = await Create(target.MainModule!.FileName)
                .ExecuteAsync(Payload(target.Id, target.MainModule.FileName, false), CancellationToken.None);

            Assert.Equal("success", result.Status);
            Assert.True(target.WaitForExit(5_000));
            Assert.False(unrelated.HasExited);
        }
        finally
        {
            Stop(target);
            Stop(unrelated);
        }
    }

    [Fact]
    public async Task Terminates_a_dedicated_process_tree()
    {
        using var parent = StartHelper("--spawn-child", redirectOutput: true);
        var childIdText = await parent.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(int.TryParse(childIdText, out var childId));
        using var child = Process.GetProcessById(childId);
        try
        {
            var path = parent.MainModule!.FileName;
            var result = await Create(path).ExecuteAsync(Payload(parent.Id, path, true), CancellationToken.None);

            Assert.Equal("success", result.Status);
            Assert.True(parent.WaitForExit(5_000));
            Assert.True(child.WaitForExit(5_000));
        }
        finally
        {
            Stop(parent);
            Stop(child);
        }
    }

    private static Process StartHelper(string argument, bool redirectOutput = false)
    {
        var configuration = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).Parent!.Name;
        var executable = Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory,
            "..", "..", "..", "..",
            "Nacho.Agent.TestProcess", "bin", configuration, "net10.0-windows", "nacho-agent-test-process.exe"));
        Assert.True(File.Exists(executable), $"Test helper was not built: {executable}");
        return Process.Start(new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = redirectOutput,
            ArgumentList = { argument },
        }) ?? throw new InvalidOperationException("Test helper failed to start.");
    }

    private static WindowsProcessTerminator Create(string allowedPath) => new(
        Options.Create(new AgentOptions { ServerUrl = "http://127.0.0.1", AllowedProcessPaths = [allowedPath] }),
        new WindowsProcessController());

    private static JsonElement Payload(int processId, string expectedPath, bool killProcessTree)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            processId,
            expectedPath,
            timeoutSeconds = 10,
            killProcessTree,
        }));
        return document.RootElement.Clone();
    }

    private static void Stop(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5_000);
            }
        }
        catch { }
    }
}
