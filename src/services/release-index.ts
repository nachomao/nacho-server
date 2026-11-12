import { verify, type KeyObject } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { config } from "../config"
import { resolveUpdateOrigin as resolveSettingsUpdateOrigin } from "./settings"

export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2qjcjfU4N2/nMmD9XkemMqqq6P0K6OVfjAnwlBJDU1g=
-----END PUBLIC KEY-----`

/** 当前生效的更新源：面板持久化优先，其次 NACHO_UPDATE_ORIGIN。 */
export function resolveUpdateOrigin(): string | null {
  return resolveSettingsUpdateOrigin().origin
}

function requireUpdateOrigin(): string {
  const origin = resolveUpdateOrigin()
  if (!origin) throw new Error("未配置更新源，请在面板“设置 → 更新”中设置，或配置 NACHO_UPDATE_ORIGIN")
  return origin
}

function cacheFilePath() {
  return path.join(path.dirname(config.databasePath), "release-index-cache-recommended.json")
}

const cacheReaders = new Set<() => void>()

/** 面板保存新 origin 后清空所有读者的内存缓存与磁盘缓存。 */
export function invalidateReleaseIndexCache(): void {
  for (const invalidate of cacheReaders) invalidate()
  fs.rmSync(cacheFilePath(), { force: true })
}

export type ReleaseComponent = "panel" | "server" | "agent"
export type ReleaseEntry = {
  version: string
  releaseType?: string
  fileName: string
  url: string
  sha256: string
  sizeBytes: number
  publishedAt: string
  minPanelVersion?: string
  minServerVersion?: string
  minAgentVersion?: string
  apiVersion?: number
  authenticodeThumbprint?: string
  windows?: { fileName: string; url: string; sha256: string; sizeBytes: number }
  source?: { fileName: string; url: string; sha256: string; sizeBytes: number }
  agent?: { fileName: string; url: string; sha256: string; sizeBytes: number }
  title: string
  notes: string
  sourceCommit: string
}
export type ReleaseIndex = {
  schemaVersion: 2 | 3 | 4
  channel?: "stable" | "beta" | "alpha"
  sequence: number
  publishedAt: string
  releases: Record<ReleaseComponent, ReleaseEntry>
}

const MAX_INDEX_BYTES = 32 * 1024
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SHA = /^[a-f0-9]{64}$/
export type UpdateChannel = "stable" | "beta" | "alpha"
const channels: UpdateChannel[] = ["stable", "beta", "alpha"]
function githubAsset(repo: "nacho-main" | "nacho-server", version: string, name: string, value: unknown) {
  if (!value || typeof value !== "object") throw new Error("GitHub 制品信息无效")
  const item = value as Record<string, unknown>
  if (item.fileName !== name || item.url !==
      `https://github.com/nachomao/${repo}/releases/download/v${version}/${name}` ||
      typeof item.sha256 !== "string" || !SHA.test(item.sha256) ||
      !Number.isSafeInteger(item.sizeBytes) || Number(item.sizeBytes) < 1 ||
      Number(item.sizeBytes) > MAX_ARTIFACT_BYTES) throw new Error("GitHub 制品信息无效")
  return item as { fileName: string; url: string; sha256: string; sizeBytes: number }
}
function normalizeV3(index: Record<string, unknown>): ReleaseIndex {
  const releases = index.releases as Record<string, Record<string, unknown>>
  if (!releases || Object.keys(releases).sort().join(",") !== "panel,server") throw new Error("双仓发布信息无效")
  const panel = releases.panel, server = releases.server
  for (const [name, item] of [["panel", panel], ["server", server]] as const) {
    if (!item || typeof item.version !== "string" || !VERSION.test(item.version) ||
        typeof item.title !== "string" || !item.title.trim() ||
        typeof item.notes !== "string" || !item.notes.trim() ||
        typeof item.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(item.sourceCommit) ||
        typeof item.publishedAt !== "string" || !Number.isFinite(Date.parse(item.publishedAt))) {
      throw new Error(`${name} 发布信息无效`)
    }
    if (index.schemaVersion === 4 && (typeof item.releaseType !== "string" ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(item.releaseType))) throw new Error("发布类型无效")
  }
  const panelAsset = githubAsset("nacho-main", panel.version as string,
    `NachoPanel-Setup-${panel.version}.exe`, panel.asset)
  const source = githubAsset("nacho-server", server.version as string,
    `nacho-server-source-${server.version}.tar.gz`, server.source)
  const agent = githubAsset("nacho-server", server.version as string,
    `nacho-agent-${server.version}-win-x64.exe`, server.agent)
  for (const key of ["minPanelVersion", "minAgentVersion", "minServerVersion"]) {
    if (typeof server[key] !== "string" || !VERSION.test(server[key] as string)) throw new Error(`${key} 无效`)
  }
  if (panel.authenticodeThumbprint !== undefined &&
      (typeof panel.authenticodeThumbprint !== "string" ||
       !/^[A-F0-9]{40}$/.test(panel.authenticodeThumbprint))) throw new Error("面板证书指纹无效")
  return {
    ...index,
    releases: {
      panel: { ...panel, ...panelAsset },
      server: { ...server, ...source, source, agent },
      agent: { ...server, ...agent, minServerVersion: server.minServerVersion },
    },
  } as ReleaseIndex
}
export function indexUrl(sequence?: number, origin = requireUpdateOrigin()) {
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1)) throw new Error("推荐索引序号无效")
  return sequence === undefined ? `${origin}/updates/index.json` : `${origin}/updates/revisions/${sequence}/index.json`
}
const FILE: Record<ReleaseComponent, RegExp> = {
  panel: /^NachoPanel-Setup-\d+\.\d+\.\d+\.exe$/,
  server: /^control-server-\d+\.\d+\.\d+-linux-x64\.tar\.gz$/,
  agent: /^nacho-agent-\d+\.\d+\.\d+-win-x64\.exe$/,
}

