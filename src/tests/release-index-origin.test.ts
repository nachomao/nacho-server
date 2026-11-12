import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import express from "express"
import type http from "node:http"
import { after, before, beforeEach, test } from "node:test"

const databasePath = path.join(process.cwd(), "tmp-release-index-origin-test.db")
process.env.DATABASE_PATH = databasePath
process.env.NACHO_UPDATE_ORIGIN = "https://env.example.test"

let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let settings: typeof import("../services/settings")
let releaseIndex: typeof import("../services/release-index")
let productUpdates: typeof import("../services/product-updates")
let config: typeof import("../config").config
let server: http.Server
let baseUrl: string

const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const payload = Buffer.from("fixture-agent")
const sha256 = createHash("sha256").update(payload).digest("hex")
const asset = (repo: string, version: string, fileName: string) => ({
  fileName,
  url: `https://github.com/nachomao/${repo}/releases/download/v${version}/${fileName}`,
  sha256,
  sizeBytes: payload.length,
})
const sample = {
  schemaVersion: 4,
  sequence: 1,
  publishedAt: "2026-11-12T00:00:00Z",
  releases: {
    panel: {
      version: "0.4.0", releaseType: "beta", sourceCommit: "a".repeat(40),
      title: "面板", notes: "测试", publishedAt: "2026-11-12T00:00:00Z",
      asset: asset("nacho-main", "0.4.0", "NachoPanel-Setup-0.4.0.exe"),
    },
    server: {
      version: "1.2.0", releaseType: "beta", sourceCommit: "b".repeat(40),
      title: "服务端", notes: "测试", publishedAt: "2026-11-12T00:00:00Z",
      minPanelVersion: "0.4.0", minAgentVersion: "1.2.0", minServerVersion: "1.2.0",
      source: asset("nacho-server", "1.2.0", "nacho-server-source-1.2.0.tar.gz"),
      agent: asset("nacho-server", "1.2.0", "nacho-agent-1.2.0-win-x64.exe"),
    },
  },
}
const indexBytes = Buffer.from(JSON.stringify(sample))
const indexSignature = sign(null, indexBytes, privateKey)
const cacheFile = () => path.join(path.dirname(databasePath), "release-index-cache-recommended.json")

let offline = false
let corruptSignature = false
const calls: string[] = []
const originalFetch = global.fetch

function installFetchMock() {
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init)
    calls.push(url)
    if (offline) throw new TypeError("fetch failed")
    const origin = new URL(url).origin
    const signature = url.endsWith(".sig")
    const response = new Response(signature ? (corruptSignature ? Buffer.alloc(64) : indexSignature) : indexBytes)
    Object.defineProperty(response, "url", {
      value: `${origin}/updates/revisions/1/index.json${signature ? ".sig" : ""}`,
    })
    return response
  }) as typeof fetch
}

before(async () => {
  fs.rmSync(databasePath, { force: true })
  ;({ db, initSchema } = await import("../db"))
  settings = await import("../services/settings")
  releaseIndex = await import("../services/release-index")
  productUpdates = await import("../services/product-updates")
  ;({ config } = await import("../config"))
  const { panelRouter } = await import("../routes/panel")
  const { HttpError, fail } = await import("../lib/http")
  initSchema()
  const app = express()
  app.use(express.json())
  app.use("/api/panel", panelRouter)
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) return fail(res, error.message, error.status, error.extra)
    return fail(res, "测试服务器内部错误", 500)
  })
  server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance))
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  baseUrl = `http://127.0.0.1:${address.port}/api/panel/settings`
  installFetchMock()
})

beforeEach(() => {
  db.exec("DELETE FROM settings; DELETE FROM logs")
  settings.invalidateSettingsCache()
  releaseIndex.invalidateReleaseIndexCache()
  calls.length = 0
  offline = false
  corruptSignature = false
})

after(async () => {
  global.fetch = originalFetch
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  db.close()
  fs.rmSync(databasePath, { force: true })
  fs.rmSync(`${databasePath}-shm`, { force: true })
  fs.rmSync(`${databasePath}-wal`, { force: true })
  fs.rmSync(cacheFile(), { force: true })
})

const headers = () => ({ Authorization: `Bearer ${config.panelApiKey}`, "Content-Type": "application/json" })
const putSettings = (patch: unknown) =>
  originalFetch(baseUrl, { method: "PUT", headers: headers(), body: JSON.stringify(patch) })

test("未持久化时回退 NACHO_UPDATE_ORIGIN，并在 runtime-info 中标记来源", async () => {
  const reader = releaseIndex.createReleaseIndexReader(publicKey)
  const { index } = await reader(true)
  assert.equal(index.sequence, 1)
  assert.ok(calls.length >= 2)
  assert.ok(calls.every((url) => url.startsWith("https://env.example.test/")))

  const runtime = productUpdates.runtimeInfo()
  assert.equal(runtime.updateSourceConfigured, true)
  assert.equal(runtime.updateSource, "https://env.example.test")
  assert.equal(runtime.updateSourceOrigin, "env")
  assert.equal(runtime.capabilities.updateSourceManagement, true)
  assert.equal(runtime.capabilities.featureMinimums.updateSourceManagement, "0.4.1")

  const cached = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as { origin?: string }
  assert.equal(cached.origin, "https://env.example.test")
})

test("面板保存 origin 后 runtime-info 立即变化，缓存被清空并从新源读取", async () => {
  const reader = releaseIndex.createReleaseIndexReader(publicKey)
  await reader(true)
  assert.ok(fs.existsSync(cacheFile()))

  const response = await putSettings({ updates: { origin: "https://panel.example.test/" } })
  assert.equal(response.status, 200)
  assert.equal(fs.existsSync(cacheFile()), false, "保存后磁盘缓存必须清空")

  const runtime = productUpdates.runtimeInfo()
  assert.equal(runtime.updateSourceConfigured, true)
  assert.equal(runtime.updateSource, "https://panel.example.test")
  assert.equal(runtime.updateSourceOrigin, "panel")

  calls.length = 0
  const { index } = await reader()
  assert.equal(index.sequence, 1)
  assert.ok(calls.length >= 2)
  assert.ok(calls.every((url) => url.startsWith("https://panel.example.test/")))
})

test("缓存来源与当前 origin 不一致时不得复用旧索引", async () => {
  const reader = releaseIndex.createReleaseIndexReader(publicKey)
  await reader(true)
  assert.ok(fs.existsSync(cacheFile()))

  // 绕过路由直接改设置，保留旧 origin 的内存与磁盘缓存，验证读取侧按 origin 隔离。
  settings.mergeSettings({ updates: { origin: "https://panel.example.test" } })
  offline = true
  await assert.rejects(reader(), /fetch failed|网络|超时|HTTP/)
})

test("切换 origin 时在途请求的结果不会写回缓存", async () => {
  const reader = releaseIndex.createReleaseIndexReader(publicKey)
  const pending = reader(true)
  releaseIndex.invalidateReleaseIndexCache()
  await assert.rejects(pending, /更新源已变更/)
  assert.equal(fs.existsSync(cacheFile()), false)
})

test("签名校验在动态 origin 下仍然生效", async () => {
  corruptSignature = true
  const reader = releaseIndex.createReleaseIndexReader(publicKey)
  await assert.rejects(reader(true), /签名无效/)
})
