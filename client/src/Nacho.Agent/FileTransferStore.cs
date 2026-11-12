using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Nacho.Agent;

/// <summary>
/// WebSSH 文件传输的本地文件系统实现：
/// 路径只允许本机固定/可移动驱动器上的绝对 Windows 路径；
/// 上传先写入临时文件，按块校验 SHA-256，完成后整文件校验并原子替换目标。
/// </summary>
public sealed class FileTransferStore
{
    public const int MaxFileBytes = 512 * 1024 * 1024;
    public const int MaxChunkBytes = 256 * 1024;
    public const int MaxListEntries = 2000;
    private static readonly TimeSpan StaleTransferAge = TimeSpan.FromHours(24);
    private readonly string _tempDirectory;
    private readonly Dictionary<string, UploadState> _uploads = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public FileTransferStore(string tempDirectory)
    {
        _tempDirectory = Path.GetFullPath(tempDirectory);
        Directory.CreateDirectory(_tempDirectory);
        CleanupStaleTransfers();
    }

    public sealed record Entry(string Name, string Type, long? Size, string? MtimeUtc);

    public sealed record ListResult(string Path, IReadOnlyList<Entry> Entries, bool Truncated);

    public sealed record DownloadInfo(string Name, long Size, string Sha256);

    public sealed record UploadState(string TransferId, string Path, long Size, string TemporaryPath, long ReceivedBytes);

