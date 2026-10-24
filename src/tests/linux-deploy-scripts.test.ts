import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
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
  scripts?: Record<string, string>
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
  assert.match(uninstall, /systemctl disable --now control-server-updater\.path/)
  assert.match(napl, /systemctl disable --now control-server-updater\.path/)
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

test("napl 交互菜单使用统一选择器、状态头部与无色降级，且保留源码载入入口", () => {
  assert.match(napl, /menu_select\(\) \{/)
  assert.match(napl, /render_menu_frame\(\) \{/)
  assert.match(napl, /menu_item_line\(\) \{/)
  assert.match(napl, /menu_redraw_item\(\) \{/)
  assert.match(napl, /menu_park_cursor\(\) \{/)
  assert.match(napl, /menu_status_load\(\) \{/)
  assert.match(napl, /menu_step_index\(\) \{/)
  assert.match(napl, /NO_COLOR/)
  assert.match(napl, /BASH_SOURCE\[0\]/)
  assert.match(napl, /\$'\\033'/)
  // 旧版盲目提示已被子菜单替换，避免再次退化为“输入字母/单词”的交互。
  assert.doesNotMatch(napl, /printf 'panel\/enrollment/)
  assert.doesNotMatch(napl, /printf 'start\/stop\/restart/)
  assert.doesNotMatch(napl, /printf 'list\/create\/restore/)
  assert.doesNotMatch(napl, /printf 'check\/install/)
  assert.doesNotMatch(napl, /printf 'keep-data\/purge/)
})

test("release builder creates the fixed Linux asset name and signs the manifest", () => {
  assert.match(release, /control-server-\$\{version\}-linux-x64\.tar\.gz/)
  assert.match(release, /manifest\.sig/)
  assert.match(release, /pkeyutl/)
  assert.match(release, /NAPL_RELEASE_SIGNING_KEY_FILE/)
  assert.doesNotMatch(release, /artifacts\/windows/)
  assert.doesNotMatch(install, /verify_windows_artifact/)
})

test("Linux updater is root-owned and restores the pre-upgrade database after an unhealthy start", () => {
  assert.match(install, /control-server-updater\.path/)
  assert.match(install, /install -m 755 -o root -g root/)
  assert.match(install, /install -d -m 755 -o root -g root "\$\{DATA_DIR\}\/update-status"/)
  const broker = fs.readFileSync(path.join(deployDir, "execute-update.mjs"), "utf8")
  assert.match(broker, /update-status\/status\.json/)
  assert.match(broker, /flag: "wx"/)
  assert.match(napl, /restore_upgrade_database "\$current"/)
})

test("Linux 发布包与在线安装器均确保 napl 可执行", () => {
  assert.match(release, /chmod\(join\(payload, "deploy", "napl"\), 0o755\)/)
  assert.match(napl, /chmod 755 "\$INSTALL_DIR\/deploy\/napl"/)
})

// GitHub 仅是源码来源，签名更新下载不再依赖 GitHub Release。
const REPO_SLUG = "nachomao/nacho-server"

test("source repository identity remains correct while upgrade artifacts use the independent server", () => {
  assert.match(install, new RegExp(`Documentation=https://github\\.com/${REPO_SLUG.replace("/", "\\/")}`))
  assert.equal(manifest.repository?.url, `git+https://github.com/${REPO_SLUG}.git`)
  assert.match(napl, /github\.com\/nachomao\/nacho-server\/releases\/download/)
})

test("napl validates the signed independent update server index and immutable asset URL", () => {
  assert.match(napl, /RELEASE_INDEX_URL/)
  assert.match(napl, /openssl pkeyutl -verify/)
  assert.match(napl, /UPDATE_CHANNEL/)
  assert.match(napl, /includes\(data\?\.schemaVersion\)/)
  assert.match(napl, /artifacts\/server/)
  assert.match(napl, /crypto\.createHash\("sha256"\)/)
})

test("napl update check reads signed-index v3 source asset and rejects substituted GitHub URLs", () => {
  const script = /latest_release_asset\(\) \{[\s\S]*?node - "\$metadata" <<'NODE'\n([\s\S]*?)\nNODE/.exec(napl)?.[1]
  assert.ok(script, "应提取 napl 的版本解析脚本")
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "napl-v3-check-"))
  const file = path.join(directory, "index.json")
  const version = "1.1.22"
  const fileName = `nacho-server-source-${version}.tar.gz`
  const asset = { fileName, sizeBytes: 100, sha256: "a".repeat(64),
    url: `https://github.com/nachomao/nacho-server/releases/download/v${version}/${fileName}` }
  const index = { schemaVersion: 3, channel: "stable", sequence: 3,
    releases: { server: { version, source: asset } } }
  const run = () => spawnSync(process.execPath, ["-", file], {
    input: script, encoding: "utf8",
    env: { ...process.env, UPDATE_ORIGIN: "https://maojiu.cc", UPDATE_CHANNEL: "stable" },
  })
  try {
    fs.writeFileSync(file, JSON.stringify(index))
    const valid = run()
    assert.equal(valid.status, 0)
    assert.deepEqual(JSON.parse(valid.stdout), { version, releaseType: "stable", asset: asset.url, sha256: asset.sha256, sizeBytes: 100 })
    asset.url = "https://example.org/other.tar.gz"
    fs.writeFileSync(file, JSON.stringify(index))
    assert.equal(run().status, 1)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("server project identity stays nacho-server for the Windows local launcher", () => {
  assert.equal(manifest.name, "nacho-server")
  assert.equal(manifest.license, "AGPL-3.0")
  const launcher = fs.readFileSync(path.join(deployDir, "windows", "local-control-server.ps1"), "utf8")
  assert.match(launcher, /\$Manifest\.name -ne "nacho-server"/)
})

test("napl v4 使用组件发布类型，忽略旧频道，并拒绝非固定 GitHub 制品", () => {
  const script = /latest_release_asset\(\) \{[\s\S]*?node - "\$metadata" <<'NODE'\n([\s\S]*?)\nNODE/.exec(napl)?.[1]
  assert.ok(script)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "napl-v4-check-"))
  const file = path.join(directory, "index.json")
  const version = "1.1.24", fileName = `nacho-server-source-${version}.tar.gz`
  const index = { schemaVersion: 4, sequence: 9, releases: {
    server: { version, releaseType: "stable", source: { fileName, sha256: "a".repeat(64), sizeBytes: 100,
      url: `https://github.com/nachomao/nacho-server/releases/download/v${version}/${fileName}` } },
  } }
  const run = () => spawnSync(process.execPath, ["-", file], { input: script, encoding: "utf8",
    env: { ...process.env, UPDATE_ORIGIN: "https://maojiu.cc", UPDATE_CHANNEL: "alpha" } })
  try {
    fs.writeFileSync(file, JSON.stringify(index))
    const valid = run()
    assert.equal(valid.status, 0)
    assert.equal(JSON.parse(valid.stdout).releaseType, "stable")
    index.releases.server.source.url = "https://example.org/source.tar.gz"
    fs.writeFileSync(file, JSON.stringify(index))
    assert.equal(run().status, 1)
    assert.doesNotMatch(napl, /DATA_DIR\/update-channel\.json/)
    assert.match(napl, /updates\/revisions/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test("构建产物必须包含 src/lib 的 .cjs 运行时资源", () => {
  assert.match(manifest.scripts?.build ?? "", /deploy\/build-assets\.mjs/)
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nacho-build-assets-"))
  try {
    const run = spawnSync(process.execPath, ["deploy/build-assets.mjs"], {
      cwd: repoDir, encoding: "utf8", env: { ...process.env, NACHO_DIST_DIR: out },
    })
    assert.equal(run.status, 0, run.stderr)
    // agent-release-sync 启动时 require 这个文件，缺失会让服务端直接崩溃。
    assert.ok(fs.existsSync(path.join(out, "lib", "github-download.cjs")))
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
})

test("卸载脚本按单元文件判断服务，避免 pipefail 下的 SIGPIPE 漏删", () => {
  assert.doesNotMatch(uninstall, /systemctl list-unit-files[^\n]*\|\s*grep -q/)
  assert.ok(uninstall.includes('[ -f "/etc/systemd/system/${APP_NAME}.service" ]'))
  assert.match(uninstall, /systemctl daemon-reload/)
})
