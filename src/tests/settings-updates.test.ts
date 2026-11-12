import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import express from "express"
import type http from "node:http"
import { after, before, beforeEach, test } from "node:test"

const databasePath = path.join(process.cwd(), "tmp-settings-updates-test.db")
process.env.DATABASE_PATH = databasePath
process.env.NACHO_UPDATE_ORIGIN = "https://env.example.test/"

let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let settings: typeof import("../services/settings")
let config: typeof import("../config").config
let server: http.Server
let baseUrl: string

before(async () => {
  fs.rmSync(databasePath, { force: true })
  ;({ db, initSchema } = await import("../db"))
  settings = await import("../services/settings")
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
})

beforeEach(() => {
  db.exec("DELETE FROM settings; DELETE FROM logs")
  settings.invalidateSettingsCache()
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  db.close()
  fs.rmSync(databasePath, { force: true })
  fs.rmSync(`${databasePath}-shm`, { force: true })
  fs.rmSync(`${databasePath}-wal`, { force: true })
})

const headers = () => ({
  Authorization: `Bearer ${config.panelApiKey}`,
  "Content-Type": "application/json",
})

async function getSettings(): Promise<Record<string, Record<string, unknown>>> {
  const response = await fetch(baseUrl, { headers: headers() })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { data: Record<string, Record<string, unknown>> }
  return body.data
}

function putSettings(patch: unknown): Promise<Response> {
  return fetch(baseUrl, { method: "PUT", headers: headers(), body: JSON.stringify(patch) })
}

test("默认更新源来自 NACHO_UPDATE_ORIGIN 并去除尾斜杠", async () => {
  const data = await getSettings()
  assert.equal(data.updates.origin, "https://env.example.test")
  assert.deepEqual(settings.resolveUpdateOrigin(), { origin: "https://env.example.test", source: "env" })
})

test("面板保存的非空 origin 优先于环境变量，并跨缓存重载保留", async () => {
  const response = await putSettings({ updates: { origin: "https://panel.example.test///" } })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { data: Record<string, Record<string, unknown>> }
  assert.equal(body.data.updates.origin, "https://panel.example.test")
  assert.deepEqual(settings.resolveUpdateOrigin(), { origin: "https://panel.example.test", source: "panel" })

  // 模拟服务重启：清空内存缓存后从 SQLite 重新读取。
  settings.invalidateSettingsCache()
  const reloaded = await getSettings()
  assert.equal(reloaded.updates.origin, "https://panel.example.test")
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string }
  assert.equal((JSON.parse(row.value) as { updates?: { origin?: string } }).updates?.origin, "https://panel.example.test")
})

test("空字符串表示未配置，生效值回退环境变量", async () => {
  assert.equal((await putSettings({ updates: { origin: "https://panel.example.test" } })).status, 200)
  assert.equal((await putSettings({ updates: { origin: "" } })).status, 200)
  const data = await getSettings()
  assert.equal(data.updates.origin, "https://env.example.test")
  assert.deepEqual(settings.resolveUpdateOrigin(), { origin: "https://env.example.test", source: "env" })
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string }
  assert.equal((JSON.parse(row.value) as { updates?: { origin?: string } }).updates?.origin, "")
})

test("非法 origin 与占位值全部拒绝且不覆盖旧值", async () => {
  assert.equal((await putSettings({ updates: { origin: "https://panel.example.test" } })).status, 200)
  const invalid: unknown[] = [
    "http://panel.example.test",
    "https://panel.example.test/updates",
    "https://panel.example.test?x=1",
    "https://user:pass@panel.example.test",
    "https://updates.example.invalid",
    "https://",
    "https://panel.example.test#fragment",
    "https://panel.example.test/\u0001",
    "https://panel.example.test:99999",
    123,
  ]
  for (const origin of invalid) {
    const response = await putSettings({ updates: { origin } })
    assert.equal(response.status, 400, `应拒绝 ${String(origin)}`)
  }
  const data = await getSettings()
  assert.equal(data.updates.origin, "https://panel.example.test")
})

test("updates 分组中的未知字段在局部更新中保持原样", async () => {
  assert.equal((await putSettings({ updates: { futureFlag: true } })).status, 200)
  assert.equal((await putSettings({ updates: { origin: "https://panel.example.test" } })).status, 200)
  const data = await getSettings()
  assert.equal(data.updates.futureFlag, true)
  assert.equal(data.updates.origin, "https://panel.example.test")
})

test("并发保存不同分组时 origin 与其他设置都不丢失", async () => {
  const [updatesResponse, securityResponse] = await Promise.all([
    putSettings({ updates: { origin: "https://panel.example.test" } }),
    putSettings({ security: { openEnrollment: false } }),
  ])
  assert.equal(updatesResponse.status, 200)
  assert.equal(securityResponse.status, 200)
  const data = await getSettings()
  assert.equal(data.updates.origin, "https://panel.example.test")
  assert.equal(data.security.openEnrollment, false)
})

test("审计日志记录分组名与 origin，不写入其他设置值", async () => {
  assert.equal((await putSettings({
    updates: { origin: "https://panel.example.test" },
    email: { password: "smtp-secret-value" },
  })).status, 200)
  const rows = db.prepare("SELECT message, detail FROM logs WHERE source = 'settings'").all() as Array<{ message: string; detail: string | null }>
  assert.ok(rows.length > 0)
  const last = rows[rows.length - 1]
  const text = `${last.message}\n${last.detail ?? ""}`
  assert.match(last.detail ?? "", /sections=email,updates/)
  assert.match(last.detail ?? "", /origin=https:\/\/panel\.example\.test/)
  assert.equal(text.includes("smtp-secret-value"), false)
})
