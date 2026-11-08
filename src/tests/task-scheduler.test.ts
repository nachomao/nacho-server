import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, test } from "node:test"

const databasePath = path.join(process.cwd(), "tmp-task-scheduler-test.db")

let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let clients: typeof import("../services/clients")
let tasks: typeof import("../services/tasks")
let commands: typeof import("../services/commands")
let scheduler: typeof import("../services/task-scheduler")

before(async () => {
  fs.rmSync(databasePath, { force: true })
  process.env.DATABASE_PATH = databasePath
  process.env.LOG_RETENTION_MAX = "2000"
  ;({ db, initSchema } = await import("../db"))
  clients = await import("../services/clients")
  tasks = await import("../services/tasks")
  commands = await import("../services/commands")
  scheduler = await import("../services/task-scheduler")
  initSchema()
})

after(() => {
  db.close()
  fs.rmSync(databasePath, { force: true })
})

function reset() {
  db.exec("DELETE FROM task_runs; DELETE FROM commands; DELETE FROM tasks; DELETE FROM clients; DELETE FROM logs")
}

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

function setNextRunAt(taskId: string, at: number) {
  db.prepare("UPDATE tasks SET next_run_at = ? WHERE id = ?").run(at, taskId)
}

function listRuns(taskId: string) {
  return db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY scheduled_for").all(taskId) as Array<{
    id: string
    status: string
    attempts: number
    next_attempt_at: number | null
    command_ids: string
    error: string | null
  }>
}

test("recurring task creation stores timezone and computes a future next run", () => {
  reset()
  const task = createTask({ triggerId: "daily", time: "09:00", cron: "", timezone: "Asia/Shanghai" })
  assert.equal(task.timezone, "Asia/Shanghai")
  assert.ok(task.nextRunAt && task.nextRunAt > Date.now() - 1000)
  assert.throws(
    () => createTask({ triggerId: "cron", cron: "not a cron", timezone: "UTC" }),
    /Cron 表达式无效/,
  )
  const eventTask = createTask({ triggerId: "logon" })
  assert.equal(eventTask.nextRunAt, null)
})

test("legacy recurring tasks without a stored next run are scheduled on the next scan", () => {
  reset()
  const clientId = registerClient("scheduler-legacy")
  const task = createTask({ triggerId: "daily", time: "06:00", cron: "", clientIds: [clientId] })
  db.prepare("UPDATE tasks SET next_run_at = NULL, last_run_at = NULL, last_status = NULL WHERE id = ?").run(task.id)
  const now = Date.parse("2026-06-01T10:00:00Z")
  scheduler.runTaskSchedulerTick(now)
  const updated = tasks.getTask(task.id)
  assert.equal(updated?.nextRunAt, Date.parse("2026-06-02T06:00:00Z"))
  assert.equal(commands.listCommands(clientId).length, 0)
})

test("scheduler dispatches a due task exactly once and advances the next run", () => {
  reset()
  const clientId = registerClient("scheduler-once")
  const task = createTask({ clientIds: [clientId] })
  const scheduledFor = Date.parse("2026-06-01T10:02:00Z")
  setNextRunAt(task.id, scheduledFor)

  scheduler.runTaskSchedulerTick(scheduledFor)
  const first = commands.listCommands(clientId)
  assert.equal(first.length, 1)
  assert.equal(first[0].taskId, task.id)
  assert.ok(first[0].runId)

  const afterFirst = tasks.getTask(task.id)
  assert.equal(afterFirst?.lastRunAt, scheduledFor)
  assert.equal(afterFirst?.lastStatus, "success")
  assert.ok((afterFirst?.nextRunAt ?? 0) > scheduledFor)

  scheduler.runTaskSchedulerTick(scheduledFor)
  assert.equal(commands.listCommands(clientId).length, 1)
  assert.equal(listRuns(task.id).length, 1)
})

test("restart catch-up executes one missed occurrence and schedules the future cadence", () => {
  reset()
  const clientId = registerClient("scheduler-catch-up")
  const task = createTask({ triggerId: "daily", time: "03:00", cron: "", clientIds: [clientId] })
  const now = Date.parse("2026-06-03T10:00:00Z")
  setNextRunAt(task.id, Date.parse("2026-06-01T03:00:00Z"))

  scheduler.runTaskSchedulerTick(now)
  assert.equal(commands.listCommands(clientId).length, 1)
  const updated = tasks.getTask(task.id)
  assert.equal(updated?.nextRunAt, Date.parse("2026-06-04T03:00:00Z"))
  assert.equal(updated?.lastStatus, "success")

  scheduler.runTaskSchedulerTick(now)
  assert.equal(commands.listCommands(clientId).length, 1)
})

test("failed dispatch retries, then reuses the run commands without duplicate delivery", () => {
  reset()
  const clientId = registerClient("scheduler-retry")
  const task = createTask({ clientIds: [clientId] })
  const scheduledFor = Date.parse("2026-06-01T10:02:00Z")
  setNextRunAt(task.id, scheduledFor)

  scheduler.runTaskSchedulerTick(scheduledFor, () => {
    throw new Error("fixture dispatch failure")
  })
  let [run] = listRuns(task.id)
  assert.equal(run.status, "retrying")
  assert.equal(run.attempts, 1)
  assert.match(run.error ?? "", /fixture dispatch failure/)
  assert.equal(commands.listCommands(clientId).length, 0)
  assert.equal(tasks.getTask(task.id)?.lastStatus, "retrying")

  const retryAt = scheduledFor + scheduler.retryDelayMs(1)
  scheduler.runTaskSchedulerTick(retryAt)
  assert.equal(commands.listCommands(clientId).length, 1)
  ;[run] = listRuns(task.id)
  assert.equal(run.status, "success")
  assert.equal(run.attempts, 2)

  // 模拟“命令已创建但运行记录未收尾”后再次恢复，runId 唯一约束应复用命令。
  db.prepare("UPDATE task_runs SET status = 'retrying', next_attempt_at = ?, updated_at = ? WHERE id = ?")
    .run(retryAt + 1, retryAt + 1, run.id)
  scheduler.runTaskSchedulerTick(retryAt + 1)
  assert.equal(commands.listCommands(clientId).length, 1)
  ;[run] = listRuns(task.id)
  assert.equal(run.status, "success")
  assert.equal(run.attempts, 3)
})

test("disabled tasks stay out of the scheduler and manual dispatch does not shift next run", () => {
  reset()
  const clientId = registerClient("scheduler-disabled")
  const task = createTask({ enabled: false, clientIds: [clientId] })
  const scheduledFor = Date.parse("2026-06-01T10:02:00Z")
  setNextRunAt(task.id, scheduledFor)
  scheduler.runTaskSchedulerTick(scheduledFor)
  assert.equal(commands.listCommands(clientId).length, 0)
  assert.equal(listRuns(task.id).length, 0)

  const enabled = tasks.setEnabled(task.id, true)
  assert.ok(enabled?.nextRunAt && enabled.nextRunAt > Date.now() - 1000)
  const nextBeforeManual = enabled?.nextRunAt
  const result = tasks.dispatchTask(task.id)
  assert.equal(result?.commands.length, 1)
  assert.equal(tasks.getTask(task.id)?.lastStatus, "success")
  assert.equal(tasks.getTask(task.id)?.nextRunAt, nextBeforeManual)
})
