import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test, { after, before, beforeEach } from "node:test"
import { DatabaseSync } from "node:sqlite"

const databasePath = path.join(process.cwd(), "tmp-health-test.db")
const artifactsPath = path.join(process.cwd(), "tmp-health-artifacts")
process.env.DATABASE_PATH = databasePath
process.env.ARTIFACTS_PATH = artifactsPath
process.env.LOG_RETENTION_MAX = "1000"

let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let health: typeof import("../services/health")
let clients: typeof import("../services/clients")
let commands: typeof import("../services/commands")

before(async () => {
  fs.rmSync(databasePath, { force: true })
  fs.rmSync(artifactsPath, { force: true, recursive: true })
  const legacy = new DatabaseSync(databasePath)
  legacy.exec(`
    CREATE TABLE health_findings (
      id TEXT PRIMARY KEY, host TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info', category TEXT NOT NULL DEFAULT '系统日志',
      title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE log_packages (
      id TEXT PRIMARY KEY, host TEXT NOT NULL, category TEXT NOT NULL DEFAULT '系统日志', size_mb REAL NOT NULL DEFAULT 0,
      time TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL, findings INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending'
    );
  `)
  legacy.close()
  ;({ db, initSchema } = await import("../db"))
  health = await import("../services/health")
  clients = await import("../services/clients")
  commands = await import("../services/commands")
  initSchema()
})

beforeEach(() => {
  db.exec("DELETE FROM health_findings; DELETE FROM log_packages; DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs;")
  fs.rmSync(artifactsPath, { force: true, recursive: true })
})

after(() => {
  db.close()
  fs.rmSync(databasePath, { force: true })
  fs.rmSync(`${databasePath}-shm`, { force: true })
  fs.rmSync(`${databasePath}-wal`, { force: true })
  fs.rmSync(artifactsPath, { force: true, recursive: true })
})

function collectionInput(clientIds: string[]) {
  const until = new Date(Date.now() - 1000)
  const since = new Date(until.getTime() - 60 * 60 * 1000)
  return {
    clientIds,
    sources: ["agent", "system", "application"] as Array<"agent" | "system" | "application">,
    sinceUtc: since.toISOString(),
    untilUtc: until.toISOString(),
    maxEntries: 500,
  }
}

type Entry = {
  source: "agent" | "system" | "application"
  timestampUtc: string
  level: string | null
  eventId: number | null
  provider: string | null
  message: string
}

function result(entries: Entry[], options: { truncated?: boolean; error?: string | null } = {}) {
  const sources = ["agent", "system", "application"] as const
  return JSON.stringify({
    sources,
    requestedSinceUtc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    requestedUntilUtc: new Date(Date.now() - 1000).toISOString(),
    effectiveSinceUtc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    effectiveUntilUtc: new Date(Date.now() - 1000).toISOString(),
    entries,
    countsBySource: Object.fromEntries(sources.map((source) => [source, entries.filter((entry) => entry.source === source).length])),
    truncated: options.truncated ?? false,
    durationMs: 12,
    error: options.error ?? null,
  })
}

function register(name = "health-agent") {
  return clients.registerClient({ name, hostname: `${name}-host`, os: "Windows" }).client
}

test("健康表增量迁移可重复执行并包含归档关联字段", () => {
  initSchema()
  initSchema()
  const packageColumns = db.prepare("PRAGMA table_info(log_packages)").all() as Array<{ name: string }>
  const findingColumns = db.prepare("PRAGMA table_info(health_findings)").all() as Array<{ name: string }>
  for (const name of ["client_id", "command_id", "storage_name", "size_bytes", "sha256", "sources", "entry_count", "truncated", "error", "analyzed_at"]) {
    assert.ok(packageColumns.some((column) => column.name === name), name)
  }
  assert.ok(findingColumns.some((column) => column.name === "package_id"))
})

test("批量采集先创建关联包，非法目标不会产生部分命令", () => {
  const online = register("online")
  assert.throws(() => health.createCollections(collectionInput([online.id, "missing-client"])), /客户端不存在/)
  assert.equal(commands.listCommands().length, 0)
  assert.equal(health.listPackages().length, 0)

  const packages = health.createCollections(collectionInput([online.id]))
  assert.equal(packages.length, 1)
  assert.equal(packages[0].status, "collecting")
  assert.ok(packages[0].commandId)
  assert.equal(commands.getCommand(packages[0].commandId!)?.type, "collect-logs")
})

