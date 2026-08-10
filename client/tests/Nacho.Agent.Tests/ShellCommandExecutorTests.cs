using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Nacho.Agent.Tests;

public sealed class ShellCommandExecutorTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"nacho-shell-tests-{Guid.NewGuid():N}");

    public ShellCommandExecutorTests() => Directory.CreateDirectory(_directory);

    [Fact]
    public void Policies_default_to_disabled()
    {
        var options = new AgentOptions { ServerUrl = "http://127.0.0.1" };
        Assert.False(options.AllowCmdExecution);
        Assert.False(options.AllowPowerShellExecution);
    }

    [Fact]
    public async Task Disabled_policy_returns_stable_structured_failure()
    {
        var result = await Create().ExecuteAsync(Payload("cmd", "echo hidden"), CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal("failed", result.Status);
        Assert.Equal("cmd", json.GetProperty("shell").GetString());
        Assert.Contains("disabled", json.GetProperty("error").GetString(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("hidden", result.Result, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("{}", "shell")]
    [InlineData("{\"shell\":\"bash\",\"script\":\"echo x\",\"timeoutSeconds\":5}", "cmd or powershell")]
    [InlineData("{\"shell\":\"cmd\",\"script\":\"\",\"timeoutSeconds\":5}", "script")]
    [InlineData("{\"shell\":\"cmd\",\"script\":\"  \\r\\n\\t\",\"timeoutSeconds\":5}", "script")]
    [InlineData("{\"shell\":\"cmd\",\"script\":\"echo x\",\"timeoutSeconds\":0}", "1 to 900")]
    [InlineData("{\"shell\":\"cmd\",\"script\":\"echo x\",\"timeoutSeconds\":5,\"extra\":true}", "unsupported")]
    public async Task Rejects_invalid_payloads(string raw, string expected)
    {
        using var document = JsonDocument.Parse(raw);
        var result = await Create(cmd: true, powershell: true).ExecuteAsync(document.RootElement, CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains(expected, JsonDocument.Parse(result.Result).RootElement.GetProperty("error").GetString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Executes_multiline_cmd_and_cleans_temporary_script()
    {
        var result = await Create(cmd: true).ExecuteAsync(Payload("cmd", "echo first\r\necho second"), CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal("success", result.Status);
        Assert.Equal(0, result.ExitCode);
        Assert.Contains("first", json.GetProperty("stdout").GetString(), StringComparison.Ordinal);
        Assert.Contains("second", json.GetProperty("stdout").GetString(), StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(_directory, "work")));
    }

    [Fact]
    public async Task Executes_powershell_and_preserves_unicode()
    {
        var result = await Create(powershell: true).ExecuteAsync(Payload("powershell", "Write-Output '你好-shell'"), CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal("success", result.Status);
        Assert.Contains("你好-shell", json.GetProperty("stdout").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Reports_nonzero_exit_code()
    {
        var result = await Create(cmd: true).ExecuteAsync(Payload("cmd", "exit /b 7"), CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal("failed", result.Status);
        Assert.Equal(7, result.ExitCode);
        Assert.Equal(7, json.GetProperty("exitCode").GetInt32());
    }

    [Fact]
    public async Task Times_out_and_kills_the_process_tree()
    {
        var result = await Create(cmd: true).ExecuteAsync(Payload("cmd", "ping -n 6 127.0.0.1 >nul", 1), CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.Equal("failed", result.Status);
        Assert.True(json.GetProperty("timedOut").GetBoolean());
    }

    [Fact]
    public async Task Bounds_output_and_complete_result_size()
    {
        var result = await Create(powershell: true).ExecuteAsync(
            Payload("powershell", "1..20000 | ForEach-Object { Write-Output ('\\u0001' * 20) }", 30),
            CancellationToken.None);
        var json = JsonDocument.Parse(result.Result).RootElement;
        Assert.True(json.GetProperty("truncated").GetBoolean());
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(result.Result) < 512 * 1024);
    }

    private ShellCommandExecutor Create(bool cmd = false, bool powershell = false) => new(
        Options.Create(new AgentOptions
        {
            ServerUrl = "http://127.0.0.1",
            AllowCmdExecution = cmd,
            AllowPowerShellExecution = powershell,
        }),
        new AgentPaths(_directory),
        NullLogger<ShellCommandExecutor>.Instance);

    private static JsonElement Payload(string shell, string script, int timeoutSeconds = 10) =>
        JsonDocument.Parse(JsonSerializer.Serialize(new { shell, script, timeoutSeconds })).RootElement.Clone();

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
    }
}
