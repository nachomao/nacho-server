using Nacho.Agent;
using System.Text;

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

var dataDirectory = AgentPaths.ResolveDataDirectory(args);
Directory.CreateDirectory(dataDirectory);

if (args.Contains("--apply-update", StringComparer.Ordinal))
{
    Environment.ExitCode = await AgentUpdater.ApplyUpdateAsync(new AgentPaths(dataDirectory), CancellationToken.None);
    return;
}

var agentPaths = new AgentPaths(dataDirectory);
AgentPolicyMigrator.EnsureMessagePushEnabled(agentPaths);
AgentPolicyMigrator.RemoveOpenUrlPolicy(agentPaths);
AgentPolicyMigrator.EnsureAllPoliciesDisabled(agentPaths);

var builder = Host.CreateApplicationBuilder(args);
builder.Configuration.Sources.Clear();
builder.Configuration
    .AddJsonFile(Path.Combine(dataDirectory, "agent.json"), optional: false, reloadOnChange: true)
    .AddEnvironmentVariables("NACHO_");

builder.Services.Configure<AgentOptions>(builder.Configuration);
builder.Services.AddWindowsService(options => options.ServiceName = "NachoAgent");
builder.Services.AddSingleton(agentPaths);
builder.Logging.AddProvider(new AgentDiagnosticLoggerProvider(new AgentPaths(dataDirectory)));
builder.Services.AddSingleton<StateStore>();
builder.Services.AddSingleton<CommandJournal>();
builder.Services.AddSingleton<WindowsMetrics>();
builder.Services.AddSingleton<ProgramExecutor>();
builder.Services.AddSingleton<ShellCommandExecutor>();
builder.Services.AddSingleton<IManagedArtifactDownloader>(sp => sp.GetRequiredService<AgentApiClient>());
builder.Services.AddSingleton<IPackageInstallerRunner, PackageInstallerRunner>();
    builder.Services.AddSingleton<PackageInstallManager>();
    builder.Services.AddSingleton<FileDeploymentManager>();
builder.Services.AddSingleton<IWindowsServiceController, WindowsServiceController>();
builder.Services.AddSingleton<WindowsServiceManager>();
builder.Services.AddSingleton<IWindowsProcessController, WindowsProcessController>();
builder.Services.AddSingleton<WindowsProcessTerminator>();
builder.Services.AddSingleton<IBootIdentityProvider, WindowsBootIdentityProvider>();
builder.Services.AddSingleton<IWindowsRestartController, WindowsRestartController>();
builder.Services.AddSingleton<SystemRestartManager>();
builder.Services.AddSingleton<ILogCollectionSourceReader, WindowsLogCollectionSourceReader>();
builder.Services.AddSingleton<LogCollectionManager>();
builder.Services.AddSingleton<ILocalUserPlatform, LocalUserPlatform>();
builder.Services.AddSingleton<LocalUserManager>();
builder.Services.AddSingleton<IRegistryPlatform, WindowsRegistryPlatform>();
builder.Services.AddSingleton<RegistryManager>();
builder.Services.AddSingleton<IUserSessionPlatform, WindowsUserSessionPlatform>();
builder.Services.AddSingleton<ActiveUserSessionResolver>();
builder.Services.AddSingleton<IWindowsMessageSender, WindowsMessageSender>();
builder.Services.AddSingleton<IMessageClock, SystemMessageClock>();
builder.Services.AddSingleton<MessagePushManager>();
builder.Services.AddSingleton<IUserProcessLauncher, WindowsUserProcessLauncher>();
builder.Services.AddSingleton<OpenUrlManager>();
builder.Services.AddSingleton<AgentApiClient>();
builder.Services.AddSingleton<CommandProcessor>();
builder.Services.AddSingleton<AgentUpdater>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<CommandProcessor>());
builder.Services.AddHostedService<AgentWorker>();

await builder.Build().RunAsync();
