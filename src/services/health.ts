import { db } from "../db"
import { shortId } from "../lib/ids"
import type { HealthFinding, LogPackage, LogPackageStatus, Severity } from "../types"

/* -------------------- 健康发现项 -------------------- */

type FindingRow = {
  id: string
  host: string
  severity: string
  category: string
  title: string
  detail: string
  time: string
  ts: number
  read: number
}

function mapFinding(r: FindingRow): HealthFinding {
  return {
    id: r.id,
    host: r.host,
    severity: r.severity as Severity,
    category: r.category,
    title: r.title,
    detail: r.detail,
    time: r.time,
    ts: r.ts,
    read: r.read === 1,
  }
}

export function listFindings(): HealthFinding[] {
  const rows = db.prepare("SELECT * FROM health_findings ORDER BY ts DESC").all() as FindingRow[]
  return rows.map(mapFinding)
}

export type FindingInput = {
  host: string
  severity: Severity
  category: string
  title: string
  detail?: string
}

export function addFinding(input: FindingInput): HealthFinding {
  const id = shortId("f")
  const ts = Date.now()
  db.prepare(
    `INSERT INTO health_findings (id, host, severity, category, title, detail, time, ts, read)
     VALUES (@id, @host, @severity, @category, @title, @detail, @time, @ts, 0)`,
  ).run({
    id,
    host: input.host,
    severity: input.severity,
    category: input.category,
    title: input.title,
    detail: input.detail ?? "",
    time: new Date(ts).toLocaleString("zh-CN", { hour12: false }),
    ts,
  })
  return db.prepare("SELECT * FROM health_findings WHERE id = ?").get(id) as FindingRow as unknown as HealthFinding
}

export function markRead(id: string): void {
  db.prepare("UPDATE health_findings SET read = 1 WHERE id = ?").run(id)
}

export function markAllRead(): void {
  db.prepare("UPDATE health_findings SET read = 1").run()
}

/* -------------------- 日志包 -------------------- */

type PackageRow = {
  id: string
  host: string
  category: string
  size_mb: number
  time: string
  ts: number
  findings: number
  status: string
}

function mapPackage(r: PackageRow): LogPackage {
  return {
    id: r.id,
    host: r.host,
    category: r.category,
    sizeMB: r.size_mb,
    time: r.time,
    ts: r.ts,
    findings: r.findings,
    status: r.status as LogPackageStatus,
  }
}

export function listPackages(): LogPackage[] {
  const rows = db.prepare("SELECT * FROM log_packages ORDER BY ts DESC").all() as PackageRow[]
  return rows.map(mapPackage)
}

export type PackageInput = {
  host: string
  category?: string
  sizeMB?: number
  status?: LogPackageStatus
  findings?: number
}

export function addPackage(input: PackageInput): LogPackage {
  const id = shortId("p")
  const ts = Date.now()
  db.prepare(
    `INSERT INTO log_packages (id, host, category, size_mb, time, ts, findings, status)
     VALUES (@id, @host, @category, @sizeMB, @time, @ts, @findings, @status)`,
  ).run({
    id,
    host: input.host,
    category: input.category ?? "系统日志",
    sizeMB: input.sizeMB ?? 0,
    time: new Date(ts).toLocaleString("zh-CN", { hour12: false }),
    ts,
    findings: input.findings ?? 0,
    status: input.status ?? "pending",
  })
  return db.prepare("SELECT * FROM log_packages WHERE id = ?").get(id) as PackageRow as unknown as LogPackage
}

export function updatePackageStatus(id: string, status: LogPackageStatus, findings?: number): LogPackage | null {
  const row = db.prepare("SELECT * FROM log_packages WHERE id = ?").get(id) as PackageRow | undefined
  if (!row) return null
  db.prepare("UPDATE log_packages SET status = ?, findings = COALESCE(?, findings) WHERE id = ?").run(
    status,
    findings ?? null,
    id,
  )
  return mapPackage(db.prepare("SELECT * FROM log_packages WHERE id = ?").get(id) as PackageRow)
}

export function healthStats() {
  const findings = listFindings()
  return {
    unread: findings.filter((f) => !f.read).length,
    critical: findings.filter((f) => f.severity === "critical").length,
    error: findings.filter((f) => f.severity === "error").length,
    packages: (db.prepare("SELECT COUNT(*) AS c FROM log_packages").get() as { c: number }).c,
  }
}
