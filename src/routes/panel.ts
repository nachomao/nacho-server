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
import { addServerCommandFields, batchCommandSchema, commandSupportsClient, panelCommandSchema } from "../schemas/commands"
import * as managedArtifacts from "../services/managed-artifacts"
import * as installProfiles from "../services/install-profiles"
import { healthCollectionSchema } from "../schemas/health"

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
  osName: z.string().max(120).optional(),
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

panelRouter.post(
  "/clients/:id/commands",
  asyncHandler((req, res) => {
    const c = clients.getClient(req.params.id)
    if (!c) return fail(res, "客户端不存在", 404)
    const body = parseBody(panelCommandSchema, req.body)
    if (body.type === "install-package") return fail(res, "install-package 必须通过软件包部署接口创建", 400)
    if (body.type === "deploy-file" || body.type === "rollback-file-deploy") {
      return fail(res, `${body.type} 必须通过文件部署专用接口创建`, 400)
    }
    if (!commandSupportsClient(body.type, c.os)) {
      return fail(res, "该命令仅支持 Windows 客户端", 400)
    }
    if (body.type === "open-url" && c.status !== "online") {
      return fail(res, "打开网页仅支持当前在线的 Windows 客户端", 400)
    }
    return ok(res, commands.dispatchCommand({ clientId: c.id, type: body.type, payload: addServerCommandFields(body.type, body.payload) }), 201)
  }),
)

