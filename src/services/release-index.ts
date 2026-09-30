import { verify, type KeyObject } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { config } from "../config"

export const UPDATE_ORIGIN = process.env.NACHO_UPDATE_ORIGIN || "https://updates.example.invalid"
export const RELEASE_INDEX_URL = `${UPDATE_ORIGIN}/updates/stable/index.json`
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2qjcjfU4N2/nMmD9XkemMqqq6P0K6OVfjAnwlBJDU1g=
-----END PUBLIC KEY-----`

export type ReleaseComponent = "panel" | "server" | "agent"
export type ReleaseEntry = {
  version: string
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
  schemaVersion: 2 | 3
  channel: "stable" | "beta" | "alpha"
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
    ...index, schemaVersion: 3,
    releases: {
      panel: { ...panel, ...panelAsset },
      server: { ...server, ...source, source, agent },
      agent: { ...server, ...agent, minServerVersion: server.minServerVersion },
    },
  } as ReleaseIndex
}
const channelFile = () => path.join(path.dirname(config.databasePath), "update-channel.json")
export function getUpdateChannel(): UpdateChannel {
  try {
    const value = JSON.parse(fs.readFileSync(channelFile(), "utf8")) as { channel?: UpdateChannel }
    return channels.includes(value.channel as UpdateChannel) ? value.channel! : "stable"
  } catch { return "stable" }
}
export function indexUrl(channel = getUpdateChannel()) {
  if (!channels.includes(channel)) throw new Error("无效更新频道")
  if (UPDATE_ORIGIN === "https://updates.example.invalid") throw new Error("请先配置独立更新服务器的 NACHO_UPDATE_ORIGIN")
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(UPDATE_ORIGIN)) throw new Error("更新服务器 HTTPS 地址无效")
  return `${UPDATE_ORIGIN}/updates/${channel}/index.json`
}
export function setUpdateChannel(channel: UpdateChannel) {
  if (!channels.includes(channel)) throw new Error("无效更新频道")
  fs.mkdirSync(path.dirname(channelFile()), { recursive: true })
  fs.writeFileSync(`${channelFile()}.tmp`, JSON.stringify({ channel }), { mode: 0o600 })
  fs.renameSync(`${channelFile()}.tmp`, channelFile())
  memory = null
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

function validateEntry(component: ReleaseComponent, value: unknown): ReleaseEntry {
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
  const expected = `${UPDATE_ORIGIN}/artifacts/${component}/${item.version}/${item.sha256}/${item.fileName}`
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
        win.url !== `${UPDATE_ORIGIN}/artifacts/server/${item.version}/${win.sha256}/${fileName}` ||
        typeof win.sha256 !== "string" || !SHA.test(win.sha256) ||
        !Number.isSafeInteger(win.sizeBytes) || Number(win.sizeBytes) < 1 || Number(win.sizeBytes) > MAX_ARTIFACT_BYTES) {
      throw new Error("Windows 服务端发布信息无效")
    }
  }
  return item as ReleaseEntry
}

export function verifyReleaseIndex(bytes: Buffer, signature: Buffer, publicKey: string | KeyObject = RELEASE_PUBLIC_KEY): ReleaseIndex {
  if (!bytes.length || bytes.length > MAX_INDEX_BYTES || signature.length !== 64 ||
      !verify(null, bytes, publicKey, signature)) throw new Error("发布索引签名无效")
  const parsed: unknown = JSON.parse(bytes.toString("utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("发布索引格式无效")
  const index = parsed as Record<string, unknown>
  if (![2, 3].includes(index.schemaVersion as number) || !channels.includes(index.channel as UpdateChannel) ||
      !Number.isSafeInteger(index.sequence) || Number(index.sequence) < 1 ||
      typeof index.publishedAt !== "string" || !Number.isFinite(Date.parse(index.publishedAt)) ||
      !index.releases || typeof index.releases !== "object" || Array.isArray(index.releases)) throw new Error("发布索引格式无效")
  const releases = index.releases as Record<string, unknown>
  if (index.schemaVersion === 3) return normalizeV3(index)
  for (const name of ["panel", "server", "agent"] as const) validateEntry(name, releases[name])
  return index as ReleaseIndex
}

let memory: { index: ReleaseIndex; checkedAt: number; channel: UpdateChannel } | null = null
const cacheFile = (channel: UpdateChannel) => path.join(path.dirname(config.databasePath), `release-index-cache-${channel}.json`)

async function download(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
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
  return bytes
}

export async function getReleaseIndex(force = false, channel = getUpdateChannel()): Promise<{ index: ReleaseIndex; stale: boolean }> {
  if (!force && memory?.channel === channel && Date.now() - memory.checkedAt < 24 * 60 * 60 * 1000) return { index: memory.index, stale: false }
  let old: ReleaseIndex | null = null
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile(channel), "utf8")) as { bytes: string; signature: string }
    old = verifyReleaseIndex(Buffer.from(cached.bytes, "base64"), Buffer.from(cached.signature, "base64"))
    if (old.channel !== channel) old = null
  } catch { /* 损坏或不存在的缓存不可用于升级 */ }
  try {
    const [bytes, signature] = await Promise.all([
      download(indexUrl(channel), MAX_INDEX_BYTES),
      download(`${indexUrl(channel)}.sig`, 128),
    ])
    const index = verifyReleaseIndex(bytes, signature)
    if (index.channel !== channel) throw new Error("更新频道与签名索引不一致")
    if (old && index.sequence < old.sequence) throw new Error("发布索引发生版本倒退")
    for (const component of ["panel", "server", "agent"] as const) {
      if (old && compareReleaseVersions(index.releases[component].version, old.releases[component].version) < 0) {
        throw new Error(`${component} 发布版本倒退`)
      }
    }
    fs.mkdirSync(path.dirname(cacheFile(channel)), { recursive: true })
    fs.writeFileSync(`${cacheFile(channel)}.tmp`, JSON.stringify({ bytes: bytes.toString("base64"), signature: signature.toString("base64") }))
    fs.renameSync(`${cacheFile(channel)}.tmp`, cacheFile(channel))
    memory = { index, checkedAt: Date.now(), channel }
    return { index, stale: false }
  } catch (error) {
    if (old && !(error instanceof Error && /倒退|签名无效/.test(error.message))) return { index: old, stale: true }
    throw error
  }
}
