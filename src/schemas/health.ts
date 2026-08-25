import { z } from "zod"

export const healthLogSources = ["agent", "system", "application"] as const

const utcTimestamp = z.string().datetime({ offset: true })

export const healthCollectionSchema = z.object({
  clientIds: z.array(z.string().min(1).max(120)).min(1).max(100)
    .refine((items) => new Set(items).size === items.length, "clientIds must be unique"),
  sources: z.array(z.enum(healthLogSources)).min(1).max(3)
    .refine((items) => new Set(items).size === items.length, "sources must be unique"),
  sinceUtc: utcTimestamp,
  untilUtc: utcTimestamp,
  maxEntries: z.number().int().min(1).max(1000),
}).strict().superRefine((value, context) => {
  const since = Date.parse(value.sinceUtc)
  const until = Date.parse(value.untilUtc)
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sinceUtc"], message: "sinceUtc must be earlier than untilUtc" })
    return
  }
  if (until - since > 24 * 60 * 60 * 1000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["untilUtc"], message: "collection window must not exceed 24 hours" })
  }
  if (until > Date.now() + 1000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["untilUtc"], message: "untilUtc must not be in the future" })
  }
})

export const collectedLogEntrySchema = z.object({
  source: z.enum(healthLogSources),
  timestampUtc: utcTimestamp,
  level: z.string().max(120).nullable(),
  eventId: z.number().int().nullable(),
  provider: z.string().max(500).nullable(),
  message: z.string().max(32_768),
}).strict()

export const collectLogsResultSchema = z.object({
  sources: z.array(z.enum(healthLogSources)).min(1).max(3),
  requestedSinceUtc: utcTimestamp.nullable(),
  requestedUntilUtc: utcTimestamp.nullable(),
  effectiveSinceUtc: utcTimestamp.nullable(),
  effectiveUntilUtc: utcTimestamp.nullable(),
  entries: z.array(collectedLogEntrySchema).max(1000),
  countsBySource: z.record(z.enum(healthLogSources), z.number().int().min(0)),
  truncated: z.boolean(),
  durationMs: z.number().int().min(0),
  error: z.string().max(4000).nullable(),
}).strict().superRefine((value, context) => {
  if (new Set(value.sources).size !== value.sources.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sources"], message: "sources must be unique" })
  }
  for (const source of value.sources) {
    const actual = value.entries.filter((entry) => entry.source === source).length
    if (value.countsBySource[source] !== actual) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["countsBySource", source], message: "count does not match entries" })
    }
  }
  if (value.entries.some((entry) => !value.sources.includes(entry.source))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "entry source was not requested" })
  }
})

export type HealthCollectionInput = z.infer<typeof healthCollectionSchema>
export type CollectLogsResult = z.infer<typeof collectLogsResultSchema>
export type CollectedLogEntry = z.infer<typeof collectedLogEntrySchema>
