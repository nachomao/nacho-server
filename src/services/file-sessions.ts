import crypto from "node:crypto"
import type { WebSocket } from "ws"
import { db } from "../db"
import { HttpError } from "../lib/http"
import { shortId } from "../lib/ids"
import { logger } from "../lib/logger"
import {
  FILE_LIMITS,
  fileAgentMessageSchema,
  filePanelMessageSchema,
  type FileAgentMessage,
  type FilePanelMessage,
} from "../schemas/webssh"
import type { Client } from "../types"
import { recordLog } from "./logs"
import { isClientConnected, pushToClient } from "./realtime"

/**
 * WebSSH 文件会话：
 * 与终端共用“面板 ticket + Agent ticket”的 WebSocket 附加模型。
 * 面板与 Agent 之间是带请求 id 的 RPC：目录浏览、删除为一次性请求，
 * 上传/下载以 256 KiB 分块传输并按块校验 SHA-256，断线后可按已确认偏移续传。
 * 服务端只做校验、限额、计数与转发，不落盘文件内容。
 */

const WS_OPEN = 1
const SWEEP_INTERVAL_MS = 10_000

type FileSession = {
  id: string
  clientId: string
  clientName: string
  status: "starting" | "active" | "closed" | "failed"
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  panel: WebSocket | null
  agent: WebSocket | null
  panelAttachedOnce: boolean
  uploadBytes: number
  downloadBytes: number
  lastActivityAt: number
  closeReason: string | null
  error: string | null
  attachTimer: NodeJS.Timeout | null
  graceTimer: NodeJS.Timeout | null
  sweepTimer: NodeJS.Timeout | null
}

type Ticket = { sessionId: string; expiresAt: number }

const sessions = new Map<string, FileSession>()
const panelTickets = new Map<string, Ticket>()
const agentTickets = new Map<string, Ticket>()

function makeTicket(): string {
  return crypto.randomBytes(24).toString("base64url")
}

function scopedTickets(map: Map<string, Ticket>, sessionId: string, expiresAt: number): string {
  for (const [ticket, value] of map) if (value.sessionId === sessionId) map.delete(ticket)
  const ticket = makeTicket()
  map.set(ticket, { sessionId, expiresAt })
  return ticket
}

function consumeTicket(map: Map<string, Ticket>, ticket: string, sessionId?: string): Ticket | null {
  const value = map.get(ticket)
  if (!value) return null
  if (Date.now() > value.expiresAt) {
    map.delete(ticket)
    return null
  }
  if (sessionId && value.sessionId !== sessionId) return null
  map.delete(ticket)
  return value
}

function isOpen(ws: WebSocket | null): ws is WebSocket {
  return !!ws && ws.readyState === WS_OPEN
}

function send(ws: WebSocket | null, message: unknown): boolean {
  if (!isOpen(ws)) return false
  try {
    ws.send(JSON.stringify(message))
    return true
  } catch (error) {
    logger.warn("WebSSH 文件消息发送失败：", error)
    return false
  }
}

function closeSocket(ws: WebSocket | null, code: number, reason: string) {
  if (!isOpen(ws)) return
  try { ws.close(code, reason) } catch { /* 已关闭 */ }
}

function activeSessions(): FileSession[] {
  return [...sessions.values()].filter((session) => session.status === "starting" || session.status === "active")
}

function insertSession(session: FileSession) {
  db.prepare(
    `INSERT INTO file_sessions (id, client_id, status, created_at) VALUES (?, ?, ?, ?)`,
  ).run(session.id, session.clientId, session.status, session.createdAt)
}

function updateSessionRow(session: FileSession) {
  db.prepare(
    `UPDATE file_sessions
     SET status = ?, upload_bytes = ?, download_bytes = ?, close_reason = ?, error = ?, started_at = ?, ended_at = ?
     WHERE id = ?`,
  ).run(
    session.status,
    session.uploadBytes,
    session.downloadBytes,
    session.closeReason,
    session.error,
    session.startedAt,
    session.endedAt,
    session.id,
  )
}

function audit(session: FileSession, message: string, level: "info" | "warn" = "info") {
  recordLog(
    level,
    "terminal",
    message,
    `session=${session.id};client=${session.clientId};uploadBytes=${session.uploadBytes};downloadBytes=${session.downloadBytes};` +
      `durationMs=${Math.max(0, (session.endedAt ?? Date.now()) - (session.startedAt ?? session.createdAt))}`,
  )
}

