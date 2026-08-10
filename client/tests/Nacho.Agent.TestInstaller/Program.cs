using System.Diagnostics;

static string? Value(string[] values, string name)
{
    var index = Array.IndexOf(values, name);
    return index >= 0 && index + 1 < values.Length ? values[index + 1] : null;
}

var marker = Value(args, "--marker");
if (marker is not null)
{
    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(marker))!);
    await File.WriteAllTextAsync(marker, "nacho-test-installer");
}

if (args.Contains("--spawn-child", StringComparer.Ordinal))
{
    var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Executable path is unavailable.");
    var child = Process.Start(new ProcessStartInfo
    {
        FileName = executable,
        UseShellExecute = false,
        CreateNoWindow = true,
        ArgumentList = { "--sleep-seconds", "30" },
    }) ?? throw new InvalidOperationException("Child process failed to start.");
    var childPidFile = Value(args, "--child-pid-file") ?? throw new InvalidDataException("--child-pid-file is required.");
    await File.WriteAllTextAsync(childPidFile, child.Id.ToString());
}

if (int.TryParse(Value(args, "--sleep-seconds"), out var sleepSeconds) && sleepSeconds > 0)
    await Task.Delay(TimeSpan.FromSeconds(sleepSeconds));

return int.TryParse(Value(args, "--exit-code"), out var exitCode) ? exitCode : 0;
