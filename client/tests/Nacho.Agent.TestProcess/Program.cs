using System.Diagnostics;

if (args.Contains("--spawn-child", StringComparer.Ordinal))
{
    var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Executable path is unavailable.");
    var child = Process.Start(new ProcessStartInfo
    {
        FileName = executable,
        UseShellExecute = false,
        CreateNoWindow = true,
        ArgumentList = { "--idle" },
    }) ?? throw new InvalidOperationException("Child process failed to start.");
    Console.WriteLine(child.Id);
    Console.Out.Flush();
}

await Task.Delay(Timeout.InfiniteTimeSpan);
