import { db } from "../db"
import { shortId } from "../lib/ids"
import { isRecurringTrigger, nextTaskRunAt } from "../lib/schedule"
import type { Command, ScheduledTask } from "../types"
import { recordLog } from "./logs"
import { getGeneralSettings } from "./settings"
import { cancelRunPendingCommands, dispatchTaskForRun, getTask, markTaskRun } from "./tasks"

/** 调度器扫描间隔；单个 tick 内同步处理到期任务与重试队列。 */
export const TASK_SCHEDULER_TICK_MS = 15_000
/** 进程在运行中崩溃后，超过该时长仍未收尾的运行会被重新排队。 */
export const TASK_RUN_STALE_MS = 2 * 60_000
/** 已结束运行记录保留时长（自动清理开启时生效）。 */
export const TASK_RUN_RETENTION_MS = 30 * 86_400_000
const CLEANUP_INTERVAL_MS = 60 * 60_000
const MAX_RUNS_PER_TICK = 50

type TaskRunState = "pending" | "running" | "retrying" | "success" | "failed" | "skipped"

type TaskRunRow = {
  id: string
  task_id: string
  scheduled_for: number
  status: TaskRunState
  attempts: number
  next_attempt_at: number | null
  target_ids: string
  command_ids: string
  error: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
}

type RunDispatcher = (task: ScheduledTask, targetIds: string[], runId: string) => Command[]

function parseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, " ").trim().slice(0, 512) || "未知错误"
}

export function retryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  return Math.min(5 * 60_000, 30_000 * 2 ** (safeAttempt - 1))
}

/** 自动下发最多尝试次数 = 首次 + 系统设置中的重试次数（默认 2 次重试，共 3 次）。 */
function maxDispatchAttempts(): number {
  const retryCount = Math.min(10, Math.max(0, Math.floor(getGeneralSettings().retryCount)))
  return retryCount + 1
}

/**
 * 清理已正常结束的历史运行记录（成功/跳过），失败记录保留用于审计。
 * 仅在「自动清理已完成任务」开启时生效。
 */
export function cleanupFinishedTaskRuns(now = Date.now()): number {
  if (!getGeneralSettings().autoCleanTasks) return 0
  const info = db.prepare(
    "DELETE FROM task_runs WHERE status IN ('success', 'skipped') AND finished_at IS NOT NULL AND finished_at < ?",
  ).run(now - TASK_RUN_RETENTION_MS)
  return Number(info.changes)
}

function finishRun(
  runId: string,
  status: Exclude<TaskRunState, "pending" | "running" | "retrying">,
  now: number,
  commandIds: string[],
  error: string | null,
): void {
  db.prepare(
    "UPDATE task_runs SET status = ?, command_ids = ?, error = ?, updated_at = ?, finished_at = ? WHERE id = ?",
  ).run(status, JSON.stringify(commandIds), error, now, now, runId)
}

/**
 * 服务重启恢复：运行中的记录可能停在“已创建部分命令但未收尾”的状态。
 * 重新排队后按 runId 复用已创建命令，因此不会重复投递。
 */
export function recoverTaskRuns(now = Date.now(), force = false): number {
  const info = force
    ? db.prepare(
        "UPDATE task_runs SET status = 'retrying', next_attempt_at = ?, error = COALESCE(error, '服务重启后恢复'), updated_at = ? WHERE status = 'running'",
      ).run(now, now)
    : db.prepare(
        "UPDATE task_runs SET status = 'retrying', next_attempt_at = ?, error = COALESCE(error, '调度进程超时恢复'), updated_at = ? WHERE status = 'running' AND updated_at < ?",
      ).run(now, now, now - TASK_RUN_STALE_MS)
  if (info.changes > 0) {
    recordLog("warn", "task", `已恢复 ${info.changes} 条未完成的计划任务运行记录`, `status=retrying`)
  }
  return Number(info.changes)
}

/** 升级旧数据库或修复异常数据：为启用中的周期任务补齐首次排期。 */
function initializeMissingSchedules(now: number): number {
  const rows = db.prepare(
    `SELECT id FROM tasks
     WHERE enabled = 1 AND next_run_at IS NULL AND trigger_id IN ('daily', 'weekly', 'cron')`,
  ).all() as Array<{ id: string }>
  let initialized = 0
  for (const row of rows) {
    const task = getTask(row.id)
    if (!task) continue
    const nextRunAt = nextTaskRunAt(task, now)
    if (nextRunAt === null) {
      db.prepare("UPDATE tasks SET last_status = 'failed', last_error = ? WHERE id = ?")
        .run("无法计算下次执行时间，请检查 Cron、时间与时区", task.id)
      recordLog("warn", "task", `计划任务 ${task.name} 的排期无效`, `taskId=${task.id};trigger=${task.triggerId}`)
      continue
    }
    db.prepare("UPDATE tasks SET next_run_at = ?, last_error = NULL WHERE id = ?").run(nextRunAt, task.id)
    initialized += 1
  }
  return initialized
}

