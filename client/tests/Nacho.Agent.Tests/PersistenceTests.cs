using Nacho.Agent;

namespace Nacho.Agent.Tests;

public sealed class PersistenceTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "nacho-agent-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void State_store_round_trips_DPAPI_protected_state()
    {
        var store = new StateStore(new AgentPaths(_directory));
        store.Save(new AgentState("client-1", "secret-token"));
        Assert.Equal("secret-token", new StateStore(new AgentPaths(_directory)).Load()!.Token);
        Assert.DoesNotContain("secret-token", File.ReadAllText(Path.Combine(_directory, "state.dat")));
    }

    [Fact]
    public async Task Journal_reloads_an_atomic_command_entry()
    {
        var journal = new CommandJournal(new AgentPaths(_directory));
        var payload = System.Text.Json.JsonDocument.Parse("{}").RootElement.Clone();
        var command = new AgentCommand { Id = "cmd_123", ClientId = "client-1", Type = "run-program", Status = "pending", Payload = payload, CreatedAt = 1, UpdatedAt = 1 };
        var created = await journal.GetOrCreateAsync(command, CancellationToken.None);
        created.State = "completed";
        created.FinalStatus = "success";
        created.Reported = true;
        await journal.SaveAsync(created);

        var loaded = await new CommandJournal(new AgentPaths(_directory)).GetAsync(command.Id);
        Assert.NotNull(loaded);
        Assert.Equal("completed", loaded!.State);
        Assert.True(loaded.Reported);
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, true);
    }
}
