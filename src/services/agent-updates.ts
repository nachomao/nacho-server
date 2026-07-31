import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { config } from "../config"
import { db } from "../db"
import type { Client, Command } from "../types"
import * as clients from "./clients"
import * as commands from "./commands"

export type AgentRelease = {
  version: string
  fileName: string
  sha256: string
  rid: "win-x64"
  sizeBytes: number
  publishedAt: string
}

export type UpdateSkipReason = "not-windows" | "already-current" | "newer-than-release" | "invalid-version" | "active-update"

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const FILE_NAME = /^[a-zA-Z0-9._-]+\.exe$/
const SHA256 = /^[a-f0-9]{64}$/

export class ReleaseManifestError extends Error {}

export function compareVersions(left: string, right: string): number | null {
  const a = VERSION.exec(left)
  const b = VERSION.exec(right)
  if (!a || !b) return null
  for (let i = 1; i <= 3; i++) {
    const difference = Number(a[i]) - Number(b[i])
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

export function readAgentRelease(): AgentRelease {
  const directory = path.join(config.artifactsPath, "windows")
  const manifestPath = path.join(directory, "latest.json")
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  } catch (error) {
    throw new ReleaseManifestError(`latest.json is missing or invalid: ${String(error)}`)
  }
  if (!raw || typeof raw !== "object") throw new ReleaseManifestError("latest.json must contain an object")
  const value = raw as Record<string, unknown>
  if (typeof value.version !== "string" || !VERSION.test(value.version)) throw new ReleaseManifestError("release version must be strict x.y.z")
  if (typeof value.fileName !== "string" || !FILE_NAME.test(value.fileName) || path.basename(value.fileName) !== value.fileName)
    throw new ReleaseManifestError("release fileName is invalid")
  if (value.rid !== "win-x64") throw new ReleaseManifestError("release rid must be win-x64")
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw new ReleaseManifestError("release sha256 is invalid")
  if (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) <= 0) throw new ReleaseManifestError("release sizeBytes is invalid")
  if (typeof value.publishedAt !== "string" || !value.publishedAt.endsWith("Z") || Number.isNaN(Date.parse(value.publishedAt)))
    throw new ReleaseManifestError("release publishedAt must be a UTC timestamp")

  const artifactPath = path.join(directory, value.fileName)
  let data: Buffer
  try {
    data = fs.readFileSync(artifactPath)
  } catch (error) {
    throw new ReleaseManifestError(`release artifact is missing: ${String(error)}`)
  }
  if (data.byteLength !== value.sizeBytes) throw new ReleaseManifestError("release artifact size does not match latest.json")
  if (crypto.createHash("sha256").update(data).digest("hex") !== value.sha256)
    throw new ReleaseManifestError("release artifact sha256 does not match latest.json")
  return value as AgentRelease
}

function parseResult(command: Command): Record<string, unknown> | null {
  if (!command.result) return null
  try {
    const result = JSON.parse(command.result)
    return result && typeof result === "object" ? result as Record<string, unknown> : null
  } catch {
    return null
  }
}

function activeUpdate(clientId: string): Command | null {
  const row = db.prepare(
    "SELECT * FROM commands WHERE client_id = ? AND type = 'update-agent' AND status IN ('pending','sent','running') ORDER BY created_at DESC LIMIT 1",
  ).get(clientId) as Parameters<typeof commands.mapCommandRow>[0] | undefined
  return row ? commands.mapCommandRow(row) : null
}

function latestUpdate(clientId: string): Command | null {
  const row = db.prepare(
    "SELECT * FROM commands WHERE client_id = ? AND type = 'update-agent' ORDER BY created_at DESC LIMIT 1",
  ).get(clientId) as Parameters<typeof commands.mapCommandRow>[0] | undefined
  return row ? commands.mapCommandRow(row) : null
}

export function skipReason(client: Client, release: AgentRelease, active = activeUpdate(client.id)): UpdateSkipReason | null {
  if (client.os !== "Windows") return "not-windows"
  if (active) return "active-update"
  const comparison = compareVersions(client.version, release.version)
  if (comparison === null) return "invalid-version"
  if (comparison === 0) return "already-current"
  if (comparison > 0) return "newer-than-release"
  return null
}

export function listAgentUpdates() {
  const release = readAgentRelease()
  return {
    release,
    clients: clients.listClients().filter((client) => client.os === "Windows").map((client) => {
      const active = activeUpdate(client.id)
      const command = active ?? latestUpdate(client.id)
      const result = command ? parseResult(command) : null
      return {
        ...clients.withRealtime(client),
        currentVersion: client.version,
        targetVersion: active?.payload.targetVersion ?? release.version,
        command,
        phase: typeof result?.phase === "string" ? result.phase : command?.status ?? null,
        skipReason: skipReason(client, release, active),
      }
    }),
  }
}

export function queueAgentUpdates(scope: "all" | "clients", clientIds: string[] = []) {
  const release = readAgentRelease()
  const requested = scope === "all" ? clients.listClients() : clientIds.map((id) => clients.getClient(id)).filter((item): item is Client => item !== null)
  const queued: Command[] = []
  const skipped: Array<{ clientId: string; reason: UpdateSkipReason | "not-found" }> = []
  if (scope === "clients") {
    for (const id of clientIds) if (!clients.getClient(id)) skipped.push({ clientId: id, reason: "not-found" })
  }
  for (const client of requested) {
    const reason = skipReason(client, release)
    if (reason) {
      skipped.push({ clientId: client.id, reason })
      continue
    }
    queued.push(commands.dispatchCommand({
      clientId: client.id,
      type: "update-agent",
      payload: {
        targetVersion: release.version,
        fileName: release.fileName,
        sha256: release.sha256,
        sizeBytes: release.sizeBytes,
      },
    }))
  }
  return { release, queued, skipped }
}
