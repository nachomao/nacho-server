import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

const deployDir = path.resolve("deploy")
const install = fs.readFileSync(path.join(deployDir, "install.sh"), "utf8")
const uninstall = fs.readFileSync(path.join(deployDir, "uninstall.sh"), "utf8")
const napl = fs.readFileSync(path.join(deployDir, "napl"), "utf8")
const release = fs.readFileSync(path.join(deployDir, "build-release.mjs"), "utf8")

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
