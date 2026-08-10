import crypto from "node:crypto"
import fs from "node:fs"
import { open, mkdir, rename, rm, unlink } from "node:fs/promises"
import path from "node:path"
import type { Readable } from "node:stream"
import { config } from "../config"
import { db } from "../db"
import { HttpError } from "../lib/http"
import { shortId } from "../lib/ids"
import type { Client, Command, CommandStatus } from "../types"
import * as clients from "./clients"
import * as commands from "./commands"
import { recordLog } from "./logs"

export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024
export const MAX_FILE_BYTES = 512 * 1024 * 1024
const DOWNLOADABLE_STATUSES = new Set<CommandStatus>(["pending", "sent", "running"])

export type ArtifactKind = "package" | "file"
export type ArtifactStatus = "draft" | "uploading" | "ready" | "deleted"
export type InstallerType = "msi" | "exe"

export type ManagedArtifact = {
  id: string
  kind: ArtifactKind
  displayName: string
  version: string
  originalFileName: string
  storageName: string
  sizeBytes: number
  sha256: string | null
  installerType: InstallerType | null
  arguments: string[]
  successExitCodes: number[]
  status: ArtifactStatus
  createdAt: number
  updatedAt: number
}

type ArtifactRow = {
  id: string
  kind: string
  display_name: string
  version: string
  original_file_name: string
  storage_name: string
  size_bytes: number
  sha256: string | null
  installer_type: string | null
  arguments: string
  success_exit_codes: string
  status: string
  created_at: number
  updated_at: number
}

type BatchRow = {
  id: string
  kind: string
  status: string
  total_items: number
  created_at: number
  updated_at: number
}

export type CreateArtifactInput = {
  kind: ArtifactKind
  displayName: string
  version?: string
  originalFileName: string
  sizeBytes: number
  installerType?: InstallerType | null
  arguments?: string[]
  successExitCodes?: number[]
}

function parseArray<T>(value: string, fallback: T[]): T[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as T[] : fallback
  } catch {
    return fallback
  }
}

