import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { after, before, test } from "node:test"

const databasePath = path.join(process.cwd(), "tmp-command-test.db")
let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let clients: typeof import("../services/clients")
let commands: typeof import("../services/commands")
let canEnroll: typeof import("../lib/auth").canEnroll
let agentUpdates: typeof import("../services/agent-updates")
const artifactsPath = path.join(process.cwd(), "tmp-update-artifacts")

before(async () => {
  fs.rmSync(databasePath, { force: true })
  process.env.DATABASE_PATH = databasePath
  process.env.LOG_RETENTION_MAX = "1000"
  process.env.ENROLLMENT_KEY = "integration-enroll-key"
  process.env.ARTIFACTS_PATH = artifactsPath
  fs.mkdirSync(path.join(artifactsPath, "windows"), { recursive: true })
  const artifact = Buffer.from("synthetic-agent-1.1.0")
  const fileName = "nacho-agent-1.1.0-win-x64.exe"
  fs.writeFileSync(path.join(artifactsPath, "windows", fileName), artifact)
  fs.writeFileSync(path.join(artifactsPath, "windows", "latest.json"), JSON.stringify({
    version: "1.1.0",
    fileName,
    sha256: crypto.createHash("sha256").update(artifact).digest("hex"),
    rid: "win-x64",
    sizeBytes: artifact.byteLength,
    publishedAt: "2026-07-24T10:00:00.000Z",
  }))
  ;({ db, initSchema } = await import("../db"))
  clients = await import("../services/clients")
  commands = await import("../services/commands")
  ;({ canEnroll } = await import("../lib/auth"))
  agentUpdates = await import("../services/agent-updates")
  initSchema()
})

test("open enrollment bypasses the shared key only when configured", () => {
  assert.equal(canEnroll(undefined, true), true)
  assert.equal(canEnroll(undefined, false), false)
  assert.equal(canEnroll("integration-enroll-key", false), true)
})

after(() => {
  db.close()
  fs.rmSync(databasePath, { force: true })
  fs.rmSync(artifactsPath, { force: true, recursive: true })
})

test("strict versions, heartbeat version updates, offline queueing, and active update deduplication", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  assert.equal(agentUpdates.compareVersions("1.0.9", "1.1.0"), -1)
  assert.equal(agentUpdates.compareVersions("1.1", "1.1.0"), null)
  assert.equal(agentUpdates.compareVersions("01.1.0", "1.1.0"), null)
  const { client: windows } = clients.registerClient({ name: "offline-agent", os: "Windows", version: "1.0.0" })
  db.prepare("UPDATE clients SET last_seen=0, status='offline' WHERE id=?").run(windows.id)
  const { client: current } = clients.registerClient({ name: "current-agent", os: "Windows", version: "1.1.0" })
  const { client: linux } = clients.registerClient({ name: "linux-agent", os: "Linux", version: "1.0.0" })

  const first = agentUpdates.queueAgentUpdates("all")
  assert.equal(first.queued.length, 1)
  assert.equal(first.queued[0].clientId, windows.id)
  assert.equal(first.queued[0].status, "pending")
  assert.deepEqual(first.queued[0].payload, {
    targetVersion: "1.1.0",
    fileName: "nacho-agent-1.1.0-win-x64.exe",
    sha256: first.release.sha256,
    sizeBytes: Buffer.byteLength("synthetic-agent-1.1.0"),
  })
  assert.ok(first.skipped.some((item) => item.clientId === current.id && item.reason === "already-current"))
  assert.ok(first.skipped.some((item) => item.clientId === linux.id && item.reason === "not-windows"))
  const second = agentUpdates.queueAgentUpdates("clients", [windows.id])
  assert.equal(second.queued.length, 0)
  assert.equal(second.skipped[0].reason, "active-update")

  clients.heartbeat(windows.id, undefined, undefined, "1.1.0")
  assert.equal(clients.getClient(windows.id)?.version, "1.1.0")
  const view = agentUpdates.listAgentUpdates()
  assert.equal(view.release.version, "1.1.0")
  assert.equal(view.clients.length, 2)
})

test("release reader rejects an artifact hash mismatch", () => {
  const artifact = path.join(artifactsPath, "windows", "nacho-agent-1.1.0-win-x64.exe")
  const original = fs.readFileSync(artifact)
  fs.writeFileSync(artifact, "corrupt")
  assert.throws(() => agentUpdates.readAgentRelease(), /size does not match|sha256 does not match/)
  fs.writeFileSync(artifact, original)
})

test("pending command remains deliverable until client acknowledgement", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  const { client } = clients.registerClient({ name: "test-agent", os: "Windows" })
  const command = commands.dispatchCommand({ clientId: client.id, type: "run-program", payload: { program: "C:\\Windows\\System32\\hostname.exe" } })

  assert.equal(command.status, "pending")
  assert.equal(commands.pullPending(client.id).length, 1)
  assert.equal(commands.pullPending(client.id).length, 1)
  assert.equal(commands.acknowledge(command.id, "other-client"), false)
  assert.equal(commands.acknowledge(command.id, client.id), true)
  assert.equal(commands.getCommand(command.id)?.status, "sent")
  assert.equal(commands.acknowledge(command.id, client.id), true)
  assert.equal(commands.getCommand(command.id)?.status, "sent")
})

