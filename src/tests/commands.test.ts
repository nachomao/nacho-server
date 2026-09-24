import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import express from "express"
import type http from "node:http"
import { DatabaseSync } from "node:sqlite"
import { after, before, test } from "node:test"
import { addServerCommandFields, batchCommandSchema, commandSupportsClient, panelCommandSchema } from "../schemas/commands"

const databasePath = path.join(process.cwd(), "tmp-command-test.db")
let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let clients: typeof import("../services/clients")
let commands: typeof import("../services/commands")
let canEnroll: typeof import("../lib/auth").canEnroll
let agentUpdates: typeof import("../services/agent-updates")
let agentRouter: typeof import("../routes/agent").agentRouter
let logs: typeof import("../services/logs")
let settings: typeof import("../services/settings")
let enrollmentGuard: typeof import("../services/enrollment-guard")
const artifactsPath = path.join(process.cwd(), "tmp-update-artifacts")

before(async () => {
  fs.rmSync(databasePath, { force: true })
  const legacyDb = new DatabaseSync(databasePath)
  legacyDb.exec(`
    CREATE TABLE clients (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      hostname      TEXT NOT NULL DEFAULT '',
      ip            TEXT NOT NULL DEFAULT '',
      os            TEXT NOT NULL DEFAULT 'Linux',
      status        TEXT NOT NULL DEFAULT 'offline',
      tags          TEXT NOT NULL DEFAULT '[]',
      grp           TEXT NOT NULL DEFAULT '默认分组',
      version       TEXT NOT NULL DEFAULT '',
      token         TEXT NOT NULL,
      last_seen     INTEGER NOT NULL DEFAULT 0,
      registered_at INTEGER NOT NULL,
      metrics       TEXT
    );
  `)
  legacyDb.close()
  process.env.DATABASE_PATH = databasePath
  process.env.LOG_RETENTION_MAX = "1000"
  process.env.ENROLLMENT_KEY = "integration-enroll-key"
  delete process.env.ALLOW_OPEN_ENROLLMENT
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
  ;({ agentRouter } = await import("../routes/agent"))
  logs = await import("../services/logs")
  settings = await import("../services/settings")
  enrollmentGuard = await import("../services/enrollment-guard")
  agentUpdates = await import("../services/agent-updates")
  initSchema()
})

test("open enrollment bypasses the shared key only when configured", () => {
  assert.equal(canEnroll(undefined, true), true)
  assert.equal(canEnroll(undefined, false), false)
  assert.equal(canEnroll("integration-enroll-key", false), true)
})

test("new server defaults to open enrollment, while a saved choice takes precedence", async () => {
  const { config } = await import("../config")
  assert.equal(config.allowOpenEnrollment, true)
  settings.saveSettings({})
  assert.equal(canEnroll(undefined), true)
  settings.saveSettings({ security: { openEnrollment: false } })
  assert.equal(canEnroll(undefined), false)
})

test("stored security setting controls open enrollment when no explicit override is passed", () => {
  settings.saveSettings({ security: { openEnrollment: true } })
  try {
    assert.equal(canEnroll(undefined), true)
    settings.saveSettings({ security: { openEnrollment: false } })
    assert.equal(canEnroll(undefined), false)
  } finally {
    settings.saveSettings({ security: { openEnrollment: false } })
  }
})

test("panel settings reports the effective enrollment policy", async () => {
  const { panelRouter } = await import("../routes/panel")
  const { config } = await import("../config")
  const app = express()
  app.use("/api/panel", panelRouter)
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance))
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const url = `http://127.0.0.1:${address.port}/api/panel/settings`
    const headers = { Authorization: `Bearer ${config.panelApiKey}` }
    settings.saveSettings({})
    const initial = await fetch(url, { headers })
    assert.equal(initial.status, 200)
    assert.equal(((await initial.json()) as { data: { security: { openEnrollment: boolean } } }).data.security.openEnrollment, true)
    settings.saveSettings({ security: { openEnrollment: false } })
    const disabled = await fetch(url, { headers })
    assert.equal(disabled.status, 200)
    assert.equal(((await disabled.json()) as { data: { security: { openEnrollment: boolean } } }).data.security.openEnrollment, false)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("rejected enrollment attempts are rate limited per device and recover after the window", () => {
  enrollmentGuard.resetEnrollmentGuard()
  const start = 1_000_000
  for (let i = 0; i < 5; i++) assert.equal(enrollmentGuard.checkEnrollmentAttempt("10.0.0.1", "device-a", start + i).blocked, false)
  assert.equal(enrollmentGuard.checkEnrollmentAttempt("10.0.0.1", "device-a", start + 6).blocked, true)
  assert.equal(enrollmentGuard.checkEnrollmentAttempt("10.0.0.1", "device-b", start + 7).blocked, false)
  assert.equal(enrollmentGuard.checkEnrollmentAttempt("10.0.0.1", "device-a", start + 60_001).blocked, false)
  enrollmentGuard.resetEnrollmentGuard()
})

