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

var builder = Host.CreateApplicationBuilder(args);
builder.Configuration.Sources.Clear();
builder.Configuration
    .AddJsonFile(Path.Combine(dataDirectory, "agent.json"), optional: false, reloadOnChange: true)
    .AddEnvironmentVariables("NACHO_");

builder.Services.Configure<AgentOptions>(builder.Configuration);
builder.Services.AddWindowsService(options => options.ServiceName = "NachoAgent");
builder.Services.AddSingleton(new AgentPaths(dataDirectory));
builder.Logging.AddProvider(new AgentDiagnosticLoggerProvider(new AgentPaths(dataDirectory)));
builder.Services.AddSingleton<StateStore>();
builder.Services.AddSingleton<CommandJournal>();
builder.Services.AddSingleton<WindowsMetrics>();
builder.Services.AddSingleton<ProgramExecutor>();
builder.Services.AddSingleton<IWindowsServiceController, WindowsServiceController>();
builder.Services.AddSingleton<WindowsServiceManager>();
builder.Services.AddSingleton<IWindowsProcessController, WindowsProcessController>();
builder.Services.AddSingleton<WindowsProcessTerminator>();
builder.Services.AddSingleton<IBootIdentityProvider, WindowsBootIdentityProvider>();
builder.Services.AddSingleton<IWindowsRestartController, WindowsRestartController>();
builder.Services.AddSingleton<SystemRestartManager>();
builder.Services.AddSingleton<ILogCollectionSourceReader, WindowsLogCollectionSourceReader>();
builder.Services.AddSingleton<LogCollectionManager>();
builder.Services.AddSingleton<AgentApiClient>();
builder.Services.AddSingleton<CommandProcessor>();
builder.Services.AddSingleton<AgentUpdater>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<CommandProcessor>());
builder.Services.AddHostedService<AgentWorker>();

await builder.Build().RunAsync();
