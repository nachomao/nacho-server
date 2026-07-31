namespace Nacho.Agent;

public sealed class AgentOptions
{
    public required string ServerUrl { get; init; }
    public string Name { get; init; } = Environment.MachineName;
    public string Group { get; init; } = "默认分组";
    public string[] Tags { get; init; } = [];
    public int HeartbeatSeconds { get; init; } = 20;
    public int PollSeconds { get; init; } = 15;
    public int DefaultExecutionSeconds { get; init; } = 300;
    public int MaxExecutionSeconds { get; init; } = 900;
    public int MaxOutputBytes { get; init; } = 1_048_576;
    public int OutputCodePage { get; init; }
    public string[] AllowedPrograms { get; init; } = [];
    public string[] AllowedServices { get; init; } = [];
    public string[] AllowedProcessPaths { get; init; } = [];
    public bool AllowSystemRestart { get; init; }
    public bool AllowLogCollection { get; init; }
    public bool AllowAgentUpdate { get; init; } = true;
}

public sealed class AgentPaths(string dataDirectory)
{
    public string DataDirectory { get; } = Path.GetFullPath(dataDirectory);
    public string StateFile => Path.Combine(DataDirectory, "state.dat");
    public string EnrollmentKeyFile => Path.Combine(DataDirectory, "enrollment.key");
    public string QueueDirectory => Path.Combine(DataDirectory, "queue");
    public string RestartIntentFile => Path.Combine(DataDirectory, "restart-intent.json");
    public string AgentDiagnosticLogFile => Path.Combine(DataDirectory, "agent-diagnostics.jsonl");
    public string UpdatesDirectory => Path.Combine(DataDirectory, "updates");
    public string UpdateIntentFile => Path.Combine(DataDirectory, "update-intent.json");
    public string UpdateHealthFile => Path.Combine(DataDirectory, "update-health.json");
    public string LastKnownGoodFile => Path.Combine(DataDirectory, "last-known-good.exe");

    public static string ResolveDataDirectory(string[] args)
    {
        var index = Array.IndexOf(args, "--data-dir");
        if (index >= 0 && index + 1 < args.Length) return Path.GetFullPath(args[index + 1]);
        var configured = Environment.GetEnvironmentVariable("NACHO_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Nacho");
    }
}
