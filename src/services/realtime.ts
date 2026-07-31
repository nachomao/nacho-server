import type { WebSocket } from "ws"
import { logger } from "../lib/logger"

/**
 * 客户端长连接中枢：维护 clientId -> WebSocket 映射，
 * 用于把授权后的管理指令实时下发到在线客户端。
 * 客户端断线时自动回退到 HTTP 轮询拉取指令。
 */
const connections = new Map<string, WebSocket>()

export function registerConnection(clientId: string, ws: WebSocket) {
  // 若已有旧连接，先关闭
  const existing = connections.get(clientId)
  if (existing && existing !== ws) {
    try {
      existing.close(4000, "replaced by new connection")
    } catch {
      /* ignore */
    }
  }
  connections.set(clientId, ws)
  logger.info(`客户端 ${clientId} 已建立实时连接，当前在线连接数 ${connections.size}`)
}

export function removeConnection(clientId: string, ws?: WebSocket) {
  const current = connections.get(clientId)
  if (!ws || current === ws) {
    connections.delete(clientId)
    logger.info(`客户端 ${clientId} 断开实时连接，当前在线连接数 ${connections.size}`)
  }
}

export function isClientConnected(clientId: string): boolean {
  const ws = connections.get(clientId)
  return !!ws && ws.readyState === ws.OPEN
}

/** 向指定在线客户端推送消息，返回是否成功送达 */
export function pushToClient(clientId: string, message: unknown): boolean {
  const ws = connections.get(clientId)
  if (!ws || ws.readyState !== ws.OPEN) return false
  try {
    ws.send(JSON.stringify(message))
    return true
  } catch (err) {
    logger.warn(`向客户端 ${clientId} 推送消息失败：`, err)
    return false
  }
}

export function connectedClientIds(): string[] {
  return [...connections.entries()].filter(([, ws]) => ws.readyState === ws.OPEN).map(([id]) => id)
}
