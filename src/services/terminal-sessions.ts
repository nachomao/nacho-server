import crypto from "node:crypto"
import type { WebSocket } from "ws"
import { db } from "../db"
import { HttpError } from "../lib/http"
import { shortId } from "../lib/ids"
import { logger } from "../lib/logger"
import {
  TERMINAL_LIMITS,
  terminalAgentMessageSchema,
  terminalPanelMessageSchema,
  type TerminalAgentMessage,
  type TerminalPanelMessage,
  type TerminalShell,
} from "../schemas/webssh"
import type { Client } from "../types"
import { recordLog } from "./logs"
import { isClientConnected, pushToClient } from "./realtime"

/**
 * WebSSH 终端会话：
 * 面板先用 Panel API 创建会话并取得一次性 ticket，再打开
 * /api/panel/terminal/ws；服务端通过主 Agent WS 下发 terminal-open，
 * Agent 以设备令牌接入 /agent/terminal，服务端在两条 WebSocket 之间双向转发。
 * 会话状态持久化到 terminal_sessions，用于审计与重连。
 */

const WS_OPEN = 1
const SWEEP_INTERVAL_MS = 10_000

type RingFrame = { seq: number; data: string }

type TerminalSession = {
  id: string
  clientId: string
  clientName: string
  shell: TerminalShell
  cols: number
  rows: number
  status: "starting" | "active" | "closed" | "failed"
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  panel: WebSocket | null
  agent: WebSocket | null
  panelAttachedOnce: boolean
  agentReady: { shell: TerminalShell; pid: number | null; cwd: string | null } | null
  seq: number
  ring: RingFrame[]
  ringBytes: number
  inputBytes: number
  outputBytes: number
  lastInputAt: number
  exitCode: number | null
  closeReason: string | null
  error: string | null
  attachTimer: NodeJS.Timeout | null
  graceTimer: NodeJS.Timeout | null
  sweepTimer: NodeJS.Timeout | null
}

type Ticket = { sessionId: string; expiresAt: number }

const sessions = new Map<string, TerminalSession>()
const panelTickets = new Map<string, Ticket>()
const agentTickets = new Map<string, Ticket>()

function makeTicket(): string {
  return crypto.randomBytes(24).toString("base64url")
}

function scopedTickets(map: Map<string, Ticket>, sessionId: string, expiresAt: number): string {
  // 同一会话只保留最新的 ticket，避免旧票据长期滞留。
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
    logger.warn("WebSSH 终端消息发送失败：", error)
    return false
  }
}

function closeSocket(ws: WebSocket | null, code: number, reason: string) {
  if (!isOpen(ws)) return
  try { ws.close(code, reason) } catch { /* 已关闭 */ }
}

function activeSessions(): TerminalSession[] {
  return [...sessions.values()].filter((session) => session.status === "starting" || session.status === "active")
}

function perClientActive(clientId: string): number {
  return activeSessions().filter((session) => session.clientId === clientId).length
}

function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.min(TERMINAL_LIMITS.maxCols, Math.max(TERMINAL_LIMITS.minCols, Math.floor(cols))),
    rows: Math.min(TERMINAL_LIMITS.maxRows, Math.max(TERMINAL_LIMITS.minRows, Math.floor(rows))),
  }
}

