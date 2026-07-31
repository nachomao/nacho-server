using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Security;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace Nacho.Agent;

public sealed record LogSnapshotEntry(
    string Source,
    DateTimeOffset TimestampUtc,
    string? Level,
    int? EventId,
    string? Provider,
    string Message);

public sealed record LogSourceBatch(
    IReadOnlyList<LogSnapshotEntry> Entries,
    string? Error = null,
    int Skipped = 0);

public interface ILogCollectionSourceReader
{
    bool IsSupported { get; }
    Task<LogSourceBatch> ReadAsync(
        string source,
        DateTimeOffset sinceUtc,
        DateTimeOffset untilUtc,
        int maxEntries,
        CancellationToken cancellationToken);
}

public sealed class WindowsLogCollectionSourceReader(AgentPaths paths) : ILogCollectionSourceReader
{
    public bool IsSupported => OperatingSystem.IsWindows();

    public Task<LogSourceBatch> ReadAsync(
        string source,
        DateTimeOffset sinceUtc,
        DateTimeOffset untilUtc,
        int maxEntries,
        CancellationToken cancellationToken)
    {
        if (!IsSupported) return Task.FromResult(new LogSourceBatch([], "Log collection is supported only on Windows."));
        return Task.FromResult(source == "agent"
            ? ReadAgent(sinceUtc, untilUtc, maxEntries, cancellationToken)
            : ReadEventChannel(source, sinceUtc, untilUtc, maxEntries, cancellationToken));
    }

    private LogSourceBatch ReadAgent(
        DateTimeOffset sinceUtc,
        DateTimeOffset untilUtc,
        int maxEntries,
        CancellationToken cancellationToken)
    {
        if (!File.Exists(paths.AgentDiagnosticLogFile))
            return new LogSourceBatch([], "Agent diagnostic log is unavailable.");

        var entries = new List<LogSnapshotEntry>();
        var skipped = 0;
        try
        {
            using var stream = new FileStream(paths.AgentDiagnosticLogFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, new UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: true);
            while (reader.ReadLine() is { } line)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    using var document = JsonDocument.Parse(line);
                    var root = document.RootElement;
                    if (!root.TryGetProperty("timestampUtc", out var timestampElement) ||
                        timestampElement.ValueKind != JsonValueKind.String ||
                        !DateTimeOffset.TryParse(timestampElement.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var timestamp))
                    {
                        skipped++;
                        continue;
                    }
                    timestamp = timestamp.ToUniversalTime();
                    if (timestamp < sinceUtc || timestamp > untilUtc) continue;
                    entries.Add(new LogSnapshotEntry(
                        "agent",
                        timestamp,
                        ReadString(root, "level"),
                        ReadInt(root, "eventId"),
                        ReadString(root, "provider"),
                        LogTextSanitizer.Sanitize(ReadString(root, "message") ?? "")));
                }
                catch (Exception ex) when (ex is JsonException or DecoderFallbackException or InvalidDataException)
                {
                    skipped++;
                }
            }
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or SecurityException)
        {
            return new LogSourceBatch([], "Agent diagnostic log could not be read.");
        }

        var ordered = entries
            .OrderBy(item => item.TimestampUtc)
            .ThenBy(item => item.Provider, StringComparer.Ordinal)
            .ThenBy(item => item.EventId)
            .ThenBy(item => item.Message, StringComparer.Ordinal)
            .Take(maxEntries + 1)
            .ToArray();
        return new LogSourceBatch(ordered, null, skipped);
    }

    private static LogSourceBatch ReadEventChannel(
        string source,
        DateTimeOffset sinceUtc,
        DateTimeOffset untilUtc,
        int maxEntries,
        CancellationToken cancellationToken)
    {
        var channel = source == "system" ? "System" : "Application";
        var sinceText = sinceUtc.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
        var untilText = untilUtc.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
        var queryText = $"*[System[TimeCreated[@SystemTime>='{sinceText}' and @SystemTime<='{untilText}']]]";
        var entries = new List<LogSnapshotEntry>();
        var skipped = 0;
        try
        {
            var query = new EventLogQuery(channel, PathType.LogName, queryText)
            {
                ReverseDirection = false,
                TolerateQueryErrors = false,
            };
            using var reader = new EventLogReader(query);
            while (entries.Count <= maxEntries)
            {
                cancellationToken.ThrowIfCancellationRequested();
                EventRecord? record;
                try { record = reader.ReadEvent(); }
                catch (Exception ex) when (ex is EventLogException or UnauthorizedAccessException)
                {
                    return new LogSourceBatch(entries, "Windows event log reading failed.", skipped);
                }
                if (record is null) break;
                using (record)
                {
                    try
                    {
                        if (!record.TimeCreated.HasValue) { skipped++; continue; }
                        string message;
                        try { message = record.FormatDescription() ?? ""; }
                        catch (EventLogException) { message = "Event message text is unavailable."; skipped++; }
                        entries.Add(new LogSnapshotEntry(
                            source,
                            new DateTimeOffset(record.TimeCreated.Value).ToUniversalTime(),
                            LogTextSanitizer.SanitizeMetadata(record.LevelDisplayName),
                            record.Id,
                            LogTextSanitizer.SanitizeMetadata(record.ProviderName),
                            LogTextSanitizer.Sanitize(message)));
                    }
                    catch (Exception ex) when (ex is EventLogException or InvalidOperationException or FormatException)
                    {
                        skipped++;
                    }
                }
            }
        }
        catch (Exception ex) when (ex is EventLogException or UnauthorizedAccessException or SecurityException)
        {
            return new LogSourceBatch([], "Windows event log is unavailable or access was denied.");
        }
        return new LogSourceBatch(entries, null, skipped);
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static int? ReadInt(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var result) ? result : null;
}

