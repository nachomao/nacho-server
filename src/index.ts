import http from "node:http"
import cors from "cors"
import express, { type NextFunction, type Request, type Response } from "express"
import { config } from "./config"
import { db, initSchema } from "./db"
import { HttpError, fail } from "./lib/http"
import { logger } from "./lib/logger"
import { agentRouter } from "./routes/agent"
import { artifactRouter } from "./routes/artifacts"
import { panelRouter } from "./routes/panel"
import { recordLog } from "./services/logs"
import { attachWebSocket } from "./ws"

// 初始化数据库
initSchema()

const app = express()
app.disable("x-powered-by")
if (config.trustProxy) app.set("trust proxy", true)
app.use(express.json({ limit: "2mb" }))
app.use(
  cors({
    origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map((s) => s.trim()),
    credentials: true,
  }),
)

// 健康检查（无需鉴权）
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "nacho-server", time: Date.now() })
})

// Windows Agent 安装器与发布制品无需设备令牌。
app.use(artifactRouter)

// 面板 API（需面板 API Key） 与 客户端 API（需客户端令牌）
app.use("/api/panel", panelRouter)
app.use("/agent", agentRouter)

// 404
app.use((_req, res) => fail(res, "接口不存在", 404))

// 统一错误处理
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    return fail(res, err.message, err.status, err.extra)
  }
  logger.error("未处理的异常：", err)
  return fail(res, "服务器内部错误", 500)
})

const server = http.createServer(app)
attachWebSocket(server)

// 周期性把超时未心跳的客户端标记为离线
const OFFLINE_SWEEP_MS = 15_000
setInterval(() => {
  const threshold = Date.now() - config.offlineThreshold * 1000
  const info = db
    .prepare("UPDATE clients SET status = 'offline' WHERE status NOT IN ('offline', 'unregistered') AND last_seen < ? AND last_seen > 0")
    .run(threshold)
  if (info.changes > 0) {
    logger.info(`已将 ${info.changes} 台超时客户端标记为离线`)
  }
}, OFFLINE_SWEEP_MS).unref()

server.listen(config.port, config.host, () => {
  logger.info(`Nacho 服务端已启动：http://${config.host}:${config.port}（${config.nodeEnv}）`)
  recordLog("info", "server", "服务端启动完成", `port=${config.port}`)
})

// 优雅退出
function shutdown(signal: string) {
  logger.info(`收到 ${signal}，正在关闭服务端...`)
  server.close(() => {
    db.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
