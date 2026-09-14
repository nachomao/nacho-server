using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public sealed class AgentApiClient : IManagedArtifactDownloader, IDisposable
{
    private readonly AgentOptions _options;
    private readonly StateStore _stateStore;
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _enrollmentGate = new(1, 1);

    public AgentApiClient(IOptions<AgentOptions> options, StateStore stateStore)
        : this(options, stateStore, new SocketsHttpHandler())
    {
    }

    internal AgentApiClient(IOptions<AgentOptions> options, StateStore stateStore, HttpMessageHandler handler)
    {
        _options = options.Value;
        _stateStore = stateStore;
        if (!Uri.TryCreate(_options.ServerUrl, UriKind.Absolute, out var server) ||
            server.Scheme is not ("http" or "https"))
            throw new InvalidDataException("ServerUrl must be an absolute HTTP or HTTPS URL.");
        _http = new HttpClient(handler) { BaseAddress = new Uri(server.ToString().TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(30) };
    }

    public AgentState? CurrentState => _stateStore.Load();

    public void ResetEnrollment() => _stateStore.Reset();

    public async Task<AgentState> EnsureEnrolledAsync(CancellationToken cancellationToken)
    {
        var state = _stateStore.Load();
        if (state is not null) return state;

        await _enrollmentGate.WaitAsync(cancellationToken);
        try
        {
            state = _stateStore.Load();
            if (state is not null) return state;

            var body = new
            {
                enrollmentKey = _stateStore.ReadEnrollmentKey(),
                // 卸载/清理后重新安装仍复用服务端客户端 id；服务端对重复 id 做幂等更新。
                id = DeviceIdentity.GetStableId(),
                name = string.IsNullOrWhiteSpace(_options.Name) ? Environment.MachineName : _options.Name,
                hostname = Environment.MachineName,
                os = "Windows",
                osName = OsInfo.DisplayName,
                version = typeof(AgentApiClient).Assembly.GetName().Version?.ToString(3) ?? "1.0.0",
                tags = _options.Tags,
                group = _options.Group,
            };
            using var response = await _http.PostAsJsonAsync("agent/enroll", body, cancellationToken);
            var envelope = await ReadEnvelopeAsync<EnrollmentResult>(response, AgentJsonContext.Default.ApiEnvelopeEnrollmentResult, cancellationToken);
            var enrolled = envelope.Data ?? throw new InvalidDataException("Enrollment response did not include device credentials.");
            state = new AgentState(enrolled.Client.Id, enrolled.Token);
            _stateStore.Save(state);
            _stateStore.DeleteEnrollmentKey();
            return state;
        }
        finally { _enrollmentGate.Release(); }
    }

    public async Task HeartbeatAsync(ClientMetrics metrics, CancellationToken cancellationToken)
    {
        using var request = Authorized(HttpMethod.Post, "agent/heartbeat");
        request.Content = JsonContent.Create(new { metrics, version = AgentUpdater.CurrentVersion, osName = OsInfo.DisplayName });
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task<long> DownloadArtifactAsync(string fileName, string destination, long expectedSize, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMinutes(10));
        using var response = await _http.GetAsync($"agent/downloads/windows/{Uri.EscapeDataString(fileName)}", HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        await EnsureSuccessAsync(response, timeout.Token);
        if (response.Content.Headers.ContentLength is long contentLength && contentLength != expectedSize)
            throw new InvalidDataException("Artifact Content-Length does not match the command payload.");
        await using var source = await response.Content.ReadAsStreamAsync(timeout.Token);
        await using var target = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        var buffer = new byte[128 * 1024];
        long total = 0;
        while (true)
        {
            var read = await source.ReadAsync(buffer, timeout.Token);
            if (read == 0) break;
            total += read;
            if (total > expectedSize) throw new InvalidDataException("Artifact exceeded the declared size.");
            await target.WriteAsync(buffer.AsMemory(0, read), timeout.Token);
        }
        await target.FlushAsync(timeout.Token);
        return total;
    }

    public async Task<long> DownloadManagedArtifactAsync(
        string artifactId,
        string commandId,
        string destination,
        long expectedSize,
        CancellationToken cancellationToken)
    {
        using var request = Authorized(
            HttpMethod.Get,
            $"agent/managed-artifacts/{Uri.EscapeDataString(artifactId)}?commandId={Uri.EscapeDataString(commandId)}");
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        if (response.Content.Headers.ContentLength is long contentLength && contentLength != expectedSize)
            throw new InvalidDataException("Artifact Content-Length does not match the command payload.");
        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var target = new FileStream(
            destination,
            FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            128 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        var buffer = new byte[128 * 1024];
        long total = 0;
        while (true)
        {
            var read = await source.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            total += read;
            if (total > expectedSize) throw new InvalidDataException("Artifact exceeded the declared size.");
            await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        await target.FlushAsync(cancellationToken);
        return total;
    }

    public async Task<AgentCommand[]> PullPendingAsync(CancellationToken cancellationToken)
    {
        using var request = Authorized(HttpMethod.Get, "agent/commands/pending");
        using var response = await _http.SendAsync(request, cancellationToken);
        var envelope = await ReadEnvelopeAsync<AgentCommand[]>(response, AgentJsonContext.Default.ApiEnvelopeAgentCommandArray, cancellationToken);
        return envelope.Data ?? [];
    }

    public async Task AcknowledgeAsync(string id, CancellationToken cancellationToken)
    {
        using var request = Authorized(HttpMethod.Post, $"agent/commands/{Uri.EscapeDataString(id)}/ack");
        request.Content = JsonContent.Create(new { });
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task ReportAsync(string id, string status, string? result, int? exitCode, CancellationToken cancellationToken)
    {
        using var request = Authorized(HttpMethod.Post, $"agent/commands/{Uri.EscapeDataString(id)}/report");
        request.Content = JsonContent.Create(new { status, result, exitCode });
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public ClientWebSocket CreateWebSocket()
    {
        var state = _stateStore.Load() ?? throw new InvalidOperationException("Agent is not enrolled.");
        var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Authorization", $"Bearer {state.Token}");
        return socket;
    }

    public Uri WebSocketUri()
    {
        var builder = new UriBuilder(_http.BaseAddress!) { Scheme = _http.BaseAddress!.Scheme == "https" ? "wss" : "ws", Path = "/agent/ws" };
        return builder.Uri;
    }

    private HttpRequestMessage Authorized(HttpMethod method, string path)
    {
        var state = _stateStore.Load() ?? throw new InvalidOperationException("Agent is not enrolled.");
        var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", state.Token);
        return request;
    }

    private static async Task<ApiEnvelope<T>> ReadEnvelopeAsync<T>(HttpResponseMessage response, System.Text.Json.Serialization.Metadata.JsonTypeInfo<ApiEnvelope<T>> typeInfo, CancellationToken cancellationToken)
    {
        var envelope = await response.Content.ReadFromJsonAsync(typeInfo, cancellationToken)
            ?? throw new InvalidDataException("Server returned an empty response.");
        if (!response.IsSuccessStatusCode || !envelope.Ok)
            throw new HttpRequestException(envelope.Message ?? $"Server returned {(int)response.StatusCode}.", null, response.StatusCode);
        return envelope;
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode) return;
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new HttpRequestException($"Server returned {(int)response.StatusCode}: {text}", null, response.StatusCode);
    }

    public void Dispose()
    {
        _http.Dispose();
        _enrollmentGate.Dispose();
    }
}