export type CreatedFileSession = {
  session: { id: string; clientId: string; status: string; createdAt: number }
  ticket: string
  wsPath: string
}

export function createFileSession(client: Client): CreatedFileSession {
  if (client.os !== "Windows") throw new HttpError(400, "WebSSH 文件传输目前仅支持 Windows 客户端")
  if (!isClientConnected(client.id)) throw new HttpError(409, "客户端未建立实时连接，无法打开文件会话")
  const existing = activeSessions().find((session) => session.clientId === client.id)
  if (existing) {
    // 面板尚未接入的会话属于孤儿（页面卸载/开发模式重复挂载）；直接回收后重建。
    if (existing.panel !== null) throw new HttpError(409, "该客户端已存在活动文件会话，请先关闭原会话")
    endSession(existing, "closed", "replaced")
  }
  if (activeSessions().length >= FILE_LIMITS.maxSessions) {
    throw new HttpError(429, `同时进行的文件会话已达上限（${FILE_LIMITS.maxSessions}）`)
  }

  const now = Date.now()
  const session: FileSession = {
    id: shortId("file"),
    clientId: client.id,
    clientName: client.name,
    status: "starting",
    createdAt: now,
    startedAt: null,
    endedAt: null,
    panel: null,
    agent: null,
    panelAttachedOnce: false,
    uploadBytes: 0,
    downloadBytes: 0,
    lastActivityAt: now,
    closeReason: null,
    error: null,
    attachTimer: null,
    graceTimer: null,
    sweepTimer: null,
  }
  insertSession(session)
  sessions.set(session.id, session)

  const agentTicket = scopedTickets(agentTickets, session.id, now + FILE_LIMITS.ticketTtlMs)
  const delivered = pushToClient(client.id, { kind: "file-open", sessionId: session.id, ticket: agentTicket })
  if (!delivered) {
    sessions.delete(session.id)
    agentTickets.delete(agentTicket)
    session.status = "failed"
    session.endedAt = now
    session.closeReason = "agent-unreachable"
    session.error = "Agent 实时通道不可用"
    updateSessionRow(session)
    throw new HttpError(409, "Agent 实时通道不可用，无法打开文件会话")
  }

  session.attachTimer = setTimeout(() => {
    if (!isOpen(session.panel)) {
      endSession(session, "failed", "panel-attach-timeout", "面板未在规定时间内接入文件通道")
    } else if (!isOpen(session.agent)) {
      endSession(session, "failed", "agent-attach-timeout", "Agent 未在规定时间内接入文件通道")
    }
  }, FILE_LIMITS.attachTimeoutMs)
  session.attachTimer.unref()

  audit(session, `WebSSH 文件会话已创建（等待 Agent 接入）：${client.name}`)
  const panelTicket = scopedTickets(panelTickets, session.id, now + FILE_LIMITS.ticketTtlMs)
  return {
    session: { id: session.id, clientId: session.clientId, status: session.status, createdAt: session.createdAt },
    ticket: panelTicket,
    wsPath: `/api/panel/files/ws?ticket=${encodeURIComponent(panelTicket)}`,
  }
}

export function reconnectFileSession(sessionId: string): CreatedFileSession {
  const session = sessions.get(sessionId)
  if (!session || (session.status !== "starting" && session.status !== "active")) {
    throw new HttpError(410, "文件会话已结束，请重新建立会话")
  }
  if (!isOpen(session.agent)) throw new HttpError(409, "Agent 通道已断开，无法恢复文件会话")
  const ticket = scopedTickets(panelTickets, session.id, Date.now() + FILE_LIMITS.ticketTtlMs)
  return {
    session: { id: session.id, clientId: session.clientId, status: session.status, createdAt: session.createdAt },
    ticket,
    wsPath: `/api/panel/files/ws?ticket=${encodeURIComponent(ticket)}`,
  }
}

export function verifyFilePanelTicket(ticket: string): string | null {
  const value = panelTickets.get(ticket)
  if (!value || Date.now() > value.expiresAt) return null
  const session = sessions.get(value.sessionId)
  return session && (session.status === "starting" || session.status === "active") ? session.id : null
}

