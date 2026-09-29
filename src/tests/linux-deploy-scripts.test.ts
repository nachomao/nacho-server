import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

const repoDir = path.resolve(".")
const deployDir = path.resolve("deploy")
const install = fs.readFileSync(path.join(deployDir, "install.sh"), "utf8")
const uninstall = fs.readFileSync(path.join(deployDir, "uninstall.sh"), "utf8")
const napl = fs.readFileSync(path.join(deployDir, "napl"), "utf8")
const release = fs.readFileSync(path.join(deployDir, "build-release.mjs"), "utf8")
const manifest = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")) as {
  name?: string
  license?: string
  repository?: { url?: string }
}

test("Linux installation installs napl and protects an existing entrypoint", () => {
  assert.match(install, /deploy\/napl/)
  assert.match(install, /\/usr\/local\/bin\/napl/)
  assert.match(install, /readlink -f/)
  assert.match(install, /ln -sfn/)
})

test("Linux installer uses LF line endings so bash accepts strict mode after cloud upload", () => {
  assert.doesNotMatch(install, /\r/)
  assert.match(install, /^#!\/usr\/bin\/env bash\n/)
  assert.match(install, /^set -euo pipefail\n/m)
})

// 逐个 .sh + 无扩展名的 napl 都要检查：只断言 install.sh 会漏掉新脚本，
// 而 CRLF 的 bash 脚本在 Linux 上会直接报 "invalid option name"。
test("every shell script in deploy/ is committed with LF line endings", () => {
  const scripts = fs.readdirSync(deployDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.sh$/.test(entry) || entry === "napl")
    .map((entry) => path.join(deployDir, entry))
  assert.ok(scripts.length >= 4, `期望至少检查 4 个脚本，实际 ${scripts.length}`)
  for (const script of scripts) {
    const content = fs.readFileSync(script, "utf8")
    assert.doesNotMatch(content, /\r/, `${path.relative(repoDir, script)} 含 CRLF，bash 无法在 Linux 上解析`)
    assert.match(content, /^#!\/usr\/bin\/env bash\n/, `${path.relative(repoDir, script)} 缺少 bash shebang`)
  }
})

test("gitattributes forces LF for all shell scripts instead of naming them one by one", () => {
  const attributes = fs.readFileSync(path.join(repoDir, ".gitattributes"), "utf8")
  assert.match(attributes, /^\*\.sh text eol=lf$/m)
  assert.match(attributes, /^deploy\/napl text eol=lf$/m)
  // 公钥与清单必须字节级保留，不能被行尾转换改写。
  assert.match(attributes, /^deploy\/napl-release-public\.pem -text$/m)
  assert.match(attributes, /^artifacts\/windows\/latest\.json -text$/m)
})

test("Linux uninstall only removes the entrypoint owned by this installation", () => {
  assert.match(uninstall, /readlink -f/)
  assert.match(uninstall, /\/usr\/local\/bin\/napl/)
  assert.match(uninstall, /rm -f "\$\{entry\}"/)
})

test("napl exposes the documented non-interactive command surface", () => {
  for (const command of [
    "status", "start", "stop", "restart", "logs", "config", "keys",
    "backup", "update", "uninstall",
  ]) {
    assert.match(napl, new RegExp(`\\b${command}\\b`))
  }
  assert.match(napl, /EXIT_PRIVILEGE=3/)
  assert.match(napl, /EXIT_SERVICE=4/)
  assert.match(napl, /EXIT_VALIDATION=5/)
  assert.match(napl, /EXIT_INTEGRITY=6/)
  assert.match(napl, /EXIT_ROLLBACK=7/)
})

test("release builder creates the fixed Linux asset name and signs the manifest", () => {
  assert.match(release, /control-server-\$\{version\}-linux-x64\.tar\.gz/)
  assert.match(release, /manifest\.sig/)
  assert.match(release, /pkeyutl/)
  assert.match(release, /NAPL_RELEASE_SIGNING_KEY_FILE/)
})

// 本仓库已从 nacho-main 拆分为独立的 nacho-server 仓库。发布地址在 napl 默认值、
// systemd 单元和 package.json 三处必须一致，否则在线升级会静默失效。
const REPO_SLUG = "nachomao/nacho-server"

test("release repository is consistent across napl, systemd unit and package.json", () => {
  assert.match(napl, new RegExp(`REPO="\\$\\{NAPL_GITHUB_REPO:-${REPO_SLUG.replace("/", "\\/")}\\}"`))
  assert.match(install, new RegExp(`Documentation=https://github\\.com/${REPO_SLUG.replace("/", "\\/")}`))
  assert.equal(manifest.repository?.url, `git+https://github.com/${REPO_SLUG}.git`)
})

test("napl derives the download allowlist from REPO instead of hardcoding a host path", () => {
  // 白名单必须跟随 REPO 变量，否则改了仓库地址后校验仍会拒绝合法下载。
  assert.doesNotMatch(napl, /nacho-main/)
  assert.match(napl, /node - "\$metadata" "\$REPO" <<'NODE'/)
  assert.match(napl, /const prefix = new RegExp\(/)
  assert.match(napl, /repo\.replace\(/)
  assert.match(napl, /prefix\.test\(item\.browser_download_url\)/)
  // 仓库名仍需做形状校验，避免注入到正则与 API 地址中。
  assert.match(napl, /if \(!\/\^\[A-Za-z0-9\._-\]\+\\\/\[A-Za-z0-9\._-\]\+\$\/\.test\(repo/)
})

test("server project identity stays nacho-server for the Windows local launcher", () => {
  assert.equal(manifest.name, "nacho-server")
  assert.equal(manifest.license, "AGPL-3.0")
  const launcher = fs.readFileSync(path.join(deployDir, "windows", "local-control-server.ps1"), "utf8")
  assert.match(launcher, /\$Manifest\.name -ne "nacho-server"/)
})
