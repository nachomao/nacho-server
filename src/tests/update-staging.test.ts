import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import test from "node:test"

test("分块上传可断点续传，拒绝重复偏移和短块并恢复文件长度", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nacho-update-stage-test-"))
  const old = process.env.DATABASE_PATH
  process.env.DATABASE_PATH = path.join(root, "test.db")
  try {
    const { appendStage, getStage, commitStage } = await import("../services/update-staging")
    const id = randomUUID()
    const directory = path.join(root, "update-staging", id)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, "payload"), "")
    fs.writeFileSync(path.join(directory, "stage.json"), JSON.stringify({
      id, kind: "server", version: "1.1.22", sequence: 1, channel: "stable",
      sizeBytes: 6, sha256: "a".repeat(64), fileName: "source.tar.gz",
      offset: 0, phase: "uploading", publishedAt: "2026-09-30T00:00:00Z",
    }))
    assert.equal((await appendStage(id, 0, Readable.from([Buffer.from("abcd")]), 4)).offset, 4)
    await assert.rejects(appendStage(id, 0, Readable.from([Buffer.from("abcd")]), 4), /位置/)
    await assert.rejects(appendStage(id, 4, Readable.from([Buffer.from("e")]), 2), /未完整/)
    assert.equal(getStage(id).offset, 4)
    assert.equal(fs.statSync(path.join(directory, "payload")).size, 4)
    assert.equal((await appendStage(id, 4, Readable.from([Buffer.from("ef")]), 2)).offset, 6)
    assert.equal(fs.readFileSync(path.join(directory, "payload"), "utf8"), "abcdef")
    const completed = getStage(id)
    completed.phase = "ready"
    fs.writeFileSync(path.join(directory, "stage.json"), JSON.stringify(completed))
    assert.equal((await commitStage(id, "0.1.6")).phase, "ready")
    assert.throws(() => getStage("../outside"), /会话无效/)
  } finally {
    const { db } = await import("../db")
    db.close()
    if (old === undefined) delete process.env.DATABASE_PATH
    else process.env.DATABASE_PATH = old
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
