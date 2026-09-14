import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { config } from "../config"
import { db } from "../db"
import { HttpError } from "../lib/http"
import { shortId } from "../lib/ids"
import {
  collectLogsResultSchema,
  type CollectedLogEntry,
  type CollectLogsResult,
  type HealthCollectionInput,
} from "../schemas/health"
import type { Command, CommandStatus, HealthFinding, LogPackage, LogPackageStatus, Severity } from "../types"
import * as clients from "./clients"
import * as commands from "./commands"
import { recordLog } from "./logs"

const MAX_FINDINGS_PER_PACKAGE = 100
const MAX_RESULT_BYTES = 512 * 1024

type FindingRow = {
  id: string
  package_id: string | null
  host: string
  severity: string
  category: string
  title: string
  detail: string
  time: string
  ts: number
  read: number
}

type PackageRow = {
  id: string
  client_id: string | null
  command_id: string | null
  host: string
  category: string
  size_mb: number
  time: string
  ts: number
  findings: number
  status: string
  storage_name: string | null
  size_bytes: number
  sha256: string | null
  sources: string
  entry_count: number
  truncated: number
  error: string | null
  analyzed_at: number | null
}

function mapFinding(row: FindingRow): HealthFinding {
  return {
    id: row.id,
    packageId: row.package_id,
    host: row.host,
    severity: row.severity as Severity,
    category: row.category,
    title: row.title,
    detail: row.detail,
    time: row.time,
    ts: row.ts,
    read: row.read === 1,
  }
}

function parseSources(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : []
  } catch {
    return []
  }
}

function mapPackage(row: PackageRow): LogPackage {
  const status = row.status === "pending" ? "collecting" : row.status as LogPackageStatus
  return {
    id: row.id,
    clientId: row.client_id,
    commandId: row.command_id,
    host: row.host,
    category: row.category,
    sizeMB: Number((row.size_bytes / 1024 / 1024).toFixed(2)),
    time: row.time,
    ts: row.ts,
    findings: row.findings,
    status,
    storageName: row.storage_name,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    sources: parseSources(row.sources),
    entryCount: row.entry_count,
    truncated: row.truncated === 1,
    error: row.error,
    analyzedAt: row.analyzed_at,
    downloadable: Boolean(row.storage_name && row.sha256 && row.size_bytes > 0),
  }
}

function packageRow(id: string): PackageRow | undefined {
  return db.prepare("SELECT * FROM log_packages WHERE id = ?").get(id) as PackageRow | undefined
}

function healthDirectory(): string {
  return config.healthArtifactsPath
}

function artifactPath(storageName: string): string {
  if (!/^p-[a-z0-9-]+\.json$/i.test(storageName)) throw new HttpError(409, "日志快照存储名称无效")
  return path.join(healthDirectory(), storageName)
}

export function listFindings(): HealthFinding[] {
  return (db.prepare("SELECT * FROM health_findings ORDER BY ts DESC").all() as FindingRow[]).map(mapFinding)
}

export type FindingInput = {
  packageId?: string | null
  host: string
  severity: Severity
  category: string
  title: string
  detail?: string
  ts?: number
}

export function addFinding(input: FindingInput): HealthFinding {
  const id = shortId("f")
  const ts = input.ts ?? Date.now()
  db.prepare(
    `INSERT INTO health_findings (id, package_id, host, severity, category, title, detail, time, ts, read)
     VALUES (@id, @packageId, @host, @severity, @category, @title, @detail, @time, @ts, 0)`,
  ).run({
    id,
    packageId: input.packageId ?? null,
    host: input.host,
    severity: input.severity,
    category: input.category,
    title: input.title,
    detail: input.detail ?? "",
    time: new Date(ts).toLocaleString("zh-CN", { hour12: false }),
    ts,
  })
  return mapFinding(db.prepare("SELECT * FROM health_findings WHERE id = ?").get(id) as FindingRow)
}

export function markRead(id: string): boolean {
  return db.prepare("UPDATE health_findings SET read = 1 WHERE id = ?").run(id).changes > 0
}

