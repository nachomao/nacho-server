import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import type { WebSocket } from "ws"
import { WebSocketServer } from "ws"
import { db } from "./db"
import { logger } from "./lib/logger"
import * as clientsSvc from "./services/clients"
import * as commands from "./services/commands"
import * as fileSessions from "./services/file-sessions"
import * as notifications from "./services/notifications"
import { registerConnection, removeConnection } from "./services/realtime"
import { getGeneralSettings } from "./services/settings"
import * as terminalSessions from "./services/terminal-sessions"
import type { ClientMetrics } from "./types"

const LIVENESS_SWEEP_MS = 5_000
/** WebSSH 两个通道的消息上限；文件分块以 base64 承载，单独放宽。 */
const TERMINAL_MAX_PAYLOAD = 128 * 1024
const FILE_MAX_PAYLOAD = 1536 * 1024

function parseMetrics(value: unknown): ClientMetrics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!["cpu", "memory", "disk", "uptime"].every((key) => typeof record[key] === "number" && Number.isFinite(record[key]))) {
    return undefined
  }
  return {
    cpu: record.cpu as number,
    memory: record.memory as number,
    disk: record.disk as number,
    uptime: record.uptime as number,
  }
}

function bearerToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization || ""
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim()
  return ""
}

function agentToken(req: IncomingMessage, url: URL): string {
  return bearerToken(req) || url.searchParams.get("token") || ""
}

function clientIdForToken(token: string): string | null {
  if (!token) return null
  const row = db.prepare("SELECT id FROM clients WHERE token = ?").get(token) as { id: string } | undefined
  return row?.id ?? null
}

function rejectUpgrade(socket: Duplex, status: string) {
  try {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } catch {
    /* 套接字可能已关闭 */
  }
  socket.destroy()
}

/**
 * 客户端实时长连接：
 * 客户端以 wss://host/agent/ws?token=<clientToken> 建立连接，
 * 服务端校验令牌后登记连接，即可实时下发指令。
 * 客户端可在连接内发送心跳与指令结果上报。
 *
 * 另挂载两条 WebSSH 通道：
 * - /agent/terminal 与 /api/panel/terminal/ws：终端输入/输出流；
 * - /agent/files 与 /api/panel/files/ws：文件浏览与分块传输。
 * WebSSH 通道使用一次性 ticket，不把设备令牌或面板 Key 放进浏览器 URL。
 */