function mapArtifact(row: ArtifactRow): ManagedArtifact {
  return {
    id: row.id,
    kind: row.kind as ArtifactKind,
    displayName: row.display_name,
    version: row.version,
    originalFileName: row.original_file_name,
    storageName: row.storage_name,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    installerType: row.installer_type as InstallerType | null,
    arguments: parseArray<string>(row.arguments, []),
    successExitCodes: parseArray<number>(row.success_exit_codes, [0]),
    status: row.status as ArtifactStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function artifactDirectory(): string {
  return path.join(config.artifactsPath, "managed")
}

function validateFileName(value: string): string {
  if (value !== path.basename(value) || value.length < 1 || value.length > 255 || /[\\/\0-\x1f\x7f]/.test(value)) {
    throw new HttpError(400, "制品文件名无效")
  }
  return value
}

function extensionFor(input: CreateArtifactInput): string {
  const extension = path.extname(input.originalFileName).toLowerCase()
  if (input.kind === "package" && extension !== `.${input.installerType}`) {
    throw new HttpError(400, "安装器类型与文件扩展名不匹配")
  }
  return extension
}

export function createManagedArtifact(input: CreateArtifactInput): ManagedArtifact {
  validateFileName(input.originalFileName)
  const maximum = input.kind === "package" ? MAX_PACKAGE_BYTES : MAX_FILE_BYTES
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > maximum) {
    throw new HttpError(400, `制品大小必须在 1 至 ${maximum} 字节之间`)
  }
  if (input.kind === "package" && !input.installerType) throw new HttpError(400, "软件包缺少安装器类型")
  const id = shortId("artifact")
  const now = Date.now()
  const artifact: ManagedArtifact = {
    id,
    kind: input.kind,
    displayName: input.displayName,
    version: input.version ?? "",
    originalFileName: input.originalFileName,
    storageName: `${id}${extensionFor(input)}`,
    sizeBytes: input.sizeBytes,
    sha256: null,
    installerType: input.installerType ?? null,
    arguments: input.arguments ?? [],
    successExitCodes: input.successExitCodes ?? (input.installerType === "msi" ? [0, 3010] : [0]),
    status: "draft",
    createdAt: now,
    updatedAt: now,
  }
  db.prepare(`INSERT INTO managed_artifacts
    (id, kind, display_name, version, original_file_name, storage_name, size_bytes, sha256, installer_type, arguments, success_exit_codes, status, created_at, updated_at)
    VALUES (@id, @kind, @displayName, @version, @originalFileName, @storageName, @sizeBytes, @sha256, @installerType, @argumentsJson, @successCodesJson, @status, @createdAt, @updatedAt)`)
    .run({
      id: artifact.id,
      kind: artifact.kind,
      displayName: artifact.displayName,
      version: artifact.version,
      originalFileName: artifact.originalFileName,
      storageName: artifact.storageName,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      installerType: artifact.installerType,
      argumentsJson: JSON.stringify(artifact.arguments),
      successCodesJson: JSON.stringify(artifact.successExitCodes),
      status: artifact.status,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    })
  recordLog("info", "artifact", `创建制品草稿：${artifact.kind}`, `artifactId=${artifact.id};sizeBytes=${artifact.sizeBytes}`)
  return artifact
}

export function getManagedArtifact(id: string): ManagedArtifact | null {
  const row = db.prepare("SELECT * FROM managed_artifacts WHERE id = ?").get(id) as ArtifactRow | undefined
  return row ? mapArtifact(row) : null
}

export function listManagedArtifacts(kind?: ArtifactKind): ManagedArtifact[] {
  const rows = kind
    ? db.prepare("SELECT * FROM managed_artifacts WHERE kind = ? AND status != 'deleted' ORDER BY created_at DESC").all(kind) as ArtifactRow[]
    : db.prepare("SELECT * FROM managed_artifacts WHERE status != 'deleted' ORDER BY created_at DESC").all() as ArtifactRow[]
  return rows.map(mapArtifact)
}

export async function uploadManagedArtifact(id: string, input: Readable, contentLength: number | null): Promise<ManagedArtifact> {
  const artifact = getManagedArtifact(id)
  if (!artifact) throw new HttpError(404, "制品不存在")
  if (artifact.status !== "draft") throw new HttpError(409, "制品不处于可上传状态")
  if (contentLength === null || !Number.isSafeInteger(contentLength) || contentLength < 0) throw new HttpError(411, "必须提供有效 Content-Length")
  if (contentLength !== artifact.sizeBytes) throw new HttpError(400, "Content-Length 与草稿声明大小不一致")
  const claimed = db.prepare("UPDATE managed_artifacts SET status='uploading', updated_at=? WHERE id=? AND status='draft'").run(Date.now(), id)
  if (claimed.changes !== 1) throw new HttpError(409, "制品正在上传")

  const directory = artifactDirectory()
  await mkdir(directory, { recursive: true })
  const temporaryPath = path.join(directory, `.${artifact.storageName}.${crypto.randomUUID()}.upload`)
  const finalPath = path.join(directory, artifact.storageName)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  let completed = false
  try {
    handle = await open(temporaryPath, "wx", 0o600)
    const hash = crypto.createHash("sha256")
    let total = 0
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
      total += chunk.byteLength
      if (total > artifact.sizeBytes) throw new HttpError(413, "上传内容超过声明大小")
      hash.update(chunk)
      await handle.write(chunk)
    }
    if (total !== artifact.sizeBytes) throw new HttpError(400, "上传内容大小与声明不一致")
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporaryPath, finalPath)
    const sha256 = hash.digest("hex")
    db.prepare("UPDATE managed_artifacts SET status='ready', sha256=?, updated_at=? WHERE id=?").run(sha256, Date.now(), id)
    completed = true
    recordLog("info", "artifact", "制品上传完成", `artifactId=${id};sizeBytes=${total};sha256=${sha256}`)
    return getManagedArtifact(id)!
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    if (!completed) {
      await unlink(temporaryPath).catch(() => undefined)
      db.prepare("UPDATE managed_artifacts SET status='draft', updated_at=? WHERE id=? AND status='uploading'").run(Date.now(), id)
    }
  }
}

export async function deleteManagedArtifact(id: string): Promise<boolean> {
  const artifact = getManagedArtifact(id)
  if (!artifact || artifact.status === "deleted") return false
  const active = db.prepare(`SELECT 1 FROM deployment_items di JOIN commands c ON c.id=di.command_id
    WHERE di.artifact_id=? AND c.status IN ('pending','sent','running') LIMIT 1`).get(id)
  if (active) throw new HttpError(409, "制品仍有关联的活动命令")
  db.prepare("UPDATE managed_artifacts SET status='deleted', updated_at=? WHERE id=?").run(Date.now(), id)
  await rm(path.join(artifactDirectory(), artifact.storageName), { force: true })
  recordLog("info", "artifact", "删除托管制品", `artifactId=${id}`)
  return true
}

function requirePackageArtifacts(ids: string[]): ManagedArtifact[] {
  return ids.map((id) => {
    const artifact = getManagedArtifact(id)
    if (!artifact) throw new HttpError(404, "部分制品不存在", { artifactIds: [id] })
    if (artifact.kind !== "package" || artifact.status !== "ready" || !artifact.sha256 || !artifact.installerType) {
      throw new HttpError(409, "制品尚未准备好安装", { artifactIds: [id] })
    }
    return artifact
  })
}