function insertSession(session: TerminalSession) {
  db.prepare(
    `INSERT INTO terminal_sessions (id, client_id, shell, status, cols, rows, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(session.id, session.clientId, session.shell, session.status, session.cols, session.rows, session.createdAt)
}

function updateSessionRow(session: TerminalSession) {
  db.prepare(
    `UPDATE terminal_sessions
     SET status = ?, cols = ?, rows = ?, input_bytes = ?, output_bytes = ?, close_reason = ?, error = ?, started_at = ?, ended_at = ?
     WHERE id = ?`,
  ).run(
    session.status,
    session.cols,
    session.rows,
    session.inputBytes,
    session.outputBytes,
    session.closeReason,
    session.error,
    session.startedAt,
    session.endedAt,
    session.id,
  )
}

function audit(session: TerminalSession, message: string, level: "info" | "warn" = "info") {
  recordLog(
    level,
    "terminal",
    message,
    `session=${session.id};client=${session.clientId};shell=${session.shell};cols=${session.cols};rows=${session.rows};` +
      `inputBytes=${session.inputBytes};outputBytes=${session.outputBytes};durationMs=${Math.max(0, (session.endedAt ?? Date.now()) - (session.startedAt ?? session.createdAt))}`,
  )
}

export type CreatedTerminalSession = {
  session: {
    id: string
    clientId: string
    shell: TerminalShell
    cols: number
    rows: number
    status: string
    createdAt: number
  }
  ticket: string
  wsPath: string
}

export function createTerminalSession(client: Client, input: { shell: TerminalShell; cols: number; rows: number }): CreatedTerminalSession {
  if (client.os !== "Windows") throw new HttpError(400, "WebSSH 终端目前仅支持 Windows 客户端")
  if (!isClientConnected(client.id)) throw new HttpError(409, "客户端未建立实时连接，无法打开交互式终端")
  if (perClientActive(client.id) >= TERMINAL_LIMITS.maxSessionsPerClient) {
    throw new HttpError(409, "该客户端已存在活动终端会话，请先关闭原会话")
  }
  if (activeSessions().length >= TERMINAL_LIMITS.maxSessions) {
    throw new HttpError(429, `同时进行的终端会话已达上限（${TERMINAL_LIMITS.maxSessions}）`)
  }

  const size = clampSize(input.cols, input.rows)
  const now = Date.now()
  const session: TerminalSession = {
    id: shortId("term"),
    clientId: client.id,
    clientName: client.name,
    shell: input.shell,
    cols: size.cols,
    rows: size.rows,
    status: "starting",
    createdAt: now,
    startedAt: null,
    endedAt: null,
    panel: null,
    agent: null,
    panelAttachedOnce: false,
    agentReady: null,
    seq: 0,
    ring: [],
    ringBytes: 0,
    inputBytes: 0,
    outputBytes: 0,
    lastInputAt: now,
    exitCode: null,
    closeReason: null,
    error: null,
    attachTimer: null,
    graceTimer: null,
    sweepTimer: null,
  }
  insertSession(session)
  sessions.set(session.id, session)

  const agentTicket = scopedTickets(agentTickets, session.id, now + TERMINAL_LIMITS.ticketTtlMs)
  const delivered = pushToClient(client.id, {
    kind: "terminal-open",
    sessionId: session.id,
    ticket: agentTicket,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
  })
  if (!delivered) {
    sessions.delete(session.id)
    agentTickets.delete(agentTicket)
    session.status = "failed"
    session.endedAt = now
    session.closeReason = "agent-unreachable"
    session.error = "Agent 实时通道不可用"
    updateSessionRow(session)
    throw new HttpError(409, "Agent 实时通道不可用，无法打开终端会话")
  }

  session.attachTimer = setTimeout(() => {
    if (!isOpen(session.panel)) {
      endSession(session, "failed", "panel-attach-timeout", "面板未在规定时间内接入终端通道")
    } else if (!isOpen(session.agent)) {
      endSession(session, "failed", "agent-attach-timeout", "Agent 未在规定时间内接入终端通道")
    }
  }, TERMINAL_LIMITS.attachTimeoutMs)
  session.attachTimer.unref()

  audit(session, `WebSSH 终端会话已创建（等待 Agent 接入）：${client.name}`)
  const panelTicket = scopedTickets(panelTickets, session.id, now + TERMINAL_LIMITS.ticketTtlMs)
  return {
    session: {
      id: session.id,
      clientId: session.clientId,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      status: session.status,
      createdAt: session.createdAt,
    },
    ticket: panelTicket,
    wsPath: `/api/panel/terminal/ws?ticket=${encodeURIComponent(panelTicket)}`,
  }
}

export function reconnectTerminalSession(sessionId: string): CreatedTerminalSession {
  const session = sessions.get(sessionId)
  if (!session || (session.status !== "starting" && session.status !== "active")) {
    throw new HttpError(410, "终端会话已结束，请重新建立会话")
  }
  if (!isOpen(session.agent)) throw new HttpError(409, "Agent 通道已断开，无法恢复会话")
  const ticket = scopedTickets(panelTickets, session.id, Date.now() + TERMINAL_LIMITS.ticketTtlMs)
  return {
    session: {
      id: session.id,
      clientId: session.clientId,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      status: session.status,
      createdAt: session.createdAt,
    },
    ticket,
    wsPath: `/api/panel/terminal/ws?ticket=${encodeURIComponent(ticket)}`,
  }
}

export function verifyPanelTicket(ticket: string): string | null {
  const value = panelTickets.get(ticket)
  if (!value || Date.now() > value.expiresAt) return null
  const session = sessions.get(value.sessionId)
  return session && (session.status === "starting" || session.status === "active") ? session.id : null
}

export function verifyAgentTicket(sessionId: string, ticket: string, clientId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session || session.clientId !== clientId) return false
  if (session.status !== "starting" && session.status !== "active") return false
  const value = agentTickets.get(ticket)
  return !!value && value.sessionId === sessionId && Date.now() <= value.expiresAt
}

export function attachPanel(ws: WebSocket, ticket: string, since: number): boolean {
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
  session.lastInputAt = Date.now()
  session.status = "active"
  updateSessionRow(session)
  send(ws, {
    kind: "ready",
    sessionId: session.id,
    clientId: session.clientId,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    startedAt: session.startedAt,
    seq: session.seq,
    reconnected,
    agentAttached: isOpen(session.agent),
  })
  // 回放重连期间缓存的输出，面板按 seq 去重。
  const replay = session.ring.filter((frame) => frame.seq > since)
  for (const frame of replay) send(ws, { kind: "output", seq: frame.seq, data: frame.data })
  // Agent 可能先于面板接入；把最近一次 shell-ready 补发给面板，避免丢失 cwd/尺寸信息。
  if (session.agentReady && isOpen(session.agent)) send(ws, { kind: "agent-ready", ...session.agentReady })
  ensureSweeper(session)
  return true
}

export function attachAgent(ws: WebSocket, sessionId: string, ticket: string, clientId: string): boolean {
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
  session.lastInputAt = Date.now()
  session.status = "active"
  updateSessionRow(session)
  if (isOpen(session.panel)) send(session.panel, { kind: "agent-connected" })
  return true
}

function ensureSweeper(session: TerminalSession) {
  if (session.sweepTimer) return
  session.sweepTimer = setInterval(() => {
    const now = Date.now()
    if (session.status !== "active") return
    if (now - session.lastInputAt > TERMINAL_LIMITS.idleTimeoutMs) {
      endSession(session, "closed", "idle-timeout")
      return
    }
    if (session.startedAt && now - session.startedAt > TERMINAL_LIMITS.maxDurationMs) {
      endSession(session, "closed", "max-duration")
    }
  }, SWEEP_INTERVAL_MS)
  session.sweepTimer.unref()
}

export function handlePanelMessage(sessionId: string, ws: WebSocket, raw: string) {
  const session = sessions.get(sessionId)
  if (!session || session.panel !== ws) return
  if (Buffer.byteLength(raw, "utf8") > TERMINAL_LIMITS.maxMessageBytes) {
    endSession(session, "failed", "message-too-large", "面板消息超过终端通道上限")
    return
  }
  let message: TerminalPanelMessage
  try {
    message = terminalPanelMessageSchema.parse(JSON.parse(raw))
  } catch {
    send(ws, { kind: "error", code: "INVALID_MESSAGE", message: "终端消息格式无效" })
    return
  }
  if (message.kind === "ping") {
    send(ws, { kind: "pong", serverTime: Date.now() })
    return
  }
  if (message.kind === "input") {
    const bytes = Buffer.byteLength(message.data, "utf8")
    if (bytes > TERMINAL_LIMITS.maxInputBytes) {
      send(ws, { kind: "error", code: "INPUT_TOO_LARGE", message: "单次输入超过 8 KiB" })
      return
    }
    if (!isOpen(session.agent)) {
      send(ws, { kind: "error", code: "AGENT_UNAVAILABLE", message: "Agent 通道尚未接入" })
      return
    }
    session.inputBytes += bytes
    session.lastInputAt = Date.now()
    send(session.agent, { kind: "input", data: message.data })
    return
  }
  const size = clampSize(message.cols, message.rows)
  session.cols = size.cols
  session.rows = size.rows
  send(session.agent, { kind: "resize", cols: size.cols, rows: size.rows })
}

export function handleAgentMessage(sessionId: string, ws: WebSocket, raw: string) {
  const session = sessions.get(sessionId)
  if (!session || session.agent !== ws) return
  if (Buffer.byteLength(raw, "utf8") > TERMINAL_LIMITS.maxMessageBytes) {
    endSession(session, "failed", "message-too-large", "Agent 消息超过终端通道上限")
    return
  }
  let message: TerminalAgentMessage
  try {
    message = terminalAgentMessageSchema.parse(JSON.parse(raw))
  } catch {
    send(session.panel, { kind: "error", code: "INVALID_AGENT_MESSAGE", message: "Agent 返回了无法识别的终端消息" })
    return
  }
  switch (message.kind) {
    case "ready": {
      const size = clampSize(message.cols, message.rows)
      session.cols = size.cols
      session.rows = size.rows
      session.agentReady = { shell: message.shell, pid: message.pid, cwd: message.cwd }
      updateSessionRow(session)
      send(session.panel, { kind: "agent-ready", shell: message.shell, pid: message.pid, cwd: message.cwd })
      return
    }
    case "output": {
      const bytes = Buffer.byteLength(message.data, "utf8")
      if (session.outputBytes + bytes > TERMINAL_LIMITS.maxOutputBytes) {
        send(session.panel, { kind: "output", seq: ++session.seq, data: "\r\n[会话输出已达上限，服务端已终止会话]\r\n" })
        endSession(session, "closed", "output-limit")
        return
      }
      session.outputBytes += bytes
      session.seq += 1
      session.ring.push({ seq: session.seq, data: message.data })
      session.ringBytes += bytes
      while (session.ringBytes > TERMINAL_LIMITS.ringBytes && session.ring.length > 1) {
        const removed = session.ring.shift()
        session.ringBytes -= Buffer.byteLength(removed?.data ?? "", "utf8")
      }
      send(session.panel, { kind: "output", seq: session.seq, data: message.data })
      return
    }
    case "resize-ack": {
      send(session.panel, { kind: "resize-ack", cols: message.cols, rows: message.rows })
      return
    }
    case "error": {
      send(session.panel, { kind: "error", code: message.code, message: message.message })
      return
    }
    case "exit": {
      session.exitCode = message.code
      endSession(session, "closed", message.reason ?? "shell-exit", null, true)
      return
    }
    default:
      return
  }
}

export function detachPanel(sessionId: string, ws: WebSocket) {
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
  }, TERMINAL_LIMITS.reconnectGraceMs)
  session.graceTimer.unref()
}

export function detachAgent(sessionId: string, ws: WebSocket) {
  const session = sessions.get(sessionId)
  if (!session || session.agent !== ws) return
  session.agent = null
  if (session.status === "closed" || session.status === "failed") return
  endSession(session, "closed", "agent-disconnected")
}

export function closeTerminalSession(sessionId: string, reason = "panel-closed"): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  if (session.status === "closed" || session.status === "failed") return true
  endSession(session, "closed", reason)
  return true
}

function endSession(
  session: TerminalSession,
  status: "closed" | "failed",
  reason: string,
  error: string | null = null,
  preserveExit = false,
) {
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
  send(session.panel, {
    kind: "exit",
    code: preserveExit ? session.exitCode : null,
    reason,
    truncated: reason === "output-limit" || undefined,
  })
  if (reason !== "shell-exit" && reason !== "agent-disconnected") {
    send(session.agent, { kind: "close", reason })
  }
  closeSocket(session.panel, 1000, "session-closed")
  closeSocket(session.agent, 1000, "session-closed")
  session.panel = null
  session.agent = null
  audit(session, `WebSSH 终端会话结束：${reason}`, status === "failed" ? "warn" : "info")
}

export type TerminalSessionView = {
  id: string
  clientId: string
  shell: string
  status: string
  cols: number
  rows: number
  inputBytes: number
  outputBytes: number
  closeReason: string | null
  error: string | null
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  live: boolean
}

export function listTerminalSessions(limit = 50): TerminalSessionView[] {
  const rows = db
    .prepare(
      `SELECT id, client_id, shell, status, cols, rows, input_bytes, output_bytes, close_reason, error,
              created_at, started_at, ended_at
       FROM terminal_sessions ORDER BY created_at DESC LIMIT ?`,
    )
    .all(Math.min(200, Math.max(1, Math.floor(limit)))) as Array<{
    id: string
    client_id: string
    shell: string
    status: string
    cols: number
    rows: number
    input_bytes: number
    output_bytes: number
    close_reason: string | null
    error: string | null
    created_at: number
    started_at: number | null
    ended_at: number | null
  }>
  return rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    shell: row.shell,
    status: row.status,
    cols: row.cols,
    rows: row.rows,
    inputBytes: row.input_bytes,
    outputBytes: row.output_bytes,
    closeReason: row.close_reason,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    live: sessions.has(row.id),
  }))
}

/** 服务端启动时把上次进程遗留的活动会话标记为中断，避免审计表出现永久 running。 */
export function markStaleTerminalSessions(now = Date.now()) {
  db.prepare(
    `UPDATE terminal_sessions
     SET status = 'failed', close_reason = 'server-restarted', ended_at = ?
     WHERE status IN ('starting', 'active')`,
  ).run(now)
}

export function shutdownTerminalSessions() {
  for (const session of [...sessions.values()]) endSession(session, "closed", "server-shutdown")
}
