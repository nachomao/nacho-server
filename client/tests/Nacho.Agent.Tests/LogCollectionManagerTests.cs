using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Nacho.Agent.Tests;

public sealed class LogCollectionManagerTests
{
    private static readonly DateTimeOffset Until = DateTimeOffset.UtcNow.AddMinutes(-1);
    private static readonly DateTimeOffset Since = Until.AddHours(-1);

    [Fact]
    public void PolicyDefaultsToFalseAndBindsExplicitValue()
    {
        Assert.False(new AgentOptions { ServerUrl = "http://127.0.0.1" }.AllowLogCollection);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["AllowLogCollection"] = "true" })
            .Build();
        Assert.True(configuration.Get<AgentOptions>()!.AllowLogCollection);
    }

    [Fact]
    public async Task PolicyClosedReturnsStableStructuredFailure()
    {
        var result = await Manager(new FakeReader(), enabled: false).ExecuteAsync(Payload(), default);
        Assert.Equal("failed", result.Status);
        using var json = JsonDocument.Parse(result.Result);
        Assert.Equal("Log collection is disabled by local policy.", json.RootElement.GetProperty("error").GetString());
        Assert.Equal(JsonValueKind.Array, json.RootElement.GetProperty("entries").ValueKind);
        Assert.Null(result.ExitCode);
    }

    [Fact]
    public async Task UnsupportedPlatformReturnsStableFailure()
    {
        var result = await Manager(new FakeReader { IsSupported = false }).ExecuteAsync(Payload(), default);
        Assert.Equal("failed", result.Status);
        Assert.Contains("only on Windows", result.Result, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("{\"sources\":[\"agent\"],\"sinceUtc\":\"2026-01-01T00:00:00Z\",\"untilUtc\":\"2026-01-01T01:00:00Z\",\"maxEntries\":1,\"path\":\"C:\\\\secret\"}", "unsupported")]
    [InlineData("{\"sources\":[],\"sinceUtc\":\"2026-01-01T00:00:00Z\",\"untilUtc\":\"2026-01-01T01:00:00Z\",\"maxEntries\":1}", "1 to 3")]
    [InlineData("{\"sources\":[\"agent\",\"agent\"],\"sinceUtc\":\"2026-01-01T00:00:00Z\",\"untilUtc\":\"2026-01-01T01:00:00Z\",\"maxEntries\":1}", "duplicate")]
    [InlineData("{\"sources\":[\"security\"],\"sinceUtc\":\"2026-01-01T00:00:00Z\",\"untilUtc\":\"2026-01-01T01:00:00Z\",\"maxEntries\":1}", "unsupported value")]
    [InlineData("{\"sources\":[\"agent\",2],\"sinceUtc\":\"2026-01-01T00:00:00Z\",\"untilUtc\":\"2026-01-01T01:00:00Z\",\"maxEntries\":1}", "only strings")]
    public async Task RejectsUnknownEmptyDuplicateAndInvalidSources(string raw, string expected)
    {
        var result = await Manager(new FakeReader()).ExecuteAsync(Parse(raw), default);
        Assert.Equal("failed", result.Status);
        Assert.Contains(expected, result.Result, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RequiresStrictUtcOrderingAndTwentyFourHourWindow()
    {
        var offset = Payload(since: "2026-01-01T00:00:00+08:00", until: "2026-01-01T01:00:00+08:00");
        Assert.Contains("strict UTC", (await Manager(new FakeReader()).ExecuteAsync(offset, default)).Result, StringComparison.Ordinal);
        var reversed = Payload(since: Utc(Until), until: Utc(Since));
        Assert.Contains("earlier", (await Manager(new FakeReader()).ExecuteAsync(reversed, default)).Result, StringComparison.Ordinal);
        var tooLong = Payload(since: Utc(Until.AddHours(-24).AddTicks(-1)), until: Utc(Until));
        Assert.Contains("24 hours", (await Manager(new FakeReader()).ExecuteAsync(tooLong, default)).Result, StringComparison.Ordinal);
        var boundary = Payload(since: Utc(Until.AddHours(-24)), until: Utc(Until));
        Assert.Equal("success", (await Manager(new FakeReader()).ExecuteAsync(boundary, default)).Status);
        var future = Payload(since: Utc(DateTimeOffset.UtcNow.AddMinutes(1)), until: Utc(DateTimeOffset.UtcNow.AddMinutes(2)));
        Assert.Contains("future", (await Manager(new FakeReader()).ExecuteAsync(future, default)).Result, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(1, "success")]
    [InlineData(1000, "success")]
    [InlineData(0, "failed")]
    [InlineData(1001, "failed")]
    public async Task EnforcesEntryCountBoundaries(int maxEntries, string status)
    {
        Assert.Equal(status, (await Manager(new FakeReader()).ExecuteAsync(Payload(maxEntries: maxEntries), default)).Status);
    }

    [Fact]
    public async Task SortsDeterministicallyCountsSourcesAndTruncates()
    {
        var reader = new FakeReader
        {
            Batches =
            {
                ["agent"] = new LogSourceBatch([
                    Entry("agent", Since.AddMinutes(20), "second"),
                    Entry("agent", Since.AddMinutes(10), "first"),
                ]),
                ["system"] = new LogSourceBatch([Entry("system", Since.AddMinutes(15), "middle")]),
            },
        };
        var result = await Manager(reader).ExecuteAsync(Payload(["agent", "system"], maxEntries: 2), default);
        using var json = JsonDocument.Parse(result.Result);
        var entries = json.RootElement.GetProperty("entries");
        Assert.Equal(2, entries.GetArrayLength());
        Assert.Equal("first", entries[0].GetProperty("message").GetString());
        Assert.Equal("middle", entries[1].GetProperty("message").GetString());
        Assert.True(json.RootElement.GetProperty("truncated").GetBoolean());
        Assert.Equal(1, json.RootElement.GetProperty("countsBySource").GetProperty("agent").GetInt32());
        Assert.Equal(1, json.RootElement.GetProperty("countsBySource").GetProperty("system").GetInt32());
    }

    [Fact]
    public async Task SanitizesSecretsControlsAndUnicodeSafely()
    {
        var message = "Authorization: Bearer abc.def\0\r\napi_key=secret-value token=tok " + string.Concat(Enumerable.Repeat("😀", 5000));
        var reader = new FakeReader { Batches = { ["agent"] = new LogSourceBatch([Entry("agent", Since.AddMinutes(1), message)]) } };
        var result = await Manager(reader).ExecuteAsync(Payload(), default);
        using var json = JsonDocument.Parse(result.Result);
        var sanitized = json.RootElement.GetProperty("entries")[0].GetProperty("message").GetString()!;
        Assert.DoesNotContain("abc.def", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-value", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("token=tok", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain('\0', sanitized);
        Assert.Contains('\n', sanitized);
        Assert.True(sanitized.EnumerateRunes().Count() <= 4096);
    }

    [Fact]
    public async Task AppliesUtf8ResultLimitWithoutSplittingRunes()
    {
        var huge = string.Concat(Enumerable.Repeat("日志😀", 1400));
        var entries = Enumerable.Range(0, 1000)
            .Select(index => Entry("agent", Since.AddSeconds(index), huge + index))
            .ToArray();
        var reader = new FakeReader { Batches = { ["agent"] = new LogSourceBatch(entries) } };
        var result = await Manager(reader).ExecuteAsync(Payload(maxEntries: 1000), default);
        Assert.True(Encoding.UTF8.GetByteCount(result.Result) <= LogCollectionManager.MaximumResultBytes);
        using var json = JsonDocument.Parse(result.Result);
        Assert.True(json.RootElement.GetProperty("truncated").GetBoolean());
        Assert.InRange(json.RootElement.GetProperty("entries").GetArrayLength(), 1, 999);
    }

    [Fact]
    public async Task PreservesPartialSuccessAndSanitizesSourceFailures()
    {
        var reader = new FakeReader
        {
            Batches =
            {
                ["agent"] = new LogSourceBatch([Entry("agent", Since.AddMinutes(1), "ok")]),
                ["system"] = new LogSourceBatch([], "Authorization=Bearer raw-secret", 2),
            },
        };
        var result = await Manager(reader).ExecuteAsync(Payload(["agent", "system"]), default);
        Assert.Equal("success", result.Status);
        Assert.DoesNotContain("raw-secret", result.Result, StringComparison.Ordinal);
        Assert.Contains("[REDACTED]", result.Result, StringComparison.Ordinal);
        Assert.Contains("2 malformed", result.Result, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AllFailedSourcesReturnFailedWithoutRawException()
    {
        var reader = new FakeReader { Throw = true };
        var result = await Manager(reader).ExecuteAsync(Payload(), default);
        Assert.Equal("failed", result.Status);
        Assert.Contains("Source reading failed", result.Result, StringComparison.Ordinal);
        Assert.DoesNotContain("stack", result.Result, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void DiagnosticProviderWritesSanitizedFixedJsonLines()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"nacho-log-{Guid.NewGuid():N}");
        try
        {
            var paths = new AgentPaths(directory);
            using var provider = new AgentDiagnosticLoggerProvider(paths);
            var logger = provider.CreateLogger("Nacho.Agent.Test");
            logger.LogInformation("token=top-secret regular text");
            var line = File.ReadAllText(paths.AgentDiagnosticLogFile);
            Assert.DoesNotContain("top-secret", line, StringComparison.Ordinal);
            Assert.Contains("[REDACTED]", line, StringComparison.Ordinal);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    private static LogCollectionManager Manager(FakeReader reader, bool enabled = true) =>
        new(Options.Create(new AgentOptions { ServerUrl = "http://127.0.0.1", AllowLogCollection = enabled }), reader);

    private static JsonElement Payload(string[]? sources = null, int maxEntries = 200, string? since = null, string? until = null) => Parse(JsonSerializer.Serialize(new
    {
        sources = sources ?? new[] { "agent" },
        sinceUtc = since ?? Utc(Since),
        untilUtc = until ?? Utc(Until),
        maxEntries,
    }));

    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement.Clone();
    private static string Utc(DateTimeOffset value) => value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'");
    private static LogSnapshotEntry Entry(string source, DateTimeOffset timestamp, string message) =>
        new(source, timestamp, "Information", 42, "Nacho.Test", message);

    private sealed class FakeReader : ILogCollectionSourceReader
    {
        public bool IsSupported { get; init; } = true;
        public bool Throw { get; init; }
        public Dictionary<string, LogSourceBatch> Batches { get; } = new(StringComparer.Ordinal);

        public Task<LogSourceBatch> ReadAsync(string source, DateTimeOffset sinceUtc, DateTimeOffset untilUtc, int maxEntries, CancellationToken cancellationToken)
        {
            if (Throw) throw new InvalidOperationException("stack and secret details");
            return Task.FromResult(Batches.GetValueOrDefault(source) ?? new LogSourceBatch([]));
        }
    }
}
