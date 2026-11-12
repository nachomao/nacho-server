using System.Collections.Concurrent;
using System.Text.Json;

namespace Nacho.Agent;

/// <summary>
/// WebSSH 文件会话：面板通过会话通道发起目录浏览、删除、下载与分块上传。
/// 每次会话使用独立的临时目录，上传支持按 receivedBytes 断点续传。
/// </summary>
public sealed class FileSessionManager(
    AgentApiClient api,
    AgentPaths paths,
    ILogger<FileSessionManager> logger)
{
    internal const int MaxConcurrentSessions = 2;
    private readonly ConcurrentDictionary<string, FileSessionState> _sessions = new(StringComparer.Ordinal);

    internal sealed record FileOpenRequest(string SessionId, string Ticket);

    public void HandleOpen(JsonElement message, CancellationToken stoppingToken)
    {
        if (!TryParseOpen(message, out var request))
        {
            logger.LogWarning("Rejected file-open message: invalid payload");
            return;
        }
        if (_sessions.Count >= MaxConcurrentSessions)
        {
            logger.LogWarning("Rejected file session {SessionId}: too many active sessions", request.SessionId);
            return;
        }
        var state = new FileSessionState(request.SessionId, paths);
        if (!_sessions.TryAdd(request.SessionId, state)) return;
        _ = Task.Run(() => RunAsync(request, state, stoppingToken), CancellationToken.None);
    }

    internal static bool TryParseOpen(JsonElement message, out FileOpenRequest request)
    {
        request = null!;
        if (message.ValueKind != JsonValueKind.Object) return false;
        var sessionId = WebSshJson.ReadString(message, "sessionId");
        var ticket = WebSshJson.ReadString(message, "ticket");
        if (sessionId.Length is < 1 or > 128 || ticket.Length is < 8 or > 512) return false;
        request = new FileOpenRequest(sessionId, ticket);
        return true;
    }

    private async Task RunAsync(FileOpenRequest open, FileSessionState state, CancellationToken stoppingToken)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        try
        {
            await using var channel = await AgentSessionSocket.ConnectAsync(
                api,
                $"/agent/files?session={Uri.EscapeDataString(open.SessionId)}&ticket={Uri.EscapeDataString(open.Ticket)}",
                lifetime.Token);
            await channel.ReceiveAsync(
                (message, cancellationToken) => DispatchAsync(channel, state, message, lifetime, cancellationToken),
                lifetime.Token);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) when (ex is System.Net.WebSockets.WebSocketException or IOException or InvalidDataException or JsonException)
        {
            logger.LogWarning(ex, "File session {SessionId} channel ended with error", open.SessionId);
        }
        finally
        {
            state.Dispose();
            _sessions.TryRemove(open.SessionId, out _);
        }
    }

    private async Task DispatchAsync(
        AgentSessionSocket channel,
        FileSessionState state,
        JsonElement message,
        CancellationTokenSource lifetime,
        CancellationToken cancellationToken)
    {
        if (message.ValueKind != JsonValueKind.Object) return;
        var kind = WebSshJson.ReadString(message, "kind");
        var id = WebSshJson.ReadString(message, "id");
        var transferId = WebSshJson.ReadString(message, "transferId");
        logger.LogDebug("File session {SessionId} received {Kind} {RequestId}", state.Id, kind, id);
        if (kind == "close")
        {
            lifetime.Cancel();
            return;
        }
        try
        {
            switch (kind)
            {
                case "roots":
                    await channel.SendJsonAsync(new { kind = "rootsResult", id, roots = Roots() }, cancellationToken);
                    return;
                case "list": {
                    var path = WebSshJson.ReadString(message, "path");
                    var result = state.Store.List(path);
                    await channel.SendJsonAsync(new
                    {
                        kind = "listResult",
                        id,
                        path = result.Path,
                        entries = result.Entries.Select(entry => new
                        {
                            name = entry.Name,
                            type = entry.Type,
                            size = entry.Size,
                            mtimeUtc = entry.MtimeUtc,
                        }),
                        truncated = result.Truncated,
                    }, cancellationToken);
                    return;
                }
                case "delete": {
                    var path = WebSshJson.ReadString(message, "path");
                    state.Store.DeleteFile(path);
                    FileTransferStore.TryNormalizePath(path, out var full);
                    await channel.SendJsonAsync(new { kind = "deleteResult", id, path = full, deleted = true }, cancellationToken);
                    return;
                }
                case "download": {
                    var request = message.Clone();
                    state.TrackDownload(Task.Run(() => DownloadAsync(channel, state, request, lifetime.Token), CancellationToken.None));
                    return;
                }
                case "upload": {
                    var path = WebSshJson.ReadString(message, "path");
                    var size = WebSshJson.ReadInt64(message, "size") ?? -1;
                    var offset = WebSshJson.ReadInt64(message, "offset") ?? -1;
                    var upload = state.Store.BeginUpload(transferId, path, size, offset);
                    await channel.SendJsonAsync(new { kind = "uploadReady", id, transferId, receivedBytes = upload.ReceivedBytes }, cancellationToken);
                    return;
                }
                case "uploadChunk": {
                    var offset = WebSshJson.ReadInt64(message, "offset") ?? -1;
                    var dataText = WebSshJson.ReadString(message, "data");
                    var sha256 = WebSshJson.ReadString(message, "sha256");
                    if (dataText.Length is < 4 or > 360 * 1024) throw new FileTransferException("INVALID_CHUNK", "分块大小无效。");
                    byte[] data;
                    try { data = Convert.FromBase64String(dataText); }
                    catch (FormatException) { throw new FileTransferException("INVALID_CHUNK", "分块不是有效的 base64。"); }
                    var upload = state.Store.AppendChunk(transferId, offset, data, sha256);
                    await channel.SendJsonAsync(new { kind = "uploadAck", id, transferId, receivedBytes = upload.ReceivedBytes }, cancellationToken);
                    return;
                }
                case "uploadComplete": {
                    var size = WebSshJson.ReadInt64(message, "size") ?? -1;
                    var sha256 = WebSshJson.ReadString(message, "sha256");
                    var (finalPath, hash, finalSize) = state.Store.CompleteUpload(transferId, size, string.IsNullOrEmpty(sha256) ? null : sha256);
                    await channel.SendJsonAsync(new
                    {
                        kind = "uploadComplete",
                        id,
                        transferId,
                        path = finalPath,
                        size = finalSize,
                        sha256 = hash,
                    }, cancellationToken);
                    return;
                }
                case "cancel":
                    state.Store.Cancel(transferId);
                    return;
                default:
                    return;
            }
        }
        catch (FileTransferException ex)
        {
            await SendErrorAsync(channel, id, transferId, ex.Code, ex.Message, ex.ReceivedBytes, cancellationToken);
        }
        catch (UnauthorizedAccessException)
        {
            await SendErrorAsync(channel, id, transferId, "ACCESS_DENIED", "没有权限执行该文件操作。", null, cancellationToken);
        }
        catch (IOException ex)
        {
            await SendErrorAsync(channel, id, transferId, "IO_ERROR", $"文件操作失败：{ex.Message}", null, cancellationToken);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            await SendErrorAsync(channel, id, transferId, "INVALID_PATH", "路径无效。", null, cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "File session {SessionId} message {Kind} failed", state.Id, kind);
            await SendErrorAsync(channel, id, transferId, "INTERNAL_ERROR", "文件操作失败。", null, cancellationToken);
        }
    }

    private async Task DownloadAsync(AgentSessionSocket channel, FileSessionState state, JsonElement request, CancellationToken cancellationToken)
    {
        var id = WebSshJson.ReadString(request, "id");
        var transferId = WebSshJson.ReadString(request, "transferId");
        try
        {
            var path = WebSshJson.ReadString(request, "path");
            var offset = WebSshJson.ReadInt64(request, "offset") ?? 0;
            if (!FileTransferStore.IsValidTransferId(transferId)) throw new FileTransferException("INVALID_TRANSFER", "传输标识无效。");
            var info = state.Store.InspectDownload(path);
            if (offset < 0 || offset > info.Size) throw new FileTransferException("INVALID_RANGE", "下载偏移无效。");
            await channel.SendJsonAsync(new
            {
                kind = "downloadStart",
                id,
                transferId,
                name = info.Name,
                size = info.Size,
                sha256 = info.Sha256,
            }, cancellationToken);
            var position = offset;
            while (position < info.Size && !cancellationToken.IsCancellationRequested)
            {
                var chunk = state.Store.ReadChunk(path, position, FileTransferStore.MaxChunkBytes);
                if (chunk.Length == 0) break;
                await channel.SendJsonAsync(new
                {
                    kind = "downloadChunk",
                    id,
                    transferId,
                    offset = position,
                    data = Convert.ToBase64String(chunk),
                    sha256 = FileTransferStore.Sha256Hex(chunk),
                }, cancellationToken);
                position += chunk.Length;
            }
            await channel.SendJsonAsync(new { kind = "downloadComplete", id, transferId, size = info.Size }, cancellationToken);
        }
        catch (OperationCanceledException) { }
        catch (FileTransferException ex)
        {
            await SafeErrorAsync(channel, id, transferId, ex.Code, ex.Message, ex.ReceivedBytes);
        }
        catch (UnauthorizedAccessException)
        {
            await SafeErrorAsync(channel, id, transferId, "ACCESS_DENIED", "没有权限读取该文件。", null);
        }
        catch (IOException ex)
        {
            await SafeErrorAsync(channel, id, transferId, "IO_ERROR", $"下载失败：{ex.Message}", null);
        }
        catch (System.Net.WebSockets.WebSocketException) { /* 会话已关闭 */ }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "File session {SessionId} download failed", state.Id);
            await SafeErrorAsync(channel, id, transferId, "INTERNAL_ERROR", "下载失败。", null);
        }
    }

    private static async Task SendErrorAsync(
        AgentSessionSocket channel,
        string id,
        string transferId,
        string code,
        string message,
        long? receivedBytes,
        CancellationToken cancellationToken)
    {
        var payload = new Dictionary<string, object?> { ["kind"] = "error", ["code"] = code, ["message"] = message };
        if (id.Length > 0) payload["id"] = id;
        if (transferId.Length > 0) payload["transferId"] = transferId;
        if (receivedBytes is not null) payload["receivedBytes"] = receivedBytes;
        await channel.SendJsonAsync(payload, cancellationToken);
    }

    private static async Task SafeErrorAsync(
        AgentSessionSocket channel,
        string id,
        string transferId,
        string code,
        string message,
        long? receivedBytes)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        try { await SendErrorAsync(channel, id, transferId, code, message, receivedBytes, timeout.Token); }
        catch { /* 通道可能已关闭 */ }
    }

    private static object[] Roots()
    {
        var roots = new List<object>();
        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (!drive.IsReady || drive.DriveType is not (DriveType.Fixed or DriveType.Removable)) continue;
                roots.Add(new
                {
                    path = drive.RootDirectory.FullName,
                    label = drive.Name.TrimEnd('\\'),
                    freeBytes = (long?)drive.AvailableFreeSpace,
                    totalBytes = (long?)drive.TotalSize,
                });
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // 单个驱动器不可用时跳过。
            }
        }
        return roots.ToArray();
    }

    private sealed class FileSessionState : IDisposable
    {
        private readonly ConcurrentDictionary<string, Task> _downloads = new(StringComparer.Ordinal);

        public FileSessionState(string id, AgentPaths paths)
        {
            Id = id;
            TemporaryDirectory = Path.Combine(paths.WebSshTransfersDirectory, Guid.NewGuid().ToString("N"));
            Store = new FileTransferStore(TemporaryDirectory);
        }

        public string Id { get; }
        public string TemporaryDirectory { get; }
        public FileTransferStore Store { get; }

        public void TrackDownload(Task task)
        {
            var key = Guid.NewGuid().ToString("N");
            _downloads[key] = task;
            task.ContinueWith(completed => _downloads.TryRemove(key, out _), TaskScheduler.Default);
        }

        public void Dispose()
        {
            try { Directory.Delete(TemporaryDirectory, true); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* 交给过期清理 */ }
        }
    }
}
