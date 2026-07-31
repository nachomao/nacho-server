using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Nacho.Agent;

namespace Nacho.Agent.Tests;

public sealed class ProgramExecutorTests
{
    private static string SystemTool(string name) => Path.Combine(Environment.SystemDirectory, name);

    [Fact]
    public async Task Executes_an_allowlisted_absolute_program()
    {
        var executor = CreateExecutor([SystemTool("hostname.exe")]);
        var result = await executor.ExecuteAsync(Payload(SystemTool("hostname.exe")), CancellationToken.None);
        Assert.Equal("success", result.Status);
        Assert.Equal(0, result.ExitCode);
        var output = JsonDocument.Parse(result.Result).RootElement.GetProperty("stdout").GetString();
        Assert.Contains(Environment.MachineName, output, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Rejects_relative_and_not_allowlisted_paths()
    {
        var executor = CreateExecutor([SystemTool("hostname.exe")]);
        var relative = await executor.ExecuteAsync(Payload("hostname.exe"), CancellationToken.None);
        var blocked = await executor.ExecuteAsync(Payload(SystemTool("whoami.exe")), CancellationToken.None);
        Assert.Equal("failed", relative.Status);
        Assert.Contains("absolute", relative.Result);
        Assert.Equal("failed", blocked.Status);
        Assert.Contains("allowlist", blocked.Result);
    }

    [Fact]
    public async Task Caps_combined_output()
    {
        var executor = CreateExecutor([SystemTool("ipconfig.exe")], maxOutputBytes: 16);
        var result = await executor.ExecuteAsync(Payload(SystemTool("ipconfig.exe"), "/all"), CancellationToken.None);
        Assert.Contains("\"truncated\":true", result.Result);
    }

    [Fact]
    public void Splits_Windows_arguments_without_a_shell()
    {
        Assert.Equal(["hello world", "plain", ""], WindowsCommandLine.Split("\"hello world\" plain \"\""));
    }

    [Fact]
    public async Task Times_out_and_kills_the_process_tree()
    {
        var executor = CreateExecutor([SystemTool("ping.exe")], defaultSeconds: 1);
        var result = await executor.ExecuteAsync(Payload(SystemTool("ping.exe"), "-n 5 127.0.0.1"), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains("\"timedOut\":true", result.Result);
    }

    private static ProgramExecutor CreateExecutor(string[] allowedPrograms, int maxOutputBytes = 1_048_576, int defaultSeconds = 5) =>
        new(Options.Create(new AgentOptions
        {
            ServerUrl = "http://127.0.0.1:8443",
            AllowedPrograms = allowedPrograms,
            MaxOutputBytes = maxOutputBytes,
            DefaultExecutionSeconds = defaultSeconds,
            MaxExecutionSeconds = 5,
        }), NullLogger<ProgramExecutor>.Instance);

    private static JsonElement Payload(string program, string args = "") => JsonDocument.Parse(JsonSerializer.Serialize(new { program, args })).RootElement.Clone();
}
