import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { inflateRawSync } from "node:zlib"
import { after, before, beforeEach, test } from "node:test"

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nacho-log-archive-test-"))
const databasePath = path.join(testRoot, "archive.db")
process.env.DATABASE_PATH = databasePath
delete process.env.ALLOW_OPEN_ENROLLMENT

let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let logs: typeof import("../services/logs")
let settings: typeof import("../services/settings")
let archiveLogs: typeof import("../services/log-archive").archiveLogs

const archiveDirectory = () => path.join(testRoot, "log-archives")

before(async () => {
  ;({ db, initSchema } = await import("../db"))
  logs = await import("../services/logs")
  settings = await import("../services/settings")
  ;({ archiveLogs } = await import("../services/log-archive"))
  initSchema()
})

beforeEach(() => {
  db.exec("DELETE FROM logs; DELETE FROM settings")
  settings.invalidateSettingsCache()
  fs.rmSync(archiveDirectory(), { recursive: true, force: true })
})

after(() => {
  db.close()
  fs.rmSync(testRoot, { recursive: true, force: true })
})

function useRetention(patch: {
  compressArchive?: boolean
  logRetentionDays?: number
  logRetentionMax?: number
} = {}): void {
  settings.mergeSettings({
    general: { logRetentionDays: 1, logRetentionMax: 1000, compressArchive: true, ...patch },
  })
}

function insertLog(id: string, ts: number, message = id, detail: string | null = null): void {
  db.prepare("INSERT INTO logs (id, ts, level, source, message, detail) VALUES (?, ?, 'info', 'test', ?, ?)")
    .run(id, ts, message, detail)
}

function listArchiveFiles(): string[] {
  if (!fs.existsSync(archiveDirectory())) return []
  return fs.readdirSync(archiveDirectory()).filter((name) => name.endsWith(".zip")).sort()
}

type ArchivedLog = { id: string; ts: number; level: string; source: string; message: string; detail: string | null }

function readZipEntry(filePath: string): { name: string; content: string } {
  const zip = fs.readFileSync(filePath)
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "缺少 ZIP 本地文件头")
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, "缺少 ZIP 中央目录结束记录")
  assert.equal(zip.readUInt16LE(8), 8, "应使用 deflate 压缩")
  const compressedSize = zip.readUInt32LE(18)
  const uncompressedSize = zip.readUInt32LE(22)
  const nameLength = zip.readUInt16LE(26)
  const extraLength = zip.readUInt16LE(28)
  const name = zip.subarray(30, 30 + nameLength).toString("utf8")
  const dataStart = 30 + nameLength + extraLength
  const raw = inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize))
  assert.equal(raw.length, uncompressedSize)
  return { name, content: raw.toString("utf8") }
}

test("compressArchive 开启时先归档过期日志再删除，归档内容可还原", () => {
  const now = Date.parse("2026-06-01T10:00:00Z")
  useRetention({ logRetentionDays: 1, compressArchive: true })
  insertLog("old-1", now - 2 * 86_400_000, "旧日志一", "详情\n第二行")
  insertLog("old-2", now - 3 * 86_400_000, "旧日志二")
  insertLog("new-1", now - 60_000, "新日志")

  assert.equal(logs.sweepLogRetention(now), 2)
  assert.equal(db.prepare("SELECT 1 FROM logs WHERE id = 'old-1'").get(), undefined)
  assert.equal(db.prepare("SELECT 1 FROM logs WHERE id = 'old-2'").get(), undefined)
  assert.ok(db.prepare("SELECT 1 FROM logs WHERE id = 'new-1'").get())

  const files = listArchiveFiles()
  assert.equal(files.length, 1)
  const { name, content } = readZipEntry(path.join(archiveDirectory(), files[0]))
  assert.match(name, /^logs-.+\.jsonl$/)
  const entries = content.trim().split("\n").map((line) => JSON.parse(line) as ArchivedLog)
  assert.deepEqual(entries.map((entry) => entry.id), ["old-2", "old-1"])
  assert.equal(entries.find((entry) => entry.id === "old-1")?.detail, "详情\n第二行")
  assert.ok(entries.every((entry) => entry.level === "info" && entry.source === "test"))
})

