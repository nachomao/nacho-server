import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

const script = fs.readFileSync(path.resolve("deploy/windows/uninstall.ps1"), "utf8")

test("purge removes every Agent-owned local path and verifies no residue", () => {
  assert.match(script, /Stop-Service[\s\S]*WaitForStatus/)
  assert.match(script, /sc\.exe delete[\s\S]*Get-Service[\s\S]*still registered/)
  assert.match(script, /DataDir, \$HistoricalBackupDir/)
  assert.match(script, /Remove-Item -LiteralPath \$VendorDir -Force/)
  assert.match(script, /uninstall left residue/)
})

test("purge preserves retry data when server unregister fails", () => {
  assert.match(script, /--unregister/)
  assert.match(script, /WaitForExit\(30000\)/)
  assert.match(script, /local data was preserved for retry/)
  assert.ok(script.indexOf("local data was preserved for retry") < script.indexOf("Remove-Item -LiteralPath $InstallDir"))
})

test("keep-data uninstall marks the server card instead of purging it", () => {
  assert.match(script, /\$unregisterArgument = if \(\$Purge\) \{ '--unregister' \} else \{ '--mark-unregistered' \}/)
  assert.match(script, /if \(\(Test-Path \$AgentPath\)/)
})

test("elevated uninstall returns the child process exit code", () => {
  assert.match(script, /Start-Process powershell\.exe[\s\S]*-PassThru/)
  assert.match(script, /exit \$elevated\.ExitCode/)
})
