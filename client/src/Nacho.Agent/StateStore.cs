using System.Security.Cryptography;
using System.Text.Json;

namespace Nacho.Agent;

public sealed class StateStore(AgentPaths paths)
{
    private AgentState? _cached;

    public AgentState? Load()
    {
        if (_cached is not null) return _cached;
        if (!File.Exists(paths.StateFile)) return null;
        var protectedBytes = File.ReadAllBytes(paths.StateFile);
        var bytes = ProtectedData.Unprotect(protectedBytes, null, DataProtectionScope.LocalMachine);
        _cached = JsonSerializer.Deserialize(bytes, AgentJsonContext.Default.AgentState)
            ?? throw new InvalidDataException("Agent state is empty.");
        return _cached;
    }

    public void Save(AgentState state)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(state, AgentJsonContext.Default.AgentState);
        var protectedBytes = ProtectedData.Protect(bytes, null, DataProtectionScope.LocalMachine);
        WriteAtomic(paths.StateFile, protectedBytes);
        _cached = state;
    }

    public string? ReadEnrollmentKey() => File.Exists(paths.EnrollmentKeyFile)
        ? File.ReadAllText(paths.EnrollmentKeyFile).Trim()
        : null;

    public void DeleteEnrollmentKey()
    {
        if (File.Exists(paths.EnrollmentKeyFile)) File.Delete(paths.EnrollmentKeyFile);
    }

    public void Reset()
    {
        _cached = null;
        if (File.Exists(paths.StateFile)) File.Delete(paths.StateFile);
    }

    private static void WriteAtomic(string path, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp";
        File.WriteAllBytes(temporary, bytes);
        File.Move(temporary, path, true);
    }
}