test("enrollment with the same device id updates one client record", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM logs")
  const first = clients.registerClient({
    id: "device-fixture-stable",
    name: "fixture-device",
    hostname: "fixture-host",
    os: "Windows",
    version: "1.0.0",
  })
  const second = clients.registerClient({
    id: "device-fixture-stable",
    name: "fixture-device-renamed",
    hostname: "fixture-host",
    os: "Windows",
    version: "1.1.0",
  })

  assert.equal(second.client.id, first.client.id)
  assert.equal(second.token, first.token)
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM clients").get() as { count: number }).count, 1)
  assert.equal(clients.getClient(first.client.id)?.version, "1.1.0")
})

test("agent unregister purges the server-side client record and related data", async () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM logs")
  const app = express()
  app.use(express.json())
  app.use("/agent", agentRouter)
  const server = app.listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.once("listening", resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const enrolled = await fetch(`http://127.0.0.1:${address.port}/agent/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollmentKey: "integration-enroll-key", name: "unregister-fixture", os: "Windows" }),
    })
    assert.equal(enrolled.status, 201)
    const envelope = (await enrolled.json()) as { data: { token: string; client: { id: string } } }
    const clientId = envelope.data.client.id
    const command = commands.dispatchCommand({ clientId, type: "run-program", payload: { program: "hostname.exe", args: [] } })
    db.prepare(`INSERT INTO tasks (id,name,client_ids,created_at,updated_at) VALUES (?,?,?,?,?)`)
      .run("task-unregister", "unregister task", JSON.stringify([clientId, "other-client"]), Date.now(), Date.now())
    db.prepare(`INSERT INTO log_packages (id,client_id,command_id,host,ts,storage_name) VALUES (?,?,?,?,?,?)`)
      .run("p-unregister", clientId, command.id, "fixture-host", Date.now(), "p-unregister.json")
    db.prepare(`INSERT INTO health_findings (id,package_id,host,title,ts) VALUES (?,?,?,?,?)`)
      .run("finding-unregister", "p-unregister", "fixture-host", "fixture finding", Date.now())
    const healthDirectory = path.join(artifactsPath, "health")
    fs.mkdirSync(healthDirectory, { recursive: true })
    const healthArtifact = path.join(healthDirectory, "p-unregister.json")
    fs.writeFileSync(healthArtifact, "fixture")
    logs.recordLog("info", "client", "fixture client log", `id=${clientId}`)
    const removed = await fetch(`http://127.0.0.1:${address.port}/agent/client`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${envelope.data.token}` },
    })
    assert.equal(removed.status, 200)
    assert.equal(clients.getClient(clientId), null)
    assert.equal(commands.listCommands(clientId).length, 0)
    assert.equal(db.prepare("SELECT 1 FROM log_packages WHERE client_id=?").get(clientId), undefined)
    assert.equal(db.prepare("SELECT 1 FROM health_findings WHERE package_id='p-unregister'").get(), undefined)
    assert.deepEqual(JSON.parse((db.prepare("SELECT client_ids FROM tasks WHERE id='task-unregister'").get() as { client_ids: string }).client_ids), ["other-client"])
    assert.equal(db.prepare("SELECT 1 FROM logs WHERE instr(COALESCE(detail,''),?)>0").get(clientId), undefined)
    assert.equal(fs.existsSync(healthArtifact), false)
  } finally {
    server.close()
    await new Promise<void>((resolve) => server.once("close", resolve))
  }
})

test("ordinary uninstall marks a client unregistered while retaining its card and token", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM logs")
  const { client, token } = clients.registerClient({ id: "device-ordinary-uninstall", name: "ordinary", os: "Windows" })
  assert.equal(clients.markClientUnregistered(client.id), true)
  const retained = clients.getClient(client.id)
  assert.equal(retained?.status, "unregistered")
  assert.equal((db.prepare("SELECT token FROM clients WHERE id=?").get(client.id) as { token: string }).token, token)
})

