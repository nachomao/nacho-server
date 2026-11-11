import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, beforeEach, test } from "node:test"

const databasePath = path.join(process.cwd(), "tmp-notification-settings-test.db")
process.env.DATABASE_PATH = databasePath
process.env.LOG_RETENTION_MAX = "1000"
delete process.env.ALLOW_OPEN_ENROLLMENT

let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let settings: typeof import("../services/settings")
let notifications: typeof import("../services/notifications")

before(async () => {
  fs.rmSync(databasePath, { force: true })
  ;({ db, initSchema } = await import("../db"))
  settings = await import("../services/settings")
  notifications = await import("../services/notifications")
  initSchema()
})

beforeEach(() => {
  db.exec(
    "DELETE FROM notifications; DELETE FROM health_findings; DELETE FROM commands; DELETE FROM tasks; DELETE FROM clients; DELETE FROM logs; DELETE FROM settings",
  )
  settings.invalidateSettingsCache()
})

after(() => {
  db.close()
  fs.rmSync(databasePath, { force: true })
  fs.rmSync(`${databasePath}-shm`, { force: true })
  fs.rmSync(`${databasePath}-wal`, { force: true })
})

function insertClient(id: string, lastSeen: number): void {
  db.prepare("INSERT INTO clients (id, name, hostname, status, token, last_seen, registered_at) VALUES (?, ?, ?, 'offline', ?, ?, ?)")
    .run(id, id, `${id}-host`, `${id}-token`, lastSeen, lastSeen || Date.now())
}

function insertFailedCommand(id: string, clientId: string): void {
  const now = Date.now()
  db.prepare("INSERT INTO commands (id, client_id, type, status, created_at, updated_at) VALUES (?, ?, 'run-program', 'failed', ?, ?)")
    .run(id, clientId, now, now)
}

test("关闭客户端离线通知条件后不再生成离线通知", () => {
  settings.mergeSettings({ conditions: { clientOffline: false } })
  insertClient("offline-disabled", Date.now() - 120_000)
  assert.equal(notifications.listNotifications(100).some((item) => item.type === "offline"), false)

  settings.mergeSettings({ conditions: { clientOffline: true } })
  assert.ok(notifications.listNotifications(100).some((item) => item.type === "offline"))
})

test("关闭任务失败通知条件后不再生成任务失败通知", () => {
  settings.mergeSettings({ conditions: { taskFailed: false } })
  insertClient("task-client", Date.now())
  insertFailedCommand("failed-command", "task-client")
  assert.equal(notifications.listNotifications(100).some((item) => item.type === "task"), false)

  settings.mergeSettings({ conditions: { taskFailed: true } })
  assert.ok(notifications.listNotifications(100).some((item) => item.type === "task"))
})

test("CPU/内存/磁盘阈值按条件触发一次并在恢复后撤销", () => {
  insertClient("metric-client", Date.now())
  settings.mergeSettings({
    conditions: { cpuAlert: true, cpuThreshold: 50, memAlert: false, memThreshold: 90, diskAlert: false, diskThreshold: 90 },
  })
  const at = Date.now()
  const client = { id: "metric-client", name: "metric-host", hostname: "metric-host" }
  const metricAlerts = () => notifications.listNotifications(100).filter((item) => item.source === "metrics")

  notifications.evaluateClientMetrics(client, { cpu: 80, memory: 95, disk: 10, uptime: 1000 }, at)
  const first = metricAlerts()
  assert.equal(first.length, 1)
  assert.match(first[0].title, /CPU/)
  assert.equal(first[0].severity, "warning")

  notifications.evaluateClientMetrics(client, { cpu: 82, memory: 95, disk: 10, uptime: 2000 }, at + 1_000)
  assert.equal(metricAlerts().length, 1)

  notifications.evaluateClientMetrics(client, { cpu: 20, memory: 95, disk: 10, uptime: 3000 }, at + 2_000)
  assert.equal(metricAlerts().length, 0)

  // 单独开启内存告警后，超过阈值会产生对应通知。
  settings.mergeSettings({ conditions: { memAlert: true, memThreshold: 90 } })
  notifications.evaluateClientMetrics(client, { cpu: 20, memory: 95, disk: 10, uptime: 4000 }, at + 3_000)
  const memory = metricAlerts()
  assert.equal(memory.length, 1)
  assert.match(memory[0].title, /内存/)
})

test("静默时段按服务端时区计算，严重告警不受抑制", () => {
  settings.mergeSettings({ general: { timezone: "Asia/Shanghai" }, conditions: { quietHours: true } })
  const lateNight = Date.parse("2026-01-01T15:30:00Z") // Asia/Shanghai 23:30
  const beforeDawn = Date.parse("2026-01-01T22:59:00Z") // Asia/Shanghai 06:59
  const morning = Date.parse("2026-01-01T23:00:00Z") // Asia/Shanghai 07:00

  assert.equal(notifications.isQuietHours(lateNight), true)
  assert.equal(notifications.isQuietHours(beforeDawn), true)
  assert.equal(notifications.isQuietHours(morning), false)
  assert.equal(notifications.isNotificationSuppressed("warning", lateNight), true)
  assert.equal(notifications.isNotificationSuppressed("critical", lateNight), false)

  settings.mergeSettings({ conditions: { quietHours: false } })
  assert.equal(notifications.isQuietHours(lateNight), false)
})
