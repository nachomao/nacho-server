import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { generateKeyPairSync } from "node:crypto"
import { after, before, beforeEach, test } from "node:test"

const databasePath = path.join(process.cwd(), "tmp-release-index-unconfigured-test.db")
process.env.DATABASE_PATH = databasePath
delete process.env.NACHO_UPDATE_ORIGIN

let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let settings: typeof import("../services/settings")
let releaseIndex: typeof import("../services/release-index")
let productUpdates: typeof import("../services/product-updates")

const calls: string[] = []
const originalFetch = global.fetch

before(async () => {
  fs.rmSync(databasePath, { force: true })
  ;({ db, initSchema } = await import("../db"))
  settings = await import("../services/settings")
  releaseIndex = await import("../services/release-index")
  productUpdates = await import("../services/product-updates")
  initSchema()
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith("https://")) calls.push(url)
    return originalFetch(input, init)
  }) as typeof fetch
})

beforeEach(() => {
  db.exec("DELETE FROM settings; DELETE FROM logs")
  settings.invalidateSettingsCache()
  releaseIndex.invalidateReleaseIndexCache()
  calls.length = 0
})

after(() => {
  global.fetch = originalFetch
  db.close()
  fs.rmSync(databasePath, { force: true })
  fs.rmSync(`${databasePath}-shm`, { force: true })
  fs.rmSync(`${databasePath}-wal`, { force: true })
})

test("未配置更新源时 runtime-info 明确标记 none 且不请求占位地址", async () => {
  const runtime = productUpdates.runtimeInfo()
  assert.equal(runtime.updateSourceConfigured, false)
  assert.equal(runtime.updateSource, null)
  assert.equal(runtime.updateSourceOrigin, "none")
  assert.equal(runtime.capabilities.updateSourceManagement, true)

  const { publicKey } = generateKeyPairSync("ed25519")
  const reader = releaseIndex.createReleaseIndexReader(publicKey)
  await assert.rejects(reader(true), /未配置更新源/)
  assert.equal(calls.length, 0)
  assert.throws(() => releaseIndex.indexUrl(), /未配置更新源/)
})