test("rejected enrollment is recorded without exposing the submitted key", async () => {
  db.exec("DELETE FROM logs")
  const app = express()
  app.use(express.json())
  app.use("/agent", agentRouter)
  const server = app.listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.once("listening", resolve))

  try {
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const rejectedKey = "fixture-rejected-key-must-not-be-logged"
    const response = await fetch(`http://127.0.0.1:${address.port}/agent/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollmentKey: rejectedKey,
        id: "fixture-client-id",
        name: "fixture-client",
        hostname: "fixture-host",
        os: "Windows",
      }),
    })
    assert.equal(response.status, 401)

    const [entry] = logs.listLogs({ source: "client", limit: 1 })
    assert.equal(entry.level, "warn")
    assert.equal(entry.message, "客户端注册被拒绝：入网密钥无效")
    assert.match(entry.detail ?? "", /ip="127\.0\.0\.1"/)
    assert.match(entry.detail ?? "", /id="fixture-client-id"/)
    assert.match(entry.detail ?? "", /hostname="fixture-host"/)
    assert.doesNotMatch(`${entry.message};${entry.detail}`, new RegExp(rejectedKey))
  } finally {
    server.close()
    await new Promise<void>((resolve) => server.once("close", resolve))
  }
})

test("legacy client schema migrates and heartbeat persists osName", () => {
  const columns = db.prepare("PRAGMA table_info(clients)").all() as { name: string }[]
  assert.ok(columns.some((column) => column.name === "os_name"))

  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  const { client } = clients.registerClient({
    name: "windows-agent",
    os: "Windows",
    osName: "Windows 10 Pro 22H2",
    version: "1.1.1",
  })
  assert.equal(client.osName, "Windows 10 Pro 22H2")

  const heartbeat = clients.heartbeat(
    client.id,
    undefined,
    "127.0.0.1",
    "1.1.3",
    "Windows 11 Pro 25H2",
  )
  assert.equal(heartbeat?.version, "1.1.3")
  assert.equal(heartbeat?.osName, "Windows 11 Pro 25H2")
  assert.equal(clients.getClient(client.id)?.osName, "Windows 11 Pro 25H2")
})

test("heartbeat normalizes resource percentages before persistence", () => {
  db.exec("DELETE FROM clients")
  const { client } = clients.registerClient({ name: "metrics-agent", os: "Windows" })
  const updated = clients.heartbeat(client.id, {
    cpu: 96.9075958075156,
    memory: 8.968850698174007,
    disk: 176.74718097974676,
    uptime: 12,
  })
  assert.deepEqual(updated?.metrics, { cpu: 96.91, memory: 8.97, disk: 100, uptime: 12 })
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

test("run-shell schemas are strict and batch targets are unique", () => {
  const input = {
    type: "run-shell" as const,
    payload: { shell: "powershell" as const, script: "Get-Date", timeoutSeconds: 30 },
  }
  assert.deepEqual(panelCommandSchema.parse(input), input)
  assert.equal(panelCommandSchema.safeParse({ ...input, payload: { ...input.payload, extra: true } }).success, false)
  assert.equal(panelCommandSchema.safeParse({ ...input, payload: { ...input.payload, script: " \r\n\t" } }).success, false)
  assert.equal(panelCommandSchema.safeParse({ ...input, payload: { ...input.payload, timeoutSeconds: 901 } }).success, false)
  assert.equal(batchCommandSchema.safeParse({ clientIds: ["a", "a"], ...input }).success, false)
  assert.equal(batchCommandSchema.safeParse({ clientIds: ["a", "b"], ...input }).success, true)
})

test("manage-local-user uses strict per-action payloads and Windows-only targets", () => {
  const valid = [
    { type: "manage-local-user", payload: { action: "list", userName: null, groupName: null } },
    { type: "manage-local-user", payload: { action: "enable", userName: "FixtureUser", groupName: null } },
    { type: "manage-local-user", payload: { action: "disable", userName: "FixtureUser", groupName: null } },
    { type: "manage-local-user", payload: { action: "delete", userName: "FixtureUser", groupName: null } },
    { type: "manage-local-user", payload: { action: "add-to-group", userName: "FixtureUser", groupName: "FixtureGroup" } },
    { type: "manage-local-user", payload: { action: "remove-from-group", userName: "FixtureUser", groupName: "FixtureGroup" } },
  ]
  valid.forEach((input) => assert.equal(panelCommandSchema.safeParse(input).success, true))
  const invalid = [
    { type: "manage-local-user", payload: { action: "list", userName: "x", groupName: null } },
    { type: "manage-local-user", payload: { action: "enable", userName: "x", groupName: "Users" } },
    { type: "manage-local-user", payload: { action: "delete", userName: "domain\\user", groupName: null } },
    { type: "manage-local-user", payload: { action: "add-to-group", userName: "x", groupName: null } },
    { type: "manage-local-user", payload: { action: "remove-from-group", userName: "x", groupName: "Users", extra: true } },
    { type: "manage-local-user", payload: { action: "enable", userName: "x".repeat(21), groupName: null } },
  ]
  invalid.forEach((input) => assert.equal(panelCommandSchema.safeParse(input).success, false))
  assert.equal(commandSupportsClient("manage-local-user", "Windows"), true)
  assert.equal(commandSupportsClient("manage-local-user", "Linux"), false)
  assert.equal(commandSupportsClient("run-program", "Linux"), true)
})

test("manage-local-user lifecycle validates structured result and redacts account details from logs", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  const { client } = clients.registerClient({ name: "user-agent", os: "Windows" })
  const payload = { action: "list", userName: null, groupName: null }
  const command = commands.dispatchCommand({ clientId: client.id, type: "manage-local-user", payload })
  assert.equal(commands.acknowledge(command.id, client.id), true)
  commands.reportResult(command.id, client.id, "running")
  const result = JSON.stringify({
    action: "list",
    changed: false,
    accounts: [{ userName: "SensitiveFixture", sid: "S-1-5-21-1-2-3-1001", enabled: true, builtIn: false, groups: ["SensitiveGroup"] }],
    error: null,
  })
  assert.equal(commands.reportResult(command.id, client.id, "success", result), true)
  assert.equal(commands.getCommand(command.id)?.status, "success")
  assert.equal(commands.getCommand(command.id)?.result, result)
  const details = (db.prepare("SELECT detail FROM logs WHERE source='command' ORDER BY ts").all() as { detail: string | null }[]).map((row) => row.detail ?? "").join("\n")
  assert.match(details, /action=list/)
  assert.equal(details.includes("SensitiveFixture"), false)
  assert.equal(details.includes("SensitiveGroup"), false)
  assert.equal(details.includes("S-1-5-21"), false)

  const previous = commands.getCommand(command.id)?.result
  assert.equal(commands.reportResult(command.id, client.id, "success", JSON.stringify({ action: "list", accounts: [] })), false)
  assert.equal(commands.reportResult(command.id, client.id, "success"), false)
  assert.equal(commands.reportResult(command.id, client.id, "success", JSON.stringify({ action: "disable", changed: false, target: null, error: null })), false)
  assert.equal(commands.reportResult(command.id, client.id, "failed", result), false)
  assert.equal(commands.getCommand(command.id)?.result, previous)
  assert.equal(commands.reportResult(command.id, client.id, "success", "x".repeat(commands.MAX_COMMAND_RESULT_BYTES + 1)), false)
})

test("manage-registry validates every action, value kind, boundary, and Windows target", () => {
  const base = { hive: "HKLM", view: "registry64", subKey: "SOFTWARE\\Nacho\\TestFixtures\\ABC" }
  const valid = [
    { action: "list", ...base, valueName: null, valueKind: null, value: null },
    { action: "get", ...base, valueName: "Enabled", valueKind: null, value: null },
    { action: "delete", ...base, valueName: "Enabled", valueKind: null, value: null },
    { action: "set", ...base, valueName: "Text", valueKind: "string", value: "hello" },
    { action: "set", ...base, valueName: "Expanded", valueKind: "expandString", value: "%SystemRoot%" },
    { action: "set", ...base, valueName: "Dword", valueKind: "dword", value: 4_294_967_295 },
    { action: "set", ...base, valueName: "Qword", valueKind: "qword", value: "9223372036854775807" },
    { action: "set", ...base, valueName: "Multi", valueKind: "multiString", value: ["one", "two"] },
    { action: "set", ...base, valueName: "Binary", valueKind: "binary", value: "AAECAw==" },
  ]
  valid.forEach((payload) => assert.equal(panelCommandSchema.safeParse({ type: "manage-registry", payload }).success, true))
  const invalid = [
    { action: "list", ...base, valueName: "unexpected", valueKind: null, value: null },
    { action: "get", ...base, valueName: "Name", valueKind: "string", value: null },
    { action: "set", ...base, valueName: "Name", valueKind: "dword", value: -1 },
    { action: "set", ...base, valueName: "Name", valueKind: "qword", value: "9223372036854775808" },
    { action: "set", ...base, valueName: "Name", valueKind: "multiString", value: ["ok", "bad\u0001"] },
    { action: "set", ...base, valueName: "Name", valueKind: "binary", value: "not-base64" },
    { action: "delete", ...base, valueName: "Name", valueKind: null, value: null, extra: true },
    { action: "list", hive: "HKCU", view: "registry64", subKey: "Software", valueName: null, valueKind: null, value: null },
    { action: "list", hive: "HKLM", view: "native", subKey: "Software", valueName: null, valueKind: null, value: null },
    { action: "list", ...base, subKey: "SOFTWARE\\..\\Outside", valueName: null, valueKind: null, value: null },
  ]
  invalid.forEach((payload) => assert.equal(panelCommandSchema.safeParse({ type: "manage-registry", payload }).success, false))
  assert.equal(panelCommandSchema.safeParse({ type: "manage-registry", payload: { action: "set", ...base, valueName: "Binary", valueKind: "binary", value: Buffer.alloc(49_149).toString("base64") } }).success, true)
  assert.equal(panelCommandSchema.safeParse({ type: "manage-registry", payload: { action: "set", ...base, valueName: "Binary", valueKind: "binary", value: Buffer.alloc(49_150).toString("base64") } }).success, false)
  assert.equal(commandSupportsClient("manage-registry", "Windows"), true)
  assert.equal(commandSupportsClient("manage-registry", "Linux"), false)
})

test("manage-registry lifecycle stores strict results and logs only hashed path summaries", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  const { client } = clients.registerClient({ name: "registry-agent", os: "Windows" })
  const subKey = "SOFTWARE\\Nacho\\TestFixtures\\SensitivePath"
  const payload = { action: "set", hive: "HKLM", view: "registry64", subKey, valueName: "SensitiveName", valueKind: "string", value: "SensitiveValue" }
  const command = commands.dispatchCommand({ clientId: client.id, type: "manage-registry", payload })
  assert.equal(commands.acknowledge(command.id, client.id), true)
  commands.reportResult(command.id, client.id, "running")
  const result = JSON.stringify({
    action: "set", hive: "HKLM", view: "registry64", subKey, changed: true, values: null,
    previous: null,
    current: { valueName: "SensitiveName", valueKind: "string", value: "SensitiveValue", sizeBytes: 16 },
    error: null,
  })
  assert.equal(commands.reportResult(command.id, client.id, "success", result), true)
  assert.equal(commands.getCommand(command.id)?.result, result)
  const logs = (db.prepare("SELECT detail FROM logs WHERE source='command' ORDER BY ts").all() as { detail: string | null }[]).map((row) => row.detail ?? "").join("\n")
  assert.match(logs, /action=set/)
  assert.match(logs, /hive=HKLM/)
  assert.match(logs, /view=registry64/)
  assert.match(logs, /pathHash=[a-f0-9]{12}/)
  assert.equal(logs.includes("SensitivePath"), false)
  assert.equal(logs.includes("SensitiveName"), false)
  assert.equal(logs.includes("SensitiveValue"), false)
  const previous = commands.getCommand(command.id)?.result
  assert.equal(commands.reportResult(command.id, client.id, "success"), false)
  assert.equal(commands.reportResult(command.id, client.id, "success", JSON.stringify({ ...JSON.parse(result), action: "delete" })), false)
  assert.equal(commands.reportResult(command.id, client.id, "failed", result), false)
  assert.equal(commands.getCommand(command.id)?.result, previous)
})

test("show-message validates Unicode scalar boundaries and server-generated expiry", () => {
  const payload = { title: "😀".repeat(128), message: "测试消息\n第二行", severity: "warning", timeoutSeconds: 60 }
  assert.equal(panelCommandSchema.safeParse({ type: "show-message", payload }).success, true)
  assert.equal(batchCommandSchema.safeParse({ clientIds: ["a", "b"], type: "show-message", payload }).success, true)
  const invalid = [
    { ...payload, title: "😀".repeat(129) },
    { ...payload, message: "" },
    { ...payload, message: "bad\u0001" },
    { ...payload, timeoutSeconds: 4 },
    { ...payload, timeoutSeconds: 301 },
    { ...payload, expiresAt: "2026-08-07T00:00:00Z" },
  ]
  invalid.forEach((candidate) => assert.equal(panelCommandSchema.safeParse({ type: "show-message", payload: candidate }).success, false))
  const generated = addServerCommandFields("show-message", payload, Date.parse("2026-08-07T00:00:00Z"))
  assert.equal(generated.expiresAt, "2026-08-07T00:05:00.000Z")
  assert.equal(commandSupportsClient("show-message", "Windows"), true)
  assert.equal(commandSupportsClient("show-message", "Linux"), false)
})

test("show-message lifecycle validates delivery results and redacts message bodies", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  const { client } = clients.registerClient({ name: "message-agent", os: "Windows" })
  const payload = addServerCommandFields("show-message", { title: "SensitiveTitle", message: "SensitiveBody", severity: "error", timeoutSeconds: 30 }, Date.now())
  const command = commands.dispatchCommand({ clientId: client.id, type: "show-message", payload })
  assert.equal(commands.acknowledge(command.id, client.id), true)
  commands.reportResult(command.id, client.id, "running")
  const result = JSON.stringify({ sessionId: 3, deliveryStatus: "confirmed", responseCode: 1, timedOut: false, durationMs: 25, error: null })
  assert.equal(commands.reportResult(command.id, client.id, "success", result), true)
  const logText = (db.prepare("SELECT detail FROM logs WHERE source='command' ORDER BY ts").all() as { detail: string | null }[]).map((row) => row.detail ?? "").join("\n")
  assert.match(logText, /severity=error/)
  assert.match(logText, /deliveryStatus=confirmed/)
  assert.equal(logText.includes("SensitiveTitle"), false)
  assert.equal(logText.includes("SensitiveBody"), false)
  const previous = commands.getCommand(command.id)?.result
  assert.equal(commands.reportResult(command.id, client.id, "success"), false)
  assert.equal(commands.reportResult(command.id, client.id, "success", JSON.stringify({ sessionId: 3, deliveryStatus: "failed", responseCode: null, timedOut: false, durationMs: 1, error: { code: "FAIL", message: "x" } })), false)
  assert.equal(commands.reportResult(command.id, client.id, "failed", result), false)
  assert.equal(commands.getCommand(command.id)?.result, previous)
})

test("open-url validates absolute HTTP URLs and adds one server expiry", () => {
  const valid = [
    "https://example.com/path?q=secret#fragment",
    "http://127.0.0.1:8080/fixture",
    "https://例子.测试/路径",
  ]
  valid.forEach((url) => {
    assert.equal(panelCommandSchema.safeParse({ type: "open-url", payload: { url } }).success, true)
    assert.equal(batchCommandSchema.safeParse({ clientIds: ["a"], type: "open-url", payload: { url } }).success, true)
  })
  const invalid = [
    "", "/relative", "file:///tmp/a", "javascript:alert(1)", "data:text/plain,x",
    "https://user@example.com", "https://user:pass@example.com", "https://example.com/\nnext",
    `https://example.com/${"x".repeat(2049)}`,
  ]
  invalid.forEach((url) => assert.equal(panelCommandSchema.safeParse({ type: "open-url", payload: { url } }).success, false))
  assert.equal(panelCommandSchema.safeParse({ type: "open-url", payload: { url: "https://example.com", expiresAt: "2026-08-07T00:00:00Z" } }).success, false)
  const generated = addServerCommandFields("open-url", { url: "https://example.com" }, Date.parse("2026-08-07T00:00:00Z"))
  assert.equal(generated.expiresAt, "2026-08-07T00:05:00.000Z")
  assert.equal(commandSupportsClient("open-url", "Windows"), true)
  assert.equal(commandSupportsClient("open-url", "Linux"), false)
})

