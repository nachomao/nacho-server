import { z } from "zod"

/**
 * WebSSH 会话协议（面板 -> 服务端 -> Agent）。
 * 终端与文件会话都走独立的 WebSocket 通道，不进入命令队列：
 * 命令队列是串行的一次性执行，无法承载交互式输入与持续输出。
 */

export const TERMINAL_SHELLS = ["powershell", "cmd"] as const
export type TerminalShell = (typeof TERMINAL_SHELLS)[number]

export const TERMINAL_LIMITS = {
  minCols: 20,
  maxCols: 240,
  minRows: 5,
  maxRows: 100,
  /** 单条输入消息上限（UTF-8 字节） */
  maxInputBytes: 8 * 1024,
  /** 面板/Agent 单条 WS 消息上限（服务端兜底） */
  maxMessageBytes: 64 * 1024,
  /** 单会话累计输出上限，超出后服务端主动结束会话 */
  maxOutputBytes: 8 * 1024 * 1024,
  /** 重连回放缓冲区上限 */
  ringBytes: 128 * 1024,
  maxSessions: 8,
  maxSessionsPerClient: 1,
  ticketTtlMs: 30_000,
  attachTimeoutMs: 20_000,
  reconnectGraceMs: 60_000,
  idleTimeoutMs: 15 * 60_000,
  maxDurationMs: 60 * 60_000,
} as const

export const FILE_LIMITS = {
  maxFileBytes: 512 * 1024 * 1024,
  maxChunkBytes: 256 * 1024,
  /** base64 后允许的最大 data 长度：256 KiB 原始数据约 350 KiB 编码 */
  maxEncodedChunkChars: 360 * 1024,
  maxPanelMessageBytes: 1024 * 1024,
  maxAgentMessageBytes: 1024 * 1024,
  maxSessions: 8,
  maxSessionsPerClient: 1,
  ticketTtlMs: 30_000,
  attachTimeoutMs: 20_000,
  reconnectGraceMs: 60_000,
  idleTimeoutMs: 10 * 60_000,
  maxDurationMs: 60 * 60_000,
} as const

// 输入允许超出协议范围，由服务端与 Agent 统一夹取到 20..240 / 5..100。
const cols = z.number().int().min(1).max(1000)
const rows = z.number().int().min(1).max(1000)

export const createTerminalSessionSchema = z
  .object({
    clientId: z.string().min(1).max(120),
    shell: z.enum(TERMINAL_SHELLS).default("powershell"),
    cols: cols.default(120),
    rows: rows.default(30),
  })
  .strict()

/** 面板 -> 服务端终端消息 */
export const terminalPanelMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("input"), data: z.string().max(TERMINAL_LIMITS.maxInputBytes) }).strict(),
  z.object({ kind: z.literal("resize"), cols, rows }).strict(),
  z.object({ kind: z.literal("ping") }).strict(),
])

/** Agent -> 服务端终端消息 */
export const terminalAgentMessageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ready"),
      shell: z.enum(TERMINAL_SHELLS),
      pid: z.number().int().positive().nullable(),
      cwd: z.string().max(4096).nullable(),
      cols: z.number().int().min(1).max(1000),
      rows: z.number().int().min(1).max(1000),
    })
    .strict(),
  z.object({ kind: z.literal("output"), data: z.string().min(1).max(TERMINAL_LIMITS.maxMessageBytes) }).strict(),
  z
    .object({
      kind: z.literal("exit"),
      code: z.number().int().nullable(),
      reason: z.string().max(200).nullable(),
      truncated: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("resize-ack"), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal("error"), code: z.string().min(1).max(64), message: z.string().min(1).max(512) }).strict(),
])

const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const transferId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const remotePath = z
  .string()
  .min(3)
  .max(32_767)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "path contains control characters")
const byteOffset = z.number().int().min(0).max(FILE_LIMITS.maxFileBytes)
const fileSize = z.number().int().min(1).max(FILE_LIMITS.maxFileBytes)
const encodedChunk = z
  .string()
  .min(4)
  .max(FILE_LIMITS.maxEncodedChunkChars)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .refine((value) => Buffer.from(value, "base64").length <= FILE_LIMITS.maxChunkBytes, "chunk exceeds 256 KiB")

/** 面板 -> Agent 文件会话消息（服务端校验后原样转发） */
export const filePanelMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("roots"), id: requestId }).strict(),
  z.object({ kind: z.literal("list"), id: requestId, path: remotePath }).strict(),
  z.object({ kind: z.literal("delete"), id: requestId, path: remotePath }).strict(),
  z.object({ kind: z.literal("download"), id: requestId, transferId, path: remotePath, offset: byteOffset }).strict(),
  z.object({ kind: z.literal("upload"), id: requestId, transferId, path: remotePath, size: fileSize, offset: byteOffset }).strict(),
  z.object({ kind: z.literal("uploadChunk"), id: requestId, transferId, offset: byteOffset, data: encodedChunk, sha256 }).strict(),
  z.object({ kind: z.literal("uploadComplete"), id: requestId, transferId, size: fileSize, sha256: sha256.optional() }).strict(),
  z.object({ kind: z.literal("cancel"), id: requestId, transferId }).strict(),
])

const remoteEntry = z
  .object({
    name: z.string().min(1).max(255),
    type: z.enum(["dir", "file"]),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    mtimeUtc: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()

const fileError = z.object({
  kind: z.literal("error"),
  id: requestId.optional(),
  transferId: transferId.optional(),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(512),
  receivedBytes: byteOffset.optional(),
}).strict()

/** Agent -> 面板文件会话消息 */
export const fileAgentMessageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rootsResult"),
      id: requestId,
      roots: z
        .array(
          z.object({
            path: z.string().min(3).max(16),
            label: z.string().min(1).max(64),
            freeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
            totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
          }).strict(),
        )
        .max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("listResult"),
      id: requestId,
      path: remotePath,
      entries: z.array(remoteEntry).max(5000),
      truncated: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("deleteResult"), id: requestId, path: remotePath, deleted: z.literal(true) }).strict(),
  z
    .object({
      kind: z.literal("downloadStart"),
      id: requestId,
      transferId,
      name: z.string().min(1).max(255),
      size: z.number().int().min(0).max(FILE_LIMITS.maxFileBytes),
      sha256,
    })
    .strict(),
  z.object({ kind: z.literal("downloadChunk"), id: requestId, transferId, offset: byteOffset, data: encodedChunk, sha256 }).strict(),
  z.object({ kind: z.literal("downloadComplete"), id: requestId, transferId, size: z.number().int().min(0).max(FILE_LIMITS.maxFileBytes) }).strict(),
  z.object({ kind: z.literal("uploadReady"), id: requestId, transferId, receivedBytes: byteOffset }).strict(),
  z.object({ kind: z.literal("uploadAck"), id: requestId, transferId, receivedBytes: byteOffset }).strict(),
  z
    .object({
      kind: z.literal("uploadComplete"),
      id: requestId,
      transferId,
      path: remotePath,
      size: fileSize,
      sha256,
    })
    .strict(),
  fileError,
])

export type TerminalPanelMessage = z.infer<typeof terminalPanelMessageSchema>
export type TerminalAgentMessage = z.infer<typeof terminalAgentMessageSchema>
export type FilePanelMessage = z.infer<typeof filePanelMessageSchema>
export type FileAgentMessage = z.infer<typeof fileAgentMessageSchema>