export function verifyFileAgentTicket(sessionId: string, ticket: string, clientId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session || session.clientId !== clientId) return false
  if (session.status !== "starting" && session.status !== "active") return false
  const value = agentTickets.get(ticket)
  return !!value && value.sessionId === sessionId && Date.now() <= value.expiresAt
}

export function attachFilePanel(ws: WebSocket, ticket: string): boolean {
  const value = consumeTicket(panelTickets, ticket)
  if (!value) return false
  const session = sessions.get(value.sessionId)
  if (!session || (session.status !== "starting" && session.status !== "active")) return false
  if (session.graceTimer) {
    clearTimeout(session.graceTimer)
    session.graceTimer = null
  }
  if (isOpen(session.panel) && session.panel !== ws) closeSocket(session.panel, 4001, "replaced by reconnect")
  const reconnected = session.panelAttachedOnce
  session.panelAttachedOnce = true
  session.panel = ws
  session.startedAt ??= Date.now()
  session.lastActivityAt = Date.now()
  session.status = "active"
  updateSessionRow(session)
  send(ws, {
    kind: "ready",
    sessionId: session.id,
    clientId: session.clientId,
    reconnected,
    agentAttached: isOpen(session.agent),
  })
  ensureSweeper(session)
  return true
}

export function attachFileAgent(ws: WebSocket, sessionId: string, ticket: string, clientId: string): boolean {
  const value = consumeTicket(agentTickets, ticket, sessionId)
  if (!value) return false
  const session = sessions.get(sessionId)
  if (!session || session.clientId !== clientId) return false
  if (session.status !== "starting" && session.status !== "active") return false
  if (session.attachTimer) {
    clearTimeout(session.attachTimer)
    session.attachTimer = null
  }
  if (isOpen(session.agent) && session.agent !== ws) closeSocket(session.agent, 4001, "replaced by new agent connection")
  session.agent = ws
  session.startedAt ??= Date.now()
  session.lastActivityAt = Date.now()
  session.status = "active"
  updateSessionRow(session)
  if (isOpen(session.panel)) send(session.panel, { kind: "agent-connected" })
  return true
}

function ensureSweeper(session: FileSession) {
  if (session.sweepTimer) return
  session.sweepTimer = setInterval(() => {
    if (session.status !== "active") return
    const now = Date.now()
    if (now - session.lastActivityAt > FILE_LIMITS.idleTimeoutMs) {
      endSession(session, "closed", "idle-timeout")
      return
    }
    if (session.startedAt && now - session.startedAt > FILE_LIMITS.maxDurationMs) {
      endSession(session, "closed", "max-duration")
    }
  }, SWEEP_INTERVAL_MS)
  session.sweepTimer.unref()
}

export function handleFilePanelMessage(sessionId: string, ws: WebSocket, raw: string) {
  const session = sessions.get(sessionId)
  if (!session || session.panel !== ws) return
  if (Buffer.byteLength(raw, "utf8") > FILE_LIMITS.maxPanelMessageBytes) {
    endSession(session, "failed", "message-too-large", "面板消息超过文件通道上限")
    return
  }
  let message: FilePanelMessage
  try {
    message = filePanelMessageSchema.parse(JSON.parse(raw))
  } catch {
    send(ws, { kind: "error", code: "INVALID_MESSAGE", message: "文件会话消息格式无效" })
    return
  }
  if (message.kind === "uploadChunk") {
    session.uploadBytes += Buffer.from(message.data, "base64").length
  }
  session.lastActivityAt = Date.now()
  if (!isOpen(session.agent)) {
    send(ws, { kind: "error", id: message.id, code: "AGENT_UNAVAILABLE", message: "Agent 通道尚未接入" })
    return
  }
  send(session.agent, message)
}

export function handleFileAgentMessage(sessionId: string, ws: WebSocket, raw: string) {
  const session = sessions.get(sessionId)
  if (!session || session.agent !== ws) return
  if (Buffer.byteLength(raw, "utf8") > FILE_LIMITS.maxAgentMessageBytes) {
    endSession(session, "failed", "message-too-large", "Agent 消息超过文件通道上限")
    return
  }
  let message: FileAgentMessage
  try {
    message = fileAgentMessageSchema.parse(JSON.parse(raw))
  } catch {
    send(session.panel, { kind: "error", code: "INVALID_AGENT_MESSAGE", message: "Agent 返回了无法识别的文件消息" })
    return
  }
  session.lastActivityAt = Date.now()
  if (message.kind === "downloadChunk") {
    session.downloadBytes += Buffer.from(message.data, "base64").length
  }
  if (message.kind === "uploadComplete" || message.kind === "downloadComplete") {
    const bytes = message.size
    recordLog(
      "info",
      "terminal",
      `WebSSH 文件传输完成：${message.kind === "uploadComplete" ? "上传" : "下载"}`,
      `session=${session.id};client=${session.clientId};transfer=${message.transferId};bytes=${bytes}` +
        (message.kind === "uploadComplete" ? `;sha256=${message.sha256.slice(0, 16)}` : ""),
    )
  }
  send(session.panel, message)
}

