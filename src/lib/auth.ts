import crypto from "node:crypto"
import type { NextFunction, Request, Response } from "express"
import { config } from "../config"
import { db } from "../db"
import { getOpenEnrollmentSetting } from "../services/settings"
import { fail } from "./http"

/** 从请求中提取令牌：优先 Authorization: Bearer，其次 X-API-Key */
function extractToken(req: Request): string | null {
  const auth = req.header("authorization")
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim()
  const key = req.header("x-api-key")
  return key ? key.trim() : null
}

/** 定长安全比较，避免时序攻击 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/** 面板鉴权：校验面板 API Key（面板 -> 服务端） */
export function panelAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req)
  if (!token || !safeEqual(token, config.panelApiKey)) {
    return fail(res, "面板 API 鉴权失败：无效的 API Key", 401)
  }
  next()
}

/** 客户端令牌鉴权：校验 clients.token，并把对应客户端 ID 挂到 req */
export function agentAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req)
  if (!token) return fail(res, "缺少客户端访问令牌", 401)
  const row = db.prepare("SELECT id FROM clients WHERE token = ?").get(token) as { id: string } | undefined
  if (!row) return fail(res, "客户端访问令牌无效或已被吊销", 401)
  ;(req as Request & { clientId?: string }).clientId = row.id
  next()
}

/** 校验入网密钥（客户端首次注册时） */
export function checkEnrollmentKey(key: unknown): boolean {
  return typeof key === "string" && safeEqual(key, config.enrollmentKey)
}

export function canEnroll(key: unknown, allowOpenEnrollment?: boolean): boolean {
  const openEnrollment = allowOpenEnrollment ?? getOpenEnrollmentSetting(config.allowOpenEnrollment)
  return openEnrollment || checkEnrollmentKey(key)
}

export function isOpenEnrollmentEnabled(): boolean {
  return getOpenEnrollmentSetting(config.allowOpenEnrollment)
}