const cleanText = (maximum: number) => z.string().trim().min(1).max(maximum).refine(
  (value) => ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code === 0 || code < 32 || code === 127
  }),
  "contains control characters",
)
const artifactFileName = z.string().min(1).max(255).refine(
  (value) => !/[\\/\0-\x1f\x7f]/.test(value) && value !== "." && value !== "..",
  "invalid file name",
)
const packageArgument = z.string().max(4096).refine(
  (value) => !/[\0-\x1f\x7f]/.test(value),
  "contains control characters",
)
const successExitCodes = z.array(z.number().int().min(0).max(65_535)).min(1).max(32).refine(
  (value) => new Set(value).size === value.length,
  "must be unique",
)
const packageArtifactSchema = z.object({
  kind: z.literal("package"),
  displayName: cleanText(120),
  version: z.string().trim().max(64).refine((value) => !/[\0-\x1f\x7f]/.test(value), "contains control characters"),
  originalFileName: artifactFileName,
  sizeBytes: z.number().int().positive().max(managedArtifacts.MAX_PACKAGE_BYTES),
  installerType: z.enum(["msi", "exe"]),
  arguments: z.array(packageArgument).max(64).default([]),
  successExitCodes: successExitCodes.optional(),
}).strict().superRefine((value, context) => {
  if (!value.originalFileName.toLowerCase().endsWith(`.${value.installerType}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["originalFileName"], message: "extension must match installerType" })
  }
  if (value.installerType === "msi") {
    value.arguments.forEach((argument, index) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*=.+$/.test(argument)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["arguments", index], message: "MSI arguments must be PROPERTY=value" })
      }
    })
    if (value.successExitCodes && (!value.successExitCodes.includes(0) || !value.successExitCodes.includes(3010))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["successExitCodes"], message: "MSI success codes must include 0 and 3010" })
    }
  } else if (value.successExitCodes && !value.successExitCodes.includes(0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["successExitCodes"], message: "EXE success codes must include 0" })
  }
})
const fileArtifactSchema = z.object({
  kind: z.literal("file"),
  displayName: cleanText(120),
  version: z.string().trim().max(64).default(""),
  originalFileName: artifactFileName,
  sizeBytes: z.number().int().positive().max(managedArtifacts.MAX_FILE_BYTES),
}).strict()
const createArtifactSchema = z.union([packageArtifactSchema, fileArtifactSchema])

panelRouter.get(
  "/managed-artifacts",
  asyncHandler((req, res) => {
    const kind = req.query.kind === "package" || req.query.kind === "file" ? req.query.kind : undefined
    return ok(res, managedArtifacts.listManagedArtifacts(kind))
  }),
)

panelRouter.post(
  "/managed-artifacts",
  asyncHandler((req, res) => {
    const body = parseBody(createArtifactSchema, req.body)
    return ok(res, managedArtifacts.createManagedArtifact(body), 201)
  }),
)

panelRouter.put(
  "/managed-artifacts/:id/content",
  asyncHandler(async (req, res) => {
    if (req.header("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/octet-stream") {
      return fail(res, "制品内容必须使用 application/octet-stream", 415)
    }
    const rawLength = req.header("content-length")
    const contentLength = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null
    return ok(res, await managedArtifacts.uploadManagedArtifact(req.params.id, req, contentLength))
  }),
)

panelRouter.delete(
  "/managed-artifacts/:id",
  asyncHandler(async (req, res) => {
    if (!await managedArtifacts.deleteManagedArtifact(req.params.id)) return fail(res, "制品不存在", 404)
    return ok(res, { id: req.params.id })
  }),
)

const packageDeploymentSchema = z.object({
  artifactIds: z.array(z.string().regex(/^artifact-[a-f0-9]{12}$/)).min(1).max(50),
  clientIds: z.array(z.string().min(1)).min(1).max(100),
  timeoutSeconds: z.number().int().min(60).max(7200).default(1800),
}).strict().superRefine((value, context) => {
  if (new Set(value.artifactIds).size !== value.artifactIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifactIds"], message: "must be unique" })
  }
  if (new Set(value.clientIds).size !== value.clientIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["clientIds"], message: "must be unique" })
  }
})

panelRouter.post(
  "/package-deployments",
  asyncHandler((req, res) => {
    const body = parseBody(packageDeploymentSchema, req.body)
    return ok(res, managedArtifacts.createPackageDeployment(body.artifactIds, body.clientIds, body.timeoutSeconds ?? 1800), 201)
  }),
)

const fileDeploymentSchema = z.object({
  artifactId: z.string().regex(/^artifact-[a-f0-9]{12}$/),
  clientIds: z.array(z.string().min(1)).min(1).max(100),
  destinationPath: z.string().min(3).max(32_767).refine(
    (value) => /^[A-Za-z]:\\[^\0-\x1f\x7f]*$/.test(value),
    "destinationPath must be an absolute local Windows path",
  ),
  conflictPolicy: z.enum(["fail", "replace"]).default("fail"),
  createDirectories: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (new Set(value.clientIds).size !== value.clientIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["clientIds"], message: "must be unique" })
  }
})

panelRouter.post(
  "/file-deployments",
  asyncHandler((req, res) => {
    const body = parseBody(fileDeploymentSchema, req.body)
    return ok(res, managedArtifacts.createFileDeployment(
      body.artifactId,
      body.clientIds,
      body.destinationPath,
      body.conflictPolicy ?? "fail",
      body.createDirectories ?? false,
    ), 201)
  }),
)

panelRouter.post(
  "/clients/:clientId/file-deployments/:commandId/rollback",
  asyncHandler((req, res) => ok(res, managedArtifacts.createFileDeploymentRollback(
    req.params.clientId,
    req.params.commandId,
  ), 201)),
)

panelRouter.get(
  "/deployment-batches",
  asyncHandler((req, res) => {
    const kind = req.query.kind === "package" || req.query.kind === "file" ? req.query.kind : undefined
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 20
    return ok(res, managedArtifacts.listDeploymentBatches(kind, Number.isFinite(limit) ? limit : 20))
  }),
)

panelRouter.get(
  "/deployment-batches/:id",
  asyncHandler((req, res) => {
    const batch = managedArtifacts.getDeploymentBatch(req.params.id)
    return batch ? ok(res, batch) : fail(res, "部署批次不存在", 404)
  }),
)

panelRouter.post(
  "/commands/batch",
  asyncHandler((req, res) => {
    const body = parseBody(batchCommandSchema, req.body)
    const targets = body.clientIds.map((id) => clients.getClient(id))
    const missing = body.clientIds.filter((_id, index) => !targets[index])
    if (missing.length > 0) return fail(res, "部分客户端不存在", 404, { clientIds: missing })
    const nonWindows = targets.filter((client) => client?.os !== "Windows").map((client) => client?.id)
    if (nonWindows.length > 0) return fail(res, "批量命令仅支持 Windows 客户端", 400, { clientIds: nonWindows })
    if (body.type === "open-url") {
      const offline = targets.filter((client) => client?.status !== "online").map((client) => client?.id)
      if (offline.length > 0) return fail(res, "打开网页仅支持当前在线的 Windows 客户端", 400, { clientIds: offline })
    }
    const expiresBase = Date.now()
    const created = body.clientIds.map((clientId) => commands.dispatchCommand({
      clientId,
      type: body.type,
      payload: addServerCommandFields(body.type, body.payload, expiresBase),
    }))
    logs.recordLog("info", "command", `创建 Windows 批量命令：${body.type}`, `targets=${created.length}`)
    return ok(res, { commands: created }, 201)
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
    if (!health.markRead(req.params.id)) return fail(res, "健康发现项不存在", 404)
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

panelRouter.post(
  "/health/collections",
  asyncHandler((req, res) => ok(res, health.createCollections(parseBody(healthCollectionSchema, req.body)), 201)),
)

panelRouter.get(
  "/health/packages/:id/download",
  asyncHandler((req, res) => {
    const download = health.getPackageDownload(req.params.id)
    res.setHeader("Content-Type", "application/json; charset=utf-8")
    res.setHeader("Content-Length", String(download.sizeBytes))
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("X-Content-SHA256", download.sha256)
    return res.download(download.filePath, download.fileName)
  }),
)

panelRouter.post(
  "/health/packages/:id/reanalyze",
  asyncHandler((req, res) => {
    parseBody(z.object({}).strict(), req.body)
    return ok(res, health.reanalyzePackage(req.params.id))
  }),
)

panelRouter.post(
  "/health/packages/:id/recollect",
  asyncHandler((req, res) => {
    parseBody(z.object({}).strict(), req.body)
    return ok(res, health.recollectPackage(req.params.id), 201)
  }),
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

/* ==================== 安装档案 ==================== */
const printableText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "不得包含控制字符")

const nullableTrimmed = (maximum: number) => z.string().trim().max(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "不得包含控制字符")
  .transform((value) => value || null).nullable()

const agentServerUrlSchema = z.string().trim().max(2048)
  .transform((value) => value || null).nullable().refine((value) => {
    if (value === null) return true
    try {
      const parsed = new URL(value)
      return ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
        (parsed.pathname === "/" || parsed.pathname === "")
    } catch { return false }
  }, "必须是根路径上的绝对 HTTP/HTTPS 地址，且不得包含凭据、查询或片段")

const installProfileValuesSchema = z.object({
  name: printableText(80),
  runMode: z.enum(["menu", "silent"]),
  agentServerUrl: agentServerUrlSchema,
  heartbeatSeconds: z.number().int().min(5).max(3600),
  pollSeconds: z.number().int().min(5).max(3600),
  clientName: nullableTrimmed(100),
  group: printableText(80),
  tags: z.array(printableText(40)).max(20)
    .refine((items) => new Set(items.map((item) => item.toLocaleLowerCase())).size === items.length, "标签不得重复"),
  overwriteExisting: z.boolean(),
  reEnrollOnServerChange: z.boolean(),
}).strict()

const installProfileCreateSchema = installProfileValuesSchema.extend({
  note: z.string().trim().max(500).optional(),
}).strict()

const installProfileUpdateSchema = installProfileValuesSchema.extend({
  expectedRevision: z.number().int().positive(),
  expectedActiveRevision: z.number().int().positive(),
  note: z.string().trim().max(500).optional(),
}).strict()

panelRouter.get(
  "/install-profiles",
  asyncHandler((_req, res) => ok(res, installProfiles.listProfiles())),
)

panelRouter.post(
  "/install-profiles",
  asyncHandler((req, res) => {
    const { note, ...input } = parseBody(installProfileCreateSchema, req.body)
    return ok(res, installProfiles.createProfile(input, note), 201)
  }),
)

panelRouter.put(
  "/install-profiles/:id",
  asyncHandler((req, res) => {
    const { expectedRevision, expectedActiveRevision, note, ...input } = parseBody(installProfileUpdateSchema, req.body)
    return ok(res, installProfiles.updateProfile(req.params.id, input, expectedRevision, expectedActiveRevision, note))
  }),
)

panelRouter.delete(
  "/install-profiles/:id",
  asyncHandler((req, res) => ok(res, installProfiles.deleteProfile(req.params.id))),
)

panelRouter.post(
  "/install-profiles/:id/default",
  asyncHandler((req, res) => {
    parseBody(z.object({}).strict(), req.body)
    return ok(res, installProfiles.setDefaultProfile(req.params.id))
  }),
)

panelRouter.get(
  "/install-profiles/:id/revisions",
  asyncHandler((req, res) => ok(res, installProfiles.listRevisions(req.params.id))),
)

panelRouter.post(
  "/install-profiles/:id/revisions/:revision/restore",
  asyncHandler((req, res) => {
    const revision = z.coerce.number().int().positive().parse(req.params.revision)
    const body = parseBody(z.object({
      expectedRevision: z.number().int().positive(),
      expectedActiveRevision: z.number().int().positive(),
      note: z.string().trim().max(500).optional(),
    }).strict(), req.body)
    return ok(res, installProfiles.restoreRevision(
      req.params.id,
      revision,
      body.expectedRevision,
      body.expectedActiveRevision,
      body.note,
    ))
  }),
)
