import { randomUUID } from "node:crypto"
import { db } from "../db"
import { HttpError } from "../lib/http"
import { recordLog } from "./logs"

export type InstallRunMode = "menu" | "silent"

export type InstallProfileValues = {
  name: string
  runMode: InstallRunMode
  agentServerUrl: string | null
  heartbeatSeconds: number
  pollSeconds: number
  clientName: string | null
  group: string
  tags: string[]
  overwriteExisting: boolean
  reEnrollOnServerChange: boolean
}

export type InstallProfile = InstallProfileValues & {
  id: string
  isDefault: boolean
  revision: number
  activeRevision: number
  createdAt: number
  updatedAt: number
}

export type InstallProfileRevision = {
  profileId: string
  revision: number
  snapshot: InstallProfileValues
  note: string
  createdAt: number
}

type ProfileRow = {
  id: string
  name: string
  run_mode: string
  agent_server_url: string | null
  heartbeat_seconds: number
  poll_seconds: number
  client_name: string | null
  grp: string
  tags: string
  overwrite_existing: number
  re_enroll_on_server_change: number
  is_default: number
  revision: number
  active_revision: number
  created_at: number
  updated_at: number
}

const DEFAULT_VALUES: InstallProfileValues = {
  name: "默认安装档案",
  runMode: "menu",
  agentServerUrl: null,
  heartbeatSeconds: 20,
  pollSeconds: 15,
  clientName: null,
  group: "默认分组",
  tags: [],
  overwriteExisting: false,
  reEnrollOnServerChange: false,
}