test("compressArchive 关闭时直接删除过期日志且不生成归档", () => {
  const now = Date.parse("2026-06-01T10:00:00Z")
  useRetention({ logRetentionDays: 1, compressArchive: false })
  insertLog("expired", now - 2 * 86_400_000)

  assert.equal(logs.sweepLogRetention(now), 1)
  assert.equal(db.prepare("SELECT 1 FROM logs WHERE id = 'expired'").get(), undefined)
  assert.deepEqual(listArchiveFiles(), [])
  assert.equal(fs.existsSync(archiveDirectory()), false)
})

test("未超过保留天数的日志不会被归档或删除", () => {
  const now = Date.parse("2026-06-01T10:00:00Z")
  useRetention({ logRetentionDays: 30, compressArchive: true })
  insertLog("recent-enough", now - 2 * 86_400_000)

  assert.equal(logs.sweepLogRetention(now), 0)
  assert.ok(db.prepare("SELECT 1 FROM logs WHERE id = 'recent-enough'").get())
  assert.deepEqual(listArchiveFiles(), [])
})

test("归档失败时保留日志，修复后下次清理重试", () => {
  const now = Date.parse("2026-06-01T10:00:00Z")
  useRetention({ logRetentionDays: 1, compressArchive: true })
  insertLog("pending-archive", now - 2 * 86_400_000)

  // 用同名文件占住归档目录，使 mkdir 失败。
  fs.writeFileSync(archiveDirectory(), "blocked")
  assert.equal(logs.sweepLogRetention(now), 0)
  assert.ok(db.prepare("SELECT 1 FROM logs WHERE id = 'pending-archive'").get())

  fs.rmSync(archiveDirectory(), { force: true })
  assert.equal(logs.sweepLogRetention(now), 1)
  assert.equal(db.prepare("SELECT 1 FROM logs WHERE id = 'pending-archive'").get(), undefined)
  assert.equal(listArchiveFiles().length, 1)
})

test("同一时间戳的多次归档不会覆盖已有文件", () => {
  const now = Date.parse("2026-06-01T10:00:00Z")
  useRetention({ logRetentionDays: 1, compressArchive: true })

  insertLog("batch-a", now - 2 * 86_400_000)
  assert.equal(logs.sweepLogRetention(now), 1)
  insertLog("batch-b", now - 2 * 86_400_000)
  assert.equal(logs.sweepLogRetention(now), 1)

  const files = listArchiveFiles()
  assert.equal(files.length, 2)
  const ids = files
    .map((file) => readZipEntry(path.join(archiveDirectory(), file)).content.trim())
    .map((line) => (JSON.parse(line) as ArchivedLog).id)
    .sort()
  assert.deepEqual(ids, ["batch-a", "batch-b"])
})

test("条目上限裁剪保持原有行为且不写入归档", () => {
  const now = Date.parse("2026-06-01T10:00:00Z")
  useRetention({ logRetentionDays: 1, logRetentionMax: 1000, compressArchive: true })
  db.exec("BEGIN")
  const insert = db.prepare("INSERT INTO logs (id, ts, level, source, message) VALUES (?, ?, 'info', 'bulk', 'row')")
  for (let index = 0; index < 1005; index += 1) insert.run(`bulk-${index}`, now + index)
  db.exec("COMMIT")

  assert.equal(logs.sweepLogRetention(now), 5)
  const count = (db.prepare("SELECT COUNT(*) AS count FROM logs").get() as { count: number }).count
  assert.equal(count, 1000)
  assert.deepEqual(listArchiveFiles(), [])
})

test("空归档不创建目录，显式目录选项可独立使用", () => {
  const customDirectory = path.join(testRoot, "custom-archives")
  assert.equal(archiveLogs([], { directory: customDirectory }), null)
  assert.equal(fs.existsSync(customDirectory), false)

  const result = archiveLogs(
    [{ id: "unit-1", ts: 1, level: "info", source: "unit", message: "hello", detail: null }],
    { directory: customDirectory, now: Date.parse("2026-06-01T00:00:00Z") },
  )
  assert.ok(result)
  assert.equal(result.entryCount, 1)
  assert.ok(result.filePath.startsWith(customDirectory))
  const { content } = readZipEntry(result.filePath)
  assert.equal((JSON.parse(content.trim()) as ArchivedLog).id, "unit-1")
})
