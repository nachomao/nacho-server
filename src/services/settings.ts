import { z } from "zod"
import { config } from "../config"
import { db } from "../db"
import { HttpError } from "../lib/http"
import { DEFAULT_TASK_TIMEZONE, normalizeTimeZone } from "../lib/schedule"

/**
 * 键值型系统设置存储。面板的通用/邮件/通知/安全等设置整体以 JSON 存于此。
 * 读取时为每个已知字段补默认值并丢弃非法旧值；未知字段原样保留以兼容前后端版本差。
 */

const DEFAULT_KEY = "app"
const SECTION_NAMES = ["general", "email", "conditions", "security", "updates"] as const
type SectionName = (typeof SECTION_NAMES)[number]
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

export type GeneralSettings = {
  concurrency: number
  channelTimeout: number
  commandTimeout: number
  retryCount: number
  logRetentionDays: number
  logRetentionMax: number
  compressArchive: boolean
  offlineThreshold: number
  timezone: string
  autoCleanTasks: boolean
}

export type EmailSettings = {
  enabled: boolean
  host: string
  port: number
  encryption: "none" | "ssl" | "tls"
  username: string
  password: string
  from: string
  to: string
}

export type NotifyConditions = {
  clientOffline: boolean
  taskFailed: boolean
  cpuAlert: boolean
  cpuThreshold: number
  memAlert: boolean
  memThreshold: number
  diskAlert: boolean
  diskThreshold: number
  quietHours: boolean
}

export type SecuritySettings = {
  sessionTimeout: number
  twoFactor: boolean
  apiKeyAuth: boolean
  ipAllowlist: boolean
  forceHttps: boolean
  loginLockout: boolean
  openEnrollment: boolean
}

export type UpdateSettings = {
  origin: string
}

export type AppSettings = {
  general: GeneralSettings
  email: EmailSettings
  conditions: NotifyConditions
  security: SecuritySettings
  updates: UpdateSettings
} & Record<string, unknown>

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

const UPDATE_ORIGIN_PATTERN = /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i
const UPDATE_ORIGIN_PLACEHOLDER = "https://updates.example.invalid"

/** 规范化更新源：空字符串表示未配置，非法值返回 null。 */
export function normalizeUpdateOrigin(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  if (trimmed.toLowerCase() === UPDATE_ORIGIN_PLACEHOLDER) return null
  if (!UPDATE_ORIGIN_PATTERN.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

/** 默认值：容量/离线阈值沿用环境变量，其余按面板默认值。 */
export function defaultSettings(): AppSettings {
  return {
    general: {
      concurrency: 4,
      channelTimeout: 30,
      commandTimeout: 120,
      retryCount: 2,
      logRetentionDays: 30,
      logRetentionMax: clampInt(config.logRetentionMax, 1000, 1_000_000, 100_000),
      compressArchive: true,
      offlineThreshold: clampInt(config.offlineThreshold, 10, 600, 60),
      timezone: DEFAULT_TASK_TIMEZONE,
      autoCleanTasks: true,
    },
    email: {
      enabled: true,
      host: "smtp.example.com",
      port: 587,
      encryption: "tls",
      username: "notify@example.com",
      password: "",
      from: "notify@example.com",
      to: "admin@example.com",
    },
    conditions: {
      clientOffline: true,
      taskFailed: true,
      cpuAlert: true,
      cpuThreshold: 85,
      memAlert: true,
      memThreshold: 90,
      diskAlert: true,
      diskThreshold: 90,
      quietHours: false,
    },
    security: {
      sessionTimeout: 30,
      twoFactor: false,
      apiKeyAuth: true,
      ipAllowlist: false,
      forceHttps: false,
      loginLockout: true,
      openEnrollment: config.allowOpenEnrollment,
    },
    updates: {
      origin: normalizeUpdateOrigin(config.updateOrigin) || "",
    },
  }
}

const integer = (min: number, max: number) => z.number().int().min(min).max(max)
const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => normalizeTimeZone(value) !== null, "时区必须是 IANA 名称")
  .transform((value) => normalizeTimeZone(value) as string)

type FieldSchemaMap = Record<string, z.ZodTypeAny>

const generalFieldSchemas = {
  concurrency: integer(1, 64),
  channelTimeout: integer(5, 600),
  commandTimeout: integer(10, 3600),
  retryCount: integer(0, 10),
  logRetentionDays: integer(0, 365),
  logRetentionMax: integer(1000, 1_000_000),
  compressArchive: z.boolean(),
  offlineThreshold: integer(10, 600),
  timezone: timezoneSchema,
  autoCleanTasks: z.boolean(),
} satisfies FieldSchemaMap

const emailFieldSchemas = {
  enabled: z.boolean(),
  host: z.string().max(255),
  port: integer(1, 65_535),
  encryption: z.enum(["none", "ssl", "tls"]),
  username: z.string().max(320),
  password: z.string().max(1024),
  from: z.string().max(320),
  to: z.string().max(320),
} satisfies FieldSchemaMap

const conditionFieldSchemas = {
  clientOffline: z.boolean(),
  taskFailed: z.boolean(),
  cpuAlert: z.boolean(),
  cpuThreshold: integer(1, 100),
  memAlert: z.boolean(),
  memThreshold: integer(1, 100),
  diskAlert: z.boolean(),
  diskThreshold: integer(1, 100),
  quietHours: z.boolean(),
} satisfies FieldSchemaMap

const securityFieldSchemas = {
  sessionTimeout: integer(5, 1440),
  twoFactor: z.boolean(),
  apiKeyAuth: z.boolean(),
  ipAllowlist: z.boolean(),
  forceHttps: z.boolean(),
  loginLockout: z.boolean(),
  openEnrollment: z.boolean(),
} satisfies FieldSchemaMap

const updateOriginSchema = z
  .string()
  .trim()
  .max(255)
  .transform((value, ctx) => {
    const normalized = normalizeUpdateOrigin(value)
    if (normalized === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "更新源必须是有效的 HTTPS 源" })
      return z.NEVER
    }
    return normalized
  })

