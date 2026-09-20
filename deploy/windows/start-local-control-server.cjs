const { spawn } = require("node:child_process")
const { closeSync, openSync } = require("node:fs")
const path = require("node:path")

const [entryPath, workingDirectory, stdoutPath, stderrPath] = process.argv.slice(2)
const paths = [entryPath, workingDirectory, stdoutPath, stderrPath]

if (paths.some((value) => !value || !path.isAbsolute(value))) {
  process.stderr.write("本机控制服务启动参数无效。\n")
  process.exit(1)
}

let stdoutDescriptor
let stderrDescriptor

try {
  stdoutDescriptor = openSync(stdoutPath, "a", 0o600)
  stderrDescriptor = openSync(stderrPath, "a", 0o600)
  const child = spawn(process.execPath, [entryPath], {
    cwd: workingDirectory,
    detached: true,
    env: process.env,
    stdio: ["ignore", stdoutDescriptor, stderrDescriptor],
    windowsHide: true,
  })

  if (!Number.isInteger(child.pid)) throw new Error("未取得服务进程 PID")
  process.stdout.write(`${child.pid}\n`)
  child.unref()
} catch (error) {
  process.stderr.write(`启动本机控制服务失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  if (stdoutDescriptor !== undefined) closeSync(stdoutDescriptor)
  if (stderrDescriptor !== undefined) closeSync(stderrDescriptor)
}