function transaction<T>(action: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = action()
    db.exec("COMMIT")
    return result
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

function values(profile: InstallProfile): InstallProfileValues {
  return {
    name: profile.name,
    runMode: profile.runMode,
    agentServerUrl: profile.agentServerUrl,
    heartbeatSeconds: profile.heartbeatSeconds,
    pollSeconds: profile.pollSeconds,
    clientName: profile.clientName,
    group: profile.group,
    tags: profile.tags,
    overwriteExisting: profile.overwriteExisting,
    reEnrollOnServerChange: profile.reEnrollOnServerChange,
  }
}

function mapRow(row: ProfileRow): InstallProfile {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(row.tags)
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) tags = parsed
  } catch { /* 损坏的旧值按空数组读取，后续保存会修复。 */ }
  return {
    id: row.id,
    name: row.name,
    runMode: row.run_mode === "silent" ? "silent" : "menu",
    agentServerUrl: row.agent_server_url,
    heartbeatSeconds: row.heartbeat_seconds,
    pollSeconds: row.poll_seconds,
    clientName: row.client_name,
    group: row.grp,
    tags,
    overwriteExisting: row.overwrite_existing === 1,
    reEnrollOnServerChange: row.re_enroll_on_server_change === 1,
    isDefault: row.is_default === 1,
    revision: row.revision,
    activeRevision: row.active_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function insertRevision(profile: InstallProfile, note: string) {
  db.prepare(`
    INSERT INTO install_profile_revisions(profile_id, revision, snapshot, note, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(profile.id, profile.revision, JSON.stringify(values(profile)), note, profile.updatedAt)
}

function insertProfile(input: InstallProfileValues, isDefault: boolean, note: string): InstallProfile {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO install_profiles(
      id, name, run_mode, agent_server_url, heartbeat_seconds, poll_seconds, client_name, grp, tags,
      overwrite_existing, re_enroll_on_server_change, is_default, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id, input.name, input.runMode, input.agentServerUrl, input.heartbeatSeconds, input.pollSeconds,
    input.clientName, input.group, JSON.stringify(input.tags), input.overwriteExisting ? 1 : 0,
    input.reEnrollOnServerChange ? 1 : 0, isDefault ? 1 : 0, now, now,
  )
  const profile = getProfile(id, false)!
  insertRevision(profile, note)
  recordLog("info", "install-profile", "创建安装档案", `profileId=${profile.id};revision=${profile.revision}`)
  return profile
}

export function ensureDefaultProfile(): InstallProfile {
  const existingDefault = db.prepare("SELECT * FROM install_profiles WHERE is_default = 1 LIMIT 1").get() as ProfileRow | undefined
  if (existingDefault) return mapRow(existingDefault)
  return transaction(() => {
    const first = db.prepare("SELECT * FROM install_profiles ORDER BY created_at, id LIMIT 1").get() as ProfileRow | undefined
    if (first) {
      db.prepare("UPDATE install_profiles SET is_default = 1 WHERE id = ?").run(first.id)
      return getProfile(first.id, false)!
    }
    return insertProfile(DEFAULT_VALUES, true, "初始化默认安装档案")
  })
}

export function listProfiles(): InstallProfile[] {
  ensureDefaultProfile()
  return (db.prepare("SELECT * FROM install_profiles ORDER BY is_default DESC, updated_at DESC, name").all() as ProfileRow[]).map(mapRow)
}

export function getProfile(id: string, ensure = true): InstallProfile | null {
  if (ensure) ensureDefaultProfile()
  const row = db.prepare("SELECT * FROM install_profiles WHERE id = ?").get(id) as ProfileRow | undefined
  return row ? mapRow(row) : null
}

export function getDefaultProfile(): InstallProfile {
  return ensureDefaultProfile()
}

export function createProfile(input: InstallProfileValues, note = "创建安装档案"): InstallProfile {
  return transaction(() => insertProfile(input, false, note))
}

export function updateProfile(
  id: string,
  input: InstallProfileValues,
  expectedRevision: number,
  expectedActiveRevision: number,
  note = "更新安装档案",
): InstallProfile {
  return transaction(() => {
    const current = getProfile(id, false)
    if (!current) throw new HttpError(404, "安装档案不存在")
    if (current.revision !== expectedRevision || current.activeRevision !== expectedActiveRevision) {
      throw new HttpError(409, "安装档案已被其他操作更新", {
        currentRevision: current.revision,
        currentActiveRevision: current.activeRevision,
      })
    }
    const revision = current.revision + 1
    const now = Date.now()
    const result = db.prepare(`
      UPDATE install_profiles SET
        name = ?, run_mode = ?, agent_server_url = ?, heartbeat_seconds = ?, poll_seconds = ?,
        client_name = ?, grp = ?, tags = ?, overwrite_existing = ?, re_enroll_on_server_change = ?,
        revision = ?, active_revision = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND active_revision = ?
    `).run(
      input.name, input.runMode, input.agentServerUrl, input.heartbeatSeconds, input.pollSeconds,
      input.clientName, input.group, JSON.stringify(input.tags), input.overwriteExisting ? 1 : 0,
      input.reEnrollOnServerChange ? 1 : 0, revision, revision, now, id, expectedRevision, expectedActiveRevision,
    )
    if (result.changes !== 1) throw new HttpError(409, "安装档案已被其他操作更新")
    const updated = getProfile(id, false)!
    insertRevision(updated, note)
    recordLog("info", "install-profile", "更新安装档案", `profileId=${updated.id};revision=${updated.revision}`)
    return updated
  })
}

export function setDefaultProfile(id: string): InstallProfile {
  ensureDefaultProfile()
  return transaction(() => {
    const profile = getProfile(id, false)
    if (!profile) throw new HttpError(404, "安装档案不存在")
    db.prepare("UPDATE install_profiles SET is_default = 0 WHERE is_default = 1").run()
    db.prepare("UPDATE install_profiles SET is_default = 1, updated_at = ? WHERE id = ?").run(Date.now(), id)
    recordLog("info", "install-profile", "切换默认安装档案", `profileId=${id}`)
    return getProfile(id, false)!
  })
}

export function deleteProfile(id: string) {
  ensureDefaultProfile()
  return transaction(() => {
    const profile = getProfile(id, false)
    if (!profile) throw new HttpError(404, "安装档案不存在")
    let defaultProfileId: string | null = null
    if (profile.isDefault) {
      const replacement = db.prepare(`
        SELECT id FROM install_profiles WHERE id != ? ORDER BY updated_at DESC, created_at DESC, id LIMIT 1
      `).get(id) as { id: string } | undefined
      if (!replacement) throw new HttpError(409, "至少需要保留一个安装档案")
      // 唯一索引要求先释放旧默认值，再提升替代档案；事务保证外部看不到中间状态。
      db.prepare("UPDATE install_profiles SET is_default = 0 WHERE id = ?").run(id)
      db.prepare("UPDATE install_profiles SET is_default = 1, updated_at = ? WHERE id = ?").run(Date.now(), replacement.id)
      defaultProfileId = replacement.id
    }
    db.prepare("DELETE FROM install_profiles WHERE id = ?").run(id)
    recordLog(
      "info",
      "install-profile",
      "删除安装档案",
      `profileId=${id};revision=${profile.revision};newDefault=${defaultProfileId ?? "unchanged"}`,
    )
    return { id, defaultProfileId }
  })
}

export function listRevisions(id: string): InstallProfileRevision[] {
  if (!getProfile(id)) throw new HttpError(404, "安装档案不存在")
  const rows = db.prepare(`
    SELECT profile_id, revision, snapshot, note, created_at
    FROM install_profile_revisions WHERE profile_id = ? ORDER BY revision DESC
  `).all(id) as { profile_id: string; revision: number; snapshot: string; note: string; created_at: number }[]
  return rows.map((row) => ({
    profileId: row.profile_id,
    revision: row.revision,
    snapshot: JSON.parse(row.snapshot) as InstallProfileValues,
    note: row.note,
    createdAt: row.created_at,
  }))
}

export function restoreRevision(
  id: string,
  revision: number,
  expectedRevision: number,
  expectedActiveRevision: number,
  _note?: string,
): InstallProfile {
  return transaction(() => {
    const current = getProfile(id, false)
    if (!current) throw new HttpError(404, "安装档案不存在")
    if (current.revision !== expectedRevision || current.activeRevision !== expectedActiveRevision) {
      throw new HttpError(409, "安装档案已被其他操作更新", {
        currentRevision: current.revision,
        currentActiveRevision: current.activeRevision,
      })
    }
    const row = db.prepare(`
      SELECT snapshot FROM install_profile_revisions WHERE profile_id = ? AND revision = ?
    `).get(id, revision) as { snapshot: string } | undefined
    if (!row) throw new HttpError(404, "安装档案历史版本不存在")

    const snapshot = JSON.parse(row.snapshot) as InstallProfileValues
    const now = Date.now()
    const result = db.prepare(`
      UPDATE install_profiles SET
        name = ?, run_mode = ?, agent_server_url = ?, heartbeat_seconds = ?, poll_seconds = ?,
        client_name = ?, grp = ?, tags = ?, overwrite_existing = ?, re_enroll_on_server_change = ?,
        active_revision = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND active_revision = ?
    `).run(
      snapshot.name, snapshot.runMode, snapshot.agentServerUrl, snapshot.heartbeatSeconds, snapshot.pollSeconds,
      snapshot.clientName, snapshot.group, JSON.stringify(snapshot.tags), snapshot.overwriteExisting ? 1 : 0,
      snapshot.reEnrollOnServerChange ? 1 : 0, revision, now, id, expectedRevision, expectedActiveRevision,
    )
    if (result.changes !== 1) throw new HttpError(409, "安装档案已被其他操作更新")

    const restored = getProfile(id, false)!
    recordLog(
      "info",
      "install-profile",
      "恢复安装档案版本",
      `profileId=${id};latestRevision=${expectedRevision};activeRevision=${revision}`,
    )
    return restored
  })
}
