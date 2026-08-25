import fs from "node:fs"
import path from "node:path"
import type { Request } from "express"
import { Router } from "express"
import { config } from "../config"
import { fail } from "../lib/http"
import * as installProfiles from "../services/install-profiles"
import { renderInstallScript, stripScriptBom } from "../services/install-script"

export const artifactRouter = Router()

function externalBaseUrl(req: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl
  const forwardedHost = config.trustProxy ? req.get("x-forwarded-host")?.split(",")[0].trim() : undefined
  return `${req.protocol}://${forwardedHost || req.get("host")}`
}

function readScript(name: "install.ps1" | "uninstall.ps1"): string | null {
  const file = path.join(config.rootDir, "deploy", "windows", name)
  if (!fs.existsSync(file)) return null
  // UTF-8 BOM 对落盘执行有帮助，但 readFileSync(..., "utf8") 会把它保留为
  // U+FEFF。经 Express 作为文本下发后，`irm URL | iex` 会把它当作命令名
  // 的一部分，最终变成无法识别的 `﻿param`，因此仅在 HTTP 渲染边界剥离。
  return stripScriptBom(fs.readFileSync(file, "utf8"))
}

artifactRouter.get("/install.ps1", (req, res) => {
  const template = readScript("install.ps1")
  if (!template) return fail(res, "Windows Agent 安装脚本尚未发布", 503)
  if (req.query.profile !== undefined && typeof req.query.profile !== "string") {
    return fail(res, "安装档案参数无效", 400)
  }
  const profileId = typeof req.query.profile === "string" ? req.query.profile : null
  const profile = profileId ? installProfiles.getProfile(profileId) : installProfiles.getDefaultProfile()
  if (!profile) return fail(res, "安装档案不存在", 404)
  const artifactBaseUrl = externalBaseUrl(req).replace(/\/$/, "")
  const installScriptUrl = `${artifactBaseUrl}/install.ps1?profile=${encodeURIComponent(profile.id)}`
  const script = renderInstallScript(template, {
    artifactBaseUrl,
    installScriptUrl,
    openEnrollment: config.allowOpenEnrollment,
    profile,
  })
  res.type("text/plain; charset=utf-8").send(script)
})

artifactRouter.get("/uninstall.ps1", (req, res) => {
  const template = readScript("uninstall.ps1")
  const script = template?.replaceAll("__NACHO_BASE_URL__", externalBaseUrl(req).replaceAll("'", "''"))
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