const updateFieldSchemas = {
  origin: updateOriginSchema,
} satisfies FieldSchemaMap

const sectionSchemas: Record<SectionName, FieldSchemaMap> = {
  general: generalFieldSchemas,
  email: emailFieldSchemas,
  conditions: conditionFieldSchemas,
  security: securityFieldSchemas,
  updates: updateFieldSchemas,
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertSafeKeys(value: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) throw new HttpError(400, `设置字段 ${label ? `${label}.` : ""}${key} 不允许`)
  }
}

function sanitizeSection<T extends Record<string, unknown>>(section: SectionName, defaults: T, raw: unknown): T {
  const source = isPlainObject(raw) ? raw : {}
  const output: Record<string, unknown> = { ...source }
  for (const [key, schema] of Object.entries(sectionSchemas[section])) {
    const parsed = schema.safeParse(source[key])
    output[key] = parsed.success ? parsed.data : defaults[key]
  }
  return output as T
}

let cached: AppSettings | null = null

export function invalidateSettingsCache(): void {
  cached = null
}

export function getSettings(key = DEFAULT_KEY): Record<string, unknown> | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined
  if (!row) return null
  try {
    const parsed: unknown = JSON.parse(row.value)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 低层整包写入（保持既有测试与迁移语义），同时让缓存失效。 */
export function saveSettings(value: Record<string, unknown>, key = DEFAULT_KEY): Record<string, unknown> {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value))
  if (key === DEFAULT_KEY) cached = null
  return value
}

/** 读取完整有效设置：已知字段补默认值、旧数据中的非法值回退默认，未知字段保留。 */
export function getEffectiveSettings(): AppSettings {
  if (cached) return cached
  const defaults = defaultSettings()
  const stored = getSettings() ?? {}
  const updates = sanitizeSection("updates", defaults.updates, stored.updates)
  cached = {
    ...stored,
    general: sanitizeSection("general", defaults.general, stored.general),
    email: sanitizeSection("email", defaults.email, stored.email),
    conditions: sanitizeSection("conditions", defaults.conditions, stored.conditions),
    security: sanitizeSection("security", defaults.security, stored.security),
    // 空 origin 表示未配置，生效值回退到环境变量；来源由 resolveUpdateOrigin 区分。
    updates: { ...updates, origin: updates.origin || defaults.updates.origin },
  }
  return cached
}

export function getGeneralSettings(): GeneralSettings {
  return getEffectiveSettings().general
}

export function getNotifyConditions(): NotifyConditions {
  return getEffectiveSettings().conditions
}

/** 面板 PUT 语义：按分组浅合并，未提交字段保持原值，未知字段原样保留。 */
export function mergeSettings(patch: Record<string, unknown>): AppSettings {
  assertSafeKeys(patch, "")
  const stored = getSettings() ?? {}
  const next: Record<string, unknown> = { ...stored }
  for (const section of SECTION_NAMES) {
    if (!(section in patch)) continue
    const incoming = patch[section]
    if (!isPlainObject(incoming)) throw new HttpError(400, `设置分组 ${section} 必须是对象`)
    assertSafeKeys(incoming, section)
    const current = isPlainObject(stored[section]) ? (stored[section] as Record<string, unknown>) : {}
    const validated: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(incoming)) {
      const schema = sectionSchemas[section][key]
      if (!schema) {
        // 未知字段前向兼容：保留但不做类型约束。
        validated[key] = value
        continue
      }
      const parsed = schema.safeParse(value)
      if (!parsed.success) {
        throw new HttpError(400, `设置项 ${section}.${key} 无效`, {
          errors: [`${section}.${key}: ${parsed.error.issues[0]?.message ?? "值无效"}`],
        })
      }
      validated[key] = parsed.data
    }
    next[section] = { ...current, ...validated }
  }
  for (const [key, value] of Object.entries(patch)) {
    if ((SECTION_NAMES as readonly string[]).includes(key)) continue
    next[key] = value
  }
  saveSettings(next)
  return getEffectiveSettings()
}

export type ResolvedUpdateOrigin = {
  origin: string | null
  source: "panel" | "env" | "none"
}

/** 原始持久化中的非空更新源；不做环境变量回退，用于区分来源。 */
export function storedUpdateOrigin(): string | null {
  const raw = getSettings()
  const updates = raw?.updates
  if (!isPlainObject(updates) || typeof updates.origin !== "string") return null
  return normalizeUpdateOrigin(updates.origin) || null
}

/** 更新源读取语义：面板持久化非空优先，其次回退 NACHO_UPDATE_ORIGIN。 */
export function resolveUpdateOrigin(): ResolvedUpdateOrigin {
  const stored = storedUpdateOrigin()
  if (stored) return { origin: stored, source: "panel" }
  const env = normalizeUpdateOrigin(config.updateOrigin)
  if (env) return { origin: env, source: "env" }
  return { origin: null, source: "none" }
}

/** 返回面板持久化的免密注册策略；未保存时回退到传入的环境变量默认值。 */
export function getOpenEnrollmentSetting(fallback: boolean): boolean {
  const value = getSettings()
  const security = value?.security
  if (!security || typeof security !== "object" || Array.isArray(security)) return fallback
  const openEnrollment = (security as Record<string, unknown>).openEnrollment
  return typeof openEnrollment === "boolean" ? openEnrollment : fallback
}
