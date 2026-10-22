import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import test from "node:test"

test("推荐索引绑定不可变发布；上传时仅面板变化可提交，服务端变化须重新确认", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nacho-recommended-stage-"))
  const environment = Object.fromEntries(["DATABASE_PATH", "ARTIFACTS_PATH", "NACHO_UPDATE_ORIGIN"].map((name) => [name, process.env[name]]))
  const originalFetch = global.fetch
  process.env.DATABASE_PATH = path.join(root, "test.db")
  process.env.ARTIFACTS_PATH = path.join(root, "artifacts")
  process.env.NACHO_UPDATE_ORIGIN = "https://updates.example.test"
  const { privateKey: key, publicKey } = generateKeyPairSync("ed25519")
  const payload = Buffer.from("fixture-agent")
  const sha256 = createHash("sha256").update(payload).digest("hex")
  const asset = (repo: string, version: string, fileName: string) => ({
    fileName, url: `https://github.com/nachomao/${repo}/releases/download/v${version}/${fileName}`,
    sha256, sizeBytes: payload.length,
  })
  const sample = (sequence: number, panelVersion = "0.2.4", serverVersion = "1.1.24") => ({
    schemaVersion: 4, sequence, publishedAt: "2026-10-10T00:00:00Z", releases: {
      panel: { version: panelVersion, releaseType: "beta", sourceCommit: "a".repeat(40), title: "面板", notes: "测试",
        publishedAt: "2026-10-10T00:00:00Z", asset: asset("nacho-main", panelVersion, `NachoPanel-Setup-${panelVersion}.exe`) },
      server: { version: serverVersion, releaseType: "stable", sourceCommit: "b".repeat(40), title: "服务端", notes: "测试",
        publishedAt: "2026-10-10T00:00:00Z", minPanelVersion: "0.2.4", minAgentVersion: "1.0.0", minServerVersion: "1.0.0",
        source: asset("nacho-server", serverVersion, `nacho-server-source-${serverVersion}.tar.gz`),
        agent: asset("nacho-server", serverVersion, `nacho-agent-${serverVersion}-win-x64.exe`) },
    },
  })
  const revisions = new Map<number, { bytes: Buffer; signature: Buffer }>()
  let current = 1, offline = false, corrupt = false
  const calls: string[] = []
  function publish(index: ReturnType<typeof sample>) {
    const bytes = Buffer.from(JSON.stringify(index))
    revisions.set(index.sequence, { bytes, signature: sign(null, bytes, key) })
    current = index.sequence
  }
  publish(sample(1))
  global.fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (offline) throw new TypeError("fetch failed")
    const sequence = url.endsWith("/updates/index.json") ? current : Number(/\/revisions\/(\d+)\//.exec(url)?.[1])
    const revision = revisions.get(sequence)!
    assert.ok(revision, url)
    const signature = url.endsWith(".sig")
    const response = new Response(signature ? corrupt ? Buffer.alloc(64) : revision.signature : revision.bytes)
    Object.defineProperty(response, "url", { value: `https://updates.example.test/updates/revisions/${sequence}/index.json${signature ? ".sig" : ""}` })
    return response
  }
  try {
    fs.writeFileSync(path.join(root, "update-channel.json"), '{"channel":"alpha"}')
    const { initSchema } = await import("../db")
    initSchema()
    const { createReleaseIndexReader } = await import("../services/release-index")
    const getReleaseIndex = createReleaseIndexReader(publicKey)
    const { createStage, appendStage, commitStage } = await import("../services/update-staging")
    const { changeUpdateChannel, runtimeInfo } = await import("../services/product-updates")
    const initial = await getReleaseIndex(true)
    assert.equal(initial.index.releases.panel.releaseType, "beta")
    assert.equal(initial.index.releases.agent.releaseType, "stable")
    assert.equal(runtimeInfo().updateMode, "recommended")
    assert.equal(runtimeInfo().updateSourceConfigured, true)
    assert.ok(calls.every((url) => !url.includes("/alpha/")))
    const stage = await createStage("agent", "1.1.24", 1, getReleaseIndex)
    await appendStage(stage.id, 0, Readable.from([payload]), payload.length)
    publish(sample(2, "0.2.5"))
    assert.equal((await commitStage(stage.id, "0.2.4", getReleaseIndex)).phase, "ready")
    assert.equal((await getReleaseIndex(true, 1)).index.sequence, 1, "固定发布不受当前推荐序号变化影响")
    const manifest = path.join(root, "artifacts", "windows", "latest.json")
    assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).version, "1.1.24")

    const interrupted = await createStage("agent", "1.1.24", 1, getReleaseIndex)
    await appendStage(interrupted.id, 0, Readable.from([payload]), payload.length)
    publish(sample(3, "0.2.5", "1.1.25"))
    await assert.rejects(commitStage(interrupted.id, "0.2.4", getReleaseIndex), /发布清单与上传会话不匹配/)
    await assert.rejects(createStage("agent", "1.1.24", 1, getReleaseIndex), /有效的 GitHub 服务端发布/)
    assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).version, "1.1.24")
    const rollback = sample(4, "0.2.5", "1.1.23")
    publish(rollback)
    await assert.rejects(getReleaseIndex(true), /倒退/)
    const substituted = sample(4, "0.2.5", "1.1.25")
    substituted.releases.server.source.sha256 = "a".repeat(64)
    publish(substituted)
    await assert.rejects(getReleaseIndex(true), /同版本内容变化/)
    publish(sample(3, "0.2.5", "1.1.25"))
    corrupt = true
    await assert.rejects(getReleaseIndex(true), /签名无效/)
    corrupt = false
    offline = true
    assert.equal((await getReleaseIndex(true)).stale, true)
    await assert.rejects(getReleaseIndex(true, 1), /fetch failed/)
    await assert.rejects(commitStage(interrupted.id, "0.2.4", getReleaseIndex), /发布清单与上传会话不匹配/)
    await assert.rejects(changeUpdateChannel("beta"), /更新服务器决定/)
    assert.equal(fs.readFileSync(path.join(root, "update-channel.json"), "utf8"), '{"channel":"alpha"}')
    const { db } = await import("../db")
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM commands WHERE type='update-agent'").get() as { count: number }).count, 0)
  } finally {
    const { db } = await import("../db")
    db.close()
    global.fetch = originalFetch
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
