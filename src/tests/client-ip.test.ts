import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import express from "express"
import type http from "node:http"
import { after, before, beforeEach, test } from "node:test"
import {
  isLoopbackOrPrivateAddress,
  normalizeAddress,
  parseForwardedFor,
  resolveClientIp,
} from "../lib/client-ip"

// 测试数据全部落在临时目录，避免在仓库根留下数据库与归档。
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nacho-client-ip-test-"))
process.env.DATABASE_PATH = path.join(testRoot, "client-ip.db")
process.env.ARTIFACTS_PATH = path.join(testRoot, "artifacts")
process.env.LOG_RETENTION_MAX = "1000"
process.env.ENROLLMENT_KEY = "client-ip-enroll-key"
// 本文件默认验证“已开启 TRUST_PROXY”的场景；关闭场景在用例内临时改写 config。
process.env.TRUST_PROXY = "true"
delete process.env.ALLOW_OPEN_ENROLLMENT

const VALID_KEY = "client-ip-enroll-key"
const INVALID_KEY = "client-ip-invalid-key"

let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let agentRouter: typeof import("../routes/agent").agentRouter
let clients: typeof import("../services/clients")
let settings: typeof import("../services/settings")
let enrollmentGuard: typeof import("../services/enrollment-guard")
let config: typeof import("../config").config

before(async () => {
  ;({ db, initSchema } = await import("../db"))
  ;({ agentRouter } = await import("../routes/agent"))
  clients = await import("../services/clients")
  settings = await import("../services/settings")
  enrollmentGuard = await import("../services/enrollment-guard")
  ;({ config } = await import("../config"))
  initSchema()
  // 关闭开放注册：错误的入网密钥必然被拒绝，从而触发注册限流。
  settings.saveSettings({ security: { openEnrollment: false } })
})

beforeEach(() => {
  db.exec("DELETE FROM clients; DELETE FROM logs")
  enrollmentGuard.resetEnrollmentGuard()
  config.trustProxy = true
})

after(() => {
  db.close()
  fs.rmSync(testRoot, { recursive: true, force: true })
})

async function withServer(run: (base: string) => Promise<void>) {
  const app = express()
  app.use(express.json())
  app.use("/agent", agentRouter)
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance))
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

