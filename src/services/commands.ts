import { db } from "../db"
import { shortId } from "../lib/ids"
import type { Command, CommandStatus } from "../types"
import { recordLog } from "./logs"
import { pushToClient } from "./realtime"
import { manageLocalUserResultSchema, manageRegistryResultSchema, openUrlResultSchema, showMessageResultSchema } from "../schemas/commands"
import { createHash } from "node:crypto"

export const MAX_COMMAND_RESULT_BYTES = 512 * 1024

type CommandRow = {
  id: string
  client_id: string
  task_id: string | null
  type: string
  payload: string
  status: string
  result: string | null
  exit_code: number | null
  created_at: number
  updated_at: number
}

export function mapCommandRow(r: CommandRow): Command {
  return {
    id: r.id,
    clientId: r.client_id,
    taskId: r.task_id,
    type: r.type,
    payload: safeParse(r.payload),
    status: r.status as CommandStatus,
    result: r.result,
    exitCode: r.exit_code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return {}
  }
}

export type NewCommand = {
  clientId: string
  taskId?: string | null
  type: string
  payload?: Record<string, unknown>
}

/**
 * 创建并下发一条指令：
 * 若客户端在线则实时推送，否则等待 HTTP 轮询；收到客户端 ACK 后才标记为 sent。
 */
export function dispatchCommand(input: NewCommand): Command {
  const now = Date.now()
  const cmd: Command = {
    id: shortId("cmd"),
    clientId: input.clientId,
    taskId: input.taskId ?? null,
    type: input.type,
    payload: input.payload ?? {},
    status: "pending",
    result: null,
    exitCode: null,
    createdAt: now,
    updatedAt: now,
  }
  db.prepare(
    `INSERT INTO commands (id, client_id, task_id, type, payload, status, result, exit_code, created_at, updated_at)
     VALUES (@id, @clientId, @taskId, @type, @payload, @status, @result, @exitCode, @createdAt, @updatedAt)`,
  ).run({ ...cmd, payload: JSON.stringify(cmd.payload) })

  // 套接字写入成功不代表客户端已经持久化；收到 ACK 后才标记 sent。
  pushToClient(input.clientId, { kind: "command", command: cmd })
  const action = input.type === "manage-local-user" && typeof input.payload?.action === "string"
    ? `;action=${input.payload.action}`
    : ""
  const registryAction = input.type === "manage-registry" && typeof input.payload?.action === "string" && typeof input.payload?.subKey === "string"
    ? `;action=${input.payload.action};hive=${input.payload.hive};view=${input.payload.view};pathHash=${createHash("sha256").update(input.payload.subKey).digest("hex").slice(0, 12)}`
    : ""
  const messageSummary = input.type === "show-message" && typeof input.payload?.severity === "string" ? `;severity=${input.payload.severity}` : ""
  const openUrlSummary = input.type === "open-url" && typeof input.payload?.url === "string"
    ? (() => {
        try {
          const url = new URL(input.payload.url as string)
          return `;scheme=${url.protocol.slice(0, -1).toLowerCase()};host=${url.hostname.toLowerCase().replace(/\.+$/, "")}`
        } catch { return ";scheme=invalid;host=invalid" }
      })()
    : ""
  recordLog("info", "command", `向客户端 ${input.clientId} 下发指令 ${input.type}`, `commandId=${cmd.id}${action}${registryAction}${messageSummary}${openUrlSummary}`)
  return cmd
}

/** 客户端拉取待执行指令；收到 ACK 前保持 pending，允许断线重投。 */
export function pullPending(clientId: string): Command[] {
  const rows = db
    .prepare("SELECT * FROM commands WHERE client_id = ? AND status = 'pending' ORDER BY created_at ASC")
    .all(clientId) as CommandRow[]
  return rows.map(mapCommandRow)
}

/** 客户端持久化指令后确认接收（pending -> sent），重复确认保持幂等。 */
export function acknowledge(id: string, clientId: string): boolean {
  const row = db.prepare("SELECT client_id, status FROM commands WHERE id = ?").get(id) as
    | { client_id: string; status: CommandStatus }
    | undefined
  if (!row || row.client_id !== clientId) return false
  if (row.status === "pending") updateStatus(id, "sent")
  return true
}

/** 更新指令状态 */
export function updateStatus(id: string, status: CommandStatus, result?: string, exitCode?: number) {
  db.prepare("UPDATE commands SET status = ?, result = ?, exit_code = ?, updated_at = ? WHERE id = ?").run(
    status,
    result ?? null,
    exitCode ?? null,
    Date.now(),
    id,
  )
}