export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true })
  const terminalWss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_MAX_PAYLOAD })
  const fileWss = new WebSocketServer({ noServer: true, maxPayload: FILE_MAX_PAYLOAD })
  const lastPongAt = new WeakMap<WebSocket, number>()

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", "http://localhost")

    if (url.pathname === "/agent/ws") {
      const clientId = clientIdForToken(agentToken(req, url))
      if (!clientId) return rejectUpgrade(socket, "401 Unauthorized")
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, clientId)
      })
      return
    }

    if (url.pathname === "/agent/terminal") {
      const clientId = clientIdForToken(agentToken(req, url))
      if (!clientId) return rejectUpgrade(socket, "401 Unauthorized")
      const sessionId = url.searchParams.get("session") || ""
      const ticket = url.searchParams.get("ticket") || ""
      if (!terminalSessions.verifyAgentTicket(sessionId, ticket, clientId)) return rejectUpgrade(socket, "403 Forbidden")
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        if (!terminalSessions.attachAgent(ws, sessionId, ticket, clientId)) {
          ws.close(4003, "ticket-consumed")
          return
        }
        ws.on("message", (raw) => terminalSessions.handleAgentMessage(sessionId, ws, raw.toString()))
        ws.on("close", () => terminalSessions.detachAgent(sessionId, ws))
        ws.on("error", (err) => logger.warn(`Agent 终端通道异常（${sessionId}）：`, err))
      })
      return
    }

    if (url.pathname === "/agent/files") {
      const clientId = clientIdForToken(agentToken(req, url))
      if (!clientId) return rejectUpgrade(socket, "401 Unauthorized")
      const sessionId = url.searchParams.get("session") || ""
      const ticket = url.searchParams.get("ticket") || ""
      if (!fileSessions.verifyFileAgentTicket(sessionId, ticket, clientId)) return rejectUpgrade(socket, "403 Forbidden")
      fileWss.handleUpgrade(req, socket, head, (ws) => {
        if (!fileSessions.attachFileAgent(ws, sessionId, ticket, clientId)) {
          ws.close(4003, "ticket-consumed")
          return
        }
        ws.on("message", (raw) => fileSessions.handleFileAgentMessage(sessionId, ws, raw.toString()))
        ws.on("close", () => fileSessions.detachFileAgent(sessionId, ws))
        ws.on("error", (err) => logger.warn(`Agent 文件通道异常（${sessionId}）：`, err))
      })
      return
    }

    if (url.pathname === "/api/panel/terminal/ws") {
      const ticket = url.searchParams.get("ticket") || ""
      const sinceRaw = Number(url.searchParams.get("since") ?? "0")
      const since = Number.isSafeInteger(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0
      const sessionId = terminalSessions.verifyPanelTicket(ticket)
      if (!sessionId) return rejectUpgrade(socket, "401 Unauthorized")
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        if (!terminalSessions.attachPanel(ws, ticket, since)) {
          ws.close(4003, "ticket-consumed")
          return
        }
        ws.on("message", (raw) => terminalSessions.handlePanelMessage(sessionId, ws, raw.toString()))
        ws.on("close", () => terminalSessions.detachPanel(sessionId, ws))
        ws.on("error", (err) => logger.warn(`面板终端通道异常（${sessionId}）：`, err))
      })
      return
    }

    if (url.pathname === "/api/panel/files/ws") {
      const ticket = url.searchParams.get("ticket") || ""
      const sessionId = fileSessions.verifyFilePanelTicket(ticket)
      if (!sessionId) return rejectUpgrade(socket, "401 Unauthorized")
      fileWss.handleUpgrade(req, socket, head, (ws) => {
        if (!fileSessions.attachFilePanel(ws, ticket)) {
          ws.close(4003, "ticket-consumed")
          return
        }
        ws.on("message", (raw) => fileSessions.handleFilePanelMessage(sessionId, ws, raw.toString()))
        ws.on("close", () => fileSessions.detachFilePanel(sessionId, ws))
        ws.on("error", (err) => logger.warn(`面板文件通道异常（${sessionId}）：`, err))
      })
      return
    }

    socket.destroy()
  })

  wss.on("connection", (ws: WebSocket, clientId: string) => {
    registerConnection(clientId, ws)
    lastPongAt.set(ws, Date.now())
    ws.on("pong", () => lastPongAt.set(ws, Date.now()))
    clientsSvc.heartbeat(clientId)

    // 上线后立即推送积压的待执行指令
    for (const cmd of commands.pullPending(clientId)) {
      ws.send(JSON.stringify({ kind: "command", command: cmd }))
    }
    ws.send(JSON.stringify({ kind: "ready", clientId, serverTime: Date.now() }))

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      switch (msg.kind) {
        case "heartbeat": {
          const metrics = parseMetrics(msg.metrics)
          const client = clientsSvc.heartbeat(clientId, metrics)
          if (client && metrics) notifications.evaluateClientMetrics(client, metrics)
          break
        }
        case "result": {
          const { id, status, result, exitCode } = msg as {
            id: string
            status: commands.NewCommand extends never ? never : "running" | "success" | "failed" | "canceled"
            result?: string
            exitCode?: number
          }
          if (
            id &&
            ["running", "success", "failed", "canceled"].includes(status) &&
            (result === undefined || typeof result === "string") &&
            (exitCode === undefined || (typeof exitCode === "number" && Number.isInteger(exitCode)))
          ) commands.reportResult(id, clientId, status, result, exitCode)
          break
        }
        case "ack": {
          const id = typeof msg.id === "string" ? msg.id : ""
          if (id) commands.acknowledge(id, clientId)
          break
        }
        default:
          break
      }
    })

    ws.on("close", () => removeConnection(clientId, ws))
    ws.on("error", (err) => logger.warn(`客户端 ${clientId} 连接错误：`, err))
  })

  // 主通道心跳超时：按系统设置中的 channelTimeout 终止无响应的连接。
  const livenessTimer = setInterval(() => {
    const timeoutMs = getGeneralSettings().channelTimeout * 1000
    const at = Date.now()
    for (const ws of wss.clients) {
      const lastAt = lastPongAt.get(ws) ?? at
      if (at - lastAt > timeoutMs) {
        logger.warn(`实时通道超过 ${Math.round(timeoutMs / 1000)} 秒无心跳响应，终止连接`)
        ws.terminate()
        continue
      }
      try {
        ws.ping()
      } catch {
        /* 连接正在关闭，交由 close 事件回收 */
      }
    }
  }, LIVENESS_SWEEP_MS)
  livenessTimer.unref()

  logger.info("WebSocket 实时通道已挂载：/agent/ws、/agent/terminal、/agent/files 与面板 WebSSH 通道")
}
