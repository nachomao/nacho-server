using System.Net.WebSockets;
using System.Text.Json;

namespace Nacho.Agent;

/// <summary>
/// WebSSH 会话通道的 Agent 侧封装：连接服务端下发的 ticket 地址，串行发送 JSON。
/// 与主通道（/agent/ws）分离，避免交互流量阻塞命令队列。
/// </summary>
internal sealed class AgentSessionSocket : IAsyncDisposable
{
    private const int MaxMessageBytes = 2 * 1024 * 1024;
    private readonly ClientWebSocket _socket;
    private readonly SemaphoreSlim _sendGate = new(1, 1);

    private AgentSessionSocket(ClientWebSocket socket) => _socket = socket;

    public static async Task<AgentSessionSocket> ConnectAsync(AgentApiClient api, string pathAndQuery, CancellationToken cancellationToken)
    {
        var socket = api.CreateWebSocket();
        try
        {
            await socket.ConnectAsync(api.WebSocketUri(pathAndQuery), cancellationToken);
            return new AgentSessionSocket(socket);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    public async Task SendJsonAsync(object message, CancellationToken cancellationToken)
    {
        if (_socket.State != WebSocketState.Open) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        await _sendGate.WaitAsync(cancellationToken);
        try
        {
            if (_socket.State == WebSocketState.Open)
                await _socket.SendAsync(bytes.AsMemory(), WebSocketMessageType.Text, true, cancellationToken);
        }
        finally { _sendGate.Release(); }
    }

    public async Task ReceiveAsync(Func<JsonElement, CancellationToken, Task> handler, CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        while (_socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            var received = await _socket.ReceiveAsync(buffer.AsMemory(), cancellationToken);
            if (received.MessageType == WebSocketMessageType.Close) return;
            message.Write(buffer, 0, received.Count);
            if (message.Length > MaxMessageBytes) throw new InvalidDataException("WebSSH session message exceeds 2 MiB.");
            if (!received.EndOfMessage) continue;
            if (received.MessageType == WebSocketMessageType.Text)
            {
                using var document = JsonDocument.Parse(message.ToArray());
                await handler(document.RootElement.Clone(), cancellationToken);
            }
            message.SetLength(0);
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_socket.State == WebSocketState.Open)
                await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "session closed", CancellationToken.None);
        }
        catch { /* 对端可能已断开 */ }
        _socket.Dispose();
        _sendGate.Dispose();
    }
}

internal static class WebSshJson
{
    public static string ReadString(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    public static long? ReadInt64(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number &&
        value.TryGetInt64(out var number)
            ? number
            : null;

    public static int? ReadInt32(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number &&
        value.TryGetInt32(out var number)
            ? number
            : null;
}
