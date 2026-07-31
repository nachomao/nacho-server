import { config } from "../config"
import { db } from "../db"
import { shortId } from "../lib/ids"
import type { LogEntry, LogLevel } from "../types"

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
  // 按保留上限裁剪最旧日志
  const count = (db.prepare("SELECT COUNT(*) AS c FROM logs").get() as { c: number }).c
  if (count > config.logRetentionMax) {
    const overflow = count - config.logRetentionMax
    db.prepare("DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY ts ASC LIMIT ?)").run(overflow)
  }
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