function enqueueDueTasks(now: number): number {
  const due = db.prepare(
    "SELECT * FROM tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?",
  ).all(now, MAX_RUNS_PER_TICK) as Array<{ id: string; next_run_at: number }>
  let enqueued = 0
  for (const row of due) {
    const task = getTask(row.id)
    if (!task || !task.enabled || task.nextRunAt === null || !isRecurringTrigger(task.triggerId)) continue
    const scheduledFor = task.nextRunAt
    const nextRunAt = nextTaskRunAt(task, now, scheduledFor)
    const runId = shortId("run")
    let inserted = false
    db.exec("BEGIN IMMEDIATE")
    try {
      const info = db.prepare(
        `INSERT OR IGNORE INTO task_runs (
           id, task_id, scheduled_for, status, attempts, next_attempt_at,
           target_ids, command_ids, error, created_at, updated_at, finished_at
         ) VALUES (?, ?, ?, 'pending', 0, ?, ?, '[]', NULL, ?, ?, NULL)`,
      ).run(runId, task.id, scheduledFor, now, JSON.stringify(task.clientIds), now, now)
      inserted = Number(info.changes) > 0
      // 无论本次是否由当前实例抢到，都把已到期的排期推进到未来，避免卡死。
      db.prepare("UPDATE tasks SET next_run_at = ? WHERE id = ? AND next_run_at = ?")
        .run(nextRunAt, task.id, scheduledFor)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
    if (inserted) {
      enqueued += 1
      if (nextRunAt === null) {
        recordLog(
          "warn",
          "task",
          `计划任务 ${task.name} 本次运行后无法计算下次执行时间`,
          `taskId=${task.id};timezone=${task.timezone};trigger=${task.triggerId}`,
        )
      }
    }
  }
  return enqueued
}

function processPendingRuns(now: number, dispatcher: RunDispatcher): number {
  const runs = db.prepare(
    `SELECT * FROM task_runs
     WHERE status IN ('pending', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY scheduled_for ASC LIMIT ?`,
  ).all(now, MAX_RUNS_PER_TICK) as TaskRunRow[]
  let processed = 0
  for (const run of runs) {
    const claimed = db.prepare(
      `UPDATE task_runs SET status = 'running', attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status = ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
    ).run(now, run.id, run.status, now)
    if (Number(claimed.changes) !== 1) continue
    const attempts = run.attempts + 1
    const task = getTask(run.task_id)
    if (!task) {
      cancelRunPendingCommands(run.id, now)
      finishRun(run.id, "failed", now, parseArray(run.command_ids), "任务已删除")
      continue
    }
    if (!task.enabled || !isRecurringTrigger(task.triggerId)) {
      cancelRunPendingCommands(run.id, now)
      finishRun(run.id, "skipped", now, parseArray(run.command_ids), "任务已停用或触发器已变更")
      continue
    }

    const targetIds = parseArray(run.target_ids)
    const maxAttempts = maxDispatchAttempts()
    try {
      const commands = dispatcher(task, targetIds, run.id)
      if (commands.length === 0) {
        const error = "没有可用的目标客户端"
        finishRun(run.id, "failed", now, [], error)
        markTaskRun(task.id, now, "failed", error)
        recordLog("warn", "task", `计划任务 ${task.name} 没有可下发的目标客户端`, `taskId=${task.id};runId=${run.id}`)
        continue
      }
      finishRun(run.id, "success", now, commands.map((command) => command.id), null)
      markTaskRun(task.id, now, "success", null)
      processed += 1
      recordLog(
        "info",
        "task",
        `计划任务 ${task.name} 已自动下发`,
        `taskId=${task.id};runId=${run.id};scheduledFor=${run.scheduled_for};targets=${commands.length}`,
      )
    } catch (error) {
      const message = describeError(error)
      if (attempts < maxAttempts) {
        const delay = retryDelayMs(attempts)
        db.prepare(
          "UPDATE task_runs SET status = 'retrying', next_attempt_at = ?, error = ?, updated_at = ? WHERE id = ?",
        ).run(now + delay, message, now, run.id)
        markTaskRun(task.id, now, "retrying", message)
        recordLog(
          "warn",
          "task",
          `计划任务 ${task.name} 自动下发失败，稍后重试`,
          `taskId=${task.id};runId=${run.id};attempt=${attempts};retryInMs=${delay}`,
        )
      } else {
        finishRun(run.id, "failed", now, parseArray(run.command_ids), message)
        markTaskRun(task.id, now, "failed", message)
        recordLog(
          "error",
          "task",
          `计划任务 ${task.name} 自动下发失败，已停止重试`,
          `taskId=${task.id};runId=${run.id};attempt=${attempts}`,
        )
      }
    }
  }
  return processed
}

/**
 * 执行一次调度扫描：恢复超时运行、把到期任务加入运行队列、处理待执行/待重试运行。
 * 通过 unique(task_id, scheduled_for) 与 runId 命令唯一约束防止重复投递。
 */
let lastCleanupAt = 0

export function runTaskSchedulerTick(now = Date.now(), dispatcher: RunDispatcher = dispatchTaskForRun): void {
  initializeMissingSchedules(now)
  recoverTaskRuns(now)
  enqueueDueTasks(now)
  processPendingRuns(now, dispatcher)
  if (now - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
    lastCleanupAt = now
    const removed = cleanupFinishedTaskRuns(now)
    if (removed > 0) recordLog("info", "task", `已清理 ${removed} 条历史任务运行记录`)
  }
}

let schedulerTimer: NodeJS.Timeout | null = null

export function startTaskScheduler(): void {
  if (schedulerTimer) return
  recoverTaskRuns(Date.now(), true)
  const tick = () => {
    try {
      runTaskSchedulerTick()
    } catch (error) {
      recordLog("error", "task", "计划任务调度扫描失败", describeError(error))
    }
  }
  // 启动后稍等再扫描，避免与服务监听和制品同步争抢启动窗口。
  setTimeout(tick, 1_000).unref()
  schedulerTimer = setInterval(tick, TASK_SCHEDULER_TICK_MS)
  schedulerTimer.unref()
}

export function stopTaskScheduler(): void {
  if (!schedulerTimer) return
  clearInterval(schedulerTimer)
  schedulerTimer = null
}
