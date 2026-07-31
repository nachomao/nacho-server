using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nacho.Agent;

public sealed record AgentState(string ClientId, string Token);

public sealed record ClientMetrics(double Cpu, double Memory, double Disk, long Uptime);

public sealed class AgentCommand
{
    public required string Id { get; init; }
    public required string ClientId { get; init; }
    public string? TaskId { get; init; }
    public required string Type { get; init; }
    public JsonElement Payload { get; init; }
    public required string Status { get; init; }
    public long CreatedAt { get; init; }
    public long UpdatedAt { get; init; }
}

public sealed class ApiEnvelope<T>
{
    public bool Ok { get; init; }
    public T? Data { get; init; }
    public string? Message { get; init; }
}

public sealed record EnrollmentResult(EnrollmentClient Client, string Token);
public sealed record EnrollmentClient(string Id);

public sealed class JournalEntry
{
    public required AgentCommand Command { get; init; }
    public string State { get; set; } = "received";
    public string? FinalStatus { get; set; }
    public string? Result { get; set; }
    public int? ExitCode { get; set; }
    public bool Reported { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed record ExecutionResult(string Status, string Result, int? ExitCode);

public sealed class UpdateIntent
{
    public int Version { get; init; } = 1;
    public required string CommandId { get; init; }
    public required string FromVersion { get; init; }
    public required string TargetVersion { get; init; }
    public required string InstallPath { get; init; }
    public required string StagedPath { get; init; }
    public required string BackupPath { get; init; }
    public required string Sha256 { get; init; }
    public required long SizeBytes { get; init; }
    public required string Phase { get; set; }
    public string? Error { get; set; }
    public bool RolledBack { get; set; }
    public string? RollbackReason { get; set; }
    public long DownloadedBytes { get; set; }
    public long DurationMs { get; set; }
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed record UpdateHealth(string Version, DateTimeOffset HeartbeatAt);

public sealed class RestartIntent
{
    public int Version { get; init; } = 1;
    public required string CommandId { get; init; }
    public required DateTimeOffset RequestedAt { get; init; }
    public required DateTimeOffset ExpiresAt { get; init; }
    public required string PreviousBootId { get; init; }
    public string? CurrentBootId { get; set; }
    public required int DelaySeconds { get; init; }
    public string? Reason { get; init; }
    public required string Phase { get; set; }
    public string? Error { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

[JsonSerializable(typeof(AgentState))]
[JsonSerializable(typeof(AgentCommand))]
[JsonSerializable(typeof(ApiEnvelope<EnrollmentResult>))]
[JsonSerializable(typeof(ApiEnvelope<AgentCommand[]>))]
[JsonSerializable(typeof(ApiEnvelope<JsonElement>))]
[JsonSerializable(typeof(JournalEntry))]
[JsonSerializable(typeof(RestartIntent))]
[JsonSerializable(typeof(UpdateIntent))]
[JsonSerializable(typeof(UpdateHealth))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class AgentJsonContext : JsonSerializerContext;
