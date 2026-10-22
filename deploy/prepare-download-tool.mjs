// root 拥有的固定工具准备执行器；服务用户只能提交 aria2 + requestId。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

const request = "/var/lib/control-server/download-tool-requests/aria2.json"
const statusDirectory = "/var/lib/control-server/download-tool-status"
const script = fileURLToPath(new URL("./prepare-download-tool.sh", import.meta.url))
let requestId = null
let child

function status(phase, error = null) {
  const directory = fs.openSync(statusDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(directory)
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error("工具状态目录权限无效")
    // 通过已核对的目录描述符写入，避免业务用户替换父目录造成路径竞态。
    const stableDirectory = `/proc/self/fd/${directory}`
    const temporary = path.join(stableDirectory, `${randomUUID()}.tmp`)
    fs.writeFileSync(temporary, JSON.stringify({ requestId, phase, error, at: new Date().toISOString() }),
      { flag: "wx", mode: 0o644 })
    fs.renameSync(temporary, path.join(stableDirectory, "aria2.json"))
  } finally { fs.closeSync(directory) }
}

try {
  if (process.getuid?.() !== 0) throw new Error("工具准备执行器必须由 root 运行")
  const parent = fs.lstatSync(path.dirname(request))
  const source = fs.lstatSync(script)
  const output = fs.lstatSync(statusDirectory)
  if (parent.isSymbolicLink() || !parent.isDirectory() || source.isSymbolicLink() ||
      !source.isFile() || source.uid !== 0 || (source.mode & 0o022) ||
      output.isSymbolicLink() || !output.isDirectory() || output.uid !== 0 || (output.mode & 0o022)) {
    throw new Error("工具准备目录或 root 脚本权限无效")
  }
  const handle = fs.openSync(request, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let body
  try {
    const stat = fs.fstatSync(handle)
    if (!stat.isFile() || stat.size > 1024 || stat.uid !== parent.uid || stat.nlink !== 1) {
      throw new Error("工具准备请求文件无效")
    }
    body = fs.readFileSync(handle, "utf8")
    if (fs.lstatSync(request).ino !== stat.ino) throw new Error("工具准备请求已变化")
    fs.unlinkSync(request)
  } finally { fs.closeSync(handle) }
  const parsed = JSON.parse(body)
  if (!parsed || Object.keys(parsed).sort().join(",") !== "requestId,tool" ||
      parsed.tool !== "aria2" || !/^[a-f0-9-]{36}$/.test(parsed.requestId)) {
    throw new Error("只允许固定的 aria2 工具准备请求")
  }
  requestId = parsed.requestId
  status("installing")
  const code = await new Promise((resolve, reject) => {
    child = spawn("/bin/bash", [script, "--install-only"], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
    })
    child.once("error", reject)
    child.once("close", resolve)
  })
  if (code !== 0) throw new Error("aria2 自动安装失败；本次下载可使用单连接")
  status("ready")
} catch (error) {
  try { status("failed", error.message) } catch { /* 无效状态目录不能被写入 */ }
  console.error(`[Nacho] ${error.message}`)
  process.exitCode = 1
}