export function compareReleaseVersions(left: string, right: string): number {
  if (!VERSION.test(left) || !VERSION.test(right)) throw new Error("版本格式无效")
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  }
  return 0
}

function validateEntry(component: ReleaseComponent, value: unknown, origin: string): ReleaseEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${component} 发布信息无效`)
  const item = value as Record<string, unknown>
  const expectedName = component === "panel"
    ? `NachoPanel-Setup-${item.version}.exe`
    : component === "server"
      ? `control-server-${item.version}-linux-x64.tar.gz`
      : `nacho-agent-${item.version}-win-x64.exe`
  if (typeof item.version !== "string" || !VERSION.test(item.version) ||
      typeof item.fileName !== "string" || !FILE[component].test(item.fileName) ||
      item.fileName !== expectedName || typeof item.sha256 !== "string" || !SHA.test(item.sha256) ||
      !Number.isSafeInteger(item.sizeBytes) || Number(item.sizeBytes) < 1 || Number(item.sizeBytes) > MAX_ARTIFACT_BYTES ||
      typeof item.publishedAt !== "string" || !Number.isFinite(Date.parse(item.publishedAt))) {
    throw new Error(`${component} 发布信息无效`)
  }
  const expected = `${origin}/artifacts/${component}/${item.version}/${item.sha256}/${item.fileName}`
  if (item.url !== expected) throw new Error(`${component} 下载地址不在固定发布路径`)
  if (typeof item.title !== "string" || !item.title.trim() ||
      typeof item.notes !== "string" || !item.notes.trim() ||
      typeof item.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(item.sourceCommit)) throw new Error("发布说明或源码提交无效")
  if (item.minPanelVersion !== undefined && (typeof item.minPanelVersion !== "string" || !VERSION.test(item.minPanelVersion))) throw new Error("面板兼容版本无效")
  if (item.minServerVersion !== undefined && (typeof item.minServerVersion !== "string" || !VERSION.test(item.minServerVersion))) throw new Error("服务端兼容版本无效")
  if (item.minAgentVersion !== undefined && (typeof item.minAgentVersion !== "string" || !VERSION.test(item.minAgentVersion))) throw new Error("Agent 兼容版本无效")
  if (item.apiVersion !== undefined && (!Number.isSafeInteger(item.apiVersion) || Number(item.apiVersion) < 1)) throw new Error("API 版本无效")
  if (component === "panel" && item.authenticodeThumbprint !== undefined &&
      (typeof item.authenticodeThumbprint !== "string" ||
       !/^[A-F0-9]{40}$/.test(item.authenticodeThumbprint))) throw new Error("面板证书指纹无效")
  if (component === "server") {
    const win = item.windows as Record<string, unknown> | undefined
    const fileName = `control-server-${item.version}-win-x64.zip`
    if (!win || win.fileName !== fileName ||
        win.url !== `${origin}/artifacts/server/${item.version}/${win.sha256}/${fileName}` ||
        typeof win.sha256 !== "string" || !SHA.test(win.sha256) ||
        !Number.isSafeInteger(win.sizeBytes) || Number(win.sizeBytes) < 1 || Number(win.sizeBytes) > MAX_ARTIFACT_BYTES) {
      throw new Error("Windows 服务端发布信息无效")
    }
  }
  return item as ReleaseEntry
}

export function verifyReleaseIndex(bytes: Buffer, signature: Buffer, publicKey: string | KeyObject = RELEASE_PUBLIC_KEY, origin?: string): ReleaseIndex {
  if (!bytes.length || bytes.length > MAX_INDEX_BYTES || signature.length !== 64 ||
      !verify(null, bytes, publicKey, signature)) throw new Error("发布索引签名无效")
  const parsed: unknown = JSON.parse(bytes.toString("utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("发布索引格式无效")
  const index = parsed as Record<string, unknown>
  if (![2, 3, 4].includes(index.schemaVersion as number) ||
      (index.schemaVersion !== 4 && !channels.includes(index.channel as UpdateChannel)) ||
      (index.schemaVersion === 4 && index.channel !== undefined) ||
      !Number.isSafeInteger(index.sequence) || Number(index.sequence) < 1 ||
      typeof index.publishedAt !== "string" || !Number.isFinite(Date.parse(index.publishedAt)) ||
      !index.releases || typeof index.releases !== "object" || Array.isArray(index.releases)) throw new Error("发布索引格式无效")
  const releases = index.releases as Record<string, unknown>
  if (index.schemaVersion === 3 || index.schemaVersion === 4) return normalizeV3(index)
  const fixedOrigin = origin ?? requireUpdateOrigin()
  for (const name of ["panel", "server", "agent"] as const) validateEntry(name, releases[name], fixedOrigin)
  return index as ReleaseIndex
}

async function download(url: string, maxBytes: number): Promise<{ bytes: Buffer; url: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (response.status === 404) throw new Error("更新服务器尚未提供推荐索引，请先迁移更新服务")
  if (!response.ok) throw new Error(`发布索引读取失败（HTTP ${response.status}）`)
  if (Number(response.headers.get("content-length")) > maxBytes || !response.body) throw new Error("发布索引大小无效")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes) throw new Error("发布索引大小无效")
    chunks.push(Buffer.from(chunk))
  }
  const bytes = Buffer.concat(chunks)
  if (!bytes.length || bytes.length > maxBytes) throw new Error("发布索引大小无效")
  return { bytes, url: response.url || url }
}

export function createReleaseIndexReader(publicKey: string | KeyObject = RELEASE_PUBLIC_KEY) {
  let memory: { index: ReleaseIndex; checkedAt: number; origin: string } | null = null
  let checking: Promise<{ index: ReleaseIndex; stale: boolean }> | null = null
  let generation = 0
  const invalidate = () => {
    memory = null
    checking = null
    generation += 1
  }
  cacheReaders.add(invalidate)
  function getReleaseIndex(force = false, sequence?: number): Promise<{ index: ReleaseIndex; stale: boolean }> {
    if (sequence !== undefined) return loadReleaseIndex(force, sequence)
    if (checking) return checking
    const tracked = loadReleaseIndex(force).finally(() => {
      if (checking === tracked) checking = null
    })
    checking = tracked
    return tracked
  }
  async function loadReleaseIndex(force = false, sequence?: number): Promise<{ index: ReleaseIndex; stale: boolean }> {
    const origin = requireUpdateOrigin()
    const startGeneration = generation
    if (sequence === undefined && !force && memory && memory.origin === origin &&
        Date.now() - memory.checkedAt < 60_000) return { index: memory.index, stale: false }
    let old: ReleaseIndex | null = null
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFilePath(), "utf8")) as {
        origin?: string; bytes: string; signature: string
      }
      // 跨 origin 的缓存不可复用，否则会把旧更新源的索引当成新配置的结果。
      if (cached.origin === origin) {
        old = verifyReleaseIndex(Buffer.from(cached.bytes, "base64"), Buffer.from(cached.signature, "base64"), publicKey, origin)
        if (old.schemaVersion !== 4) old = null
      }
    } catch { /* 损坏、过期或跨 origin 的缓存不可用于升级 */ }
    try {
      const remote = await download(indexUrl(sequence, origin), MAX_INDEX_BYTES)
      const match = /^\/updates\/revisions\/([1-9]\d*)\/index\.json$/.exec(new URL(remote.url).pathname)
      if (new URL(remote.url).origin !== origin || !match ||
          (sequence !== undefined && Number(match[1]) !== sequence)) throw new Error("推荐索引固定地址无效")
      const bytes = remote.bytes
      const { bytes: signature } = await download(`${remote.url}.sig`, 128)
      const index = verifyReleaseIndex(bytes, signature, publicKey, origin)
      if (index.schemaVersion !== 4 || index.sequence !== Number(match[1])) throw new Error("推荐索引序号或协议无效")
      if (sequence !== undefined) return { index, stale: false }
      if (old && (index.sequence < old.sequence ||
          (index.sequence === old.sequence && JSON.stringify(index) !== JSON.stringify(old)))) throw new Error("发布索引发生版本倒退或同序号内容变化")
      for (const component of ["panel", "server", "agent"] as const) {
        if (old && compareReleaseVersions(index.releases[component].version, old.releases[component].version) < 0) {
          throw new Error(`${component} 发布版本倒退`)
        }
        if (old && index.releases[component].version === old.releases[component].version &&
            (index.releases[component].sha256 !== old.releases[component].sha256 ||
             index.releases[component].sizeBytes !== old.releases[component].sizeBytes)) {
          throw new Error(`${component} 同版本内容变化`)
        }
      }
      // 失效发生在请求过程中时丢弃结果，避免旧 origin 的索引写回缓存。
      if (generation !== startGeneration) throw new Error("更新源已变更，请重新检查更新")
      fs.mkdirSync(path.dirname(cacheFilePath()), { recursive: true })
      fs.writeFileSync(`${cacheFilePath()}.tmp`, JSON.stringify({
        origin, bytes: bytes.toString("base64"), signature: signature.toString("base64"),
      }))
      fs.renameSync(`${cacheFilePath()}.tmp`, cacheFilePath())
      memory = { index, checkedAt: Date.now(), origin }
      return { index, stale: false }
    } catch (error) {
      if (generation !== startGeneration) throw new Error("更新源已变更，请重新检查更新")
      if (memory?.origin === origin) memory = null
      if (sequence === undefined && old && error instanceof Error &&
          /HTTP|fetch|网络|超时|timed out|abort/i.test(error.message)) return { index: old, stale: true }
      throw error
    }
  }
  return getReleaseIndex
}
export const getReleaseIndex = createReleaseIndexReader()
