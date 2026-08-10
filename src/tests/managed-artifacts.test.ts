import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import test, { after, before, beforeEach } from "node:test"

const databasePath = path.join(process.cwd(), "tmp-managed-artifacts-test.db")
const artifactsPath = path.join(process.cwd(), "tmp-managed-artifacts")
process.env.DATABASE_PATH = databasePath
process.env.ARTIFACTS_PATH = artifactsPath
process.env.OFFLINE_THRESHOLD = "60"

let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let managed: typeof import("../services/managed-artifacts")
let clients: typeof import("../services/clients")
let commands: typeof import("../services/commands")
let installPackagePayloadSchema: typeof import("../schemas/commands").installPackagePayloadSchema
let deployFilePayloadSchema: typeof import("../schemas/commands").deployFilePayloadSchema
let rollbackFileDeployPayloadSchema: typeof import("../schemas/commands").rollbackFileDeployPayloadSchema

before(async () => {
  fs.rmSync(databasePath, { force: true })
  fs.rmSync(artifactsPath, { recursive: true, force: true })
  ;({ db, initSchema } = await import("../db"))
  managed = await import("../services/managed-artifacts")
  clients = await import("../services/clients")
  commands = await import("../services/commands")
  ;({ installPackagePayloadSchema, deployFilePayloadSchema, rollbackFileDeployPayloadSchema } = await import("../schemas/commands"))
  initSchema()
})

beforeEach(() => {
  db.exec("DELETE FROM deployment_items; DELETE FROM deployment_batches; DELETE FROM managed_artifacts; DELETE FROM commands; DELETE FROM clients; DELETE FROM groups; DELETE FROM logs;")
  fs.rmSync(artifactsPath, { recursive: true, force: true })
})

after(() => {
  db.close()
  fs.rmSync(databasePath, { force: true })
  fs.rmSync(`${databasePath}-shm`, { force: true })
  fs.rmSync(`${databasePath}-wal`, { force: true })
  fs.rmSync(artifactsPath, { recursive: true, force: true })
})

function draft(fileName = "fixture.exe", content = Buffer.from("fixture-package")) {
  return {
    artifact: managed.createManagedArtifact({
      kind: "package",
      displayName: `Fixture ${fileName}`,
      version: "1.0.0",
      originalFileName: fileName,
      sizeBytes: content.byteLength,
      installerType: fileName.endsWith(".msi") ? "msi" as const : "exe" as const,
      arguments: fileName.endsWith(".msi") ? ["PROPERTY=value"] : ["/S"],
      successExitCodes: fileName.endsWith(".msi") ? [0, 3010] : [0, 7],
    }),
    content,
  }
}

async function ready(fileName = "fixture.exe", content = Buffer.from(`fixture-${fileName}`)) {
  const created = draft(fileName, content)
  return managed.uploadManagedArtifact(created.artifact.id, Readable.from([content]), content.byteLength)
}

async function readyFile(fileName = "config.json", content = Buffer.from(`fixture-${fileName}`)) {
  const artifact = managed.createManagedArtifact({
    kind: "file",
    displayName: `Fixture ${fileName}`,
    originalFileName: fileName,
    sizeBytes: content.byteLength,
  })
  return managed.uploadManagedArtifact(artifact.id, Readable.from([content]), content.byteLength)
}

test("incremental schema creates deployment tables idempotently", () => {
  initSchema()
  initSchema()
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  const names = new Set(tables.map((table) => table.name))
  assert.equal(names.has("managed_artifacts"), true)
  assert.equal(names.has("deployment_batches"), true)
  assert.equal(names.has("deployment_items"), true)
})

test("package schema and draft creation reject unsafe metadata and boundaries", () => {
  assert.throws(() => managed.createManagedArtifact({
    kind: "package", displayName: "bad", originalFileName: "../bad.exe", sizeBytes: 1, installerType: "exe",
  }), /文件名/)
  assert.throws(() => managed.createManagedArtifact({
    kind: "package", displayName: "bad", originalFileName: "bad.exe", sizeBytes: managed.MAX_PACKAGE_BYTES + 1, installerType: "exe",
  }), /大小/)
  assert.equal(installPackagePayloadSchema.safeParse({
    artifactId: "artifact-0123456789ab",
    fileName: "fixture.exe",
    sha256: "a".repeat(64),
    sizeBytes: 1,
    installerType: "exe",
    arguments: [],
    successExitCodes: [0],
    timeoutSeconds: 1800,
    extra: true,
  }).success, false)
  const first = draft("same.exe").artifact
  const second = draft("same.exe").artifact
  assert.notEqual(first.storageName, second.storageName)
  assert.equal(first.originalFileName, second.originalFileName)
})

