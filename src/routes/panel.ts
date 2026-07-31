import { Router } from "express"
import { z } from "zod"
import { panelAuth } from "../lib/auth"
import { asyncHandler, fail, ok, parseBody } from "../lib/http"
import * as clients from "../services/clients"
import * as commands from "../services/commands"
import * as health from "../services/health"
import * as logs from "../services/logs"
import { getOverview } from "../services/overview"
import * as plugins from "../services/plugins"
import * as settings from "../services/settings"
import * as tasks from "../services/tasks"
import * as agentUpdates from "../services/agent-updates"

export const panelRouter = Router()

// 所有面板接口都需要面板 API Key
panelRouter.use(panelAuth)

/* ==================== 概览 ==================== */
panelRouter.get(
  "/overview",
  asyncHandler((_req, res) => ok(res, getOverview())),
)

/* ==================== 客户端 ==================== */
panelRouter.get(
  "/clients",
  asyncHandler((_req, res) => ok(res, clients.listClients().map(clients.withRealtime))),
)

panelRouter.get(
  "/clients/:id",
  asyncHandler((req, res) => {
    const c = clients.getClient(req.params.id)
    if (!c) return fail(res, "客户端不存在", 404)
    return ok(res, clients.withRealtime(c))
  }),
)

const clientCreateSchema = z.object({
  name: z.string().min(1),
  hostname: z.string().optional(),
  ip: z.string().optional(),
  os: z.enum(["Windows", "macOS", "Linux"]).optional(),
  version: z.string().optional(),
  tags: z.array(z.string()).optional(),
  group: z.string().optional(),
})

panelRouter.post(
  "/clients",
  asyncHandler((req, res) => {
    const body = parseBody(clientCreateSchema, req.body)
    return ok(res, clients.createClient(body), 201)
  }),
)

const clientUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  group: z.string().optional(),
  status: z.enum(["online", "offline", "warning"]).optional(),
})

panelRouter.patch(
  "/clients/:id",
  asyncHandler((req, res) => {
    const body = parseBody(clientUpdateSchema, req.body)
    const c = clients.updateClient(req.params.id, body)
    if (!c) return fail(res, "客户端不存在", 404)
    return ok(res, c)
  }),
)

panelRouter.delete(
  "/clients/:id",
  asyncHandler((req, res) => {
    const removed = clients.deleteClient(req.params.id)
    if (!removed) return fail(res, "客户端不存在", 404)
    return ok(res, { id: req.params.id })
  }),
)

// 面板直接向某客户端下发一次性指令
const commandSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
})

panelRouter.post(
  "/clients/:id/commands",
  asyncHandler((req, res) => {
    const c = clients.getClient(req.params.id)
    if (!c) return fail(res, "客户端不存在", 404)
    const body = parseBody(commandSchema, req.body)
    if (body.type === "update-agent") return fail(res, "update-agent must be created through /agent-updates", 400)
    return ok(res, commands.dispatchCommand({ clientId: c.id, type: body.type, payload: body.payload }), 201)
  }),
)

const updateRequestSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("all") }),
  z.object({ scope: z.literal("clients"), clientIds: z.array(z.string().min(1)).min(1) }),
])

panelRouter.get(
  "/agent-updates",
  asyncHandler((_req, res) => ok(res, agentUpdates.listAgentUpdates())),
)

panelRouter.post(
  "/agent-updates",
  asyncHandler((req, res) => {
    const body = parseBody(updateRequestSchema, req.body)
    return ok(res, agentUpdates.queueAgentUpdates(body.scope, body.scope === "clients" ? body.clientIds : []), 201)
  }),
)

panelRouter.get(
  "/commands",
  asyncHandler((req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined
    return ok(res, commands.listCommands(clientId))
  }),
)

/* ==================== 分组 ==================== */
panelRouter.get(
  "/groups",
  asyncHandler((_req, res) => ok(res, clients.listGroups())),
)

panelRouter.post(
  "/groups",
  asyncHandler((req, res) => {
    const body = parseBody(z.object({ name: z.string().min(1) }), req.body)
    return ok(res, clients.addGroup(body.name), 201)
  }),
)

panelRouter.delete(
  "/groups/:name",
  asyncHandler((req, res) => ok(res, clients.deleteGroup(req.params.name))),
)

/* ==================== 计划任务 ==================== */
const taskSchema = z.object({
  name: z.string().min(1),
  os: z.enum(["windows", "linux"]),
  action: z.string(),
  program: z.string(),
  args: z.string(),
  triggerId: z.enum(["daily", "weekly", "logon", "startup", "boot", "cron"]),
  time: z.string(),
  interval: z.number().int().nonnegative(),
  cron: z.string(),
  clientIds: z.array(z.string()),
  enabled: z.boolean(),
})

panelRouter.get(
  "/tasks",
  asyncHandler((_req, res) => ok(res, tasks.listTasks())),
)

panelRouter.post(
  "/tasks",
  asyncHandler((req, res) => {
    const body = parseBody(taskSchema, req.body)
    return ok(res, tasks.createTask(body), 201)
  }),
)

