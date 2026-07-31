import crypto from "node:crypto"

/** 生成带前缀的短 ID，例如 cl-a1b2c3d4 */
export function shortId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`
}

/** 生成客户端访问令牌 */
export function makeToken(): string {
  return `nct_${crypto.randomBytes(24).toString("base64url")}`
}

/** 生成面板 API Key */
export function makeApiKey(): string {
  return `nk_live_${crypto.randomBytes(18).toString("base64url")}`
}
