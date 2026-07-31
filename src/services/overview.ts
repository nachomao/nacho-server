import { db } from "../db"
import { listClients } from "./clients"
import { healthStats } from "./health"
import { connectedClientIds } from "./realtime"

/** 面板首页概览统计 */
export function getOverview() {
  const clients = listClients()
  const online = clients.filter((c) => c.status === "online").length
  const warning = clients.filter((c) => c.status === "warning").length
  const offline = clients.filter((c) => c.status === "offline").length

  const taskCount = (db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c
  const enabledTasks = (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE enabled = 1").get() as { c: number }).c
  const pluginCount = (db.prepare("SELECT COUNT(*) AS c FROM plugins WHERE status = 'installed'").get() as { c: number }).c
  const pendingCommands = (
    db.prepare("SELECT COUNT(*) AS c FROM commands WHERE status IN ('pending','sent','running')").get() as { c: number }
  ).c

  // 汇总在线客户端的平均资源占用
  const withMetrics = clients.filter((c) => c.status === "online" && c.metrics)
  const avg = (pick: (m: NonNullable<(typeof withMetrics)[number]["metrics"]>) => number) =>
    withMetrics.length
      ? Math.round(withMetrics.reduce((s, c) => s + pick(c.metrics!), 0) / withMetrics.length)
      : 0

  return {
    clients: {
      total: clients.length,
      online,
      warning,
      offline,
      realtimeConnections: connectedClientIds().length,
    },
    tasks: { total: taskCount, enabled: enabledTasks },
    plugins: { installed: pluginCount },
    commands: { pending: pendingCommands },
    resources: {
      cpu: avg((m) => m.cpu),
      memory: avg((m) => m.memory),
      disk: avg((m) => m.disk),
    },
    health: healthStats(),
    updatedAt: Date.now(),
  }
}