test("open-url lifecycle validates launch results and redacts query and fragment", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  const { client } = clients.registerClient({ name: "url-agent", os: "Windows" })
  const payload = addServerCommandFields("open-url", { url: "https://Example.COM./fixture?query-secret#fragment-secret" }, Date.now())
  const command = commands.dispatchCommand({ clientId: client.id, type: "open-url", payload })
  assert.equal(commands.acknowledge(command.id, client.id), true)
  assert.equal(commands.reportResult(command.id, client.id, "running"), true)
  const result = JSON.stringify({ sessionId: 3, processStarted: true, pid: 4321, durationMs: 25, expired: false, error: null })
  assert.equal(commands.reportResult(command.id, client.id, "success", result), true)
  const logText = (db.prepare("SELECT detail FROM logs WHERE source='command' ORDER BY ts").all() as { detail: string | null }[]).map((row) => row.detail ?? "").join("\n")
  assert.match(logText, /scheme=https;host=example\.com/)
  assert.match(logText, /processStarted=true/)
  assert.equal(logText.includes("query-secret"), false)
  assert.equal(logText.includes("fragment-secret"), false)
  assert.equal(commands.reportResult(command.id, client.id, "success"), false)
  assert.equal(commands.reportResult(command.id, client.id, "success", JSON.stringify({ sessionId: 3, processStarted: false, pid: null, durationMs: 1, expired: false, error: { code: "WIN32_ERROR", message: "x" } })), false)
  assert.equal(commands.reportResult(command.id, client.id, "failed", result), false)
})

