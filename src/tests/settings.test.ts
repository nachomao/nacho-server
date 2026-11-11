import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import express from "express"
import type http from "node:http"
import { after, before, beforeEach, test } from "node:test"

const databasePath = path.join(process.cwd(), "tmp-settings-test.db")
process.env.DATABASE_PATH = databasePath
process.env.LOG_RETENTION_MAX = "1234"
process.env.OFFLINE_THRESHOLD = "45"
delete process.env.ALLOW_OPEN_ENROLLMENT

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

async function getSettings(): Promise<Record<string, unknown>> {
  const response = await fetch(baseUrl, { headers: headers() })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { data: Record<string, unknown> }
  return body.data
}

function putSettings(patch: unknown): Promise<Response> {
  return fetch(baseUrl, { method: "PUT", headers: headers(), body: JSON.stringify(patch) })
}

test("缺失设置返回完整默认值，并沿用环境变量回退", async () => {
  const data = await getSettings()
  const general = data.general as Record<string, unknown>
  const conditions = data.conditions as Record<string, unknown>
  const security = data.security as Record<string, unknown>
  assert.equal(general.concurrency, 4)
  assert.equal(general.channelTimeout, 30)
  assert.equal(general.commandTimeout, 120)
  assert.equal(general.retryCount, 2)
  assert.equal(general.logRetentionDays, 30)
  assert.equal(general.logRetentionMax, 1234)
  assert.equal(general.offlineThreshold, 45)
  assert.equal(general.timezone, "UTC")
  assert.equal(general.autoCleanTasks, true)
  assert.equal(conditions.clientOffline, true)
  assert.equal(conditions.quietHours, false)
  assert.equal(security.openEnrollment, true)
  assert.equal(security.sessionTimeout, 30)
  assert.equal(data.forgot, undefined)
})

test("旧数据中的非法字段逐项回退，合法字段与未知字段保留", async () => {
  settings.saveSettings({
    general: { concurrency: 999, commandTimeout: 240, timezone: "Mars/Olympus", futureFlag: true },
    security: { openEnrollment: false },
    advanced: { mode: "compat" },
  })
  const data = await getSettings()
  const general = data.general as Record<string, unknown>
  assert.equal(general.concurrency, 4)
  assert.equal(general.commandTimeout, 240)
  assert.equal(general.timezone, "UTC")
  assert.equal(general.futureFlag, true)
  assert.equal((data.advanced as Record<string, unknown>).mode, "compat")
  assert.equal((data.security as Record<string, unknown>).openEnrollment, false)
  assert.equal(settings.getOpenEnrollmentSetting(true), false)
})

test("存储值损坏或不是对象时回退默认值", async () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('app', '[]') ON CONFLICT(key) DO UPDATE SET value = '[]'").run()
  settings.invalidateSettingsCache()
  const data = await getSettings()
  assert.equal((data.general as Record<string, unknown>).concurrency, 4)
  assert.equal((data.security as Record<string, unknown>).openEnrollment, true)
})

test("PUT 按分组浅合并，未提交字段与未知字段不被清空，重启后仍生效", async () => {
  const initial = await putSettings({
    general: { concurrency: 8, timezone: "Asia/Shanghai" },
    email: { password: "smtp-secret", host: "smtp.local" },
    conditions: { cpuThreshold: 70 },
    security: { openEnrollment: false },
    future: { mode: "x" },
  })
  assert.equal(initial.status, 200)

  const merged = await putSettings({ security: { openEnrollment: true } })
  assert.equal(merged.status, 200)
  const mergedData = (await merged.json()) as { data: Record<string, unknown> }
  const mergedGeneral = mergedData.data.general as Record<string, unknown>
  const mergedEmail = mergedData.data.email as Record<string, unknown>
  const mergedConditions = mergedData.data.conditions as Record<string, unknown>
  assert.equal(mergedGeneral.concurrency, 8)
  assert.equal(mergedGeneral.timezone, "Asia/Shanghai")
  assert.equal(mergedEmail.password, "smtp-secret")
  assert.equal(mergedEmail.host, "smtp.local")
  assert.equal(mergedConditions.cpuThreshold, 70)
  assert.equal((mergedData.data.security as Record<string, unknown>).openEnrollment, true)
  assert.deepEqual(mergedData.data.future, { mode: "x" })

  // 模拟服务重启：清空内存缓存后从 SQLite 重新读取。
  settings.invalidateSettingsCache()
  const reloaded = await getSettings()
  assert.equal((reloaded.general as Record<string, unknown>).concurrency, 8)
  assert.equal((reloaded.email as Record<string, unknown>).password, "smtp-secret")
})

test("设置审计日志只记录分组名，不写入 SMTP 密码等设置值", async () => {
  await putSettings({ email: { password: "smtp-secret-value", host: "private.smtp.local" } })
  const rows = db.prepare("SELECT message, detail FROM logs WHERE source = 'settings'").all() as Array<{ message: string; detail: string | null }>
  assert.ok(rows.length > 0)
  for (const row of rows) {
    const text = `${row.message}\n${row.detail ?? ""}`
    assert.equal(text.includes("smtp-secret-value"), false)
    assert.equal(text.includes("private.smtp.local"), false)
  }
  assert.match(rows[rows.length - 1].detail ?? "", /sections=email/)
})

test("非法设置值与非对象分组返回 400", async () => {
  const cases: unknown[] = [
    { general: { concurrency: 0 } },
    { general: { commandTimeout: "240" } },
    { general: { timezone: "Mars/Olympus" } },
    { conditions: { cpuThreshold: 101 } },
    { email: { encryption: "starttls" } },
    { security: { openEnrollment: "false" } },
    { general: [] },
  ]
  for (const patch of cases) {
    const response = await putSettings(patch)
    assert.equal(response.status, 400, `应拒绝 ${JSON.stringify(patch)}`)
  }
  const initial = await getSettings()
  assert.equal((initial.general as Record<string, unknown>).concurrency, 4)
})

test("未知分组字段在后续局部更新中保持原样", async () => {
  assert.equal((await putSettings({ general: { futureFlag: true } })).status, 200)
  assert.equal((await putSettings({ general: { concurrency: 6 } })).status, 200)
  const data = await getSettings()
  assert.equal((data.general as Record<string, unknown>).concurrency, 6)
  assert.equal((data.general as Record<string, unknown>).futureFlag, true)
})
