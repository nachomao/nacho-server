using System.Text;
using System.Text.Json;

namespace Nacho.Agent.Tests;

public sealed class TerminalSessionManagerTests
{
    [Fact]
    public void Clamps_terminal_size_to_protocol_bounds()
    {
        Assert.Equal((20, 5), TerminalSessionManager.ClampSize(1, 1));
        Assert.Equal((120, 30), TerminalSessionManager.ClampSize(120, 30));
        Assert.Equal((240, 100), TerminalSessionManager.ClampSize(9999, 9999));
    }

    [Fact]
    public void Parses_terminal_open_message_strictly()
    {
        var valid = JsonSerializer.SerializeToElement(new
        {
            kind = "terminal-open",
            sessionId = "term-123456789abc",
            ticket = "ticket-0123456789abcdef",
            shell = "powershell",
            cols = 400,
            rows = 1,
        });
        Assert.True(TerminalSessionManager.TryParseOpen(valid, out var request));
        Assert.Equal("term-123456789abc", request.SessionId);
        Assert.Equal(240, request.Cols);
        Assert.Equal(5, request.Rows);

        Assert.False(TerminalSessionManager.TryParseOpen(JsonSerializer.SerializeToElement(new
        {
            sessionId = "term-1",
            ticket = "ticket-12345678",
            shell = "bash",
            cols = 80,
            rows = 24,
        }), out _));
        Assert.False(TerminalSessionManager.TryParseOpen(JsonSerializer.SerializeToElement(new
        {
            sessionId = "term-1",
            ticket = "short",
            shell = "cmd",
            cols = 80,
            rows = 24,
        }), out _));
        Assert.False(TerminalSessionManager.TryParseOpen(JsonSerializer.SerializeToElement(new
        {
            sessionId = "term-1",
            ticket = "ticket-12345678",
            shell = "cmd",
            cols = "80",
            rows = 24,
        }), out _));
        Assert.False(TerminalSessionManager.TryParseOpen(JsonSerializer.SerializeToElement(new { kind = "terminal-open" }), out _));
    }

    [Fact]
    public void PowerShell_start_info_runs_a_utf8_line_loop()
    {
        var info = TerminalSessionManager.BuildStartInfo("powershell", 120, 30, "C:\\");
        Assert.Equal("powershell.exe", Path.GetFileName(info.FileName), ignoreCase: true);
        Assert.Equal("C:\\", info.WorkingDirectory);
        Assert.Contains("-NoLogo", info.ArgumentList);
        Assert.Contains("-NoProfile", info.ArgumentList);
        Assert.Contains(TerminalSessionManager.PowerShellLoopScript, info.ArgumentList);
        Assert.Contains("[Console]::In.ReadLine()", TerminalSessionManager.PowerShellLoopScript);
        Assert.Contains("Invoke-Expression", TerminalSessionManager.PowerShellLoopScript);
        Assert.Equal("120", info.Environment["COLUMNS"]);
        Assert.Equal("30", info.Environment["LINES"]);
        Assert.Equal("utf-8", info.StandardInputEncoding?.WebName);
        Assert.Equal("utf-8", info.StandardOutputEncoding?.WebName);
    }

    [Fact]
    public void Cmd_start_info_uses_a_persistent_processor()
    {
        var info = TerminalSessionManager.BuildStartInfo("cmd", 80, 24, "C:\\");
        Assert.Equal("cmd.exe", Path.GetFileName(info.FileName), ignoreCase: true);
        Assert.Contains("/d", info.ArgumentList);
        Assert.Contains("/q", info.ArgumentList);
        Assert.Contains("/k", info.ArgumentList);
        Assert.True(info.RedirectStandardInput);
        Assert.True(info.RedirectStandardOutput);
    }
}
