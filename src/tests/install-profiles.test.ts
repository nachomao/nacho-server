import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { after, before, test } from "node:test"
import express from "express"

const databasePath = path.join(process.cwd(), "tmp-install-profiles-test.db")
let db: typeof import("../db").db
let profiles: typeof import("../services/install-profiles")
let renderInstallScript: typeof import("../services/install-script").renderInstallScript
let stripScriptBom: typeof import("../services/install-script").stripScriptBom

before(async () => {
  fs.rmSync(databasePath, { force: true })
  process.env.DATABASE_PATH = databasePath
  ;({ db } = await import("../db"))
  const database = await import("../db")
  profiles = await import("../services/install-profiles")
  ;({ renderInstallScript, stripScriptBom } = await import("../services/install-script"))
  database.initSchema()
})

after(() => {
  db.close()
  fs.rmSync(databasePath, { force: true })
})

test("default profile is created once and remains the only default", () => {
  const first = profiles.listProfiles()
  assert.equal(first.length, 1)
  assert.equal(first[0].isDefault, true)
  assert.equal(first[0].runMode, "menu")
  assert.equal(first[0].heartbeatSeconds, 20)
  assert.equal(profiles.listProfiles().length, 1)
})

test("profile restore switches the active snapshot without changing revision history", () => {
  const created = profiles.createProfile({
    name: "静默办公终端",
    runMode: "silent",
    agentServerUrl: "https://agent.example.test",
    heartbeatSeconds: 30,
    pollSeconds: 25,
    clientName: null,
    group: "办公终端",
    tags: ["Windows", "华东"],
    overwriteExisting: false,
    reEnrollOnServerChange: true,
  }, "创建测试档案")
  assert.equal(created.revision, 1)
  assert.equal(created.activeRevision, 1)
  const updated = profiles.updateProfile(created.id, { ...created, heartbeatSeconds: 45 }, 1, 1, "调整心跳")
  assert.equal(updated.revision, 2)
  assert.equal(updated.heartbeatSeconds, 45)
  assert.throws(() => profiles.updateProfile(created.id, { ...created, heartbeatSeconds: 60 }, 1, 1), /其他操作更新/)

  let latest = updated
  for (let revision = 3; revision <= 7; revision += 1) {
    latest = profiles.updateProfile(created.id, { ...latest, pollSeconds: 37 + revision }, revision - 1, revision - 1, `版本 ${revision}`)
  }
  assert.equal(latest.revision, 7)
  assert.equal(latest.activeRevision, 7)

  assert.throws(() => profiles.restoreRevision(created.id, 5, 6, 7), /其他操作更新/)
  assert.deepEqual(profiles.listRevisions(created.id).map((item) => item.revision), [7, 6, 5, 4, 3, 2, 1])

  const restored = profiles.restoreRevision(created.id, 5, 7, 7)
  assert.equal(restored.revision, 7)
  assert.equal(restored.activeRevision, 5)
  assert.equal(restored.pollSeconds, 42)
  assert.deepEqual(profiles.listRevisions(created.id).map((item) => item.revision), [7, 6, 5, 4, 3, 2, 1])
  assert.equal(renderInstallScript("$ProfileRevision = __NACHO_PROFILE_REVISION__", {
    artifactBaseUrl: "https://artifacts.example.test",
    installScriptUrl: `https://artifacts.example.test/nacho.ps1?profile=${restored.id}`,
    openEnrollment: false,
    profile: restored,
  }), "$ProfileRevision = 5")
  assert.throws(() => profiles.updateProfile(created.id, { ...latest, heartbeatSeconds: 35 }, 7, 7), /其他操作更新/)

  const savedAfterRestore = profiles.updateProfile(created.id, { ...restored, heartbeatSeconds: 35 }, 7, 5)
  assert.equal(savedAfterRestore.revision, 8)
  assert.equal(savedAfterRestore.activeRevision, 8)
  assert.deepEqual(profiles.listRevisions(created.id).map((item) => item.revision), [8, 7, 6, 5, 4, 3, 2, 1])

  const nextDefault = profiles.setDefaultProfile(created.id)
  assert.equal(nextDefault.isDefault, true)
  assert.equal(profiles.listProfiles().filter((item) => item.isDefault).length, 1)
  const deleted = profiles.deleteProfile(created.id)
  assert.equal(deleted.id, created.id)
  assert.ok(deleted.defaultProfileId)
  const remaining = profiles.listProfiles()
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].isDefault, true)
  assert.equal(remaining[0].id, deleted.defaultProfileId)
  assert.throws(() => profiles.deleteProfile(remaining[0].id), /至少需要保留一个安装档案/)
})