test("run-shell payload and result survive lifecycle without copying output into logs", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  const { client } = clients.registerClient({ name: "shell-agent", os: "Windows" })
  const payload = { shell: "cmd", script: "echo sensitive-output", timeoutSeconds: 30 }
  const command = commands.dispatchCommand({ clientId: client.id, type: "run-shell", payload })
  assert.deepEqual(commands.pullPending(client.id)[0].payload, payload)
  assert.equal(commands.acknowledge(command.id, client.id), true)
  const result = JSON.stringify({
    shell: "cmd",
    stdout: "sensitive-output\r\n",
    stderr: "",
    exitCode: 0,
    durationMs: 12,
    timedOut: false,
    truncated: false,
    error: null,
  })
  assert.equal(commands.reportResult(command.id, client.id, "success", result, 0), true)
  assert.equal(commands.getCommand(command.id)?.status, "success")
  const log = db.prepare("SELECT detail FROM logs WHERE message LIKE '%上报指令%' AND detail IS NOT NULL ORDER BY ts DESC LIMIT 1").get() as { detail: string }
  assert.equal(log.detail, `resultBytes=${Buffer.byteLength(result, "utf8")};exitCode=0`)
  assert.equal(log.detail.includes("sensitive-output"), false)
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
  const log = db.prepare("SELECT detail FROM logs WHERE message LIKE '%上报指令%' AND detail IS NOT NULL ORDER BY ts DESC LIMIT 1").get() as { detail: string }
  assert.match(log.detail, /^action=restart;serviceNameHash=[a-f0-9]{12};timedOut=false;resultBytes=\d+$/)
  assert.equal(log.detail.includes("ExampleService"), false)
})