/** 客户端上报执行结果 */
export function reportResult(id: string, clientId: string, status: CommandStatus, result?: string, exitCode?: number): boolean {
  if (result !== undefined && typeof result !== "string") return false
  if (result !== undefined && Buffer.byteLength(result, "utf8") > MAX_COMMAND_RESULT_BYTES) return false
  const row = db.prepare("SELECT client_id, type, payload FROM commands WHERE id = ?").get(id) as { client_id: string; type: string; payload: string } | undefined
  if (!row || row.client_id !== clientId) return false
  let localUserSummary: string | null = null
  let registrySummary: string | null = null
  let messageResultSummary: string | null = null
  let openUrlResultSummary: string | null = null
  if (row.type === "manage-local-user" && status !== "running" && result === undefined) return false
  if (row.type === "manage-local-user" && result !== undefined) {
    try {
      const parsed = manageLocalUserResultSchema.safeParse(JSON.parse(result))
      if (!parsed.success) return false
      const expectedAction = safeParse(row.payload).action
      if (parsed.data.action !== expectedAction) return false
      if (status === "success" && parsed.data.error !== null) return false
      if (status === "failed" && parsed.data.error === null) return false
      localUserSummary = `action=${parsed.data.action};changed=${parsed.data.changed};exitCode=${exitCode ?? "none"};resultBytes=${Buffer.byteLength(result, "utf8")}`
    } catch {
      return false
    }
  }
  if (row.type === "manage-registry" && status !== "running" && result === undefined) return false
  if (row.type === "manage-registry" && result !== undefined) {
    try {
      const parsed = manageRegistryResultSchema.safeParse(JSON.parse(result))
      if (!parsed.success) return false
      const expectedAction = safeParse(row.payload).action
      if (parsed.data.action !== expectedAction) return false
      if (status === "success" && parsed.data.error !== null) return false
      if (status === "failed" && parsed.data.error === null) return false
      registrySummary = `action=${parsed.data.action};changed=${parsed.data.changed};hive=${parsed.data.hive};view=${parsed.data.view};pathHash=${createHash("sha256").update(parsed.data.subKey).digest("hex").slice(0, 12)};resultBytes=${Buffer.byteLength(result, "utf8")}`
    } catch {
      return false
    }
  }
  if (row.type === "show-message" && status !== "running" && result === undefined) return false
  if (row.type === "show-message" && result !== undefined) {
    try {
      const parsed = showMessageResultSchema.safeParse(JSON.parse(result))
      if (!parsed.success) return false
      const successDelivery = ["confirmed", "canceled", "timed-out"].includes(parsed.data.deliveryStatus)
      if (status === "success" && (!successDelivery || parsed.data.error !== null)) return false
      if (status === "failed" && (successDelivery || parsed.data.error === null)) return false
      if (parsed.data.timedOut !== (parsed.data.deliveryStatus === "timed-out")) return false
      messageResultSummary = `deliveryStatus=${parsed.data.deliveryStatus};sessionId=${parsed.data.sessionId ?? "none"};responseCode=${parsed.data.responseCode ?? "none"};timedOut=${parsed.data.timedOut};resultBytes=${Buffer.byteLength(result, "utf8")}`
    } catch { return false }
  }
  if (row.type === "open-url" && status !== "running" && result === undefined) return false
  if (row.type === "open-url" && result !== undefined) {
    try {
      const parsed = openUrlResultSchema.safeParse(JSON.parse(result))
      if (!parsed.success) return false
      const successful = parsed.data.processStarted && parsed.data.pid !== null && !parsed.data.expired && parsed.data.error === null
      const failed = !parsed.data.processStarted && parsed.data.pid === null && parsed.data.error !== null
      if (status === "success" && !successful) return false
      if (status === "failed" && !failed) return false
      if (parsed.data.expired !== (parsed.data.error?.code === "EXPIRED")) return false
      openUrlResultSummary = `processStarted=${parsed.data.processStarted};sessionId=${parsed.data.sessionId ?? "none"};pid=${parsed.data.pid ?? "none"};expired=${parsed.data.expired};resultBytes=${Buffer.byteLength(result, "utf8")}`
    } catch { return false }
  }
  updateStatus(id, status, result, exitCode)
  const level = status === "failed" ? "error" : "info"
  const summarizedResults = new Set(["collect-logs", "run-shell", "install-package", "deploy-file", "rollback-file-deploy", "manage-local-user", "manage-registry", "show-message", "open-url"])
  const detail = localUserSummary ?? registrySummary ?? messageResultSummary ?? openUrlResultSummary ?? (summarizedResults.has(row.type) && result !== undefined
    ? `resultBytes=${Buffer.byteLength(result, "utf8")};exitCode=${exitCode ?? "none"}`
    : result)
  recordLog(level, "command", `客户端 ${clientId} 上报指令 ${id} 执行结果：${status}`, detail)
  return true
}

export function getCommand(id: string): Command | null {
  const row = db.prepare("SELECT * FROM commands WHERE id = ?").get(id) as CommandRow | undefined
  return row ? mapCommandRow(row) : null
}

export function listCommands(clientId?: string, limit = 100): Command[] {
  const rows = clientId
    ? (db.prepare("SELECT * FROM commands WHERE client_id = ? ORDER BY created_at DESC LIMIT ?").all(clientId, limit) as CommandRow[])
    : (db.prepare("SELECT * FROM commands ORDER BY created_at DESC LIMIT ?").all(limit) as CommandRow[])
  return rows.map(mapCommandRow)
}