function requireFileArtifact(id: string): ManagedArtifact {
  const artifact = getManagedArtifact(id)
  if (!artifact) throw new HttpError(404, "文件制品不存在", { artifactId: id })
  if (artifact.kind !== "file" || artifact.status !== "ready" || !artifact.sha256) {
    throw new HttpError(409, "文件制品尚未准备好", { artifactId: id })
  }
  return artifact
}

function requireOnlineWindowsClients(ids: string[], operation = "部署"): Client[] {
  return ids.map((id) => {
    const client = clients.getClient(id)
    if (!client) throw new HttpError(404, "部分客户端不存在", { clientIds: [id] })
    if (client.os !== "Windows") throw new HttpError(400, `${operation}仅支持 Windows 客户端`, { clientIds: [id] })
    if (client.status !== "online") throw new HttpError(409, `${operation}目标必须当前在线`, { clientIds: [id] })
    return client
  })
}

export function createPackageDeployment(artifactIds: string[], clientIds: string[], timeoutSeconds: number) {
  const artifacts = requirePackageArtifacts(artifactIds)
  const targets = requireOnlineWindowsClients(clientIds, "批量安装")
  const batchId = shortId("batch")
  const now = Date.now()
  const total = artifacts.length * targets.length
  db.prepare("INSERT INTO deployment_batches (id, kind, status, total_items, created_at, updated_at) VALUES (?, 'package', 'pending', ?, ?, ?)")
    .run(batchId, total, now, now)
  const created: Command[] = []
  for (const artifact of artifacts) {
    for (const client of targets) {
      const command = commands.dispatchCommand({
        clientId: client.id,
        type: "install-package",
        payload: {
          artifactId: artifact.id,
          fileName: artifact.originalFileName,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          installerType: artifact.installerType,
          arguments: artifact.arguments,
          successExitCodes: artifact.successExitCodes,
          timeoutSeconds,
        },
      })
      db.prepare("INSERT INTO deployment_items (id, batch_id, command_id, artifact_id, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(shortId("deployment"), batchId, command.id, artifact.id, client.id, now)
      created.push(command)
    }
  }
  recordLog("info", "deployment", "创建软件包部署批次", `batchId=${batchId};packages=${artifacts.length};targets=${targets.length};commands=${created.length}`)
  return getDeploymentBatch(batchId)!
}

export function createFileDeployment(
  artifactId: string,
  clientIds: string[],
  destinationPath: string,
  conflictPolicy: "fail" | "replace",
  createDirectories: boolean,
) {
  const artifact = requireFileArtifact(artifactId)
  const targets = requireOnlineWindowsClients(clientIds, "文件下发")
  const batchId = shortId("batch")
  const now = Date.now()
  db.prepare("INSERT INTO deployment_batches (id, kind, status, total_items, created_at, updated_at) VALUES (?, 'file', 'pending', ?, ?, ?)")
    .run(batchId, targets.length, now, now)
  for (const client of targets) {
    const command = commands.dispatchCommand({
      clientId: client.id,
      type: "deploy-file",
      payload: {
        artifactId: artifact.id,
        fileName: artifact.originalFileName,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        destinationPath,
        conflictPolicy,
        createDirectories,
      },
    })
    db.prepare("INSERT INTO deployment_items (id, batch_id, command_id, artifact_id, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(shortId("deployment"), batchId, command.id, artifact.id, client.id, now)
  }
  recordLog("info", "deployment", "创建文件下发批次", `batchId=${batchId};targets=${targets.length};sizeBytes=${artifact.sizeBytes};conflictPolicy=${conflictPolicy}`)
  return getDeploymentBatch(batchId)!
}

type DeployFileResult = {
  phase: string
  backupValid: boolean
  finalSha256: string | null
}

function parseSuccessfulDeployResult(command: Command): DeployFileResult {
  if (command.type !== "deploy-file" || command.status !== "success" || !command.result) {
    throw new HttpError(409, "原文件下发命令尚未成功")
  }
  try {
    const value = JSON.parse(command.result) as Record<string, unknown>
    if (value.phase !== "success" || value.backupValid !== true || typeof value.finalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.finalSha256)) {
      throw new Error("invalid result")
    }
    return value as DeployFileResult
  } catch {
    throw new HttpError(409, "原文件下发结果没有有效备份")
  }
}

export function createFileDeploymentRollback(clientId: string, originalCommandId: string): Command {
  const client = clients.getClient(clientId)
  if (!client) throw new HttpError(404, "客户端不存在")
  if (client.os !== "Windows") throw new HttpError(400, "文件回滚仅支持 Windows 客户端")
  const row = db.prepare(`SELECT c.* FROM commands c
    JOIN deployment_items di ON di.command_id=c.id
    JOIN deployment_batches dbatch ON dbatch.id=di.batch_id
    WHERE c.id=? AND c.client_id=? AND di.client_id=? AND dbatch.kind='file'`)
    .get(originalCommandId, clientId, clientId) as Parameters<typeof commands.mapCommandRow>[0] | undefined
  if (!row) throw new HttpError(404, "原文件下发命令不存在或不属于该客户端")
  const original = commands.mapCommandRow(row)
  parseSuccessfulDeployResult(original)
  const active = db.prepare(`SELECT id FROM commands WHERE client_id=? AND type='rollback-file-deploy'
    AND status IN ('pending','sent','running','success') AND json_extract(payload, '$.originalCommandId')=? LIMIT 1`)
    .get(clientId, originalCommandId) as { id: string } | undefined
  if (active) throw new HttpError(409, "该文件下发已有进行中的回滚命令", { commandId: active.id })
  const command = commands.dispatchCommand({ clientId, type: "rollback-file-deploy", payload: { originalCommandId } })
  recordLog("info", "deployment", "创建文件下发回滚命令", `commandId=${command.id};originalCommandId=${originalCommandId};clientId=${clientId}`)
  return command
}

function deriveBatchStatus(commandsInBatch: Command[]): string {
  if (commandsInBatch.some((command) => command.status === "running" || command.status === "sent")) return "running"
  if (commandsInBatch.some((command) => command.status === "pending")) return "pending"
  if (commandsInBatch.every((command) => command.status === "success")) return "success"
  if (commandsInBatch.every((command) => command.status === "failed" || command.status === "canceled")) return "failed"
  return "completed-with-failures"
}

export function getDeploymentBatch(id: string) {
  const batch = db.prepare("SELECT * FROM deployment_batches WHERE id=?").get(id) as BatchRow | undefined
  if (!batch) return null
  const rows = db.prepare(`SELECT di.id, di.command_id, di.artifact_id, di.client_id
    FROM deployment_items di WHERE di.batch_id=? ORDER BY di.created_at, di.id`).all(id) as Array<{ id: string; command_id: string; artifact_id: string; client_id: string }>
  const items = rows.map((row) => ({
    id: row.id,
    commandId: row.command_id,
    artifactId: row.artifact_id,
    clientId: row.client_id,
    artifact: getManagedArtifact(row.artifact_id),
    client: clients.getClient(row.client_id),
    command: commands.getCommand(row.command_id),
  }))
  const batchCommands = items.map((item) => item.command).filter((command): command is Command => command !== null)
  const status = deriveBatchStatus(batchCommands)
  if (status !== batch.status) db.prepare("UPDATE deployment_batches SET status=?, updated_at=? WHERE id=?").run(status, Date.now(), id)
  const counts = batchCommands.reduce<Record<string, number>>((result, command) => {
    result[command.status] = (result[command.status] ?? 0) + 1
    return result
  }, {})
  return { id: batch.id, kind: batch.kind, status, totalItems: batch.total_items, createdAt: batch.created_at, updatedAt: batch.updated_at, counts, items }
}

export function listDeploymentBatches(kind?: ArtifactKind, limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  const rows = kind
    ? db.prepare("SELECT id FROM deployment_batches WHERE kind=? ORDER BY created_at DESC LIMIT ?").all(kind, safeLimit) as Array<{ id: string }>
    : db.prepare("SELECT id FROM deployment_batches ORDER BY created_at DESC LIMIT ?").all(safeLimit) as Array<{ id: string }>
  return rows.map((row) => getDeploymentBatch(row.id)).filter((batch): batch is NonNullable<ReturnType<typeof getDeploymentBatch>> => batch !== null)
}

export function authorizeManagedArtifactDownload(clientId: string, artifactId: string, commandId: string) {
  const row = db.prepare(`SELECT a.*, c.status AS command_status, c.client_id AS command_client
    FROM deployment_items di
    JOIN commands c ON c.id=di.command_id
    JOIN managed_artifacts a ON a.id=di.artifact_id
    WHERE di.client_id=? AND di.command_id=? AND di.artifact_id=?`)
    .get(clientId, commandId, artifactId) as (ArtifactRow & { command_status: CommandStatus; command_client: string }) | undefined
  if (!row || row.command_client !== clientId) throw new HttpError(404, "制品下载映射不存在")
  if (!DOWNLOADABLE_STATUSES.has(row.command_status)) throw new HttpError(409, "命令当前不可下载制品")
  const artifact = mapArtifact(row)
  if (artifact.status !== "ready" || !artifact.sha256) throw new HttpError(409, "制品尚未准备好")
  const filePath = path.join(artifactDirectory(), artifact.storageName)
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new HttpError(404, "制品文件不存在")
  return { artifact, filePath }
}
