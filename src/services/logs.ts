import { db } from "../db"
import { shortId } from "../lib/ids"
import { logger } from "../lib/logger"
import type { LogEntry, LogLevel } from "../types"
import { archiveLogs } from "./log-archive"
import { getGeneralSettings } from "./settings"

const MIN_LOG_RETENTION_MAX = 1000
const MAX_LOG_RETENTION_MAX = 1_000_000
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000
/** 单次清理最多归档的记录数，避免一次性把大量日志读入内存。 */
const MAX_ARCHIVE_BATCH = 5000
let lastRetentionSweep = 0

function retentionMax(): number {
  const configured = getGeneralSettings().logRetentionMax
  return Math.min(MAX_LOG_RETENTION_MAX, Math.max(MIN_LOG_RETENTION_MAX, Math.floor(configured)))
}

/** 按条目上限淘汰最旧日志，返回删除条数。 */
function trimExcessLogs(): number {
  const max = retentionMax()
  const count = (db.prepare("SELECT COUNT(*) AS c FROM logs").get() as { c: number }).c
  if (count <= max) return 0
  const overflow = count - max
  return Number(db.prepare("DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY ts ASC LIMIT ?)").run(overflow).changes)
}

/** 归档并删除超过保留天数的日志；归档失败时保留数据，等待下次清理重试。 */
function archiveExpiredLogs(cutoff: number, now: number): number {
  const rows = db
    .prepare("SELECT * FROM logs WHERE ts < ? ORDER BY ts ASC LIMIT ?")
    .all(cutoff, MAX_ARCHIVE_BATCH) as LogRow[]
  if (rows.length === 0) return 0
  if (getGeneralSettings().compressArchive) {
    try {
      archiveLogs(rows.map(mapLog), { now })
    } catch (error) {
      logger.warn("日志归档失败，已保留待清理日志：", error)
      return 0
    }
  }
  const placeholders = rows.map(() => "?").join(",")
  return Number(
    db.prepare(`DELETE FROM logs WHERE id IN (${placeholders})`).run(...rows.map((row) => row.id)).changes,
  )
}

/** 按保留天数与条目上限清理日志；天数为 0 时只按条目上限裁剪。 */
export function sweepLogRetention(now = Date.now()): number {
  const days = getGeneralSettings().logRetentionDays
  let removed = 0
  if (days > 0) removed += archiveExpiredLogs(now - days * 86_400_000, now)
  removed += trimExcessLogs()
  lastRetentionSweep = now
  return removed
}

type LogRow = {
  id: string
  ts: number
  level: string
  source: string
  message: string
  detail: string | null
}

function mapLog(r: LogRow): LogEntry {
  return {
    id: r.id,
    ts: r.ts,
    level: r.level as LogLevel,
    source: r.source,
    message: r.message,
    detail: r.detail,
  }
}

// node:sqlite 会在 prepare 时立即校验表是否存在，因此延迟到首次调用时再准备语句，
// 避免在 initSchema() 执行前因导入顺序导致 “no such table” 错误。
let insertStmt: ReturnType<typeof db.prepare> | null = null
function getInsertStmt() {
  if (!insertStmt) {
    insertStmt = db.prepare(
      "INSERT INTO logs (id, ts, level, source, message, detail) VALUES (@id, @ts, @level, @source, @message, @detail)",
    )
  }
  return insertStmt
}

/** 记录一条业务日志（同时输出到控制台由 systemd 采集） */
export function recordLog(level: LogLevel, source: string, message: string, detail?: string): LogEntry {
  const entry: LogEntry = {
    id: shortId("log"),
    ts: Date.now(),
    level,
    source,
    message,
    detail: detail ?? null,
  }
  getInsertStmt().run(entry)
  // 每次写入都按条目上限裁剪；按天数的清理每小时最多执行一次，避免频繁全表扫描。
  trimExcessLogs()
  if (Date.now() - lastRetentionSweep >= RETENTION_SWEEP_INTERVAL_MS) sweepLogRetention()
  return entry
}

export type LogFilter = {
  level?: LogLevel
  source?: string
  q?: string
  limit?: number
  since?: number
}

/** 查询日志（倒序） */
export function listLogs(filter: LogFilter = {}): LogEntry[] {
  const clauses: string[] = []
  const params: Record<string, string | number> = {}
  if (filter.level) {
    clauses.push("level = @level")
    params.level = filter.level
  }
  if (filter.source) {
    clauses.push("source = @source")
    params.source = filter.source
  }
  if (filter.q) {
    clauses.push("(message LIKE @q OR source LIKE @q)")
    params.q = `%${filter.q}%`
  }
  if (filter.since) {
    clauses.push("ts > @since")
    params.since = filter.since
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
  const rows = db
    .prepare(`SELECT * FROM logs ${where} ORDER BY ts DESC LIMIT ${limit}`)
    .all(params) as LogRow[]
  return rows.map(mapLog)
}

/** 已注册的日志来源（用于面板筛选） */
export function listSources(): string[] {
  const rows = db.prepare("SELECT DISTINCT source FROM logs ORDER BY source ASC").all() as { source: string }[]
  return rows.map((r) => r.source)
}

/** 清空日志 */
export function clearLogs(): void {
  db.prepare("DELETE FROM logs").run()
}
