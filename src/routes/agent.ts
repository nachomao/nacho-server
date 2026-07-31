import type { Request } from "express"
import { Router } from "express"
import { z } from "zod"
import { agentAuth, canEnroll } from "../lib/auth"
import { asyncHandler, fail, ok, parseBody } from "../lib/http"
import * as clients from "../services/clients"
import * as commands from "../services/commands"
import { MAX_COMMAND_RESULT_BYTES } from "../services/commands"
import * as health from "../services/health"
import { recordLog } from "../services/logs"

export const agentRouter = Router()

function clientIp(req: Request): string {
  const fwd = req.header("x-forwarded-for")
  if (fwd) return fwd.split(",")[0].trim()
  return req.socket.remoteAddress || ""
}

/* -------------------- 注册（凭入网密钥，无需令牌） -------------------- */
const enrollSchema = z.object({
  enrollmentKey: z.string().nullish(),
  id: z.string().optional(),
  name: z.string().min(1),
  hostname: z.string().optional(),
  os: z.enum(["Windows", "macOS", "Linux"]).optional(),
  /** 具体系统名：Windows 上报版本描述，Linux 上报 /etc/os-release 的 ID */
  osName: z.string().max(120).optional(),
  version: z.string().optional(),
  tags: z.array(z.string()).optional(),
  group: z.string().optional(),
})

agentRouter.post(
  "/enroll",
  asyncHandler((req, res) => {
    const body = parseBody(enrollSchema, req.body)
    if (!canEnroll(body.enrollmentKey)) {
      return fail(res, "入网密钥无效，拒绝注册", 401)
    }
    const { client, token } = clients.registerClient({
      id: body.id,
      name: body.name,
      hostname: body.hostname,
      ip: clientIp(req),
      os: body.os,
      osName: body.osName,
      version: body.version,
      tags: body.tags,
      group: body.group,
    })
    // token 仅在注册时返回一次，客户端需自行持久化
    return ok(res, { client, token }, 201)
  }),
)

/* -------------------- 以下接口需要客户端令牌 -------------------- */
agentRouter.use(agentAuth)

const metricsSchema = z.object({
  version: z.string().optional(),
  osName: z.string().max(120).optional(),
  metrics: z
    .object({
      cpu: z.number(),
      memory: z.number(),
      disk: z.number(),
      uptime: z.number(),
    })
    .optional(),
})

agentRouter.post(
  "/heartbeat",
  asyncHandler((req, res) => {
    const clientId = (req as Request & { clientId: string }).clientId
    const body = parseBody(metricsSchema, req.body ?? {})
    const c = clients.heartbeat(clientId, body.metrics, clientIp(req), body.version, body.osName)
    if (!c) return fail(res, "客户端不存在", 404)
    // 心跳响应带上待执行指令数，客户端可据此决定是否立即拉取
    const pending = commands.listCommands(clientId).filter((cmd) => cmd.status === "pending").length
    return ok(res, { client: c, pendingCommands: pending, serverTime: Date.now() })
  }),
)

// 客户端拉取待执行指令（HTTP 轮询回退通道）
agentRouter.get(
  "/commands/pending",
  asyncHandler((req, res) => {
    const clientId = (req as Request & { clientId: string }).clientId
    return ok(res, commands.pullPending(clientId))
  }),
)

agentRouter.post(
  "/commands/:id/ack",
  asyncHandler((req, res) => {
    const clientId = (req as Request & { clientId: string }).clientId
    if (!commands.acknowledge(req.params.id, clientId)) {
      return fail(res, "指令不存在或不属于该客户端", 404)
    }
    return ok(res, { id: req.params.id, status: commands.getCommand(req.params.id)?.status })
  }),
)

// 客户端上报指令执行结果
const reportSchema = z.object({
  status: z.enum(["running", "success", "failed", "canceled"]),
  result: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMAND_RESULT_BYTES, "result exceeds 512 KiB").nullish(),
  exitCode: z.number().int().nullish(),
})

agentRouter.post(
  "/commands/:id/report",
  asyncHandler((req, res) => {
    const clientId = (req as Request & { clientId: string }).clientId
    const body = parseBody(reportSchema, req.body)
    const okReport = commands.reportResult(req.params.id, clientId, body.status, body.result ?? undefined, body.exitCode ?? undefined)
    if (!okReport) return fail(res, "指令不存在或不属于该客户端", 404)
    return ok(res, { id: req.params.id, status: body.status })
  }),
)

// 客户端上报健康发现（异常/告警）
const findingSchema = z.object({
  severity: z.enum(["critical", "error", "warning", "info"]),
  category: z.string(),
  title: z.string().min(1),
  detail: z.string().optional(),
})

agentRouter.post(
  "/findings",
  asyncHandler((req, res) => {
    const clientId = (req as Request & { clientId: string }).clientId
    const c = clients.getClient(clientId)
    const body = parseBody(findingSchema, req.body)
    const finding = health.addFinding({
      host: c?.hostname || c?.name || clientId,
      severity: body.severity,
      category: body.category,
      title: body.title,
      detail: body.detail,
    })
    recordLog(body.severity === "info" ? "info" : "warn", "health", `客户端上报健康发现：${body.title}`, `client=${clientId}`)
    return ok(res, finding, 201)
  }),
)