test("streaming upload requires length, computes SHA-256, and cleans interrupted temporary files", async () => {
  const content = Buffer.from("streamed-package-content")
  const created = draft("stream.exe", content).artifact
  await assert.rejects(managed.uploadManagedArtifact(created.id, Readable.from([content]), null), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 411)
    return true
  })
  await assert.rejects(managed.uploadManagedArtifact(created.id, Readable.from([content]), content.byteLength - 1), /Content-Length/)

  async function* interrupted() {
    yield content.subarray(0, 3)
    throw new Error("fixture disconnect")
  }
  await assert.rejects(managed.uploadManagedArtifact(created.id, Readable.from(interrupted()), content.byteLength), /fixture disconnect/)
  assert.equal(managed.getManagedArtifact(created.id)?.status, "draft")
  const managedDirectory = path.join(artifactsPath, "managed")
  assert.deepEqual(fs.existsSync(managedDirectory) ? fs.readdirSync(managedDirectory) : [], [])

  const uploaded = await managed.uploadManagedArtifact(created.id, Readable.from([content]), content.byteLength)
  assert.equal(uploaded.status, "ready")
  assert.equal(uploaded.sha256, (await import("node:crypto")).createHash("sha256").update(content).digest("hex"))
  assert.equal(fs.readFileSync(path.join(managedDirectory, uploaded.storageName)).equals(content), true)
})

test("package deployment creates the full matrix and enforces four-way download ownership", async () => {
  const one = await ready("one.exe")
  const two = await ready("two.msi")
  const a = clients.registerClient({ name: "win-a", os: "Windows" }).client
  const b = clients.registerClient({ name: "win-b", os: "Windows" }).client
  const linux = clients.registerClient({ name: "linux", os: "Linux" }).client

  assert.throws(() => managed.createPackageDeployment([one.id], [linux.id], 1800), /Windows/)
  const batch = managed.createPackageDeployment([one.id, two.id], [a.id, b.id], 1800)
  assert.equal(batch.totalItems, 4)
  assert.equal(batch.items.length, 4)
  assert.deepEqual(new Set(batch.items.map((item) => item.command?.type)), new Set(["install-package"]))
  const msi = batch.items.find((item) => item.artifactId === two.id)!
  assert.deepEqual(msi.command?.payload.successExitCodes, [0, 3010])
  assert.equal(msi.command?.payload.timeoutSeconds, 1800)

  const item = batch.items.find((candidate) => candidate.clientId === a.id && candidate.artifactId === one.id)!
  const download = managed.authorizeManagedArtifactDownload(a.id, one.id, item.commandId)
  assert.equal(download.artifact.id, one.id)
  assert.throws(() => managed.authorizeManagedArtifactDownload(b.id, one.id, item.commandId), /映射不存在/)
  assert.throws(() => managed.authorizeManagedArtifactDownload(a.id, two.id, item.commandId), /映射不存在/)
  assert.throws(() => managed.authorizeManagedArtifactDownload(a.id, one.id, "cmd-missing"), /映射不存在/)

  await assert.rejects(managed.deleteManagedArtifact(one.id), /活动命令/)
  for (const deployment of batch.items) {
    assert.equal(commands.acknowledge(deployment.commandId, deployment.clientId), true)
    assert.equal(commands.reportResult(deployment.commandId, deployment.clientId, "success", JSON.stringify({
      phase: "success", downloadedBytes: deployment.artifact?.sizeBytes, hashVerified: true,
      installerType: deployment.artifact?.installerType, exitCode: 0, rebootRequired: false,
      durationMs: 10, timedOut: false, error: null,
    }), 0), true)
  }
  assert.throws(() => managed.authorizeManagedArtifactDownload(a.id, one.id, item.commandId), /不可下载/)
  const terminal = managed.getDeploymentBatch(batch.id)!
  assert.equal(terminal.status, "success")
  assert.equal(terminal.counts.success, 4)
  assert.equal(await managed.deleteManagedArtifact(one.id), true)
  assert.equal(managed.listManagedArtifacts("package").some((artifact) => artifact.id === one.id), false)
  assert.equal(commands.getCommand(item.commandId)?.payload.artifactId, one.id)
})

test("offline target is rejected and install results are not copied into service logs", async () => {
  const artifact = await ready("offline.exe")
  const target = clients.registerClient({ name: "offline", os: "Windows" }).client
  db.prepare("UPDATE clients SET last_seen=0,status='offline' WHERE id=?").run(target.id)
  assert.throws(() => managed.createPackageDeployment([artifact.id], [target.id], 1800), /在线/)

  clients.heartbeat(target.id)
  const batch = managed.createPackageDeployment([artifact.id], [target.id], 1800)
  const command = batch.items[0].command!
  const sensitive = "INSTALL_RESULT_SHOULD_NOT_BE_LOGGED"
  assert.equal(commands.reportResult(command.id, target.id, "failed", JSON.stringify({ error: sensitive }), 7), true)
  const logs = db.prepare("SELECT message,detail FROM logs").all() as Array<{ message: string; detail: string | null }>
  assert.equal(JSON.stringify(logs).includes(sensitive), false)
  assert.equal(logs.some((entry) => entry.detail?.includes("resultBytes=")), true)
})