test("终态结果原子归档、生成高信号去重发现并保持重复上报幂等", () => {
  const client = register()
  const pkg = health.createCollections(collectionInput([client.id]))[0]
  const now = new Date().toISOString()
  const raw = result([
    { source: "system", timestampUtc: now, level: "Critical", eventId: 41, provider: "Microsoft-Windows-Kernel-Power", message: "Unexpected power loss sequence 123" },
    { source: "system", timestampUtc: now, level: "Critical", eventId: 41, provider: "Microsoft-Windows-Kernel-Power", message: "Unexpected power loss sequence 456" },
    { source: "application", timestampUtc: now, level: "Error", eventId: 1000, provider: "Application Error", message: "Sensitive crash marker should stay out of audit logs" },
    { source: "system", timestampUtc: now, level: "Warning", eventId: 129, provider: "storport", message: "Storage retry" },
  ], { truncated: true, error: "application: one malformed event skipped" })
  assert.equal(commands.reportResult(pkg.commandId!, client.id, "success", raw), true)

  const archived = health.getPackage(pkg.id)!
  assert.equal(archived.status, "analyzed")
  assert.equal(archived.entryCount, 4)
  assert.equal(archived.truncated, true)
  assert.equal(archived.downloadable, true)
  assert.match(archived.sha256 ?? "", /^[a-f0-9]{64}$/)
  assert.equal(archived.findings, 5)
  const findings = health.listFindings()
  assert.equal(findings.filter((finding) => finding.title.includes("意外关机")).length, 1)
  assert.match(findings.find((finding) => finding.title.includes("意外关机"))?.detail ?? "", /重复 2 次/)

  assert.equal(commands.reportResult(pkg.commandId!, client.id, "success", raw), true)
  assert.equal(health.listFindings().length, findings.length)
  assert.equal(health.reanalyzePackage(pkg.id).findings, findings.length)
  const audit = db.prepare("SELECT detail FROM logs WHERE source = 'health' ORDER BY ts DESC").all() as Array<{ detail: string }>
  assert.ok(audit.every((entry) => !entry.detail.includes("Sensitive crash marker")))
})

test("分析结果限制为 100 个发现且下载前验证快照完整性", () => {
  const client = register()
  const pkg = health.createCollections(collectionInput([client.id]))[0]
  const now = new Date().toISOString()
  const entries: Entry[] = Array.from({ length: 110 }, (_, index) => ({
    source: "application",
    timestampUtc: now,
    level: "Error",
    eventId: 1000,
    provider: `Application Error ${index}`,
    message: `Crash signature ${index}`,
  }))
  assert.equal(commands.reportResult(pkg.commandId!, client.id, "success", result(entries)), true)
  assert.equal(health.getPackage(pkg.id)?.findings, 100)
  const download = health.getPackageDownload(pkg.id)
  assert.equal(fs.readFileSync(download.filePath, "utf8").length > 0, true)
  fs.appendFileSync(download.filePath, "tampered")
  assert.throws(() => health.getPackageDownload(pkg.id), /完整性校验失败/)
  assert.throws(() => health.reanalyzePackage(pkg.id), /完整性校验失败/)
})

test("失败结果生成可见发现并可重新采集，非法结果安全失败", () => {
  const client = register()
  const failed = health.createCollections(collectionInput([client.id]))[0]
  const raw = result([], { error: "Windows event log access failed" })
  assert.equal(commands.reportResult(failed.commandId!, client.id, "failed", raw), true)
  assert.equal(health.getPackage(failed.id)?.status, "failed")
  assert.equal(health.listFindings()[0].title, "日志采集失败")
  assert.throws(() => health.reanalyzePackage(failed.id), /重新采集/)
  const retried = health.recollectPackage(failed.id)
  assert.equal(retried.length, 1)
  assert.equal(retried[0].clientId, client.id)

  const invalid = health.createCollections(collectionInput([client.id]))[0]
  assert.equal(commands.reportResult(invalid.commandId!, client.id, "failed", "{}"), true)
  assert.equal(health.getPackage(invalid.id)?.status, "failed")
  assert.equal(health.getPackage(invalid.id)?.downloadable, false)
})