test("manage-service list is single-client only and validates inventory reports", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  assert.equal(panelCommandSchema.safeParse({ type: "manage-service", payload: { action: "list" } }).success, true)
  assert.equal(batchCommandSchema.safeParse({ clientIds: ["a"], type: "manage-service", payload: { action: "list" } }).success, false)
  assert.equal(panelCommandSchema.safeParse({ type: "manage-service", payload: { action: "list", serviceName: "extra" } }).success, false)

  const { client } = clients.registerClient({ name: "service-inventory-agent", os: "Windows" })
  const command = commands.dispatchCommand({ clientId: client.id, type: "manage-service", payload: { action: "list" } })
  assert.equal(commands.acknowledge(command.id, client.id), true)
  assert.equal(commands.reportResult(command.id, client.id, "running"), true)
  const result = JSON.stringify({
    action: "list",
    capturedAtUtc: "2026-08-25T01:02:03Z",
    sampleDurationMs: 751,
    total: 2,
    returned: 2,
    truncated: false,
    services: [
      {
        serviceName: "AllowedService",
        displayName: "Allowed service",
        status: "running",
        processId: 42,
        canControl: true,
        controlRestriction: null,
        sharedProcess: false,
        sharedServiceCount: 1,
        resources: { cpuPercent: 1.25, workingSetBytes: 4096, privateMemoryBytes: 2048 },
      },
      {
        serviceName: "StoppedService",
        displayName: "Stopped service",
        status: "stopped",
        processId: null,
        canControl: false,
        controlRestriction: "not-allowlisted",
        sharedProcess: false,
        sharedServiceCount: 0,
        resources: null,
      },
    ],
    error: null,
  })
  assert.equal(commands.reportResult(command.id, client.id, "success", result), true)
  const log = db.prepare("SELECT detail FROM logs WHERE message LIKE '%上报指令%' AND detail IS NOT NULL ORDER BY ts DESC LIMIT 1").get() as { detail: string }
  assert.match(log.detail, /^action=list;serviceCount=2;total=2;truncated=false;resultBytes=\d+$/)
  assert.equal(log.detail.includes("AllowedService"), false)

  const malformed = commands.dispatchCommand({ clientId: client.id, type: "manage-service", payload: { action: "list" } })
  const inconsistent = JSON.stringify({ ...JSON.parse(result), returned: 1 })
  assert.equal(commands.reportResult(malformed.id, client.id, "success", inconsistent), false)
  assert.equal(commands.getCommand(malformed.id)?.status, "pending")
})