    public static bool TryNormalizePath(string? raw, out string fullPath)
    {
        fullPath = "";
        if (string.IsNullOrWhiteSpace(raw) || raw.Length > 32_767) return false;
        if (raw.Any(character => character == '\0' || char.IsControl(character))) return false;
        var candidate = raw.Replace('/', '\\');
        if (candidate.Length < 3) return false;
        if (!char.IsAsciiLetter(candidate[0]) || candidate[1] != ':' || candidate[2] != '\\') return false;
        if (candidate.IndexOf(':', 2) >= 0) return false;
        if (candidate.StartsWith(@"\\?\", StringComparison.Ordinal) || candidate.StartsWith(@"\\.\", StringComparison.Ordinal)) return false;
        try
        {
            var full = Path.GetFullPath(candidate);
            if (full.Length < 3 || !char.IsAsciiLetter(full[0]) || full[1] != ':' || full[2] != '\\') return false;
            fullPath = full;
            return true;
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }
    }

    public static bool IsValidTransferId(string transferId) =>
        transferId.Length is >= 8 and <= 64 &&
        transferId.All(character => char.IsAsciiLetterOrDigit(character) || character == '-');

    public ListResult List(string path)
    {
        var full = RequirePath(path, "INVALID_PATH");
        var directory = new DirectoryInfo(full);
        if (!directory.Exists) throw new FileTransferException("NOT_FOUND", "目录不存在。");
        var entries = new List<Entry>();
        var truncated = false;
        foreach (var info in directory.EnumerateFileSystemInfos())
        {
            if (entries.Count >= MaxListEntries)
            {
                truncated = true;
                break;
            }
            try
            {
                if (info is DirectoryInfo childDirectory)
                    entries.Add(new Entry(childDirectory.Name, "dir", null, childDirectory.LastWriteTimeUtc.ToString("o", CultureInfo.InvariantCulture)));
                else if (info is FileInfo childFile)
                    entries.Add(new Entry(childFile.Name, "file", childFile.Length, childFile.LastWriteTimeUtc.ToString("o", CultureInfo.InvariantCulture)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // 单个条目读取失败不应让整个目录不可用。
            }
        }
        entries.Sort((left, right) =>
        {
            if (left.Type != right.Type) return left.Type == "dir" ? -1 : 1;
            return string.Compare(left.Name, right.Name, StringComparison.OrdinalIgnoreCase);
        });
        return new ListResult(full, entries, truncated);
    }

    public void DeleteFile(string path)
    {
        var full = RequirePath(path, "INVALID_PATH");
        if (Directory.Exists(full)) throw new FileTransferException("NOT_A_FILE", "该路径是目录，当前仅支持删除文件。");
        if (!File.Exists(full)) throw new FileTransferException("NOT_FOUND", "文件不存在。");
        try { File.Delete(full); }
        catch (UnauthorizedAccessException) { throw new FileTransferException("ACCESS_DENIED", "没有权限删除该文件。"); }
        catch (IOException ex) { throw new FileTransferException("IO_ERROR", $"删除失败：{ex.Message}"); }
    }

    public DownloadInfo InspectDownload(string path)
    {
        var full = RequirePath(path, "INVALID_PATH");
        var info = new FileInfo(full);
        if (!info.Exists) throw new FileTransferException("NOT_FOUND", "文件不存在。");
        if (info.Length > MaxFileBytes) throw new FileTransferException("FILE_TOO_LARGE", "文件超过 512 MiB 传输上限。");
        try
        {
            using var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 128 * 1024, FileOptions.SequentialScan);
            var hash = Convert.ToHexStringLower(SHA256.HashData(stream));
            return new DownloadInfo(info.Name, info.Length, hash);
        }
        catch (UnauthorizedAccessException) { throw new FileTransferException("ACCESS_DENIED", "没有权限读取该文件。"); }
        catch (IOException ex) { throw new FileTransferException("IO_ERROR", $"读取失败：{ex.Message}"); }
    }

    public byte[] ReadChunk(string path, long offset, int maximumBytes)
    {
        var full = RequirePath(path, "INVALID_PATH");
        if (offset < 0 || offset > MaxFileBytes || maximumBytes is < 1 or > MaxChunkBytes)
            throw new FileTransferException("INVALID_RANGE", "下载偏移或分块大小无效。");
        try
        {
            using var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 128 * 1024, FileOptions.SequentialScan);
            if (offset > stream.Length) throw new FileTransferException("INVALID_RANGE", "下载偏移超过文件大小。");
            stream.Seek(offset, SeekOrigin.Begin);
            var buffer = new byte[Math.Min(maximumBytes, Math.Max(0, (int)Math.Min(int.MaxValue, stream.Length - offset)))];
            var total = 0;
            while (total < buffer.Length)
            {
                var read = stream.Read(buffer, total, buffer.Length - total);
                if (read == 0) break;
                total += read;
            }
            return total == buffer.Length ? buffer : buffer[..total];
        }
        catch (UnauthorizedAccessException) { throw new FileTransferException("ACCESS_DENIED", "没有权限读取该文件。"); }
        catch (IOException ex) { throw new FileTransferException("IO_ERROR", $"读取失败：{ex.Message}"); }
    }

    public UploadState BeginUpload(string transferId, string path, long size, long offset)
    {
        if (!IsValidTransferId(transferId)) throw new FileTransferException("INVALID_TRANSFER", "传输标识无效。");
        var full = RequirePath(path, "INVALID_PATH");
        if (size is < 1 or > MaxFileBytes) throw new FileTransferException("FILE_TOO_LARGE", "文件大小超过 512 MiB 上限。");
        if (offset < 0 || offset > size) throw new FileTransferException("INVALID_RANGE", "上传偏移无效。");
        if (Directory.Exists(full)) throw new FileTransferException("TARGET_IS_DIRECTORY", "目标路径是目录。");
        var parent = Path.GetDirectoryName(full);
        if (string.IsNullOrEmpty(parent) || !Directory.Exists(parent)) throw new FileTransferException("PARENT_NOT_FOUND", "目标目录不存在。");

        var temporaryPath = Path.Combine(_tempDirectory, transferId + ".part");
        lock (_gate)
        {
            if (offset == 0)
            {
                try
                {
                    using (new FileStream(temporaryPath, FileMode.Create, FileAccess.Write, FileShare.None)) { }
                }
                catch (IOException ex) { throw new FileTransferException("IO_ERROR", $"无法创建临时文件：{ex.Message}"); }
                var reset = new UploadState(transferId, full, size, temporaryPath, 0);
                _uploads[transferId] = reset;
                return reset;
            }
            if (!File.Exists(temporaryPath)) throw new FileTransferException("OFFSET_MISMATCH", "临时分片不存在，请从 0 开始上传。", 0);
            long received;
            try { received = new FileInfo(temporaryPath).Length; }
            catch (IOException) { received = 0; }
            if (received != offset) throw new FileTransferException("OFFSET_MISMATCH", "已接收字节与请求偏移不一致。", received);
            var state = new UploadState(transferId, full, size, temporaryPath, received);
            _uploads[transferId] = state;
            return state;
        }
    }

    public UploadState AppendChunk(string transferId, long offset, byte[] data, string sha256)
    {
        if (data.Length is < 1 or > MaxChunkBytes) throw new FileTransferException("INVALID_CHUNK", "分块大小无效。");
        var expectedHash = Convert.ToHexStringLower(SHA256.HashData(data));
        if (!string.Equals(expectedHash, sha256, StringComparison.OrdinalIgnoreCase))
            throw new FileTransferException("CHUNK_HASH_MISMATCH", "分块校验失败。");
        lock (_gate)
        {
            if (!_uploads.TryGetValue(transferId, out var state))
            {
                var received = File.Exists(Path.Combine(_tempDirectory, transferId + ".part"))
                    ? new FileInfo(Path.Combine(_tempDirectory, transferId + ".part")).Length
                    : 0;
                throw new FileTransferException("TRANSFER_NOT_OPENED", "上传会话未初始化。", received);
            }
            if (offset != state.ReceivedBytes)
                throw new FileTransferException("OFFSET_MISMATCH", "分块偏移与已接收字节不一致。", state.ReceivedBytes);
            if (state.ReceivedBytes + data.Length > state.Size)
                throw new FileTransferException("SIZE_EXCEEDED", "上传内容超过声明的文件大小。", state.ReceivedBytes);
            try
            {
                using var stream = new FileStream(state.TemporaryPath, FileMode.Append, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.None);
                stream.Write(data, 0, data.Length);
                stream.Flush(true);
            }
            catch (IOException ex) { throw new FileTransferException("IO_ERROR", $"写入分块失败：{ex.Message}", state.ReceivedBytes); }
            var next = state with { ReceivedBytes = state.ReceivedBytes + data.Length };
            _uploads[transferId] = next;
            return next;
        }
    }

    public (string Path, string Sha256, long Size) CompleteUpload(string transferId, long size, string? expectedSha256)
    {
        lock (_gate)
        {
            if (!_uploads.TryGetValue(transferId, out var state))
                throw new FileTransferException("TRANSFER_NOT_OPENED", "上传会话未初始化。");
            if (state.Size != size) throw new FileTransferException("SIZE_MISMATCH", "声明大小与上传状态不一致。", state.ReceivedBytes);
            long actualLength;
            try { actualLength = new FileInfo(state.TemporaryPath).Length; }
            catch (IOException) { throw new FileTransferException("IO_ERROR", "无法读取临时文件。", state.ReceivedBytes); }
            if (actualLength != size)
                throw new FileTransferException("INCOMPLETE_UPLOAD", "文件尚未完整上传。", actualLength);
            string finalHash;
            try
            {
                using var stream = new FileStream(state.TemporaryPath, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.SequentialScan);
                finalHash = Convert.ToHexStringLower(SHA256.HashData(stream));
            }
            catch (IOException ex) { throw new FileTransferException("IO_ERROR", $"校验失败：{ex.Message}", actualLength); }
            if (!string.IsNullOrEmpty(expectedSha256) &&
                !string.Equals(finalHash, expectedSha256, StringComparison.OrdinalIgnoreCase))
                throw new FileTransferException("FILE_HASH_MISMATCH", "整文件校验失败。", actualLength);
            try { File.Move(state.TemporaryPath, state.Path, true); }
            catch (UnauthorizedAccessException) { throw new FileTransferException("ACCESS_DENIED", "没有权限写入目标文件。", actualLength); }
            catch (IOException ex) { throw new FileTransferException("IO_ERROR", $"写入目标文件失败：{ex.Message}", actualLength); }
            _uploads.Remove(transferId);
            return (state.Path, finalHash, size);
        }
    }

    public void Cancel(string transferId)
    {
        lock (_gate)
        {
            if (!_uploads.Remove(transferId)) return;
            try { File.Delete(Path.Combine(_tempDirectory, transferId + ".part")); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* 交给过期清理 */ }
        }
    }

    public static string Sha256Hex(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));

    private static string RequirePath(string raw, string code)
    {
        if (!TryNormalizePath(raw, out var full)) throw new FileTransferException(code, "路径无效，仅支持本机绝对 Windows 路径。");
        return full;
    }

    private void CleanupStaleTransfers()
    {
        try
        {
            var cutoff = DateTimeOffset.UtcNow - StaleTransferAge;
            foreach (var file in Directory.EnumerateFiles(_tempDirectory, "*.part"))
            {
                try
                {
                    if (File.GetLastWriteTimeUtc(file) < cutoff.UtcDateTime) File.Delete(file);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* 下次再试 */ }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* 目录不可用时不阻塞会话 */ }
    }
}

public sealed class FileTransferException(string code, string message, long? receivedBytes = null) : Exception(message)
{
    public string Code { get; } = code;
    public long? ReceivedBytes { get; } = receivedBytes;
}