test("file deployment schemas are strict and enforce payload boundaries", () => {
  const valid = {
    artifactId: "artifact-0123456789ab",
    fileName: "config.json",
    sha256: "a".repeat(64),
    sizeBytes: 123,
    destinationPath: "C:\\Deploy\\config.json",
    conflictPolicy: "replace",
    createDirectories: true,
  }
  assert.equal(deployFilePayloadSchema.safeParse(valid).success, true)
  assert.equal(deployFilePayloadSchema.safeParse({ ...valid, extra: true }).success, false)
  assert.equal(deployFilePayloadSchema.safeParse({ ...valid, destinationPath: "relative\\config.json" }).success, false)
  assert.equal(deployFilePayloadSchema.safeParse({ ...valid, sizeBytes: managed.MAX_FILE_BYTES + 1 }).success, false)
  assert.equal(rollbackFileDeployPayloadSchema.safeParse({ originalCommandId: "cmd-0123456789ab" }).success, true)
  assert.equal(rollbackFileDeployPayloadSchema.safeParse({ originalCommandId: "cmd-0123456789ab", extra: true }).success, false)
})

test("file deployment creates a Windows matrix, keeps four-way download binding, and creates validated rollback", async () => {
  const artifact = await readyFile("config.json", Buffer.from("new-content"))
  const a = clients.registerClient({ name: "file-a", os: "Windows" }).client
  const b = clients.registerClient({ name: "file-b", os: "Windows" }).client
  const linux = clients.registerClient({ name: "file-linux", os: "Linux" }).client
  assert.throws(() => managed.createFileDeployment(artifact.id, [linux.id], "C:\\Deploy\\config.json", "fail", false), /Windows/)

  const batch = managed.createFileDeployment(artifact.id, [a.id, b.id], "C:\\Deploy\\config.json", "replace", true)
  assert.equal(batch.kind, "file")
  assert.equal(batch.totalItems, 2)
  assert.deepEqual(new Set(batch.items.map((item) => item.command?.type)), new Set(["deploy-file"]))
  const first = batch.items.find((item) => item.clientId === a.id)!
  assert.deepEqual(first.command?.payload, {
    artifactId: artifact.id,
    fileName: "config.json",
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    destinationPath: "C:\\Deploy\\config.json",
    conflictPolicy: "replace",
    createDirectories: true,
  })
  assert.equal(managed.authorizeManagedArtifactDownload(a.id, artifact.id, first.commandId).artifact.id, artifact.id)
  assert.throws(() => managed.authorizeManagedArtifactDownload(b.id, artifact.id, first.commandId), /映射不存在/)
  assert.throws(() => managed.createFileDeploymentRollback(a.id, first.commandId), /尚未成功/)

  assert.equal(commands.acknowledge(first.commandId, a.id), true)
  const result = JSON.stringify({
    phase: "success", downloadedBytes: artifact.sizeBytes, hashVerified: true,
    destinationPath: "C:\\Deploy\\config.json", conflictPolicy: "replace", replaced: true,
    backupValid: true, previousSha256: "b".repeat(64), finalSha256: artifact.sha256,
    durationMs: 12, error: null,
  })
  assert.equal(commands.reportResult(first.commandId, a.id, "success", result, 0), true)
  const rollback = managed.createFileDeploymentRollback(a.id, first.commandId)
  assert.equal(rollback.type, "rollback-file-deploy")
  assert.deepEqual(rollback.payload, { originalCommandId: first.commandId })
  assert.throws(() => managed.createFileDeploymentRollback(b.id, first.commandId), /不存在|不属于/)
  assert.throws(() => managed.createFileDeploymentRollback(a.id, first.commandId), /进行中/)
})

test("file deployment rejects non-ready artifacts, offline targets, and redacts result details", async () => {
  const content = Buffer.from("file-body-secret")
  const draftArtifact = managed.createManagedArtifact({ kind: "file", displayName: "draft", originalFileName: "draft.txt", sizeBytes: content.length })
  const target = clients.registerClient({ name: "offline-file", os: "Windows" }).client
  assert.throws(() => managed.createFileDeployment(draftArtifact.id, [target.id], "C:\\Deploy\\draft.txt", "fail", false), /尚未准备好/)
  const artifact = await managed.uploadManagedArtifact(draftArtifact.id, Readable.from([content]), content.length)
  db.prepare("UPDATE clients SET last_seen=0,status='offline' WHERE id=?").run(target.id)
  assert.throws(() => managed.createFileDeployment(artifact.id, [target.id], "C:\\Deploy\\draft.txt", "fail", false), /在线/)
  clients.heartbeat(target.id)
  const command = managed.createFileDeployment(artifact.id, [target.id], "C:\\Deploy\\draft.txt", "fail", false).items[0].command!
  const sensitive = "FILE_RESULT_BODY_MUST_NOT_REACH_LOGS"
  assert.equal(commands.reportResult(command.id, target.id, "failed", JSON.stringify({ error: sensitive }), undefined), true)
  const logs = db.prepare("SELECT message,detail FROM logs").all() as Array<{ message: string; detail: string | null }>
  assert.equal(JSON.stringify(logs).includes(sensitive), false)
  assert.equal(logs.some((entry) => entry.detail?.includes("resultBytes=")), true)
})