panelRouter.patch(
  "/tasks/:id",
  asyncHandler((req, res) => {
    const body = parseBody(taskSchema.partial(), req.body)
    const t = tasks.updateTask(req.params.id, body)
    if (!t) return fail(res, "任务不存在", 404)
    return ok(res, t)
  }),
)

panelRouter.post(
  "/tasks/:id/enabled",
  asyncHandler((req, res) => {
    const body = parseBody(z.object({ enabled: z.boolean() }), req.body)
    const t = tasks.setEnabled(req.params.id, body.enabled)
    if (!t) return fail(res, "任务不存在", 404)
    return ok(res, t)
  }),
)

// 核心链路：面板提交任务后授权下发到客户端
panelRouter.post(
  "/tasks/:id/dispatch",
  asyncHandler((req, res) => {
    const result = tasks.dispatchTask(req.params.id)
    if (!result) return fail(res, "任务不存在", 404)
    return ok(res, result)
  }),
)

panelRouter.delete(
  "/tasks/:id",
  asyncHandler((req, res) => {
    const removed = tasks.deleteTask(req.params.id)
    if (!removed) return fail(res, "任务不存在", 404)
    return ok(res, { id: req.params.id })
  }),
)

/* ==================== 日志 ==================== */
panelRouter.get(
  "/logs",
  asyncHandler((req, res) => {
    const q = req.query
    return ok(
      res,
      logs.listLogs({
        level: typeof q.level === "string" ? (q.level as logs.LogFilter["level"]) : undefined,
        source: typeof q.source === "string" ? q.source : undefined,
        q: typeof q.q === "string" ? q.q : undefined,
        since: typeof q.since === "string" ? Number(q.since) : undefined,
        limit: typeof q.limit === "string" ? Number(q.limit) : undefined,
      }),
    )
  }),
)

panelRouter.get(
  "/logs/sources",
  asyncHandler((_req, res) => ok(res, logs.listSources())),
)

panelRouter.delete(
  "/logs",
  asyncHandler((_req, res) => {
    logs.clearLogs()
    return ok(res, { cleared: true })
  }),
)

/* ==================== 插件 ==================== */
const pluginSchema = z.object({
  name: z.string().min(1),
  version: z.string(),
  author: z.string(),
  category: z.string(),
  description: z.string(),
  size: z.string(),
  icon: z.string(),
  status: z.enum(["installed", "available", "disabled"]),
  restartRestore: z.boolean(),
  params: z.array(z.object({ id: z.string(), label: z.string(), value: z.string() })),
})

panelRouter.get(
  "/plugins",
  asyncHandler((_req, res) => ok(res, plugins.listPlugins())),
)

panelRouter.post(
  "/plugins",
  asyncHandler((req, res) => {
    const body = parseBody(pluginSchema, req.body)
    return ok(res, plugins.createPlugin(body), 201)
  }),
)

panelRouter.patch(
  "/plugins/:id",
  asyncHandler((req, res) => {
    const body = parseBody(pluginSchema.partial(), req.body)
    const p = plugins.updatePlugin(req.params.id, body)
    if (!p) return fail(res, "插件不存在", 404)
    return ok(res, p)
  }),
)

panelRouter.post(
  "/plugins/:id/status",
  asyncHandler((req, res) => {
    const body = parseBody(z.object({ status: z.enum(["installed", "available", "disabled"]) }), req.body)
    const p = plugins.setStatus(req.params.id, body.status)
    if (!p) return fail(res, "插件不存在", 404)
    return ok(res, p)
  }),
)

panelRouter.delete(
  "/plugins/:id",
  asyncHandler((req, res) => {
    const removed = plugins.deletePlugin(req.params.id)
    if (!removed) return fail(res, "插件不存在", 404)
    return ok(res, { id: req.params.id })
  }),
)

/* ==================== 健康监控 ==================== */
panelRouter.get(
  "/health/findings",
  asyncHandler((_req, res) => ok(res, health.listFindings())),
)

panelRouter.post(
  "/health/findings/:id/read",
  asyncHandler((req, res) => {
    health.markRead(req.params.id)
    return ok(res, { id: req.params.id })
  }),
)

panelRouter.post(
  "/health/findings/read-all",
  asyncHandler((_req, res) => {
    health.markAllRead()
    return ok(res, { done: true })
  }),
)

panelRouter.get(
  "/health/packages",
  asyncHandler((_req, res) => ok(res, health.listPackages())),
)

panelRouter.get(
  "/health/stats",
  asyncHandler((_req, res) => ok(res, health.healthStats())),
)

/* ==================== 设置 ==================== */
panelRouter.get(
  "/settings",
  asyncHandler((_req, res) => ok(res, settings.getSettings() ?? {})),
)

panelRouter.put(
  "/settings",
  asyncHandler((req, res) => {
    const body = parseBody(z.record(z.unknown()), req.body)
    return ok(res, settings.saveSettings(body))
  }),
)
