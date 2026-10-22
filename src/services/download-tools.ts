import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { aria2Available } from "../lib/github-download.cjs"

const requestDirectory = "/var/lib/control-server/download-tool-requests"
const requestFile = `${requestDirectory}/aria2.json`
const statusFile = "/var/lib/control-server/download-tool-status/aria2.json"
let preparing: Promise<void> | null = null

/** 普通服务只发送固定 aria2 请求；安装命令由 root 拥有的 systemd 执行器决定。 */
export function prepareLinuxDownloadTool(): Promise<void> {
  if (preparing) return preparing
  preparing = (async () => {
    if (await aria2Available()) return
    await fs.access("/etc/systemd/system/control-server-downloader.path")
    const directory = await fs.lstat(requestDirectory)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("下载工具请求目录无效")
    const requestId = randomUUID()
    const temporary = `${requestFile}.${requestId}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify({ tool: "aria2", requestId }), { flag: "wx", mode: 0o600 })
      await fs.rename(temporary, requestFile)
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        try {
          const status = JSON.parse(await fs.readFile(statusFile, "utf8")) as {
            requestId: string; phase: string; error?: string
          }
          if (status.requestId === requestId) {
            if (status.phase === "ready") return
            if (status.phase === "failed") throw new Error(status.error || "aria2 自动安装失败")
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      throw new Error("aria2 工具准备超过三分钟")
    } finally {
      await fs.rm(temporary, { force: true })
    }
  })().finally(() => { preparing = null })
  return preparing
}
