import { config } from "../config"
import { db } from "../db"
import { makeToken, shortId } from "../lib/ids"
import type { Client, ClientMetrics, ClientOS, ClientStatus } from "../types"
import { recordLog } from "./logs"
import { isClientConnected } from "./realtime"

type ClientRow = {
  id: string
  name: string
  hostname: string
  ip: string
  os: string
  os_name: string | null
  status: string
  tags: string
  grp: string
  version: string
  token: string
  last_seen: number
  registered_at: number
  metrics: string | null
}

function mapClient(r: ClientRow): Client {
  return {
    id: r.id,
    name: r.name,
    hostname: r.hostname,
    ip: r.ip,
    os: r.os as ClientOS,
    osName: r.os_name ?? "",
    status: computeStatus(r),
    tags: parseArr(r.tags),
    group: r.grp,
    version: r.version,
    lastSeen: r.last_seen,
    registeredAt: r.registered_at,
    metrics: r.metrics ? (JSON.parse(r.metrics) as ClientMetrics) : null,
  }
}

function parseArr(s: string): string[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** 根据心跳时间与存储状态计算实时在线状态 */
function computeStatus(r: ClientRow): ClientStatus {
  if (r.status === "warning") {
    // 告警状态下仍要判断是否已离线
    if (Date.now() - r.last_seen > config.offlineThreshold * 1000) return "offline"
    return "warning"
  }
  if (Date.now() - r.last_seen > config.offlineThreshold * 1000) return "offline"
  return "online"
}

export function listClients(): Client[] {
  const rows = db.prepare("SELECT * FROM clients ORDER BY registered_at DESC").all() as ClientRow[]
  return rows.map(mapClient)
}

export function getClient(id: string): Client | null {
  const row = db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as ClientRow | undefined
  return row ? mapClient(row) : null
}

export type RegisterInput = {
  name: string
  hostname?: string
  ip?: string
  os?: ClientOS
  /** 具体系统名，Windows 上报版本描述，Linux 上报 /etc/os-release 的 ID */
  osName?: string
  version?: string
  tags?: string[]
  group?: string
  /** 客户端可携带上次的 id 以重连（幂等注册） */
  id?: string
}

/** 客户端注册：返回带 token 的客户端记录（token 仅注册时返回一次） */
export function registerClient(input: RegisterInput): { client: Client; token: string } {
  const now = Date.now()
  const existing = input.id
    ? (db.prepare("SELECT * FROM clients WHERE id = ?").get(input.id) as ClientRow | undefined)
    : undefined

  ensureGroup(input.group || "默认分组")

  if (existing) {
    const token = existing.token || makeToken()
    db.prepare(
      `UPDATE clients SET name=@name, hostname=@hostname, ip=@ip, os=@os, os_name=@osName, version=@version,
       tags=@tags, grp=@grp, token=@token, status='online', last_seen=@now WHERE id=@id`,
    ).run({
      id: existing.id,
      name: input.name || existing.name,
      hostname: input.hostname ?? existing.hostname,
      ip: input.ip ?? existing.ip,
      os: input.os ?? existing.os,
      osName: input.osName ?? existing.os_name ?? "",
      version: input.version ?? existing.version,
      tags: JSON.stringify(input.tags ?? parseArr(existing.tags)),
      grp: input.group ?? existing.grp,
      token,
      now,
    })
    recordLog("info", "client", `客户端重新注册：${input.name}`, `id=${existing.id}`)
    return { client: getClient(existing.id)!, token }
  }

  const id = shortId("cl")
  const token = makeToken()
  db.prepare(
    `INSERT INTO clients (id, name, hostname, ip, os, os_name, status, tags, grp, version, token, last_seen, registered_at, metrics)
     VALUES (@id, @name, @hostname, @ip, @os, @osName, 'online', @tags, @grp, @version, @token, @now, @now, NULL)`,
  ).run({
    id,
    name: input.name,
    hostname: input.hostname ?? "",
    ip: input.ip ?? "",
    os: input.os ?? "Linux",
    osName: input.osName ?? "",
    tags: JSON.stringify(input.tags ?? []),
    grp: input.group ?? "默认分组",
    version: input.version ?? "",
    token,
    now,
  })
  recordLog("info", "client", `新客户端注册：${input.name}`, `id=${id}`)
  return { client: getClient(id)!, token }
}

/** 客户端心跳/状态上报 */
export function heartbeat(id: string, metrics?: ClientMetrics, ip?: string, version?: string, osName?: string): Client | null {
  const row = db.prepare("SELECT id FROM clients WHERE id = ?").get(id) as { id: string } | undefined
  if (!row) return null
  db.prepare(
    `UPDATE clients SET last_seen = @now, status = 'online', metrics = @metrics, ip = COALESCE(@ip, ip),
     version = COALESCE(@version, version), os_name = COALESCE(@osName, os_name) WHERE id = @id`,
  ).run({
    id,
    now: Date.now(),
    metrics: metrics ? JSON.stringify(metrics) : null,
    ip: ip ?? null,
    version: version ?? null,
    osName: osName ?? null,
  })
  return getClient(id)
}

/** 面板手动录入客户端（占位，等待真实设备注册后合并） */
export function createClient(input: RegisterInput): Client {
  const { client } = registerClient(input)
  // 手动录入的默认视为离线，等待真实心跳
  db.prepare("UPDATE clients SET status='offline', last_seen=0 WHERE id=?").run(client.id)
  return getClient(client.id)!
}

export function updateClient(id: string, patch: Partial<Pick<Client, "name" | "tags" | "group" | "status">>): Client | null {
  const existing = db.prepare("SELECT id FROM clients WHERE id = ?").get(id) as { id: string } | undefined
  if (!existing) return null
  if (patch.group) ensureGroup(patch.group)
  const current = getClient(id)!
  db.prepare("UPDATE clients SET name=@name, tags=@tags, grp=@grp, status=@status WHERE id=@id").run({
    id,
    name: patch.name ?? current.name,
    tags: JSON.stringify(patch.tags ?? current.tags),
    grp: patch.group ?? current.group,
    status: patch.status ?? current.status,
  })
  return getClient(id)
}

export function deleteClient(id: string): boolean {
  const info = db.prepare("DELETE FROM clients WHERE id = ?").run(id)
  db.prepare("DELETE FROM commands WHERE client_id = ?").run(id)
  return info.changes > 0
}

/** 附加实时连接标记（是否有活跃 WebSocket） */
export function withRealtime(client: Client): Client & { connected: boolean } {
  return { ...client, connected: isClientConnected(client.id) }
}

/* -------------------- 分组 -------------------- */

export function ensureGroup(name: string) {
  db.prepare("INSERT OR IGNORE INTO groups (name, created_at) VALUES (?, ?)").run(name, Date.now())
}

export function listGroups(): string[] {
  const rows = db.prepare("SELECT name FROM groups ORDER BY created_at ASC").all() as { name: string }[]
  return rows.map((r) => r.name)
}

export function addGroup(name: string): string[] {
  ensureGroup(name)
  return listGroups()
}

export function deleteGroup(name: string): string[] {
  db.prepare("DELETE FROM groups WHERE name = ?").run(name)
  db.prepare("UPDATE clients SET grp = '默认分组' WHERE grp = ?").run(name)
  return listGroups()
}
