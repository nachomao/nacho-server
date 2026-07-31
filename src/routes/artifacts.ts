import fs from "node:fs"
import path from "node:path"
import type { Request } from "express"
import { Router } from "express"
import { config } from "../config"
import { fail } from "../lib/http"

export const artifactRouter = Router()

function externalBaseUrl(req: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl
  const forwardedHost = config.trustProxy ? req.get("x-forwarded-host")?.split(",")[0].trim() : undefined
  return `${req.protocol}://${forwardedHost || req.get("host")}`
}

function renderScript(name: "install.ps1" | "uninstall.ps1", req: Request): string | null {
  const file = path.join(config.rootDir, "deploy", "windows", name)
  if (!fs.existsSync(file)) return null
  return fs
    .readFileSync(file, "utf8")
    .replaceAll("__NACHO_BASE_URL__", externalBaseUrl(req).replaceAll("'", "''"))
    .replaceAll("__NACHO_OPEN_ENROLLMENT__", config.allowOpenEnrollment ? "$true" : "$false")
}

artifactRouter.get("/install.ps1", (req, res) => {
  const script = renderScript("install.ps1", req)
  if (!script) return fail(res, "Windows Agent 安装脚本尚未发布", 503)
  res.type("text/plain; charset=utf-8").send(script)
})

artifactRouter.get("/uninstall.ps1", (req, res) => {
  const script = renderScript("uninstall.ps1", req)
  if (!script) return fail(res, "Windows Agent 卸载脚本尚未发布", 503)
  res.type("text/plain; charset=utf-8").send(script)
})

artifactRouter.get("/agent/downloads/windows/latest.json", (_req, res) => {
  const file = path.join(config.artifactsPath, "windows", "latest.json")
  if (!fs.existsSync(file)) return fail(res, "Windows Agent 制品尚未发布", 503)
  res.type("application/json").send(fs.readFileSync(file, "utf8"))
})

artifactRouter.get("/agent/downloads/windows/:file", (req, res) => {
  const name = req.params.file
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === "latest.json") return fail(res, "制品名称无效", 400)
  const file = path.join(config.artifactsPath, "windows", name)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, "制品不存在", 404)
  res.download(file, name)
})
