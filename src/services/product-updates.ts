import fs from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { config } from "../config"
import { agentArtifactVersion, syncAgentRelease } from "./agent-release-sync"
import * as clients from "./clients"
import { compareReleaseVersions, getReleaseIndex, getUpdateChannel, setUpdateChannel, type UpdateChannel } from "./release-index"

const packageInfo = JSON.parse(fs.readFileSync(path.join(config.rootDir, "package.json"), "utf8")) as { version: string }
const compatibility = JSON.parse(fs.readFileSync(path.join(config.rootDir, "deploy", "compatibility.json"), "utf8")) as {
  apiVersion: number
  minPanelVersion: string
  minAgentVersion: string
  features: Record<string, string>
  routes: Array<{ prefix: string; methods: string[]; minPanelVersion: string }>
}
const requestPath = path.join(path.dirname(config.databasePath), "update-requests", "request.json")
const lockPath = path.join(path.dirname(config.databasePath), "update-requests", ".pending")
const statusPath = path.join(path.dirname(config.databasePath), "update-status", "status.json")

export function runtimeInfo() {
  let status: unknown = null
  try { status = JSON.parse(fs.readFileSync(statusPath, "utf8")) } catch { /* 尚未升级 */ }
  if (fs.existsSync(lockPath) && (!status || (typeof status === "object" &&
      status !== null && ["healthy", "failed"].includes((status as { phase?: string }).phase || "")))) {
    status = { phase: "queued", version: null, at: new Date().toISOString() }
  }
  return {
    version: packageInfo.version,
    apiVersion: compatibility.apiVersion,
    minPanelVersion: compatibility.minPanelVersion,
    minAgentVersion: compatibility.minAgentVersion,
    capabilities: { agentUpdates: true, productUpdates: true, featureMinimums: compatibility.features },
    agentArtifactVersion: agentArtifactVersion(),
    updateExecutor: process.platform === "linux" && fs.existsSync("/etc/systemd/system/control-server-updater.path"),
    updateStatus: status,
    updateChannel: getUpdateChannel(),
  }
}

export function operationCompatibility(method: string, requestPath: string, panelVersion: string | undefined): string | null {
  const route = compatibility.routes.find((item) => item.methods.includes(method.toUpperCase()) &&
    (requestPath === item.prefix || requestPath.startsWith(`${item.prefix}/`)))
  if (!route) return null
  try {
    if (panelVersion && compareReleaseVersions(panelVersion, route.minPanelVersion) >= 0) return null
  } catch { /* 无效版本不能绕过能力门槛 */ }
  return route.minPanelVersion
}

export async function availableUpdates() {
  const releases = await getReleaseIndex()
  return { ...runtimeInfo(), ...releases }
}
export async function changeUpdateChannel(channel: UpdateChannel) {
  const { index, stale } = await getReleaseIndex(true, channel)
  if (stale) throw new Error("离线索引不可用于切换频道")
  if (compareReleaseVersions(index.releases.server.version, packageInfo.version) < 0) throw new Error("目标频道服务端版本低于当前版本")
  const agent = agentArtifactVersion()
  if (agent && compareReleaseVersions(index.releases.agent.version, agent) < 0) throw new Error("目标频道 Agent 制品版本低于当前版本")
  setUpdateChannel(channel)
  return { channel }
}

export async function requestServerUpdate(version: string, panelVersion: string) {
  if (process.platform !== "linux") throw new Error("Windows 本机服务请使用面板本机管理器升级")
  if (!fs.existsSync("/etc/systemd/system/control-server-updater.path")) throw new Error("尚未安装独立升级执行器")
  const { index, stale } = await getReleaseIndex(true)
  if (stale) throw new Error("离线缓存不可用于升级")
  const target = index.releases.server
  if (target.version !== version || compareReleaseVersions(version, packageInfo.version) <= 0) throw new Error("目标版本不是可信的新版本")
  if (target.minPanelVersion && compareReleaseVersions(panelVersion, target.minPanelVersion) < 0) throw new Error("请先升级面板再升级服务端")
  if (target.minAgentVersion) {
    const incompatible = clients.listClients().filter((client) => client.status !== "unregistered" && client.os === "Windows")
      .filter((client) => {
        try { return compareReleaseVersions(client.version, target.minAgentVersion!) < 0 }
        catch { return true }
      })
    if (incompatible.length) throw new Error(`存在 ${incompatible.length} 台 Agent 不兼容目标服务端，请先手动更新`)
  }
  const request = { version, sequence: index.sequence, channel: getUpdateChannel(), requestedAt: new Date().toISOString() }
  fs.mkdirSync(path.dirname(requestPath), { recursive: true })
  try { fs.mkdirSync(lockPath) } catch { throw new Error("服务端升级已经在执行") }
  const temporary = `${requestPath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(request), { flag: "wx", mode: 0o600 })
    fs.renameSync(temporary, requestPath)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    fs.rmdirSync(lockPath)
    throw error
  }
  return request
}

export { syncAgentRelease }
