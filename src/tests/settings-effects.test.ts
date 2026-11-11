import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, beforeEach, test } from "node:test"

const databasePath = path.join(process.cwd(), "tmp-settings-effects-test.db")
process.env.DATABASE_PATH = databasePath
process.env.LOG_RETENTION_MAX = "1000"
delete process.env.ALLOW_OPEN_ENROLLMENT

let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let settings: typeof import("../services/settings")
let clients: typeof import("../services/clients")
let commands: typeof import("../services/commands")
let logs: typeof import("../services/logs")
let tasks: typeof import("../services/tasks")
let scheduler: typeof import("../services/task-scheduler")

before(async () => {
  fs.rmSync(databasePath, { force: true })
  ;({ db, initSchema } = await import("../db"))
  settings = await import("../services/settings")
  clients = await import("../services/clients")
  commands = await import("../services/commands")
  logs = await import("../services/logs")
  tasks = await import("../services/tasks")
  scheduler = await import("../services/task-scheduler")
  initSchema()
})

beforeEach(() => {
  db.exec(
    "DELETE FROM task_runs; DELETE FROM commands; DELETE FROM tasks; DELETE FROM clients; DELETE FROM logs; DELETE FROM notifications; DELETE FROM settings",
  )
  settings.invalidateSettingsCache()
})

after(() => {
  db.close()
  fs.rmSync(databasePath, { force: true })
  fs.rmSync(`${databasePath}-shm`, { force: true })
  fs.rmSync(`${databasePath}-wal`, { force: true })
})

function registerClient(name: string): string {
  return clients.registerClient({ name, os: "Windows" }).client.id
}

function createTask(patch: Partial<Parameters<typeof tasks.createTask>[0]> = {}) {
  return tasks.createTask({
    name: "fixture task",
    os: "windows",
    action: "运行程序",
    program: "C:\\Windows\\System32\\hostname.exe",
    args: "",
    triggerId: "cron",
    time: "06:00",
    interval: 1,
    cron: "*/5 * * * *",
    timezone: "UTC",
    clientIds: [],
    enabled: true,
    ...patch,
  })
}

test("离线阈值设置即时影响客户端在线状态计算", () => {
  settings.mergeSettings({ general: { offlineThreshold: 10 } })
  const clientId = registerClient("offline-threshold")
  db.prepare("UPDATE clients SET last_seen = ? WHERE id = ?").run(Date.now() - 20_000, clientId)
  assert.equal(clients.getClient(clientId)?.status, "offline")

  settings.mergeSettings({ general: { offlineThreshold: 60 } })
  assert.equal(clients.getClient(clientId)?.status, "online")
})

test("未指定超时的 run-program 使用设置默认值，并截断到 Agent 契约上限", () => {
  settings.mergeSettings({ general: { commandTimeout: 180 } })
  const clientId = registerClient("timeout-default")
  const implicit = commands.dispatchCommand({
    clientId,
    type: "run-program",
    payload: { program: "hostname.exe", args: "" },
  })
  assert.equal(implicit.payload.timeoutSeconds, 180)

  const explicit = commands.dispatchCommand({
    clientId,
    type: "run-program",
    payload: { program: "hostname.exe", args: "", timeoutSeconds: 45 },
  })
  assert.equal(explicit.payload.timeoutSeconds, 45)

  settings.mergeSettings({ general: { commandTimeout: 1200 } })
  const clamped = commands.dispatchCommand({
    clientId,
    type: "run-program",
    payload: { program: "hostname.exe", args: "" },
  })
  assert.equal(clamped.payload.timeoutSeconds, 900)
})

test("并发数限制单客户端的在途指令，结果上报后继续投递排队指令", () => {
  settings.mergeSettings({ general: { concurrency: 1 } })
  const clientId = registerClient("concurrency")
  const first = commands.dispatchCommand({
    clientId,
    type: "run-shell",
    payload: { shell: "cmd", script: "echo 1", timeoutSeconds: 30 },
  })
  const second = commands.dispatchCommand({
    clientId,
    type: "run-shell",
    payload: { shell: "cmd", script: "echo 2", timeoutSeconds: 30 },
  })

  assert.deepEqual(commands.pullPending(clientId).map((item) => item.id), [first.id])
  assert.equal(commands.acknowledge(first.id, clientId), true)
  assert.deepEqual(commands.pullPending(clientId), [])

  assert.equal(commands.reportResult(first.id, clientId, "success", "ok", 0), true)
  assert.deepEqual(commands.pullPending(clientId).map((item) => item.id), [second.id])
})