test("list-processes is strict, Windows-only, single-client, validated and redacted", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  assert.equal(panelCommandSchema.safeParse({ type: "list-processes", payload: {} }).success, true)
  assert.equal(panelCommandSchema.safeParse({ type: "list-processes", payload: { extra: true } }).success, false)
  assert.equal(batchCommandSchema.safeParse({ clientIds: ["a"], type: "list-processes", payload: {} }).success, false)
  assert.equal(commandSupportsClient("list-processes", "Windows"), true)
  assert.equal(commandSupportsClient("list-processes", "Linux"), false)

  const { client } = clients.registerClient({ name: "process-inventory-agent", os: "Windows" })
  const command = commands.dispatchCommand({ clientId: client.id, type: "list-processes", payload: {} })
  assert.equal(commands.acknowledge(command.id, client.id), true)
  assert.equal(commands.reportResult(command.id, client.id, "running"), true)
  const result = JSON.stringify({
    capturedAtUtc: "2026-08-25T01:02:03Z",
    sampleDurationMs: 751,
    total: 2,
    returned: 2,
    truncated: false,
    processes: [
      {
        processId: 42,
        processName: "fixture-worker",
        executablePath: "C:\\Fixtures\\fixture-worker.exe",
        startedAtUtc: "2026-08-25T01:00:00Z",
        sessionId: 1,
        canTerminate: true,
        terminationRestriction: null,
        canRestart: true,
        restartRestriction: null,
        efficiencyMode: false,
        canSetEfficiency: true,
        efficiencyRestriction: null,
        resources: { cpuPercent: 1.25, workingSetBytes: 4096, privateMemoryBytes: 2048 },
      },
      {
        processId: 4,
        processName: "System",
        executablePath: null,
        startedAtUtc: "2026-08-25T00:00:00Z",
        sessionId: 0,
        canTerminate: false,
        terminationRestriction: "system",
        canRestart: false,
        restartRestriction: "system",
        efficiencyMode: null,
        canSetEfficiency: false,
        efficiencyRestriction: "system",
        resources: null,
      },
    ],
    error: null,
  })
  assert.equal(commands.reportResult(command.id, client.id, "success", result), true)
  assert.deepEqual(JSON.parse(commands.getCommand(command.id)?.result ?? "{}"), JSON.parse(result))
  const log = db.prepare("SELECT detail FROM logs WHERE message LIKE '%上报指令%' AND detail IS NOT NULL ORDER BY ts DESC LIMIT 1").get() as { detail: string }
  assert.match(log.detail, /^processCount=2;total=2;truncated=false;resultBytes=\d+$/)
  assert.equal(log.detail.includes("fixture-worker"), false)
  assert.equal(log.detail.includes("Fixtures"), false)

  const malformed = commands.dispatchCommand({ clientId: client.id, type: "list-processes", payload: {} })
  assert.equal(commands.reportResult(malformed.id, client.id, "success", JSON.stringify({ ...JSON.parse(result), returned: 1 })), false)
  assert.equal(commands.reportResult(malformed.id, client.id, "success", JSON.stringify({ ...JSON.parse(result), error: "failed" })), false)
  assert.equal(commands.getCommand(malformed.id)?.status, "pending")
})

