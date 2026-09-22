import { db } from "../db"

/**
 * 键值型系统设置存储。面板的通用/邮件/通知/安全等设置整体以 JSON 存于此，
 * 便于面板一次性读取与保存。
 */

const DEFAULT_KEY = "app"

export function getSettings(key = DEFAULT_KEY): Record<string, unknown> | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value) as Record<string, unknown>
  } catch {
    return null
  }
}

export function saveSettings(value: Record<string, unknown>, key = DEFAULT_KEY): Record<string, unknown> {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value))
  return value
}

/** 返回面板持久化的免密注册策略；未保存时回退到环境变量默认值。 */
export function getOpenEnrollmentSetting(fallback: boolean): boolean {
  const value = getSettings()
  const security = value?.security
  if (!security || typeof security !== "object" || Array.isArray(security)) return fallback
  const openEnrollment = (security as Record<string, unknown>).openEnrollment
  return typeof openEnrollment === "boolean" ? openEnrollment : fallback
}