export function detachFilePanel(sessionId: string, ws: WebSocket) {
  const session = sessions.get(sessionId)
  if (!session || session.panel !== ws) return
  session.panel = null
  if (session.status === "closed" || session.status === "failed") return
  if (!isOpen(session.agent)) {
    endSession(session, "closed", "panel-disconnected")
    return
  }
  if (session.graceTimer) clearTimeout(session.graceTimer)
  session.graceTimer = setTimeout(() => {
    if (!isOpen(session.panel)) endSession(session, "closed", "panel-disconnected")
  }, FILE_LIMITS.reconnectGraceMs)
  session.graceTimer.unref()
}

export function detachFileAgent(sessionId: string, ws: WebSocket) {
  const session = sessions.get(sessionId)
  if (!session || session.agent !== ws) return
  session.agent = null
  if (session.status === "closed" || session.status === "failed") return
  endSession(session, "closed", "agent-disconnected")
}

export function closeFileSession(sessionId: string, reason = "panel-closed"): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  if (session.status === "closed" || session.status === "failed") return true
  endSession(session, "closed", reason)
  return true
}

function endSession(session: FileSession, status: "closed" | "failed", reason: string, error: string | null = null) {
  if (session.status === "closed" || session.status === "failed") return
  session.status = status
  session.endedAt = Date.now()
  session.closeReason = reason
  session.error = error
  sessions.delete(session.id)
  if (session.attachTimer) clearTimeout(session.attachTimer)
  if (session.graceTimer) clearTimeout(session.graceTimer)
  if (session.sweepTimer) clearInterval(session.sweepTimer)
  panelTickets.forEach((value, ticket) => {
    if (value.sessionId === session.id) panelTickets.delete(ticket)
  })
  agentTickets.forEach((value, ticket) => {
    if (value.sessionId === session.id) agentTickets.delete(ticket)
  })
  updateSessionRow(session)
  send(session.panel, { kind: "closed", reason, error })
  if (reason !== "agent-disconnected") send(session.agent, { kind: "close", reason })
  closeSocket(session.panel, 1000, "session-closed")
  closeSocket(session.agent, 1000, "session-closed")
  session.panel = null
  session.agent = null
  audit(session, `WebSSH 文件会话结束：${reason}`, status === "failed" ? "warn" : "info")
}

export type FileSessionView = {
  id: string
  clientId: string
  status: string
  uploadBytes: number
  downloadBytes: number
  closeReason: string | null
  error: string | null
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  live: boolean
}

export function listFileSessions(limit = 50): FileSessionView[] {
  const rows = db
    .prepare(
      `SELECT id, client_id, status, upload_bytes, download_bytes, close_reason, error,
              created_at, started_at, ended_at
       FROM file_sessions ORDER BY created_at DESC LIMIT ?`,
    )
    .all(Math.min(200, Math.max(1, Math.floor(limit)))) as Array<{
    id: string
    client_id: string
    status: string
    upload_bytes: number
    download_bytes: number
    close_reason: string | null
    error: string | null
    created_at: number
    started_at: number | null
    ended_at: number | null
  }>
  return rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    status: row.status,
    uploadBytes: row.upload_bytes,
    downloadBytes: row.download_bytes,
    closeReason: row.close_reason,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    live: sessions.has(row.id),
  }))
}

export function markStaleFileSessions(now = Date.now()) {
  db.prepare(
    `UPDATE file_sessions
     SET status = 'failed', close_reason = 'server-restarted', ended_at = ?
     WHERE status IN ('starting', 'active')`,
  ).run(now)
}

export function shutdownFileSessions() {
  for (const session of [...sessions.values()]) endSession(session, "closed", "server-shutdown")
}
