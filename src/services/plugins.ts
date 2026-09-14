import { db } from "../db"
import { shortId } from "../lib/ids"
import type { Plugin, PluginParam, PluginStatus } from "../types"
import { recordLog } from "./logs"

type PluginRow = {
  id: string
  name: string
  version: string
  author: string
  category: string
  description: string
  size: string
  icon: string
  status: string
  restart_restore: number
  params: string
  created_at: number
}

function mapPlugin(r: PluginRow): Plugin {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    author: r.author,
    category: r.category,
    description: r.description,
    size: r.size,
    icon: r.icon,
    status: r.status as PluginStatus,
    restartRestore: r.restart_restore === 1,
    params: parseParams(r.params),
    createdAt: r.created_at,
  }
}

function parseParams(s: string): PluginParam[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function listPlugins(): Plugin[] {
  const rows = db.prepare("SELECT * FROM plugins ORDER BY created_at DESC").all() as PluginRow[]
  return rows.map(mapPlugin)
}

export function getPlugin(id: string): Plugin | null {
  const row = db.prepare("SELECT * FROM plugins WHERE id = ?").get(id) as PluginRow | undefined
  return row ? mapPlugin(row) : null
}

export type PluginInput = Omit<Plugin, "id" | "createdAt">

export function createPlugin(input: PluginInput): Plugin {
  const id = shortId("pg")
  db.prepare(
    `INSERT INTO plugins (id, name, version, author, category, description, size, icon, status, restart_restore, params, created_at)
     VALUES (@id, @name, @version, @author, @category, @description, @size, @icon, @status, @restartRestore, @params, @now)`,
  ).run({
    id,
    name: input.name,
    version: input.version,
    author: input.author,
    category: input.category,
    description: input.description,
    size: input.size,
    icon: input.icon,
    status: input.status,
    restartRestore: input.restartRestore ? 1 : 0,
    params: JSON.stringify(input.params ?? []),
    now: Date.now(),
  })
  recordLog("info", "plugin", `新增插件：${input.name}`, `id=${id}`)
  return getPlugin(id)!
}

export function updatePlugin(id: string, input: Partial<PluginInput>): Plugin | null {
  const current = getPlugin(id)
  if (!current) return null
  const merged = { ...current, ...input }
  db.prepare(
    `UPDATE plugins SET name=@name, version=@version, author=@author, category=@category, description=@description,
     size=@size, icon=@icon, status=@status, restart_restore=@restartRestore, params=@params WHERE id=@id`,
  ).run({
    id,
    name: merged.name,
    version: merged.version,
    author: merged.author,
    category: merged.category,
    description: merged.description,
    size: merged.size,
    icon: merged.icon,
    status: merged.status,
    restartRestore: merged.restartRestore ? 1 : 0,
    params: JSON.stringify(merged.params ?? []),
  })
  return getPlugin(id)
}

export function deletePlugin(id: string): boolean {
  const changed = db.prepare("DELETE FROM plugins WHERE id = ?").run(id).changes > 0
  if (changed) db.prepare("DELETE FROM notifications WHERE type='plugin' AND source_id=?").run(id)
  return changed
}

export function setStatus(id: string, status: PluginStatus): Plugin | null {
  return updatePlugin(id, { status })
}
