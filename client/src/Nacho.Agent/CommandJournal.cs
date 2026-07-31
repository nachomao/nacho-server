using System.Text.Json;

namespace Nacho.Agent;

public sealed class CommandJournal(AgentPaths paths)
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<JournalEntry?> GetAsync(string id, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var file = PathFor(id);
            if (!File.Exists(file)) return null;
            await using var stream = File.OpenRead(file);
            return await JsonSerializer.DeserializeAsync(stream, AgentJsonContext.Default.JournalEntry, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    public async Task<JournalEntry> GetOrCreateAsync(AgentCommand command, CancellationToken cancellationToken)
    {
        var existing = await GetAsync(command.Id, cancellationToken);
        if (existing is not null) return existing;
        var entry = new JournalEntry { Command = command };
        await SaveAsync(entry, cancellationToken);
        return entry;
    }

    public async Task SaveAsync(JournalEntry entry, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            Directory.CreateDirectory(paths.QueueDirectory);
            entry.UpdatedAt = DateTimeOffset.UtcNow;
            var file = PathFor(entry.Command.Id);
            var temporary = file + ".tmp";
            await using (var stream = File.Create(temporary))
                await JsonSerializer.SerializeAsync(stream, entry, AgentJsonContext.Default.JournalEntry, cancellationToken);
            File.Move(temporary, file, true);
        }
        finally { _gate.Release(); }
    }

    public async Task<IReadOnlyList<JournalEntry>> ListAsync(CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(paths.QueueDirectory)) return [];
        var entries = new List<JournalEntry>();
        foreach (var file in Directory.EnumerateFiles(paths.QueueDirectory, "*.json"))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var id = Path.GetFileNameWithoutExtension(file);
            var entry = await GetAsync(id, cancellationToken);
            if (entry is not null) entries.Add(entry);
        }
        return entries;
    }

    private string PathFor(string id)
    {
        var safe = new string(id.Where(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_').ToArray());
        if (safe.Length == 0 || safe != id) throw new InvalidDataException("Invalid command id.");
        return Path.Combine(paths.QueueDirectory, safe + ".json");
    }
}
