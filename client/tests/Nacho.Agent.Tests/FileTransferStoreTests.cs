using System.Text;

namespace Nacho.Agent.Tests;

public sealed class FileTransferStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "nacho-webssh-store-tests", Guid.NewGuid().ToString("N"));
    private readonly string _workspace;
    private readonly FileTransferStore _store;

    public FileTransferStoreTests()
    {
        _workspace = Path.Combine(_root, "workspace");
        Directory.CreateDirectory(_workspace);
        _store = new FileTransferStore(Path.Combine(_root, "temp"));
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, true); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    [Fact]
    public void Normalizes_only_local_absolute_windows_paths()
    {
        Assert.True(FileTransferStore.TryNormalizePath(_workspace, out var normalized));
        Assert.Equal(Path.GetFullPath(_workspace), normalized);
        Assert.True(FileTransferStore.TryNormalizePath(_workspace.Replace('\\', '/'), out var slashed));
        Assert.Equal(Path.GetFullPath(_workspace), slashed);

        Assert.False(FileTransferStore.TryNormalizePath("relative\\file.txt", out _));
        Assert.False(FileTransferStore.TryNormalizePath(@"\\server\share\file.txt", out _));
        Assert.False(FileTransferStore.TryNormalizePath(@"C:\temp\file.txt:stream", out _));
        Assert.False(FileTransferStore.TryNormalizePath("C:\\temp\\bad\u0001name", out _));
        Assert.False(FileTransferStore.TryNormalizePath("", out _));
    }

    [Fact]
    public void List_returns_directories_first_with_sizes()
    {
        Directory.CreateDirectory(Path.Combine(_workspace, "zeta"));
        File.WriteAllText(Path.Combine(_workspace, "beta.txt"), "hello");
        File.WriteAllText(Path.Combine(_workspace, "Alpha.log"), "x");
        var result = _store.List(_workspace);
        Assert.EndsWith("workspace", result.Path, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(["zeta", "Alpha.log", "beta.txt"], result.Entries.Select(entry => entry.Name).ToArray());
        Assert.Equal("dir", result.Entries[0].Type);
        Assert.Null(result.Entries[0].Size);
        Assert.Equal(5, result.Entries[2].Size);
        Assert.NotNull(result.Entries[2].MtimeUtc);
    }

    [Fact]
    public void Upload_verifies_chunks_and_supports_resume()
    {
        var content = Encoding.UTF8.GetBytes("0123456789abcdefghijklmnopqrstuvwxyz");
        var target = Path.Combine(_workspace, "resume.txt");
        var transferId = "transfer-12345678";
        var first = content[..16];
        var second = content[16..];

        var opened = _store.BeginUpload(transferId, target, content.Length, 0);
        Assert.Equal(0, opened.ReceivedBytes);
        var afterFirst = _store.AppendChunk(transferId, 0, first, FileTransferStore.Sha256Hex(first));
        Assert.Equal(first.Length, afterFirst.ReceivedBytes);

        var resumed = _store.BeginUpload(transferId, target, content.Length, afterFirst.ReceivedBytes);
        Assert.Equal(first.Length, resumed.ReceivedBytes);
        var afterSecond = _store.AppendChunk(transferId, first.Length, second, FileTransferStore.Sha256Hex(second));
        Assert.Equal(content.Length, afterSecond.ReceivedBytes);

        var mismatch = Assert.Throws<FileTransferException>(() =>
            _store.CompleteUpload(transferId, content.Length, new string('0', 64)));
        Assert.Equal("FILE_HASH_MISMATCH", mismatch.Code);
        Assert.False(File.Exists(target));

        var completed = _store.CompleteUpload(transferId, content.Length, FileTransferStore.Sha256Hex(content));
        Assert.Equal(content.Length, completed.Size);
        Assert.True(File.Exists(target));
        Assert.Equal(content, File.ReadAllBytes(target));
    }

    [Fact]
    public void Upload_rejects_bad_offsets_hashes_and_sizes()
    {
        var content = Encoding.UTF8.GetBytes("chunk-data");
        var target = Path.Combine(_workspace, "guarded.txt");
        var transferId = "transfer-abcdef12";
        _store.BeginUpload(transferId, target, content.Length, 0);

        var hashFailure = Assert.Throws<FileTransferException>(() =>
            _store.AppendChunk(transferId, 0, content, new string('a', 64)));
        Assert.Equal("CHUNK_HASH_MISMATCH", hashFailure.Code);

        var offsetFailure = Assert.Throws<FileTransferException>(() =>
            _store.AppendChunk(transferId, 3, content, FileTransferStore.Sha256Hex(content)));
        Assert.Equal("OFFSET_MISMATCH", offsetFailure.Code);
        Assert.Equal(0, offsetFailure.ReceivedBytes);

        var tooLarge = Assert.Throws<FileTransferException>(() =>
            _store.BeginUpload("transfer-ffffffff", target, FileTransferStore.MaxFileBytes + 1, 0));
        Assert.Equal("FILE_TOO_LARGE", tooLarge.Code);

        var missingTransfer = Assert.Throws<FileTransferException>(() =>
            _store.AppendChunk("transfer-missing01", 0, content, FileTransferStore.Sha256Hex(content)));
        Assert.Equal("TRANSFER_NOT_OPENED", missingTransfer.Code);
    }

    [Fact]
    public void Delete_only_removes_files()
    {
        var file = Path.Combine(_workspace, "delete-me.txt");
        File.WriteAllText(file, "x");
        _store.DeleteFile(file);
        Assert.False(File.Exists(file));

        var directory = Path.Combine(_workspace, "folder");
        Directory.CreateDirectory(directory);
        var directoryFailure = Assert.Throws<FileTransferException>(() => _store.DeleteFile(directory));
        Assert.Equal("NOT_A_FILE", directoryFailure.Code);

        var missing = Assert.Throws<FileTransferException>(() => _store.DeleteFile(Path.Combine(_workspace, "missing.txt")));
        Assert.Equal("NOT_FOUND", missing.Code);
    }

    [Fact]
    public void Download_inspects_hash_and_reads_offsets()
    {
        var content = Encoding.UTF8.GetBytes("0123456789");
        var file = Path.Combine(_workspace, "download.bin");
        File.WriteAllBytes(file, content);

        var info = _store.InspectDownload(file);
        Assert.Equal("download.bin", info.Name);
        Assert.Equal(content.Length, info.Size);
        Assert.Equal(FileTransferStore.Sha256Hex(content), info.Sha256);

        var chunk = _store.ReadChunk(file, 4, 3);
        Assert.Equal("456", Encoding.UTF8.GetString(chunk));
        Assert.Empty(_store.ReadChunk(file, content.Length, 1024));
        var rangeFailure = Assert.Throws<FileTransferException>(() => _store.ReadChunk(file, content.Length + 1, 1));
        Assert.Equal("INVALID_RANGE", rangeFailure.Code);
    }
}
