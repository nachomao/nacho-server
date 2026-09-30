import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { config } from "../config"
import { db } from "../db"
import { getReleaseIndex, compareReleaseVersions, type ReleaseEntry } from "./release-index"
import { readAgentRelease } from "./agent-updates"

let syncing: Promise<{ version: string; updated: boolean }> | null = null

function localVersion(): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(config.artifactsPath, "windows", "latest.json"), "utf8")) as { version: string }
    return manifest.version
  } catch { return null }
}

export function agentArtifactVersion(): string | null { return localVersion() }

async function install(entry: ReleaseEntry) {
  const directory = path.join(config.artifactsPath, "windows")
  fs.mkdirSync(directory, { recursive: true })
  const target = path.join(directory, entry.fileName)
  const temporary = `${target}.${randomUUID()}.download`
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`Agent 制品下载失败（HTTP ${response.status}）`)
  const hash = createHash("sha256")
  let size = 0
  try {
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          if (size > entry.sizeBytes) return callback(new Error("Agent 制品超过发布大小"))
          hash.update(chunk)
          callback(null, chunk)
        },
      }), fs.createWriteStream(temporary, { flags: "wx" }))
    if (size !== entry.sizeBytes || hash.digest("hex") !== entry.sha256) throw new Error("Agent 制品大小或 SHA-256 不匹配")
    fs.renameSync(temporary, target)
    const manifest = {
      version: entry.version, fileName: entry.fileName, sha256: entry.sha256,
      sizeBytes: entry.sizeBytes, publishedAt: entry.publishedAt, rid: "win-x64",
    }
    const manifestPath = path.join(directory, "latest.json")
    fs.writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`)
    fs.renameSync(`${manifestPath}.tmp`, manifestPath)
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true })
  }
}

/** 离线待执行的命令仍须能下载它们下发时指定的旧版本。 */
export function pruneUnusedAgentArtifacts() {
  const directory = path.join(config.artifactsPath, "windows")
  if (!fs.existsSync(directory)) return
  const current = JSON.parse(fs.readFileSync(path.join(directory, "latest.json"), "utf8")) as { fileName: string }
  const referenced = new Set<string>([current.fileName])
  const active = db.prepare("SELECT payload FROM commands WHERE type='update-agent' AND status IN ('pending','sent','running')").all() as Array<{ payload: string | null }>
  for (const row of active) {
    try {
      const name = (JSON.parse(row.payload || "{}") as { fileName?: string }).fileName
      if (name && /^nacho-agent-\d+\.\d+\.\d+-win-x64\.exe$/.test(name)) referenced.add(name)
    } catch { /* 坏命令不应使制品清理失败 */ }
  }
  for (const name of fs.readdirSync(directory)) {
    if (/^nacho-agent-\d+\.\d+\.\d+-win-x64\.exe$/.test(name) && !referenced.has(name)) {
      fs.rmSync(path.join(directory, name), { force: true })
    }
  }
}

export function syncAgentRelease(force = false): Promise<{ version: string; updated: boolean }> {
  if (syncing) return syncing
  syncing = (async () => {
    const { index, stale } = await getReleaseIndex(force)
    if (stale) throw new Error("发布索引离线缓存不可用于安装")
    const entry = index.releases.agent
    let current: string | null = null
    try { current = readAgentRelease().version } catch { /* 本地制品缺失或损坏时重新获取受信任版本 */ }
    // 双仓 GitHub 发布仅在管理员从面板明确准备 Agent 制品时传输，不在启动时自动下载。
    if (index.schemaVersion === 3 && !force) return { version: current || "", updated: false }
    if (current && compareReleaseVersions(entry.version, current) <= 0) {
      pruneUnusedAgentArtifacts()
      return { version: current, updated: false }
    }
    if (entry.minServerVersion) {
      const server = JSON.parse(fs.readFileSync(path.join(config.rootDir, "package.json"), "utf8")) as { version: string }
      if (compareReleaseVersions(server.version, entry.minServerVersion) < 0) throw new Error("需要先升级服务端才能提供此 Agent 版本")
    }
    await install(entry)
    pruneUnusedAgentArtifacts()
    return { version: entry.version, updated: true }
  })().finally(() => { syncing = null })
  return syncing
}