test("rendered script separates artifact and Agent URLs and escapes profile text", () => {
  const profile = profiles.createProfile({
    name: "quoted",
    runMode: "silent",
    agentServerUrl: "https://agent.example.test",
    heartbeatSeconds: 40,
    pollSeconds: 35,
    clientName: "PC-O'Brien",
    group: "O'Brien",
    tags: ["one", "two's"],
    overwriteExisting: true,
    reEnrollOnServerChange: false,
  })
  const template = [
    "$ArtifactBaseUrl = __NACHO_ARTIFACT_BASE_URL__",
    "$AgentServerUrl = __NACHO_AGENT_SERVER_URL__",
    "$InstallScriptUrl = __NACHO_INSTALL_SCRIPT_URL__",
    "$OpenEnrollment = __NACHO_OPEN_ENROLLMENT__",
    "$ProfileId = __NACHO_PROFILE_ID__",
    "$ProfileRevision = __NACHO_PROFILE_REVISION__",
    "$ProfileRunMode = __NACHO_PROFILE_RUN_MODE__",
    "$ProfileHeartbeatSeconds = __NACHO_PROFILE_HEARTBEAT_SECONDS__",
    "$ProfilePollSeconds = __NACHO_PROFILE_POLL_SECONDS__",
    "$ProfileClientName = __NACHO_PROFILE_CLIENT_NAME__",
    "$ProfileGroup = __NACHO_PROFILE_GROUP__",
    "$ProfileTags = __NACHO_PROFILE_TAGS__",
    "$ProfileOverwriteExisting = __NACHO_PROFILE_OVERWRITE_EXISTING__",
    "$ProfileReEnroll = __NACHO_PROFILE_REENROLL__",
  ].join("\n")
  const output = renderInstallScript(template, {
    artifactBaseUrl: "https://artifacts.example.test",
    installScriptUrl: `https://artifacts.example.test/nacho.ps1?profile=${profile.id}`,
    openEnrollment: false,
    profile,
  })
  assert.equal(/__NACHO_[A-Z0-9_]+__/.test(output), false)
  assert.match(output, /\$ArtifactBaseUrl = 'https:\/\/artifacts\.example\.test'/)
  assert.match(output, /\$AgentServerUrl = 'https:\/\/agent\.example\.test'/)
  assert.match(output, /\$ProfileGroup = 'O''Brien'/)
  assert.match(output, /\$ProfileTags = @\('one', 'two''s'\)/)
  assert.match(output, /\$ProfileRunMode = 'silent'/)
  assert.equal(output.includes("ENROLLMENT_KEY ="), false)
})

test("HTTP script loader strips UTF-8 BOM before text rendering", () => {
  assert.equal(stripScriptBom("\uFEFFparam()"), "param()")
  assert.equal(stripScriptBom("param()"), "param()")
})

test("nacho.ps1 and install.ps1 render the same dynamic install script", async () => {
  const { artifactRouter } = await import("../routes/artifacts")
  const app = express()
  app.use(artifactRouter)
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance))
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const baseUrl = `http://127.0.0.1:${address.port}`
    const [nacho, legacy] = await Promise.all([
      fetch(`${baseUrl}/nacho.ps1`),
      fetch(`${baseUrl}/install.ps1`),
    ])
    assert.equal(nacho.status, 200)
    assert.equal(legacy.status, 200)
    assert.match(nacho.headers.get("content-type") ?? "", /^text\/plain/)
    assert.equal(await nacho.text(), await legacy.text())
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
