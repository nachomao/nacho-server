import type { Server } from "node:http"
import type { WebSocket } from "ws"
import { WebSocketServer } from "ws"
import { db } from "./db"
import { logger } from "./lib/logger"
import * as clientsSvc from "./services/clients"
import * as commands from "./services/commands"
import { registerConnection, removeConnection } from "./services/realtime"

/**
 * 客户端实时长连接：
 * 客户端以 wss://host/agent/ws?token=<clientToken> 建立连接，
 * 服务端校验令牌后登记连接，即可实时下发指令。
 * 客户端可在连接内发送心跳与指令结果上报。
 */
export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true })

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", "http://localhost")
    if (url.pathname !== "/agent/ws") {
      socket.destroy()
      return
    }
    const authorization = req.headers.authorization || ""
    const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : ""
    const token = bearer || url.searchParams.get("token") || ""
    const row = db.prepare("SELECT id FROM clients WHERE token = ?").get(token) as { id: string } | undefined
    if (!row) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, row.id)
    })
  })

  wss.on("connection", (ws: WebSocket, clientId: string) => {
    registerConnection(clientId, ws)
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
        case "heartbeat":
          clientsSvc.heartbeat(clientId, msg.metrics as never)
          break
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

  logger.info("WebSocket 实时通道已挂载：/agent/ws")
}