public sealed class LogCollectionManager(
    IOptions<AgentOptions> options,
    ILogCollectionSourceReader sourceReader)
{
    public const int MaximumResultBytes = 512 * 1024;
    private static readonly Regex StrictUtc = new(
        "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,7})?Z$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private static readonly string[] AllowedSources = ["agent", "system", "application"];
    private readonly AgentOptions _options = options.Value;

    public async Task<ExecutionResult> ExecuteAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var started = Stopwatch.StartNew();
        var validation = Validate(payload, DateTimeOffset.UtcNow);
        if (validation.Error is not null)
            return Failure(validation.Sources, validation.SinceUtc, validation.UntilUtc, started.ElapsedMilliseconds, validation.Error);
        if (!_options.AllowLogCollection)
            return Failure(validation.Sources, validation.SinceUtc, validation.UntilUtc, started.ElapsedMilliseconds, "Log collection is disabled by local policy.");
        if (!sourceReader.IsSupported)
            return Failure(validation.Sources, validation.SinceUtc, validation.UntilUtc, started.ElapsedMilliseconds, "Log collection is supported only on Windows.");

        var allEntries = new List<LogSnapshotEntry>();
        var errors = new List<string>();
        var successfulSources = 0;
        foreach (var source in validation.Sources)
        {
            LogSourceBatch batch;
            try
            {
                batch = await sourceReader.ReadAsync(
                    source,
                    validation.SinceUtc!.Value,
                    validation.UntilUtc!.Value,
                    validation.MaxEntries!.Value,
                    cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                batch = new LogSourceBatch([], "Source reading failed.");
            }
            allEntries.AddRange(batch.Entries.Select(entry => NormalizeEntry(source, entry)));
            if (batch.Error is null) successfulSources++;
            else errors.Add($"{source}: {LogTextSanitizer.SanitizeError(batch.Error)}");
            if (batch.Skipped > 0) errors.Add($"{source}: {batch.Skipped.ToString(CultureInfo.InvariantCulture)} malformed event(s) skipped.");
        }

        var sourceOrder = validation.Sources
            .Select((source, index) => (source, index))
            .ToDictionary(item => item.source, item => item.index, StringComparer.Ordinal);
        var ordered = allEntries
            .Where(entry => entry.TimestampUtc >= validation.SinceUtc && entry.TimestampUtc <= validation.UntilUtc)
            .OrderBy(entry => entry.TimestampUtc)
            .ThenBy(entry => sourceOrder.GetValueOrDefault(entry.Source, int.MaxValue))
            .ThenBy(entry => entry.Provider, StringComparer.Ordinal)
            .ThenBy(entry => entry.EventId)
            .ThenBy(entry => entry.Message, StringComparer.Ordinal)
            .ToList();
        var truncated = ordered.Count > validation.MaxEntries;
        if (truncated) ordered = ordered.Take(validation.MaxEntries!.Value).ToList();
        var error = errors.Count == 0 ? null : LogTextSanitizer.SanitizeError(string.Join(" ", errors));
        var result = SerializeBounded(validation, ordered, truncated, started.ElapsedMilliseconds, error);
        return new ExecutionResult(successfulSources > 0 ? "success" : "failed", result, null);
    }

    public static string ErrorJson(JsonElement payload, string error)
    {
        var validation = Validate(payload, DateTimeOffset.UtcNow);
        return Failure(validation.Sources, validation.SinceUtc, validation.UntilUtc, 0, error).Result;
    }

    private static LogSnapshotEntry NormalizeEntry(string requestedSource, LogSnapshotEntry entry) => new(
        requestedSource,
        entry.TimestampUtc.ToUniversalTime(),
        LogTextSanitizer.SanitizeMetadata(entry.Level),
        entry.EventId,
        LogTextSanitizer.SanitizeMetadata(entry.Provider),
        LogTextSanitizer.Sanitize(entry.Message));

    private static string SerializeBounded(
        Validation validation,
        List<LogSnapshotEntry> entries,
        bool truncated,
        long durationMs,
        string? error)
    {
        var low = 0;
        var high = entries.Count;
        string? best = null;
        while (low <= high)
        {
            var mid = low + ((high - low) / 2);
            var json = SerializeResult(validation.Sources, validation.SinceUtc, validation.UntilUtc, entries.Take(mid), truncated || mid < entries.Count, durationMs, error);
            if (Encoding.UTF8.GetByteCount(json) <= MaximumResultBytes)
            {
                best = json;
                low = mid + 1;
            }
            else high = mid - 1;
        }
        return best ?? SerializeResult(validation.Sources, validation.SinceUtc, validation.UntilUtc, [], true, durationMs, "Log result exceeded the size limit.");
    }

    private static string SerializeResult(
        IReadOnlyList<string> sources,
        DateTimeOffset? sinceUtc,
        DateTimeOffset? untilUtc,
        IEnumerable<LogSnapshotEntry> entries,
        bool truncated,
        long durationMs,
        string? error)
    {
        var materialized = entries.Select(entry => new
        {
            source = entry.Source,
            timestampUtc = entry.TimestampUtc.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            level = entry.Level,
            eventId = entry.EventId,
            provider = entry.Provider,
            message = entry.Message,
        }).ToArray();
        var counts = sources.Distinct(StringComparer.Ordinal)
            .ToDictionary(source => source, source => materialized.Count(entry => entry.source == source), StringComparer.Ordinal);
        return JsonSerializer.Serialize(new
        {
            sources,
            requestedSinceUtc = sinceUtc?.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            requestedUntilUtc = untilUtc?.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            effectiveSinceUtc = sinceUtc?.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            effectiveUntilUtc = untilUtc?.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            entries = materialized,
            countsBySource = counts,
            truncated,
            durationMs = Math.Max(0, durationMs),
            error,
        });
    }

    private static ExecutionResult Failure(
        IReadOnlyList<string> sources,
        DateTimeOffset? sinceUtc,
        DateTimeOffset? untilUtc,
        long durationMs,
        string error) => new(
            "failed",
            SerializeResult(
                sources.Where(source => AllowedSources.Contains(source, StringComparer.Ordinal)).Distinct(StringComparer.Ordinal).Take(3).ToArray(),
                sinceUtc,
                untilUtc,
                [],
                false,
                durationMs,
                LogTextSanitizer.SanitizeError(error)),
            null);

    private static Validation Validate(JsonElement payload, DateTimeOffset now)
    {
        if (payload.ValueKind != JsonValueKind.Object) return new([], null, null, null, "Payload must be an object.");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in payload.EnumerateObject())
        {
            if (!seen.Add(property.Name) || property.Name is not ("sources" or "sinceUtc" or "untilUtc" or "maxEntries"))
                return new(ReadSources(payload), ReadUtc(payload, "sinceUtc"), ReadUtc(payload, "untilUtc"), ReadMaxEntries(payload), "Payload contains an unsupported or duplicate field.");
        }

        var sources = ReadSources(payload);
        if (!payload.TryGetProperty("sources", out var sourcesElement) || sourcesElement.ValueKind != JsonValueKind.Array)
            return new(sources, null, null, null, "sources must be an array.");
        if (sourcesElement.GetArrayLength() != sources.Count)
            return new(sources, null, null, null, "sources must contain only strings.");
        if (sources.Count is < 1 or > 3)
            return new(sources, null, null, null, "sources must contain from 1 to 3 values.");
        if (sources.Any(source => !AllowedSources.Contains(source, StringComparer.Ordinal)))
            return new(sources, null, null, null, "sources contains an unsupported value.");
        if (sources.Distinct(StringComparer.Ordinal).Count() != sources.Count)
            return new(sources, null, null, null, "sources must not contain duplicate values.");

        var since = ReadStrictUtc(payload, "sinceUtc");
        var until = ReadStrictUtc(payload, "untilUtc");
        if (since is null || until is null)
            return new(sources, since, until, ReadMaxEntries(payload), "sinceUtc and untilUtc must be strict UTC timestamps ending in Z.");
        if (since >= until)
            return new(sources, since, until, ReadMaxEntries(payload), "sinceUtc must be earlier than untilUtc.");
        if (until - since > TimeSpan.FromHours(24))
            return new(sources, since, until, ReadMaxEntries(payload), "The log collection window must not exceed 24 hours.");
        if (since > now || until > now)
            return new(sources, since, until, ReadMaxEntries(payload), "The log collection window must not be in the future.");

        var maxEntries = ReadMaxEntries(payload);
        if (maxEntries is null or < 1 or > 1000)
            return new(sources, since, until, maxEntries, "maxEntries must be an integer from 1 to 1000.");
        return new(sources, since, until, maxEntries, null);
    }

    private static IReadOnlyList<string> ReadSources(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("sources", out var element) ||
            element.ValueKind != JsonValueKind.Array) return [];
        return element.EnumerateArray()
            .Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : null)
            .Where(item => item is not null)
            .Cast<string>()
            .Take(4)
            .ToArray();
    }

    private static DateTimeOffset? ReadStrictUtc(JsonElement payload, string name)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty(name, out var element) ||
            element.ValueKind != JsonValueKind.String) return null;
        var raw = element.GetString();
        if (raw is null || !StrictUtc.IsMatch(raw)) return null;
        return DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var value)
            ? value
            : null;
    }

    private static DateTimeOffset? ReadUtc(JsonElement payload, string name) => ReadStrictUtc(payload, name);

    private static int? ReadMaxEntries(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty("maxEntries", out var element) &&
        element.ValueKind == JsonValueKind.Number &&
        element.TryGetInt32(out var value)
            ? value
            : null;

    private sealed record Validation(
        IReadOnlyList<string> Sources,
        DateTimeOffset? SinceUtc,
        DateTimeOffset? UntilUtc,
        int? MaxEntries,
        string? Error);
}

