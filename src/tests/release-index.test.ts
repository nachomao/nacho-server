import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import test from "node:test"
import { compareReleaseVersions, verifyReleaseIndex, UPDATE_ORIGIN } from "../services/release-index"

const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const index = {
  schemaVersion: 2, channel: "stable", sequence: 7, publishedAt: "2026-09-29T00:00:00Z",
  releases: {
    panel: { version: "0.1.3", fileName: "NachoPanel-Setup-0.1.3.exe", sha256: "a".repeat(64), sizeBytes: 100, publishedAt: "2026-09-29T00:00:00Z", url: `${UPDATE_ORIGIN}/artifacts/panel/0.1.3/${"a".repeat(64)}/NachoPanel-Setup-0.1.3.exe`, authenticodeThumbprint: "A".repeat(40), title: "面板", notes: "更新", sourceCommit: "f".repeat(40) },
    server: { version: "1.0.1", fileName: "control-server-1.0.1-linux-x64.tar.gz", sha256: "b".repeat(64), sizeBytes: 100, publishedAt: "2026-09-29T00:00:00Z", url: `${UPDATE_ORIGIN}/artifacts/server/1.0.1/${"b".repeat(64)}/control-server-1.0.1-linux-x64.tar.gz`, minPanelVersion: "0.1.2", title: "服务端", notes: "更新", sourceCommit: "f".repeat(40), windows: { fileName: "control-server-1.0.1-win-x64.zip", url: `${UPDATE_ORIGIN}/artifacts/server/1.0.1/${"d".repeat(64)}/control-server-1.0.1-win-x64.zip`, sha256: "d".repeat(64), sizeBytes: 100 } },
    agent: { version: "1.1.22", fileName: "nacho-agent-1.1.22-win-x64.exe", sha256: "c".repeat(64), sizeBytes: 100, publishedAt: "2026-09-29T00:00:00Z", url: `${UPDATE_ORIGIN}/artifacts/agent/1.1.22/${"c".repeat(64)}/nacho-agent-1.1.22-win-x64.exe`, minServerVersion: "1.0.0", title: "Agent", notes: "更新", sourceCommit: "f".repeat(40) },
  },
}
function signed(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value))
  return { bytes, signature: sign(null, bytes, privateKey) }
}
test("发布索引使用签名固定发布地址和严格版本", () => {
  const { bytes, signature } = signed(index)
  assert.equal(verifyReleaseIndex(bytes, signature, publicKey).releases.agent.version, "1.1.22")
  assert.equal(compareReleaseVersions("1.1.22", "1.1.21"), 1)
  assert.equal(compareReleaseVersions("1.0.0", "1.0.0"), 0)
  assert.throws(() => compareReleaseVersions("1.0", "1.0.0"))
  assert.throws(() => verifyReleaseIndex(Buffer.from(bytes.toString().replace("1.0.1", "1.0.2")), signature, publicKey), /签名/)
  assert.throws(() => verifyReleaseIndex(bytes, Buffer.alloc(64), publicKey), /签名/)
})
test("即使索引被签名，仍拒绝任意下载地址", () => {
  const forged = structuredClone(index)
  forged.releases.agent.url = "https://example.org/agent.exe"
  const { bytes, signature } = signed(forged)
  assert.throws(() => verifyReleaseIndex(bytes, signature, publicKey), /固定发布路径/)
  const windows = structuredClone(index)
  windows.releases.server.windows.url = "https://example.org/server.zip"
  const signedWindows = signed(windows)
  assert.throws(() => verifyReleaseIndex(signedWindows.bytes, signedWindows.signature, publicKey), /Windows 服务端/)
})
test("未签名面板发布允许省略 Authenticode 指纹，但不能绕过索引签名", () => {
  const unsigned = structuredClone(index)
  delete (unsigned.releases.panel as { authenticodeThumbprint?: string }).authenticodeThumbprint
  const { bytes, signature } = signed(unsigned)
  assert.equal(verifyReleaseIndex(bytes, signature, publicKey).releases.panel.authenticodeThumbprint, undefined)
  assert.throws(() => verifyReleaseIndex(bytes, Buffer.alloc(64), publicKey), /签名无效/)
  const invalid = structuredClone(unsigned)
  ;(invalid.releases.panel as { authenticodeThumbprint?: string | null }).authenticodeThumbprint = null
  const signedInvalid = signed(invalid)
  assert.throws(() => verifyReleaseIndex(signedInvalid.bytes, signedInvalid.signature, publicKey), /证书指纹/)
})
