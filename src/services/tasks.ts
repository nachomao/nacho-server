import { db } from "../db"
import { shortId } from "../lib/ids"
import type { Command, ScheduledTask, TaskOS, TriggerId } from "../types"
import { dispatchCommand } from "./commands"
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
    clientIds: parseArr(r.client_ids),
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
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

export type TaskInput = Omit<ScheduledTask, "id" | "createdAt" | "updatedAt">

export function createTask(input: TaskInput): ScheduledTask {
  const now = Date.now()
  const id = shortId("task")
  db.prepare(
    `INSERT INTO tasks (id, name, os, action, program, args, trigger_id, time, interval, cron, client_ids, enabled, created_at, updated_at)
     VALUES (@id, @name, @os, @action, @program, @args, @triggerId, @time, @interval, @cron, @clientIds, @enabled, @now, @now)`,
  ).run({
    id,
    name: input.name,
    os: input.os,
    action: input.action,
    program: input.program,
    args: input.args,
    triggerId: input.triggerId,
    time: input.time,
    interval: input.interval,
    cron: input.cron,
    clientIds: JSON.stringify(input.clientIds),
    enabled: input.enabled ? 1 : 0,
    now,
  })
  recordLog("info", "task", `创建计划任务：${input.name}`, `id=${id}`)
  return getTask(id)!
}

export function updateTask(id: string, input: Partial<TaskInput>): ScheduledTask | null {
  const current = getTask(id)
  if (!current) return null
  const merged = { ...current, ...input }
  db.prepare(
    `UPDATE tasks SET name=@name, os=@os, action=@action, program=@program, args=@args, trigger_id=@triggerId,
     time=@time, interval=@interval, cron=@cron, client_ids=@clientIds, enabled=@enabled, updated_at=@now WHERE id=@id`,
  ).run({
    id,
    name: merged.name,
    os: merged.os,
    action: merged.action,
    program: merged.program,
    args: merged.args,
    triggerId: merged.triggerId,
    time: merged.time,
    interval: merged.interval,
    cron: merged.cron,
    clientIds: JSON.stringify(merged.clientIds),
    enabled: merged.enabled ? 1 : 0,
    now: Date.now(),
  })
  return getTask(id)
}

export function deleteTask(id: string): boolean {
  const info = db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
  return info.changes > 0
}

export function setEnabled(id: string, enabled: boolean): ScheduledTask | null {
  return updateTask(id, { enabled })
}

/**
 * 将任务下发到其所有目标客户端：为每个客户端创建一条 run-program 指令。
 * 这是「面板提交操作任务 -> 服务端授权 -> 下发到客户端」链路的核心。
 */
export function dispatchTask(id: string): { task: ScheduledTask; commands: Command[] } | null {
  const task = getTask(id)
  if (!task) return null
  const commands: Command[] = []
  for (const clientId of task.clientIds) {
    const exists = db.prepare("SELECT id FROM clients WHERE id = ?").get(clientId)
    if (!exists) continue
    commands.push(
      dispatchCommand({
        clientId,
        taskId: task.id,
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
  recordLog("info", "task", `任务 ${task.name} 已下发到 ${commands.length} 台客户端`, `taskId=${task.id}`)
  return { task, commands }
}