export function markAllRead(): number {
  return Number(db.prepare("UPDATE health_findings SET read = 1 WHERE read = 0").run().changes)
}

export function listPackages(): LogPackage[] {
  return (db.prepare("SELECT * FROM log_packages ORDER BY ts DESC").all() as PackageRow[]).map(mapPackage)
}

export function getPackage(id: string): LogPackage | null {
  const row = packageRow(id)
  return row ? mapPackage(row) : null
}

export type PackageInput = {
  host: string
  category?: string
  sizeMB?: number
  status?: LogPackageStatus
  findings?: number
}

/** 保留种子脚本兼容；真实采集使用 createCollections。 */
export function addPackage(input: PackageInput): LogPackage {
  const id = shortId("p")
  const ts = Date.now()
  const sizeBytes = Math.max(0, Math.round((input.sizeMB ?? 0) * 1024 * 1024))
  db.prepare(
    `INSERT INTO log_packages
      (id, host, category, size_mb, time, ts, findings, status, size_bytes)
     VALUES (@id, @host, @category, @sizeMB, @time, @ts, @findings, @status, @sizeBytes)`,
  ).run({
    id,
    host: input.host,
    category: input.category ?? "系统日志",
    sizeMB: input.sizeMB ?? 0,
    time: new Date(ts).toLocaleString("zh-CN", { hour12: false }),
    ts,
    findings: input.findings ?? 0,
    status: input.status ?? "collecting",
    sizeBytes,
  })
  return getPackage(id)!
}

export function createCollections(input: HealthCollectionInput): LogPackage[] {
  const targets = input.clientIds.map((id) => {
    const client = clients.getClient(id)
    if (!client) throw new HttpError(404, "部分客户端不存在", { clientIds: [id] })
    if (client.os !== "Windows") throw new HttpError(400, "日志采集仅支持 Windows 客户端", { clientIds: [id] })
    if (client.status !== "online") throw new HttpError(409, "日志采集目标必须当前在线", { clientIds: [id] })
    return client
  })
  const created: Array<{ command: Command; packageId: string }> = []
  const now = Date.now()
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const client of targets) {
      const command = commands.createCommand({
        clientId: client.id,
        type: "collect-logs",
        payload: {
          sources: input.sources,
          sinceUtc: input.sinceUtc,
          untilUtc: input.untilUtc,
          maxEntries: input.maxEntries,
        },
      })
      const packageId = shortId("p")
      const host = client.hostname || client.name || client.id
      db.prepare(
        `INSERT INTO log_packages
          (id, client_id, command_id, host, category, size_mb, time, ts, findings, status, sources)
         VALUES (?, ?, ?, ?, '系统日志', 0, ?, ?, 0, 'collecting', ?)`,
      ).run(packageId, client.id, command.id, host, new Date(now).toLocaleString("zh-CN", { hour12: false }), now, JSON.stringify(input.sources))
      created.push({ command, packageId })
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  for (const item of created) commands.deliverCommand(item.command)
  recordLog("info", "health", "创建健康日志采集批次", `targets=${created.length};sources=${input.sources.join(",")};maxEntries=${input.maxEntries}`)
  return created.map((item) => getPackage(item.packageId)!)
}

type RuleMatch = { severity: Severity; category: string; title: string }

function providerIncludes(entry: CollectedLogEntry, values: string[]): boolean {
  const provider = (entry.provider ?? "").toLowerCase()
  return values.some((value) => provider.includes(value))
}

