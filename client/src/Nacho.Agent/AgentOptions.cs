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
    public bool DisableAllPolicies { get; init; }
    public int OutputCodePage { get; init; }
    public string[] AllowedPrograms { get; init; } = [];
    public bool AllowCmdExecution { get; init; }
    public bool AllowPowerShellExecution { get; init; }
    public bool AllowPackageInstall { get; init; }
    public bool AllowLocalUserManagement { get; init; }
    public string[] AllowedLocalUsers { get; init; } = [];
    public string[] AllowedLocalGroups { get; init; } = [];
    public string[] AllowedRegistryPaths { get; init; } = [];
    public bool AllowMessagePush { get; init; } = true;
    public string[] AllowedDeployRoots { get; init; } = [];
    public int FileDeployBackupRetentionDays { get; init; } = 7;
    public string[] AllowedServices { get; init; } = [];
    public string[] AllowedProcessPaths { get; init; } = [];
    public bool AllowSystemRestart { get; init; }
    public bool AllowLogCollection { get; init; }
    public bool AllowAgentUpdate { get; init; } = true;
}

public sealed class AgentPaths(string dataDirectory)
{
    public string DataDirectory { get; } = Path.GetFullPath(dataDirectory);
    public string ConfigFile => Path.Combine(DataDirectory, "agent.json");
    public string StateFile => Path.Combine(DataDirectory, "state.dat");
    public string EnrollmentKeyFile => Path.Combine(DataDirectory, "enrollment.key");
    public string QueueDirectory => Path.Combine(DataDirectory, "queue");
    public string WorkDirectory => Path.Combine(DataDirectory, "work");
    public string PackagesDirectory => Path.Combine(DataDirectory, "packages");
    public string FileDeploymentsDirectory => Path.Combine(DataDirectory, "file-deployments");
    public string MessageIntentsDirectory => Path.Combine(DataDirectory, "message-intents");
    public string OpenUrlIntentsDirectory => Path.Combine(DataDirectory, "open-url-intents");
    public string MessagePushPolicyMigrationFile => Path.Combine(DataDirectory, "message-push-policy-v1.migrated.json");
    public string MessagePushPolicyBackupFile => Path.Combine(DataDirectory, "agent.json.before-message-push-enable.bak");
    public string OpenUrlPolicyRemovalFile => Path.Combine(DataDirectory, "open-url-policy-v1.removed.json");
    public string OpenUrlPolicyBackupFile => Path.Combine(DataDirectory, "agent.json.before-open-url-policy-removal.bak");
    public string AllPoliciesDisabledFile => Path.Combine(DataDirectory, "all-policies-disabled-v1.json");
    public string AllPoliciesDisabledBackupFile => Path.Combine(DataDirectory, "agent.json.before-all-policies-disabled.bak");
    public string RestartIntentFile => Path.Combine(DataDirectory, "restart-intent.json");
    public string AgentDiagnosticLogFile => Path.Combine(DataDirectory, "agent-diagnostics.jsonl");
    public string UpdatesDirectory => Path.Combine(DataDirectory, "updates");
    public string UpdateIntentFile => Path.Combine(DataDirectory, "update-intent.json");
    public string UpdateHealthFile => Path.Combine(DataDirectory, "update-health.json");
    public string LastKnownGoodFile => Path.Combine(DataDirectory, "last-known-good.exe");
    public string PackageInstallIntentFile(string commandId) => Path.Combine(PackagesDirectory, commandId, "intent.json");
    public string FileDeployIntentFile(string commandId) => Path.Combine(FileDeploymentsDirectory, commandId, "intent.json");
    public string MessageIntentFile(string commandId) => Path.Combine(MessageIntentsDirectory, commandId + ".json");
    public string OpenUrlIntentFile(string commandId) => Path.Combine(OpenUrlIntentsDirectory, commandId + ".json");

    public static string ResolveDataDirectory(string[] args)
    {
        var index = Array.IndexOf(args, "--data-dir");
        if (index >= 0 && index + 1 < args.Length) return Path.GetFullPath(args[index + 1]);
        var configured = Environment.GetEnvironmentVariable("NACHO_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Nacho");
    }
}