test("restart-process and set-process-efficiency are strict single-client Windows commands with redacted results", () => {
  db.exec("DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs")
  const identity = { processId: 42, expectedPath: "C:\\Fixtures\\worker.exe", expectedStartedAtUtc: "2026-08-25T01:00:00Z" }
  const restartPayload = { ...identity, timeoutSeconds: 30 }
  const efficiencyPayload = { ...identity, enabled: true }
  assert.equal(panelCommandSchema.safeParse({ type: "restart-process", payload: restartPayload }).success, true)
  assert.equal(panelCommandSchema.safeParse({ type: "set-process-efficiency", payload: efficiencyPayload }).success, true)
  assert.equal(panelCommandSchema.safeParse({ type: "restart-process", payload: { ...restartPayload, extra: true } }).success, false)
  assert.equal(batchCommandSchema.safeParse({ clientIds: ["a"], type: "restart-process", payload: restartPayload }).success, false)
  assert.equal(commandSupportsClient("restart-process", "Linux"), false)
  assert.equal(commandSupportsClient("set-process-efficiency", "Windows"), true)

  const { client } = clients.registerClient({ name: "process-action-agent", os: "Windows" })
  const restart = commands.dispatchCommand({ clientId: client.id, type: "restart-process", payload: restartPayload })
  assert.equal(commands.reportResult(restart.id, client.id, "running"), true)
  const restartResult = JSON.stringify({
    originalProcessId: 42, newProcessId: 84, expectedPath: identity.expectedPath,
    expectedStartedAtUtc: identity.expectedStartedAtUtc, sessionId: 1, phase: "verified",
    stopped: true, started: true, durationMs: 123, error: null,
  })
  assert.equal(commands.reportResult(restart.id, client.id, "success", restartResult), true)
  let log = db.prepare("SELECT detail FROM logs WHERE message LIKE '%上报指令%' AND detail IS NOT NULL ORDER BY rowid DESC LIMIT 1").get() as { detail: string }
  assert.match(log.detail, /^action=restart;pathHash=[a-f0-9]{12};stopped=true;started=true;resultBytes=\d+$/)
  assert.equal(log.detail.includes("Fixtures"), false)

  const efficiency = commands.dispatchCommand({ clientId: client.id, type: "set-process-efficiency", payload: efficiencyPayload })
  assert.equal(commands.reportResult(efficiency.id, client.id, "running"), true)
  const efficiencyResult = JSON.stringify({
    processId: 42, expectedPath: identity.expectedPath, expectedStartedAtUtc: identity.expectedStartedAtUtc,
    requestedEnabled: true, initialEnabled: false, finalEnabled: true,
    originalPriority: "normal", finalPriority: "idle", priorityRestored: false, durationMs: 20, error: null,
  })
  assert.equal(commands.reportResult(efficiency.id, client.id, "success", efficiencyResult), true)
  log = db.prepare("SELECT detail FROM logs WHERE message LIKE '%上报指令%' AND detail IS NOT NULL ORDER BY rowid DESC LIMIT 1").get() as { detail: string }
  assert.match(log.detail, /^action=efficiency;enabled=true;pathHash=[a-f0-9]{12};priorityRestored=false;resultBytes=\d+$/)

  const mismatch = commands.dispatchCommand({ clientId: client.id, type: "restart-process", payload: restartPayload })
  assert.equal(commands.reportResult(mismatch.id, client.id, "success", JSON.stringify({ ...JSON.parse(restartResult), originalProcessId: 43 })), false)
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
  assert.equal(logDetail.detail, `resultBytes=${commands.MAX_COMMAND_RESULT_BYTES};exitCode=none`)

  const previous = commands.getCommand(command.id)
  assert.equal(commands.reportResult(command.id, client.id, "success", "😀".repeat((commands.MAX_COMMAND_RESULT_BYTES / 4) + 1)), false)
  assert.equal(commands.getCommand(command.id)?.result, previous?.result)
})
