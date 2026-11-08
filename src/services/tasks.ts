import { db } from "../db"
import { HttpError } from "../lib/http"
import { shortId } from "../lib/ids"
import {
  DEFAULT_TASK_TIMEZONE,
  isRecurringTrigger,
  nextTaskRunAt,
  normalizeTimeZone,
  validateTaskSchedule,
  type ScheduleDefinition,
} from "../lib/schedule"
import type { Command, ScheduledTask, TaskOS, TaskRunStatus, TriggerId } from "../types"
import { dispatchCommand, getTaskRunCommand } from "./commands"
import { recordLog } from "./logs"

type TaskRow = {
  id: string
  name: string
  os: string
  action: string
  program: string
  args: string
  trigger_id: string
  time: string
  interval: number
  cron: string
  client_ids: string
  enabled: number
  timezone: string
  next_run_at: number | null
  last_run_at: number | null
  last_status: TaskRunStatus
  last_error: string | null
  created_at: number
  updated_at: number
}

function mapTask(r: TaskRow): ScheduledTask {
  return {
    id: r.id,
    name: r.name,
    os: r.os as TaskOS,
    action: r.action,
    program: r.program,
    args: r.args,
    triggerId: r.trigger_id as TriggerId,
    time: r.time,
    interval: r.interval,
    cron: r.cron,
    timezone: r.timezone || DEFAULT_TASK_TIMEZONE,
    clientIds: parseArr(r.client_ids),
    enabled: r.enabled === 1,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastStatus: normalizeRunStatus(r.last_status),
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function normalizeRunStatus(value: string | null): TaskRunStatus {
  return value === "success" || value === "failed" || value === "retrying" ? value : null
}

function parseArr(s: string): string[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function listTasks(): ScheduledTask[] {
  const rows = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as TaskRow[]
  return rows.map(mapTask)
}

export function getTask(id: string): ScheduledTask | null {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined
  return row ? mapTask(row) : null
}

export type TaskInput = {
  name: string
  os: TaskOS
  action: string
  program: string
  args: string
  triggerId: TriggerId
  time: string
  interval: number
  cron: string
  timezone?: string
  clientIds: string[]
  enabled: boolean
}

function scheduleOf(input: Pick<TaskInput, "triggerId" | "time" | "interval" | "cron" | "timezone">): ScheduleDefinition {
  const timezone = normalizeTimeZone(input.timezone || DEFAULT_TASK_TIMEZONE)
  if (!timezone) throw new HttpError(400, "时区无效，请使用 IANA 时区名（例如 Asia/Shanghai）")
  const schedule: ScheduleDefinition = {
    triggerId: input.triggerId,
    time: input.time,
    interval: input.interval,
    cron: input.cron,
    timezone,
  }
  const error = validateTaskSchedule(schedule)
  if (error) throw new HttpError(400, error)
  return schedule
}

function initialNextRunAt(task: ScheduleDefinition, enabled: boolean, now: number): number | null {
  if (!enabled || !isRecurringTrigger(task.triggerId)) return null
  const next = nextTaskRunAt(task, now)
  if (next === null) throw new HttpError(400, "无法计算下次执行时间，请检查 Cron 与时间设置")
  return next
}

export function createTask(input: TaskInput): ScheduledTask {
  const now = Date.now()
  const id = shortId("task")
  const schedule = scheduleOf(input)
  const nextRunAt = initialNextRunAt(schedule, input.enabled, now)
  db.prepare(
    `INSERT INTO tasks (
       id, name, os, action, program, args, trigger_id, time, interval, cron, client_ids,
       enabled, timezone, next_run_at, last_run_at, last_status, last_error, created_at, updated_at
     ) VALUES (
       @id, @name, @os, @action, @program, @args, @triggerId, @time, @interval, @cron, @clientIds,
       @enabled, @timezone, @nextRunAt, NULL, NULL, NULL, @now, @now
     )`,
  ).run({
    id,
    name: input.name,
    os: input.os,
    action: input.action,
    program: input.program,
    args: input.args,
    triggerId: schedule.triggerId,
    time: input.time,
    interval: input.interval,
    cron: input.cron,
    clientIds: JSON.stringify(input.clientIds),
    enabled: input.enabled ? 1 : 0,
    timezone: schedule.timezone,
    nextRunAt,
    now,
  })
  recordLog("info", "task", `创建计划任务：${input.name}`, `id=${id};timezone=${schedule.timezone};nextRunAt=${nextRunAt ?? "none"}`)
  return getTask(id)!
}

const SCHEDULE_FIELDS = ["triggerId", "time", "interval", "cron", "timezone"] as const

export function updateTask(id: string, input: Partial<TaskInput>): ScheduledTask | null {
  const current = getTask(id)
  if (!current) return null
  const merged: TaskInput = {
    name: input.name ?? current.name,
    os: input.os ?? current.os,
    action: input.action ?? current.action,
    program: input.program ?? current.program,
    args: input.args ?? current.args,
    triggerId: input.triggerId ?? current.triggerId,
    time: input.time ?? current.time,
    interval: input.interval ?? current.interval,
    cron: input.cron ?? current.cron,
    timezone: input.timezone ?? current.timezone,
    clientIds: input.clientIds ?? current.clientIds,
    enabled: input.enabled ?? current.enabled,
  }
  const schedule = scheduleOf(merged)
  const scheduleChanged = SCHEDULE_FIELDS.some((field) => merged[field] !== current[field])
    || (merged.enabled && !current.enabled)
  let nextRunAt: number | null
  if (!merged.enabled || !isRecurringTrigger(merged.triggerId)) {
    nextRunAt = null
  } else if (scheduleChanged || current.nextRunAt === null) {
    nextRunAt = initialNextRunAt(schedule, true, Date.now())
  } else {
    nextRunAt = current.nextRunAt
  }
  db.prepare(
    `UPDATE tasks SET name=@name, os=@os, action=@action, program=@program, args=@args, trigger_id=@triggerId,
     time=@time, interval=@interval, cron=@cron, client_ids=@clientIds, enabled=@enabled,
     timezone=@timezone, next_run_at=@nextRunAt, updated_at=@now WHERE id=@id`,
  ).run({
    id,
    name: merged.name,
    os: merged.os,
    action: merged.action,
    program: merged.program,
    args: merged.args,
    triggerId: schedule.triggerId,
    time: merged.time,
    interval: merged.interval,
    cron: merged.cron,
    clientIds: JSON.stringify(merged.clientIds),
    enabled: merged.enabled ? 1 : 0,
    timezone: schedule.timezone,
    nextRunAt,
    now: Date.now(),
  })
  // 排期或启停变化后，旧的未执行运行不应再按新配置补跑。
  if (scheduleChanged || !merged.enabled) {
    cancelPendingRunCommands(id, Date.now())
    db.prepare("DELETE FROM task_runs WHERE task_id = ? AND status IN ('pending', 'retrying')").run(id)
  }
  return getTask(id)
}

function cancelPendingRunCommands(taskId: string, now: number): void {
  const runs = db.prepare(
    "SELECT id FROM task_runs WHERE task_id = ? AND status IN ('pending', 'retrying')",
  ).all(taskId) as Array<{ id: string }>
  for (const run of runs) {
    cancelRunPendingCommands(run.id, now)
  }
}

/** 停止一次尚未最终成功的自动运行中仍处于 pending 的命令。 */
export function cancelRunPendingCommands(runId: string, now = Date.now()): number {
  const info = db.prepare(
    "UPDATE commands SET status = 'canceled', updated_at = ? WHERE run_id = ? AND status = 'pending'",
  ).run(now, runId)
  return Number(info.changes)
}

export function deleteTask(id: string): boolean {
  cancelPendingRunCommands(id, Date.now())
  const info = db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
  return info.changes > 0
}

export function setEnabled(id: string, enabled: boolean): ScheduledTask | null {
  return updateTask(id, { enabled })
}

/** 记录一次手动或自动下发的结果，供面板展示最近执行时间。 */
export function markTaskRun(id: string, at: number, status: Exclude<TaskRunStatus, null>, error: string | null = null): void {
  db.prepare("UPDATE tasks SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?")
    .run(at, status, error, id)
}

function createTaskCommands(task: ScheduledTask, clientIds: string[], runId: string | null): Command[] {
  const commands: Command[] = []
  for (const clientId of clientIds) {
    const exists = db.prepare("SELECT id FROM clients WHERE id = ?").get(clientId)
    if (!exists) continue
    if (runId) {
      // 失败重试或服务重启后复用同一次运行已创建的命令，避免重复投递。
      const existing = getTaskRunCommand(runId, clientId)
      if (existing) {
        commands.push(existing)
        continue
      }
    }
    commands.push(
      dispatchCommand({
        clientId,
        taskId: task.id,
        runId,
        type: "run-program",
        payload: {
          os: task.os,
          program: task.program,
          args: task.args,
          trigger: {
            id: task.triggerId,
            time: task.time,
            interval: task.interval,
            cron: task.cron,
          },
        },
      }),
    )
  }
  return commands
}

/** 自动调度运行专用：按入队时冻结的目标列表下发，并复用 runId 下的既有命令。 */
export function dispatchTaskForRun(task: ScheduledTask, clientIds: string[], runId: string): Command[] {
  return createTaskCommands(task, clientIds, runId)
}

/**
 * 将任务下发到其所有目标客户端：为每个客户端创建一条 run-program 指令。
 * 这是「面板提交操作任务 -> 服务端授权 -> 下发到客户端」链路的核心。
 */
export function dispatchTask(id: string): { task: ScheduledTask; commands: Command[] } | null {
  const task = getTask(id)
  if (!task) return null
  const commands = createTaskCommands(task, task.clientIds, null)
  const at = Date.now()
  markTaskRun(id, at, commands.length > 0 ? "success" : "failed", commands.length > 0 ? null : "没有可用的目标客户端")
  recordLog("info", "task", `任务 ${task.name} 已下发到 ${commands.length} 台客户端`, `taskId=${task.id}`)
  return { task: getTask(id)!, commands }
}
