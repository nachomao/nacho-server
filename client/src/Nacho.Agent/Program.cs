using Nacho.Agent;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

var dataDirectory = AgentPaths.ResolveDataDirectory(args);
Directory.CreateDirectory(dataDirectory);

// 由卸载脚本在停止服务前调用：使用本地 DPAPI 状态通知服务端移除设备记录。
if (args.Contains("--unregister", StringComparer.Ordinal) || args.Contains("--mark-unregistered", StringComparer.Ordinal))
{
    try
    {
        var paths = new AgentPaths(dataDirectory);
        var state = new StateStore(paths).Load();
        if (state is null) return;
        var configPath = Path.Combine(dataDirectory, "agent.json");
        using var config = JsonDocument.Parse(File.ReadAllText(configPath));
        var serverUrl = config.RootElement.GetProperty("serverUrl").GetString()?.TrimEnd('/')
            ?? throw new InvalidDataException("Agent serverUrl is missing.");
        using var http = new HttpClient { BaseAddress = new Uri(serverUrl + "/"), Timeout = TimeSpan.FromSeconds(15) };
        var markOnly = args.Contains("--mark-unregistered", StringComparer.Ordinal);
        using var request = new HttpRequestMessage(markOnly ? HttpMethod.Post : HttpMethod.Delete,
            markOnly ? "agent/client/unregister" : "agent/client");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", state.Token);
        using var response = await http.SendAsync(request);
        if (!response.IsSuccessStatusCode && (int)response.StatusCode != 404)
            throw new HttpRequestException($"Server returned {(int)response.StatusCode}.");
        return;
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Agent {(args.Contains("--mark-unregistered", StringComparer.Ordinal) ? "mark-unregistered" : "unregister")} failed: {ex.Message}");
        Environment.ExitCode = 1;
        return;
    }
}

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
builder.Services.AddSingleton<IWindowsServiceInventory, WindowsServiceInventory>();
builder.Services.AddSingleton<IProcessResourceReader, WindowsProcessResourceReader>();
builder.Services.AddSingleton<WindowsServiceManager>();
builder.Services.AddSingleton<IWindowsProcessController, WindowsProcessController>();
builder.Services.AddSingleton<IWindowsProcessActionPlatform, WindowsProcessActionPlatform>();
builder.Services.AddSingleton<IWindowsProcessInventory, WindowsProcessInventory>();
builder.Services.AddSingleton<WindowsProcessInventoryManager>();
builder.Services.AddSingleton<WindowsProcessActionManager>();
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
