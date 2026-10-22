import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import test from "node:test"

// 在服务端独立测试编译前的 CommonJS 模块；核心传输用真实 HTTP 夹具覆盖。
const requireTransport = createRequire(path.join(process.cwd(), "package.json"))
test("server download helper is present after a standalone build", () => {
  const modulePath = path.join(process.cwd(), "src/lib/github-download.cjs")
  assert.ok(fs.existsSync(modulePath))
  const transport = requireTransport(modulePath)
  assert.equal(transport.PROBE_TIMEOUT_MS, 5000)
  assert.equal(transport.MAX_CONNECTIONS, 4)
  assert.equal(transport.isGitHubFile("https://github.com/nachomao/nacho-server/releases/download/v1/file.exe"), true)
  assert.equal(transport.isGitHubFile("https://maojiu.cc/artifacts/file.exe"), false)
})

test("root aria2 broker accepts only its fixed request and fixed package installer", () => {
  const broker = fs.readFileSync("deploy/prepare-download-tool.mjs", "utf8")
  const installer = fs.readFileSync("deploy/prepare-download-tool.sh", "utf8")
  assert.match(broker, /O_NOFOLLOW/)
  assert.match(broker, /parsed\.tool !== "aria2"/)
  assert.match(broker, /source\.uid !== 0/)
  assert.match(installer, /install -y aria2/)
  assert.match(installer, /175s/)
  assert.doesNotMatch(installer, /eval|sudo|install -y "\$/)
})

test("installation, upgrade and uninstall maintain the fixed tool preparation units", () => {
  for (const name of ["install.sh", "napl"]) {
    assert.match(fs.readFileSync(`deploy/${name}`, "utf8"), /install-download-service\.sh/)
  }
  for (const name of ["uninstall.sh", "napl"]) {
    assert.match(fs.readFileSync(`deploy/${name}`, "utf8"), /control-server-downloader\.path/)
    assert.match(fs.readFileSync(`deploy/${name}`, "utf8"), /\/usr\/local\/lib\/nacho-downloader/)
  }
})