function classify(entry: CollectedLogEntry): RuleMatch | null {
  const eventId = entry.eventId ?? -1
  const level = (entry.level ?? "").toLowerCase()
  const message = entry.message.toLowerCase()
  if ((providerIncludes(entry, ["kernel-power"]) && eventId === 41) || (providerIncludes(entry, ["eventlog"]) && eventId === 6008)) {
    return { severity: "critical", category: "系统日志", title: "检测到意外关机或电源故障" }
  }
  if (providerIncludes(entry, ["disk", "ntfs", "storport", "storahci"])) {
    if ([7, 55].includes(eventId)) return { severity: "critical", category: "磁盘存储", title: "检测到磁盘或文件系统严重错误" }
    if ([9, 11, 15, 51].includes(eventId)) return { severity: "error", category: "磁盘存储", title: "检测到磁盘 I/O 错误" }
    if ([129, 153].includes(eventId)) return { severity: "warning", category: "磁盘存储", title: "检测到存储设备超时或重试" }
  }
  if ((providerIncludes(entry, ["application error"]) && eventId === 1000) ||
      (providerIncludes(entry, ["windows error reporting"]) && eventId === 1001) ||
      (providerIncludes(entry, [".net runtime"]) && eventId === 1026)) {
    return { severity: "error", category: "应用崩溃", title: "检测到应用程序崩溃" }
  }
  if (providerIncludes(entry, ["service control manager"]) && [7000, 7001, 7009, 7011, 7023, 7024, 7031, 7034].includes(eventId)) {
    return { severity: [7031, 7034].includes(eventId) ? "error" : "warning", category: "服务异常", title: "检测到 Windows 服务异常" }
  }
  if (providerIncludes(entry, ["tcpip", "dns client", "netwtw", "ndis"]) && (level.includes("error") || level.includes("warning") || /timeout|failed|disconnected/.test(message))) {
    return { severity: "warning", category: "网络连接", title: "检测到网络连接异常" }
  }
  if (entry.source === "agent" && ["error", "critical", "fatal"].some((value) => level.includes(value))) {
    return { severity: level.includes("critical") || level.includes("fatal") ? "critical" : "error", category: "系统日志", title: "Agent 诊断日志报告错误" }
  }
  return null
}

function normalizedMessage(value: string): string {
  return value.toLowerCase().replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/g, "<guid>")
    .replace(/0x[0-9a-f]+/g, "<hex>").replace(/\b\d{3,}\b/g, "<n>").replace(/\s+/g, " ").trim()
}