test("manage-service payload and structured result survive the generic command lifecycle", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  const { client } = clients.registerClient({ name: "service-agent", os: "Windows" })
  const payload = { serviceName: "ExampleService", action: "restart", timeoutSeconds: 60 }
  const command = commands.dispatchCommand({ clientId: client.id, type: "manage-service", payload })

  assert.deepEqual(commands.pullPending(client.id)[0].payload, payload)
  assert.equal(commands.acknowledge(command.id, client.id), true)
  commands.reportResult(command.id, client.id, "running")
  const result = JSON.stringify({
    serviceName: "ExampleService",
    action: "restart",
    initialStatus: "running",
    finalStatus: "running",
    durationMs: 42,
    timedOut: false,
    error: null,
  })
  assert.equal(commands.reportResult(command.id, client.id, "success", result), true)
  assert.equal(commands.getCommand(command.id)?.status, "success")
  assert.deepEqual(JSON.parse(commands.getCommand(command.id)?.result ?? "{}"), JSON.parse(result))
})

test("terminate-process payload and structured result survive the generic command lifecycle", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  const { client } = clients.registerClient({ name: "process-agent", os: "Windows" })
  const payload = {
    processId: 1234,
    expectedPath: "C:\\Program Files\\Example\\worker.exe",
    timeoutSeconds: 30,
    killProcessTree: true,
  }
  const command = commands.dispatchCommand({ clientId: client.id, type: "terminate-process", payload })

  assert.deepEqual(commands.pullPending(client.id)[0].payload, payload)
  assert.equal(commands.acknowledge(command.id, client.id), true)
  commands.reportResult(command.id, client.id, "running")
  const result = JSON.stringify({
    processId: 1234,
    expectedPath: payload.expectedPath,
    actualPath: payload.expectedPath,
    killProcessTree: true,
    initialStatus: "running",
    finalStatus: "exited",
    durationMs: 42,
    timedOut: false,
    error: null,
  })
  assert.equal(commands.reportResult(command.id, client.id, "success", result), true)
  assert.equal(commands.getCommand(command.id)?.status, "success")
  assert.equal(commands.getCommand(command.id)?.exitCode, null)
  assert.deepEqual(JSON.parse(commands.getCommand(command.id)?.result ?? "{}"), JSON.parse(result))
})

test("restart-system progress and verified result survive the generic command lifecycle", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  const { client } = clients.registerClient({ name: "restart-agent", os: "Windows" })
  const payload = { delaySeconds: 30, reason: "Nacho administrator requested restart" }
  const command = commands.dispatchCommand({ clientId: client.id, type: "restart-system", payload })

  assert.deepEqual(commands.pullPending(client.id)[0].payload, payload)
  assert.equal(commands.acknowledge(command.id, client.id), true)
  const requested = JSON.stringify({
    delaySeconds: 30,
    reason: payload.reason,
    requestedAt: "2026-07-24T12:00:00.0000000+00:00",
    previousBootId: "registry:100",
    currentBootId: "registry:100",
    phase: "requested",
    durationMs: 100,
    verifiedAfterRestart: false,
    error: null,
  })
  assert.equal(commands.reportResult(command.id, client.id, "running", requested), true)
  assert.equal(commands.getCommand(command.id)?.status, "running")
  assert.deepEqual(JSON.parse(commands.getCommand(command.id)?.result ?? "{}"), JSON.parse(requested))

  const verified = JSON.stringify({
    ...JSON.parse(requested),
    currentBootId: "registry:101",
    phase: "verified",
    durationMs: 42000,
    verifiedAfterRestart: true,
  })
  assert.equal(commands.reportResult(command.id, client.id, "success", verified), true)
  assert.equal(commands.getCommand(command.id)?.status, "success")
  assert.equal(commands.getCommand(command.id)?.exitCode, null)
  assert.deepEqual(JSON.parse(commands.getCommand(command.id)?.result ?? "{}"), JSON.parse(verified))
})

test("collect-logs payload and a 512 KiB result survive without duplicating sensitive entries into server logs", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  const { client } = clients.registerClient({ name: "log-agent", os: "Windows" })
  const payload = {
    sources: ["agent", "system", "application"],
    sinceUtc: "2026-07-24T07:00:00Z",
    untilUtc: "2026-07-24T08:00:00Z",
    maxEntries: 200,
  }
  const command = commands.dispatchCommand({ clientId: client.id, type: "collect-logs", payload })
  assert.deepEqual(commands.pullPending(client.id)[0].payload, payload)
  assert.equal(commands.acknowledge(command.id, client.id), true)

  const maximumResult = "x".repeat(commands.MAX_COMMAND_RESULT_BYTES)
  assert.equal(commands.reportResult(command.id, client.id, "success", maximumResult), true)
  assert.equal(commands.getCommand(command.id)?.result?.length, commands.MAX_COMMAND_RESULT_BYTES)
  const logDetail = db.prepare("SELECT detail FROM logs WHERE message LIKE '%上报指令%' ORDER BY ts DESC LIMIT 1").get() as { detail: string }
  assert.equal(logDetail.detail, `resultBytes=${commands.MAX_COMMAND_RESULT_BYTES}`)

  const previous = commands.getCommand(command.id)
  assert.equal(commands.reportResult(command.id, client.id, "success", "😀".repeat((commands.MAX_COMMAND_RESULT_BYTES / 4) + 1)), false)
  assert.equal(commands.getCommand(command.id)?.result, previous?.result)
})