function enroll(base: string, headers: Record<string, string>, body: Record<string, unknown>) {
  return fetch(`${base}/agent/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

/* -------------------- 地址归一化 -------------------- */

test("normalizeAddress 处理 IPv6 映射、方括号、端口与 zone", () => {
  assert.equal(normalizeAddress("::ffff:203.0.113.7"), "203.0.113.7")
  assert.equal(normalizeAddress("::FFFF:127.0.0.1"), "127.0.0.1")
  assert.equal(normalizeAddress("::ffff:7f00:1"), "127.0.0.1")
  assert.equal(normalizeAddress("[2001:db8::1]:443"), "2001:db8::1")
  assert.equal(normalizeAddress("203.0.113.9:4434"), "203.0.113.9")
  assert.equal(normalizeAddress("fe80::1%eth0"), "fe80::1")
  assert.equal(normalizeAddress("  "), "")
  assert.equal(normalizeAddress(undefined), "")
})

test("isLoopbackOrPrivateAddress 只承认回环与私有网段", () => {
  for (const address of ["127.0.0.1", "::1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::ffff:192.168.0.9", "fd00::1", "fe80::1"]) {
    assert.equal(isLoopbackOrPrivateAddress(address), true, address)
  }
  for (const address of ["203.0.113.7", "8.8.8.8", "2001:db8::1", "", undefined]) {
    assert.equal(isLoopbackOrPrivateAddress(address), false, String(address))
  }
})

test("parseForwardedFor 拆分、归一化并丢弃空项", () => {
  assert.deepEqual(parseForwardedFor("203.0.113.7, 10.0.0.5"), ["203.0.113.7", "10.0.0.5"])
  assert.deepEqual(parseForwardedFor(" , ::ffff:198.51.100.4 ,"), ["198.51.100.4"])
  assert.deepEqual(parseForwardedFor(""), [])
  assert.deepEqual(parseForwardedFor(undefined), [])
})

/* -------------------- 直连 -------------------- */

test("直连：未开启 TRUST_PROXY 时完全忽略转发头", () => {
  assert.equal(resolveClientIp({ remoteAddress: "203.0.113.50", forwardedFor: "1.2.3.4", trustProxy: false }), "203.0.113.50")
  assert.equal(resolveClientIp({ remoteAddress: "::ffff:198.51.100.9", forwardedFor: "1.2.3.4", trustProxy: false }), "198.51.100.9")
  assert.equal(resolveClientIp({ remoteAddress: "127.0.0.1", forwardedFor: "1.2.3.4", trustProxy: false }), "127.0.0.1")
})

test("直连：对端不是可信代理时即使开启 TRUST_PROXY 也不解析转发头", () => {
  assert.equal(resolveClientIp({ remoteAddress: "203.0.113.50", forwardedFor: "1.2.3.4", trustProxy: true }), "203.0.113.50")
  assert.equal(resolveClientIp({ remoteAddress: "2001:db8::9", forwardedFor: "1.2.3.4", trustProxy: true }), "2001:db8::9")
})

test("直连：TRUST_PROXY 关闭时 HTTP 请求记录 socket 地址，伪造头不生效", async () => {
  config.trustProxy = false
  await withServer(async (base) => {
    const response = await enroll(base, { "x-forwarded-for": "203.0.113.7" }, { enrollmentKey: VALID_KEY, name: "direct-fixture" })
    assert.equal(response.status, 201)
    const envelope = (await response.json()) as { data: { client: { ip: string } } }
    assert.equal(envelope.data.client.ip, "127.0.0.1")
  })
})

/* -------------------- 代理链 -------------------- */

test("代理链：取最靠近本机的第一个非代理地址", () => {
  assert.equal(
    resolveClientIp({ remoteAddress: "127.0.0.1", forwardedFor: "203.0.113.7, 198.51.100.23, 10.0.0.5", trustProxy: true }),
    "198.51.100.23",
  )
  // 左侧伪造段被跳过：客户端无法影响解析结果。
  assert.equal(
    resolveClientIp({ remoteAddress: "::ffff:127.0.0.1", forwardedFor: "9.9.9.9, 198.51.100.23", trustProxy: true }),
    "198.51.100.23",
  )
  // 整条链都是回环/私有地址时退回链尾（代理实际看到的对端）。
  assert.equal(resolveClientIp({ remoteAddress: "127.0.0.1", forwardedFor: "10.0.0.5, 192.168.3.4", trustProxy: true }), "192.168.3.4")
  // 没有转发头时使用直连地址。
  assert.equal(resolveClientIp({ remoteAddress: "127.0.0.1", trustProxy: true }), "127.0.0.1")
})

test("代理链：设备注册记录的 ip 是解析后的客户端地址", async () => {
  await withServer(async (base) => {
    const response = await enroll(
      base,
      { "x-forwarded-for": "203.0.113.7, 198.51.100.23, 10.0.0.5" },
      { enrollmentKey: VALID_KEY, name: "proxied-fixture" },
    )
    assert.equal(response.status, 201)
    const envelope = (await response.json()) as { data: { client: { id: string; ip: string } } }
    assert.equal(envelope.data.client.ip, "198.51.100.23")
    assert.equal(clients.getClient(envelope.data.client.id)?.ip, "198.51.100.23")
  })
})

/* -------------------- 伪造头与限流恢复 -------------------- */

test("伪造头：轮换 X-Forwarded-For 无法绕过注册限流", async () => {
  await withServer(async (base) => {
    // 每次伪造不同的首段，但可信代理追加的真实客户端地址不变，限流桶因此不变。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await enroll(
        base,
        { "x-forwarded-for": `10.9.9.${attempt}, 198.51.100.23` },
        { enrollmentKey: INVALID_KEY, name: `spoof-fixture-${attempt}`, id: `spoof-device-${attempt}` },
      )
      assert.equal(response.status, 401, `attempt ${attempt} 应当被拒绝而不是被限流`)
    }
    const blocked = await enroll(
      base,
      { "x-forwarded-for": "10.9.9.250, 198.51.100.23" },
      { enrollmentKey: INVALID_KEY, name: "spoof-fixture-blocked", id: "spoof-device-blocked" },
    )
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get("retry-after")) > 0)
  })
})

test("伪造头：直连公网对端伪造的转发头不改变限流维度", () => {
  const resolved = resolveClientIp({ remoteAddress: "203.0.113.50", forwardedFor: "10.9.9.9", trustProxy: true })
  assert.equal(resolved, "203.0.113.50")
  const start = 3_000_000
  for (let i = 0; i < 20; i += 1) {
    assert.equal(enrollmentGuard.checkEnrollmentAttempt(resolved, undefined, start + i).blocked, false)
  }
  // 换一个伪造头无效：解析结果不变，仍然命中同一个桶。
  const stillSame = resolveClientIp({ remoteAddress: "203.0.113.50", forwardedFor: "8.8.4.4", trustProxy: true })
  assert.equal(stillSame, resolved)
  assert.equal(enrollmentGuard.checkEnrollmentAttempt(stillSame, undefined, start + 21).blocked, true)
})

test("限流恢复：窗口结束后同一解析地址重新放行", () => {
  const start = 2_000_000
  for (let i = 0; i < 20; i += 1) {
    assert.equal(enrollmentGuard.checkEnrollmentAttempt("198.51.100.23", undefined, start + i).blocked, false)
  }
  assert.equal(enrollmentGuard.checkEnrollmentAttempt("198.51.100.23", undefined, start + 20).blocked, true)
  assert.equal(enrollmentGuard.checkEnrollmentAttempt("198.51.100.23", undefined, start + 60_001).blocked, false)
})