function safeExcerpt(value: string, maximum = 420): string {
  const compact = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`
}

type FindingDraft = FindingInput & { fingerprint: string; occurrences: number; firstTs: number; lastTs: number }

function analyze(result: CollectLogsResult, packageId: string, host: string, commandStatus: CommandStatus): FindingDraft[] {
  const groups = new Map<string, FindingDraft>()
  for (const entry of result.entries) {
    const match = classify(entry)
    if (!match) continue
    const timestamp = Date.parse(entry.timestampUtc)
    const fingerprint = createHash("sha256").update([
      match.category,
      (entry.provider ?? "").toLowerCase(),
      String(entry.eventId ?? ""),
      normalizedMessage(entry.message),
    ].join("\u0000")).digest("hex")
    const existing = groups.get(fingerprint)
    if (existing) {
      existing.occurrences++
      existing.firstTs = Math.min(existing.firstTs, timestamp)
      existing.lastTs = Math.max(existing.lastTs, timestamp)
      continue
    }
    groups.set(fingerprint, {
      packageId,
      host,
      ...match,
      detail: safeExcerpt(entry.message),
      ts: timestamp,
      fingerprint,
      occurrences: 1,
      firstTs: timestamp,
      lastTs: timestamp,
    })
  }
  const operational: FindingDraft[] = []
  const now = Date.now()
  if (commandStatus !== "success") {
    operational.push({ packageId, host, severity: "warning", category: "系统日志", title: "日志采集失败", detail: safeExcerpt(result.error ?? "Agent 未能完成日志采集。"), ts: now, fingerprint: "collection-failed", occurrences: 1, firstTs: now, lastTs: now })
  } else if (result.error) {
    operational.push({ packageId, host, severity: "warning", category: "系统日志", title: "部分日志源采集失败", detail: safeExcerpt(result.error), ts: now, fingerprint: "collection-partial", occurrences: 1, firstTs: now, lastTs: now })
  }
  if (result.truncated) {
    operational.push({ packageId, host, severity: "warning", category: "系统日志", title: "日志采集结果已截断", detail: `快照包含 ${result.entries.length} 条记录，已达到结果大小或条目上限。`, ts: now, fingerprint: "collection-truncated", occurrences: 1, firstTs: now, lastTs: now })
  }
  const order: Record<Severity, number> = { critical: 0, error: 1, warning: 2, info: 3 }
  return [...operational, ...groups.values()]
    .sort((a, b) => order[a.severity] - order[b.severity] || b.lastTs - a.lastTs)
    .slice(0, MAX_FINDINGS_PER_PACKAGE)
    .map((item) => ({
      ...item,
      detail: item.occurrences > 1
        ? `${item.detail}（重复 ${item.occurrences} 次，${new Date(item.firstTs).toLocaleString("zh-CN", { hour12: false })} 至 ${new Date(item.lastTs).toLocaleString("zh-CN", { hour12: false })}）`
        : item.detail,
    }))
}

function replacePackageFindings(packageId: string, drafts: FindingDraft[]): void {
  db.exec("BEGIN IMMEDIATE")
  try {
    db.prepare("DELETE FROM notifications WHERE type='health' AND source_id IN (SELECT id FROM health_findings WHERE package_id=?)").run(packageId)
    db.prepare("DELETE FROM health_findings WHERE package_id = ?").run(packageId)
    for (const draft of drafts) addFinding(draft)
    db.prepare("UPDATE log_packages SET findings = ?, analyzed_at = ? WHERE id = ?").run(drafts.length, Date.now(), packageId)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

function persistResult(packageId: string, raw: string): { storageName: string; sizeBytes: number; sha256: string } {
  const sizeBytes = Buffer.byteLength(raw, "utf8")
  if (sizeBytes > MAX_RESULT_BYTES) throw new HttpError(400, "日志采集结果超过 512 KiB")
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex")
  const storageName = `${packageId}.json`
  fs.mkdirSync(healthDirectory(), { recursive: true })
  const destination = artifactPath(storageName)
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, raw, { encoding: "utf8", flag: "wx" })
  try {
    fs.renameSync(temporary, destination)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return { storageName, sizeBytes, sha256 }
}

function markPackageFailed(packageId: string, message: string): void {
  db.prepare("UPDATE log_packages SET status = 'failed', error = ?, analyzed_at = ? WHERE id = ?")
    .run(safeExcerpt(message, 1000), Date.now(), packageId)
}

export function processCollectLogsReport(commandId: string, clientId: string, status: CommandStatus, raw?: string): void {
  const row = db.prepare("SELECT * FROM log_packages WHERE command_id = ? AND client_id = ?").get(commandId, clientId) as PackageRow | undefined
  if (!row) return
  if (!raw) {
    markPackageFailed(row.id, status === "canceled" ? "日志采集已取消。" : "Agent 未返回结构化日志结果。")
    return
  }
  let result: CollectLogsResult
  try {
    result = collectLogsResultSchema.parse(JSON.parse(raw))
  } catch {
    markPackageFailed(row.id, "Agent 返回的日志结果结构无效。")
    return
  }
  const digest = createHash("sha256").update(raw, "utf8").digest("hex")
  if (row.sha256 === digest && row.storage_name && ["analyzed", "failed"].includes(row.status)) return
  try {
    const artifact = persistResult(row.id, raw)
    db.prepare(
      `UPDATE log_packages SET status = 'analyzing', storage_name = ?, size_bytes = ?, size_mb = ?, sha256 = ?,
       sources = ?, entry_count = ?, truncated = ?, error = ? WHERE id = ?`,
    ).run(
      artifact.storageName,
      artifact.sizeBytes,
      artifact.sizeBytes / 1024 / 1024,
      artifact.sha256,
      JSON.stringify(result.sources),
      result.entries.length,
      result.truncated ? 1 : 0,
      result.error,
      row.id,
    )
    const findings = analyze(result, row.id, row.host, status)
    replacePackageFindings(row.id, findings)
    const finalStatus: LogPackageStatus = status === "success" ? "analyzed" : "failed"
    db.prepare("UPDATE log_packages SET status = ? WHERE id = ?").run(finalStatus, row.id)
    recordLog("info", "health", "健康日志快照已归档并分析", `packageId=${row.id};clientId=${clientId};entries=${result.entries.length};findings=${findings.length};bytes=${artifact.sizeBytes};sha256=${artifact.sha256.slice(0, 16)}`)
  } catch (error) {
    markPackageFailed(row.id, error instanceof Error ? error.message : "日志快照归档失败。")
  }
}

function readVerifiedPackage(id: string): { row: PackageRow; filePath: string; raw: string; result: CollectLogsResult } {
  const row = packageRow(id)
  if (!row) throw new HttpError(404, "日志包不存在")
  if (!row.storage_name || !row.sha256 || row.size_bytes <= 0) throw new HttpError(409, "日志包尚无可用快照")
  const filePath = artifactPath(row.storage_name)
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new HttpError(409, "日志快照文件不存在")
  const raw = fs.readFileSync(filePath, "utf8")
  const size = Buffer.byteLength(raw, "utf8")
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex")
  if (size !== row.size_bytes || sha256 !== row.sha256) throw new HttpError(409, "日志快照完整性校验失败")
  let result: CollectLogsResult
  try { result = collectLogsResultSchema.parse(JSON.parse(raw)) } catch { throw new HttpError(409, "日志快照结构校验失败") }
  return { row, filePath, raw, result }
}

export function reanalyzePackage(id: string): LogPackage {
  const verified = readVerifiedPackage(id)
  if (verified.row.status === "failed") throw new HttpError(409, "失败的采集请使用重新采集")
  db.prepare("UPDATE log_packages SET status = 'analyzing', error = NULL WHERE id = ?").run(id)
  try {
    const findings = analyze(verified.result, id, verified.row.host, "success")
    replacePackageFindings(id, findings)
    db.prepare("UPDATE log_packages SET status = 'analyzed' WHERE id = ?").run(id)
    recordLog("info", "health", "重新分析健康日志快照", `packageId=${id};findings=${findings.length};sha256=${verified.row.sha256?.slice(0, 16)}`)
    return getPackage(id)!
  } catch (error) {
    markPackageFailed(id, error instanceof Error ? error.message : "重新分析失败。")
    throw error
  }
}

export function recollectPackage(id: string): LogPackage[] {
  const current = getPackage(id)
  if (!current) throw new HttpError(404, "日志包不存在")
  if (!current.clientId) throw new HttpError(409, "旧日志包缺少客户端关联，无法重新采集")
  const until = new Date()
  const since = new Date(until.getTime() - 24 * 60 * 60 * 1000)
  return createCollections({
    clientIds: [current.clientId],
    sources: (current.sources.length > 0 ? current.sources : ["agent", "system", "application"]) as HealthCollectionInput["sources"],
    sinceUtc: since.toISOString(),
    untilUtc: until.toISOString(),
    maxEntries: 500,
  })
}

export function getPackageDownload(id: string): { filePath: string; fileName: string; sizeBytes: number; sha256: string } {
  const verified = readVerifiedPackage(id)
  const safeHost = verified.row.host.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").slice(0, 80) || "client"
  const stamp = new Date(verified.row.ts).toISOString().replace(/[:.]/g, "-")
  return { filePath: verified.filePath, fileName: `${safeHost}-${stamp}-${id}.json`, sizeBytes: verified.row.size_bytes, sha256: verified.row.sha256! }
}

export function healthStats() {
  const findings = listFindings()
  return {
    unread: findings.filter((finding) => !finding.read).length,
    critical: findings.filter((finding) => finding.severity === "critical").length,
    error: findings.filter((finding) => finding.severity === "error").length,
    packages: Number((db.prepare("SELECT COUNT(*) AS c FROM log_packages").get() as { c: number }).c),
  }
}