public static class LogTextSanitizer
{
    private const int MessageRunes = 4096;
    private static readonly Regex NamedSecret = new(
        "(?i)\\b(authorization|api[-_ ]?key|device[-_ ]?token|access[-_ ]?token|token|password|secret)\\b\\s*[:=]\\s*(?:bearer\\s+)?[^\\s,;]+",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private static readonly Regex BearerSecret = new(
        "(?i)\\bbearer\\s+[A-Za-z0-9._~+/=-]+",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static string Sanitize(string? value)
    {
        var normalized = NormalizeControls(value ?? "");
        normalized = NamedSecret.Replace(normalized, match => $"{match.Groups[1].Value}=[REDACTED]");
        normalized = BearerSecret.Replace(normalized, "Bearer [REDACTED]");
        return TruncateRunes(normalized, MessageRunes);
    }

    public static string? SanitizeMetadata(string? value)
    {
        if (value is null) return null;
        return TruncateRunes(NormalizeControls(value).Replace('\n', ' '), 256);
    }

    public static string SanitizeError(string value) => TruncateRunes(Sanitize(value).Replace('\n', ' '), 1024);

    private static string NormalizeControls(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var rune in value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').EnumerateRunes())
        {
            if (rune.Value == '\n') { builder.Append('\n'); continue; }
            if (rune.Value == '\t') { builder.Append(' '); continue; }
            if (Rune.GetUnicodeCategory(rune) is UnicodeCategory.Control or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator) continue;
            builder.Append(rune);
        }
        return builder.ToString();
    }

    private static string TruncateRunes(string value, int limit)
    {
        var builder = new StringBuilder(Math.Min(value.Length, limit));
        var count = 0;
        foreach (var rune in value.EnumerateRunes())
        {
            if (count++ >= limit) break;
            builder.Append(rune);
        }
        return builder.ToString();
    }
}

public sealed class AgentDiagnosticLoggerProvider(AgentPaths paths) : ILoggerProvider
{
    private readonly object _gate = new();

    public ILogger CreateLogger(string categoryName) => new DiagnosticLogger(this, categoryName);
    public void Dispose() { }

    private void Write(string category, LogLevel level, EventId eventId, string message)
    {
        try
        {
            var json = JsonSerializer.Serialize(new
            {
                timestampUtc = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                level = level.ToString(),
                eventId = eventId.Id == 0 ? (int?)null : eventId.Id,
                provider = LogTextSanitizer.SanitizeMetadata(category),
                message = LogTextSanitizer.Sanitize(message),
            });
            lock (_gate)
            {
                Directory.CreateDirectory(paths.DataDirectory);
                File.AppendAllText(paths.AgentDiagnosticLogFile, json + Environment.NewLine, new UTF8Encoding(false));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SecurityException) { }
    }

    private sealed class DiagnosticLogger(AgentDiagnosticLoggerProvider owner, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            owner.Write(category, logLevel, eventId, formatter(state, exception));
        }
    }
}