test("重试次数设置决定自动下发的最大尝试次数", () => {
  settings.mergeSettings({ general: { retryCount: 0 } })
  const clientId = registerClient("retry-zero")
  const now = Date.parse("2026-06-01T10:02:00Z")
  const task = createTask({ clientIds: [clientId] })
  db.prepare("UPDATE tasks SET next_run_at = ? WHERE id = ?").run(now, task.id)

  scheduler.runTaskSchedulerTick(now, () => {
    throw new Error("fixture dispatch failure")
  })
  const failed = db.prepare("SELECT status, attempts FROM task_runs WHERE task_id = ?").get(task.id) as { status: string; attempts: number }
  assert.equal(failed.status, "failed")
  assert.equal(failed.attempts, 1)

  settings.mergeSettings({ general: { retryCount: 2 } })
  const retryTask = createTask({ clientIds: [clientId] })
  db.prepare("UPDATE tasks SET next_run_at = ? WHERE id = ?").run(now, retryTask.id)
  scheduler.runTaskSchedulerTick(now, () => {
    throw new Error("fixture dispatch failure")
  })
  const retrying = db.prepare("SELECT status, attempts FROM task_runs WHERE task_id = ?").get(retryTask.id) as { status: string; attempts: number }
  assert.equal(retrying.status, "retrying")
  assert.equal(retrying.attempts, 1)

  scheduler.runTaskSchedulerTick(now + scheduler.retryDelayMs(1))
  const recovered = db.prepare("SELECT status, attempts FROM task_runs WHERE task_id = ?").get(retryTask.id) as { status: string; attempts: number }
  assert.equal(recovered.status, "success")
  assert.equal(recovered.attempts, 2)
  assert.equal(commands.listCommands(clientId).filter((item) => item.taskId === retryTask.id).length, 1)
})

test("日志保留按条目上限与天数生效，0 天表示不按时间清理", () => {
  settings.mergeSettings({ general: { logRetentionDays: 1, logRetentionMax: 1000 } })
  const now = Date.now()
  db.prepare("INSERT INTO logs (id, ts, level, source, message) VALUES ('old-log', ?, 'info', 'test', 'old')")
    .run(now - 2 * 86_400_000)
  db.prepare("INSERT INTO logs (id, ts, level, source, message) VALUES ('new-log', ?, 'info', 'test', 'new')")
    .run(now)
  assert.ok(logs.sweepLogRetention(now) >= 1)
  assert.equal(db.prepare("SELECT 1 FROM logs WHERE id = 'old-log'").get(), undefined)
  assert.ok(db.prepare("SELECT 1 FROM logs WHERE id = 'new-log'").get())

  db.exec("DELETE FROM logs; BEGIN")
  const insert = db.prepare("INSERT INTO logs (id, ts, level, source, message) VALUES (?, ?, 'info', 'bulk', 'row')")
  for (let index = 0; index < 1005; index += 1) insert.run(`bulk-${index}`, now + index)
  db.exec("COMMIT")
  logs.sweepLogRetention(now)
  const count = (db.prepare("SELECT COUNT(*) AS count FROM logs").get() as { count: number }).count
  assert.equal(count, 1000)
  assert.equal(db.prepare("SELECT 1 FROM logs WHERE id = 'bulk-0'").get(), undefined)
  assert.ok(db.prepare("SELECT 1 FROM logs WHERE id = 'bulk-1004'").get())

  settings.mergeSettings({ general: { logRetentionDays: 0 } })
  db.exec("DELETE FROM logs")
  db.prepare("INSERT INTO logs (id, ts, level, source, message) VALUES ('kept-log', ?, 'info', 'test', 'kept')")
    .run(now - 90 * 86_400_000)
  logs.sweepLogRetention(now)
  assert.ok(db.prepare("SELECT 1 FROM logs WHERE id = 'kept-log'").get())
})

test("自动清理只删除超过保留期的成功/跳过运行记录", () => {
  settings.mergeSettings({ general: { autoCleanTasks: true } })
  const now = Date.now()
  db.prepare("INSERT INTO tasks (id, name, client_ids, created_at, updated_at) VALUES ('task-cleanup', 'fixture', '[]', ?, ?)")
    .run(now, now)
  const insertRun = db.prepare(
    "INSERT INTO task_runs (id, task_id, scheduled_for, status, attempts, target_ids, command_ids, created_at, updated_at, finished_at) VALUES (?, 'task-cleanup', ?, ?, 0, '[]', '[]', ?, ?, ?)",
  )
  const old = now - 40 * 86_400_000
  insertRun.run("run-old-success", old, "success", old, old, old)
  insertRun.run("run-old-failed", old + 1, "failed", old, old, old)
  insertRun.run("run-recent-success", now - 86_400_000, "success", now, now, now - 86_400_000)

  assert.equal(scheduler.cleanupFinishedTaskRuns(now), 1)
  assert.equal(db.prepare("SELECT 1 FROM task_runs WHERE id = 'run-old-success'").get(), undefined)
  assert.ok(db.prepare("SELECT 1 FROM task_runs WHERE id = 'run-old-failed'").get())
  assert.ok(db.prepare("SELECT 1 FROM task_runs WHERE id = 'run-recent-success'").get())

  settings.mergeSettings({ general: { autoCleanTasks: false } })
  insertRun.run("run-older-success", old - 86_400_000, "success", old, old, old)
  assert.equal(scheduler.cleanupFinishedTaskRuns(now), 0)
  assert.ok(db.prepare("SELECT 1 FROM task_runs WHERE id = 'run-older-success'").get())
})

test("未显式指定时区的任务使用服务端时区设置", () => {
  settings.mergeSettings({ general: { timezone: "Asia/Shanghai" } })
  const task = tasks.createTask({
    name: "timezone default",
    os: "windows",
    action: "运行程序",
    program: "hostname.exe",
    args: "",
    triggerId: "daily",
    time: "06:00",
    interval: 1,
    cron: "",
    clientIds: [],
    enabled: true,
  })
  assert.equal(task.timezone, "Asia/Shanghai")
})
