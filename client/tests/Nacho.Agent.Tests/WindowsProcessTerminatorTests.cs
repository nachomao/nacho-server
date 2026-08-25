using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Nacho.Agent;

namespace Nacho.Agent.Tests;

public sealed class WindowsProcessTerminatorTests
{
    private const string AllowedPath = @"C:\Program Files\Example\worker.exe";
    private static readonly DateTime Started = new(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);

    [Fact]
    public void Allowed_process_paths_default_to_empty()
    {
        Assert.Empty(new AgentOptions { ServerUrl = "http://127.0.0.1" }.AllowedProcessPaths);
    }

    [Fact]
    public void Allowed_process_paths_bind_from_configuration()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ServerUrl"] = "http://127.0.0.1",
            ["AllowedProcessPaths:0"] = AllowedPath,
        }).Build();

        var options = configuration.Get<AgentOptions>();
        Assert.NotNull(options);
        Assert.Equal([AllowedPath], options!.AllowedProcessPaths);
    }

    [Fact]
    public async Task Allowlist_and_actual_path_matching_are_case_insensitive()
    {
        var controller = FakeController.ForPath(AllowedPath.ToUpperInvariant());
        var result = await Create([AllowedPath.ToLowerInvariant()], controller)
            .ExecuteAsync(Payload(123, AllowedPath.ToLowerInvariant()), CancellationToken.None);

        Assert.Equal("success", result.Status);
        Assert.Equal(AllowedPath.ToUpperInvariant(), Result(result).GetProperty("actualPath").GetString());
    }

    [Theory]
    [InlineData("worker.exe")]
    [InlineData(@"C:\Program Files\Example\*.exe")]
    [InlineData(@"C:\Program Files\Example\")]
    public async Task Rejects_relative_wildcard_and_directory_paths(string expectedPath)
    {
        var result = await Create([AllowedPath], FakeController.ForPath(AllowedPath))
            .ExecuteAsync(Payload(123, expectedPath), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains("absolute executable", result.Result);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"processId\":\"123\",\"expectedPath\":\"C:\\\\Program Files\\\\Example\\\\worker.exe\"}")]
    [InlineData("{\"processId\":0,\"expectedPath\":\"C:\\\\Program Files\\\\Example\\\\worker.exe\"}")]
    [InlineData("{\"processId\":-1,\"expectedPath\":\"C:\\\\Program Files\\\\Example\\\\worker.exe\"}")]
    public async Task Rejects_missing_or_invalid_process_ids(string json)
    {
        using var document = JsonDocument.Parse(json);
        var result = await Create([AllowedPath], FakeController.ForPath(AllowedPath))
            .ExecuteAsync(document.RootElement, CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains("positive integer", result.Result);
    }

    [Theory]
    [InlineData(4, "System process")]
    [InlineData(900, "cannot terminate itself")]
    public async Task Rejects_system_and_agent_process_ids(int processId, string expectedError)
    {
        var controller = FakeController.ForPath(AllowedPath);
        controller.CurrentProcessId = 900;
        var result = await Create([AllowedPath], controller)
            .ExecuteAsync(Payload(processId, AllowedPath), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains(expectedError, result.Result);
        Assert.False(controller.OpenCalled);
    }

    [Theory]
    [InlineData("{\"processId\":123,\"expectedPath\":\"C:\\\\Program Files\\\\Example\\\\worker.exe\",\"timeoutSeconds\":0}", "1 to 120")]
    [InlineData("{\"processId\":123,\"expectedPath\":\"C:\\\\Program Files\\\\Example\\\\worker.exe\",\"timeoutSeconds\":121}", "1 to 120")]
    [InlineData("{\"processId\":123,\"expectedPath\":\"C:\\\\Program Files\\\\Example\\\\worker.exe\",\"timeoutSeconds\":\"30\"}", "1 to 120")]
    [InlineData("{\"processId\":123,\"expectedPath\":\"C:\\\\Program Files\\\\Example\\\\worker.exe\",\"killProcessTree\":\"true\"}", "boolean")]
    public async Task Rejects_invalid_optional_fields(string json, string expectedError)
    {
        using var document = JsonDocument.Parse(json);
        var result = await Create([AllowedPath], FakeController.ForPath(AllowedPath))
            .ExecuteAsync(document.RootElement, CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains(expectedError, result.Result);
    }

    [Fact]
    public async Task Defaults_to_tree_termination()
    {
        var controller = FakeController.ForPath(AllowedPath);
        var result = await Create([AllowedPath], controller).ExecuteAsync(Payload(123, AllowedPath), CancellationToken.None);
        Assert.Equal("success", result.Status);
        Assert.True(controller.Handle.KillEntireTree);
        Assert.True(Result(result).GetProperty("killProcessTree").GetBoolean());
    }

    [Fact]
    public async Task Supports_single_process_termination()
    {
        var controller = FakeController.ForPath(AllowedPath);
        var result = await Create([AllowedPath], controller)
            .ExecuteAsync(Payload(123, AllowedPath, killProcessTree: false), CancellationToken.None);
        Assert.Equal("success", result.Status);
        Assert.False(controller.Handle.KillEntireTree);
        Assert.Null(result.ExitCode);
    }

    [Fact]
    public async Task Rejects_a_path_that_is_not_allowlisted()
    {
        var controller = FakeController.ForPath(AllowedPath);
        var result = await Create([], controller).ExecuteAsync(Payload(123, AllowedPath), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains("allowlist", result.Result);
        Assert.False(controller.OpenCalled);
    }

    [Fact]
    public async Task Rejects_an_actual_image_path_mismatch()
    {
        var controller = FakeController.ForPath(@"C:\Other\worker.exe");
        var result = await Create([AllowedPath], controller).ExecuteAsync(Payload(123, AllowedPath), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains("did not match", result.Result);
        Assert.False(controller.Handle.KillCalled);
    }

    [Fact]
    public async Task Reports_a_missing_process()
    {
        var controller = FakeController.ForPath(AllowedPath);
        controller.OpenError = new ArgumentException("sensitive PID detail");
        var result = await Create([AllowedPath], controller).ExecuteAsync(Payload(123, AllowedPath), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Equal("Process does not exist.", Result(result).GetProperty("error").GetString());
        Assert.DoesNotContain("sensitive", result.Result, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Fails_when_process_exits_before_identity_confirmation()
    {
        var controller = FakeController.ForPath(AllowedPath);
        controller.Handle.HasExitedValues.Enqueue(true);
        var result = await Create([AllowedPath], controller).ExecuteAsync(Payload(123, AllowedPath), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Equal("unknown", Result(result).GetProperty("initialStatus").GetString());
    }

    [Fact]
    public async Task Treats_natural_exit_after_identity_confirmation_as_success()
    {
        var controller = FakeController.ForPath(AllowedPath);
        controller.Handle.HasExitedValues.Enqueue(false);
        controller.Handle.HasExitedValues.Enqueue(false);
        controller.Handle.HasExitedValues.Enqueue(true);
        var result = await Create([AllowedPath], controller).ExecuteAsync(Payload(123, AllowedPath), CancellationToken.None);
        Assert.Equal("success", result.Status);
        Assert.False(controller.Handle.KillCalled);
        Assert.Equal("exited", Result(result).GetProperty("finalStatus").GetString());
    }

    [Fact]
    public async Task Rejects_pid_reuse_between_identity_checks()
    {
        var controller = FakeController.ForPath(AllowedPath);
        controller.Handle.Identities.Enqueue(new ProcessIdentity(123, Started, AllowedPath));
        controller.Handle.Identities.Enqueue(new ProcessIdentity(123, Started.AddSeconds(1), AllowedPath));
        var result = await Create([AllowedPath], controller).ExecuteAsync(Payload(123, AllowedPath), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains("identity changed", result.Result);
        Assert.False(controller.Handle.KillCalled);
    }

    [Fact]
    public async Task Rejects_a_start_time_that_differs_from_the_inventory_snapshot()
    {
        var controller = FakeController.ForPath(AllowedPath);
        var result = await Create([AllowedPath], controller).ExecuteAsync(
            Payload(123, AllowedPath, expectedStartedAtUtc: Started.AddSeconds(1)), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.Contains("inventory snapshot", result.Result);
        Assert.False(controller.Handle.KillCalled);
    }

    [Fact]
    public async Task Marks_a_stalled_termination_as_timed_out()
    {
        var controller = FakeController.ForPath(AllowedPath);
        controller.Handle.ThrowCancellationWhileWaiting = true;
        var result = await Create([AllowedPath], controller).ExecuteAsync(Payload(123, AllowedPath, timeoutSeconds: 1), CancellationToken.None);
        Assert.Equal("failed", result.Status);
        Assert.True(Result(result).GetProperty("timedOut").GetBoolean());
        Assert.Equal("running", Result(result).GetProperty("finalStatus").GetString());
    }

    [Fact]
    public async Task Propagates_host_cancellation()
    {
        var controller = FakeController.ForPath(AllowedPath);
        controller.Handle.WaitForHostCancellation = true;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Create([AllowedPath], controller)
            .ExecuteAsync(Payload(123, AllowedPath), cancellation.Token));
        Assert.False(controller.Handle.KillCalled);
    }

    [Fact]
    public async Task Sanitizes_access_denied_and_api_errors()
    {
        var deniedController = FakeController.ForPath(AllowedPath);
        deniedController.OpenError = new Win32Exception(5, "sensitive machine detail");
        var denied = await Create([AllowedPath], deniedController).ExecuteAsync(Payload(123, AllowedPath), CancellationToken.None);
        Assert.Equal("Process access was denied.", Result(denied).GetProperty("error").GetString());

        var apiController = FakeController.ForPath(AllowedPath);
        apiController.OpenError = new Win32Exception(87, "sensitive process detail");
        var api = await Create([AllowedPath], apiController).ExecuteAsync(Payload(123, AllowedPath), CancellationToken.None);
        Assert.Equal("Windows process API operation failed.", Result(api).GetProperty("error").GetString());
        Assert.DoesNotContain("sensitive", api.Result, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Recovery_error_json_has_the_full_contract()
    {
        var json = WindowsProcessTerminator.ErrorJson(Payload(123, AllowedPath, killProcessTree: false), "Agent restarted.");
        using var document = JsonDocument.Parse(json);
        var result = document.RootElement;
        Assert.Equal(123, result.GetProperty("processId").GetInt32());
        Assert.Equal(AllowedPath, result.GetProperty("expectedPath").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("actualPath").ValueKind);
        Assert.False(result.GetProperty("killProcessTree").GetBoolean());
        Assert.Equal("unknown", result.GetProperty("initialStatus").GetString());
        Assert.Equal("unknown", result.GetProperty("finalStatus").GetString());
        Assert.False(result.GetProperty("timedOut").GetBoolean());
        Assert.Equal("Agent restarted.", result.GetProperty("error").GetString());
    }

    private static WindowsProcessTerminator Create(string[] allowed, IWindowsProcessController controller) =>
        new(Options.Create(new AgentOptions { ServerUrl = "http://127.0.0.1", AllowedProcessPaths = allowed }), controller);

    private static JsonElement Payload(int processId, string expectedPath, int? timeoutSeconds = null, bool? killProcessTree = null, DateTime? expectedStartedAtUtc = null)
    {
        var values = new Dictionary<string, object?> { ["processId"] = processId, ["expectedPath"] = expectedPath };
        if (timeoutSeconds.HasValue) values["timeoutSeconds"] = timeoutSeconds.Value;
        if (killProcessTree.HasValue) values["killProcessTree"] = killProcessTree.Value;
        if (expectedStartedAtUtc.HasValue) values["expectedStartedAtUtc"] = expectedStartedAtUtc.Value.ToUniversalTime();
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(values));
        return document.RootElement.Clone();
    }

    private static JsonElement Result(ExecutionResult result) => JsonDocument.Parse(result.Result).RootElement.Clone();

    private sealed class FakeController : IWindowsProcessController
    {
        public int CurrentProcessId { get; set; } = 900;
        public required FakeHandle Handle { get; init; }
        public Exception? OpenError { get; set; }
        public bool OpenCalled { get; private set; }

        public IWindowsProcessHandle Open(int processId)
        {
            OpenCalled = true;
            if (OpenError is not null) throw OpenError;
            Handle.RequestedProcessId = processId;
            return Handle;
        }

        public static FakeController ForPath(string path) => new()
        {
            Handle = new FakeHandle { DefaultIdentity = new ProcessIdentity(123, Started, path) },
        };
    }

    private sealed class FakeHandle : IWindowsProcessHandle
    {
        public required ProcessIdentity DefaultIdentity { get; init; }
        public Queue<ProcessIdentity> Identities { get; } = new();
        public Queue<bool> HasExitedValues { get; } = new();
        public int RequestedProcessId { get; set; }
        public bool Exited { get; set; }
        public bool KillCalled { get; private set; }
        public bool KillEntireTree { get; private set; }
        public bool ThrowCancellationWhileWaiting { get; set; }
        public bool WaitForHostCancellation { get; set; }
        public int ProcessId => RequestedProcessId;
        public bool HasExited => HasExitedValues.Count > 0 ? HasExitedValues.Dequeue() : Exited;
        public ProcessIdentity ReadIdentity() => Identities.Count > 0 ? Identities.Dequeue() : DefaultIdentity;

        public void Kill(bool entireProcessTree)
        {
            KillCalled = true;
            KillEntireTree = entireProcessTree;
        }

        public async Task WaitForExitAsync(CancellationToken cancellationToken)
        {
            if (WaitForHostCancellation)
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return;
            }
            if (ThrowCancellationWhileWaiting) throw new OperationCanceledException(cancellationToken);
            Exited = true;
        }

        public void Dispose() { }
    }
}
