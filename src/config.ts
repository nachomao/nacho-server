import path from "node:path"
import fs from "node:fs"
import dotenv from "dotenv"

// 优先加载 .env（部署脚本会生成到服务端根目录）
dotenv.config()

function num(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
}

// 构建产物位于 dist/，部署目录（deploy、artifacts）位于项目根目录；开发运行时
// __dirname 已经是 src，因此统一探测包含 deploy 目录的根路径。
const rootDir = (() => {
  const candidates = [path.resolve(__dirname, ".."), path.resolve(__dirname, "../..")]
  return candidates.find((candidate) => path.basename(candidate) !== "dist" && fs.existsSync(path.join(candidate, "deploy"))) ?? candidates[0]
})()
const databasePath = path.isAbsolute(process.env.DATABASE_PATH || "")
  ? (process.env.DATABASE_PATH as string)
  : path.resolve(rootDir, process.env.DATABASE_PATH || "./data/nacho.db")
const artifactsPath = path.isAbsolute(process.env.ARTIFACTS_PATH || "")
  ? (process.env.ARTIFACTS_PATH as string)
  : path.resolve(rootDir, process.env.ARTIFACTS_PATH || "./artifacts")

export const config = {
  rootDir,
  host: process.env.HOST || "0.0.0.0",
  port: num(process.env.PORT, 8443),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  databasePath,
  panelApiKey: process.env.PANEL_API_KEY || "change-me-panel-api-key",
  enrollmentKey: process.env.ENROLLMENT_KEY || "change-me-enrollment-key",
  allowOpenEnrollment: bool(process.env.ALLOW_OPEN_ENROLLMENT),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  trustProxy: bool(process.env.TRUST_PROXY),
  artifactsPath,
  healthArtifactsPath: path.isAbsolute(process.env.HEALTH_ARTIFACTS_PATH || "")
    ? (process.env.HEALTH_ARTIFACTS_PATH as string)
    : process.env.HEALTH_ARTIFACTS_PATH
      ? path.resolve(rootDir, process.env.HEALTH_ARTIFACTS_PATH)
      : process.env.ARTIFACTS_PATH
        ? path.join(artifactsPath, "health")
        : path.join(path.dirname(databasePath), "health-artifacts"),
  offlineThreshold: num(process.env.OFFLINE_THRESHOLD, 60),
  logRetentionMax: num(process.env.LOG_RETENTION_MAX, 100_000),
  nodeEnv: process.env.NODE_ENV || "development",
}

export type AppConfig = typeof config
