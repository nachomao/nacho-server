import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable, Transform } from "node:stream"
import { config } from "../config"
import { getReleaseIndex, getUpdateChannel, type ReleaseEntry } from "./release-index"
import { requestServerUpdate } from "./product-updates"

type Kind = "server" | "agent"
type Stage = {
  id: string; kind: Kind; version: string; sequence: number; channel: string
  sizeBytes: number; sha256: string; fileName: string; offset: number; phase: "uploading" | "ready"
  publishedAt: string
}
const base = path.join(path.dirname(config.databasePath), "update-staging")
const busy = new Set<string>()
const maxChunk = 8 * 1024 * 1024
function expireAbandoned() {
  fs.mkdirSync(base, { recursive: true })
  for (const id of fs.readdirSync(base)) {
    if (!/^[0-9a-f-]{36}$/.test(id) || busy.has(id)) continue
    try {
      const directory = stagePath(id)
      const metadata = path.join(directory, "stage.json")
      const age = Date.now() - fs.statSync(metadata).mtimeMs
      const stage = read(id)
      if (age > (stage.phase === "ready" ? 7 : 1) * 24 * 60 * 60 * 1000) {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    } catch { /* 不清理未知状态或正在使用的目录 */ }
  }
}
function stagePath(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("上传会话无效")
  return path.join(base, id)
}
function read(id: string): Stage {
  return JSON.parse(fs.readFileSync(path.join(stagePath(id), "stage.json"), "utf8")) as Stage
}
function save(stage: Stage) {
  const directory = stagePath(stage.id)
  fs.writeFileSync(path.join(directory, "stage.json.tmp"), JSON.stringify(stage), { flag: "w", mode: 0o600 })
  fs.renameSync(path.join(directory, "stage.json.tmp"), path.join(directory, "stage.json"))
}
function file(id: string) { return path.join(stagePath(id), "payload") }
function entryFor(kind: Kind, entry: ReleaseEntry) {
  if (kind === "server") return entry.source
  return entry.agent
}
export async function createStage(kind: Kind, version: string) {
  if (kind === "server" && process.platform !== "linux") {
    throw new Error("Windows 本机服务请使用面板本机升级管理器")
  }
  expireAbandoned()
  if (fs.readdirSync(base).filter((id) => /^[0-9a-f-]{36}$/.test(id)).length >= 8) {
    throw new Error("更新上传会话已达上限")
  }
  const { index, stale } = await getReleaseIndex(true)
  if (stale || index.schemaVersion !== 3 || index.releases.server.version !== version) {
    throw new Error("目标不是有效的 GitHub 服务端发布")
  }
  const asset = entryFor(kind, index.releases.server)
  if (!asset) throw new Error("制品信息缺失")
  const id = randomUUID()
  const stage: Stage = { id, kind, version, sequence: index.sequence, channel: getUpdateChannel(),
    sizeBytes: asset.sizeBytes, sha256: asset.sha256, fileName: asset.fileName,
    offset: 0, phase: "uploading", publishedAt: index.releases.server.publishedAt }
  fs.mkdirSync(stagePath(id), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file(id), "", { flag: "wx", mode: 0o600 })
  save(stage)
  return stage
}
export function getStage(id: string) { return read(id) }
export async function appendStage(id: string, offset: number, input: Readable, length: number) {
  const stage = read(id)
  if (stage.phase !== "uploading" || offset !== stage.offset || length < 1 || length > maxChunk ||
      offset + length > stage.sizeBytes || busy.has(id)) throw new Error("分块位置、大小或会话状态无效")
  busy.add(id)
  let received = 0
  try {
    const output = fs.createWriteStream(file(id), { flags: "r+", start: offset })
    await pipeline(input, new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        callback(received <= length ? null : new Error("上传分块超过声明大小"), chunk)
      },
    }), output)
    if (received !== length) throw new Error("上传分块未完整接收")
    stage.offset += received
    save(stage)
    return stage
  } catch (error) {
    fs.truncateSync(file(id), offset)
    throw error
  } finally { busy.delete(id) }
}
export async function commitStage(id: string, panelVersion: string) {
  const stage = read(id)
  if (stage.phase === "ready") return stage
  if (stage.phase !== "uploading" || busy.has(id) || stage.offset !== stage.sizeBytes) {
    throw new Error("会话尚未完整传输或已提交")
  }
  const { index, stale } = await getReleaseIndex(true)
  const asset = entryFor(stage.kind, index.releases.server)
  if (stale || index.schemaVersion !== 3 || index.channel !== stage.channel ||
      index.sequence < stage.sequence || index.releases.server.version !== stage.version ||
      !asset || asset.sha256 !== stage.sha256 || asset.sizeBytes !== stage.sizeBytes) {
    throw new Error("发布清单与上传会话不匹配")
  }
  const hash = createHash("sha256")
  for await (const chunk of fs.createReadStream(file(id))) hash.update(chunk)
  if (hash.digest("hex") !== stage.sha256 || fs.statSync(file(id)).size !== stage.sizeBytes) {
    throw new Error("上传制品哈希或大小不匹配")
  }
  if (stage.kind === "agent") {
    const directory = path.join(config.artifactsPath, "windows")
    fs.mkdirSync(directory, { recursive: true })
    const destination = path.join(directory, stage.fileName)
    fs.copyFileSync(file(id), `${destination}.tmp`)
    fs.renameSync(`${destination}.tmp`, destination)
    const manifest = { version: stage.version, fileName: stage.fileName, sha256: stage.sha256,
      sizeBytes: stage.sizeBytes, rid: "win-x64", publishedAt: stage.publishedAt }
    fs.writeFileSync(path.join(directory, "latest.json.tmp"), JSON.stringify(manifest))
    fs.renameSync(path.join(directory, "latest.json.tmp"), path.join(directory, "latest.json"))
  } else {
    await requestServerUpdate(stage.version, panelVersion, id)
  }
  stage.phase = "ready"
  save(stage)
  return stage
}
