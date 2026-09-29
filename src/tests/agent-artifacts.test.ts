import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

// artifacts/windows 只允许存在 latest.json 指向的那一个当前版本 exe。
// 旧版本既无引用方，又会让仓库体积随发布次数线性膨胀；client/deploy/publish.ps1
// 在发布时自动清理，这里负责兜住手工改动和跨机器同步带来的偏差。
const artifactsDir = path.resolve("artifacts", "windows")
const manifestPath = path.join(artifactsDir, "latest.json")

interface Manifest {
  version?: string
  fileName?: string
  sha256?: string
  sizeBytes?: number
  rid?: string
}

test("latest.json describes a strictly named win-x64 artifact", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest
  assert.match(manifest.version || "", /^\d+\.\d+\.\d+$/)
  assert.match(manifest.fileName || "", /^nacho-agent-\d+\.\d+\.\d+-win-x64\.exe$/)
  assert.equal(manifest.rid, "win-x64")
  assert.match(manifest.sha256 || "", /^[a-f0-9]{64}$/)
  assert.ok((manifest.sizeBytes || 0) > 0)
  // 文件名里的版本必须与 version 字段一致，否则 latest.json 会指向错误的制品。
  assert.equal(manifest.fileName, `nacho-agent-${manifest.version}-win-x64.exe`)
})

test("artifacts/windows contains exactly the one executable named by latest.json", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest
  const present = fs.readdirSync(artifactsDir).filter((name) => name.endsWith(".exe"))
  assert.deepEqual(
    present,
    [manifest.fileName],
    `artifacts/windows 应只保留当前版本 ${manifest.fileName}，实际有：${present.join(", ") || "（无）"}`,
  )
})

test("the retained executable matches the size and SHA-256 recorded in latest.json", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest
  const artifact = path.join(artifactsDir, manifest.fileName!)
  assert.ok(fs.existsSync(artifact), `缺少当前版本制品：${artifact}；请运行 client/deploy/publish.ps1 后再提交`)
  const bytes = fs.readFileSync(artifact)
  assert.equal(bytes.length, manifest.sizeBytes, "制品字节数与 latest.json 不一致")
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.sha256, "制品 SHA-256 与 latest.json 不一致")
})

test("publish.ps1 prunes superseded executables so the invariant is tool-enforced", () => {
  const publish = fs.readFileSync(path.resolve("client", "deploy", "publish.ps1"), "utf8")
  assert.match(publish, /Remove-Item -Force/)
  assert.match(publish, /Where-Object \{ \$_\.Name -ne \$name \}/)
  // 清理必须发生在写入 latest.json 之后，避免中途失败留下"清单指向已删文件"。
  assert.ok(publish.indexOf("latest.json')") < publish.lastIndexOf("Remove-Item -Force"))
})
