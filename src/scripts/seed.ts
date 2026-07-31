/**
 * 演示数据初始化脚本：写入若干客户端、分组、任务、插件与健康发现，
 * 便于在没有真实客户端时预览面板效果。生产环境无需运行。
 *   npm run seed
 */
import { initSchema } from "../db"
import * as clients from "../services/clients"
import * as health from "../services/health"
import { recordLog } from "../services/logs"
import * as plugins from "../services/plugins"
import * as tasks from "../services/tasks"

initSchema()

clients.addGroup("生产环境")
clients.addGroup("测试环境")

const c1 = clients.createClient({
  name: "web-prod-01",
  hostname: "web-prod-01",
  ip: "10.0.1.11",
  os: "Linux",
  version: "1.0.0",
  tags: ["web", "nginx"],
  group: "生产环境",
})
const c2 = clients.createClient({
  name: "db-prod-01",
  hostname: "db-prod-01",
  ip: "10.0.1.21",
  os: "Linux",
  version: "1.0.0",
  tags: ["database"],
  group: "生产环境",
})
const c3 = clients.createClient({
  name: "win-office-07",
  hostname: "WIN-OFFICE-07",
  ip: "192.168.10.7",
  os: "Windows",
  version: "1.0.0",
  tags: ["office"],
  group: "测试环境",
})

// 模拟部分客户端在线并有指标
clients.heartbeat(c1.id, { cpu: 32, memory: 61, disk: 44, uptime: 864000 }, c1.ip)
clients.heartbeat(c2.id, { cpu: 78, memory: 83, disk: 67, uptime: 432000 }, c2.ip)
clients.updateClient(c2.id, { status: "warning" })

tasks.createTask({
  name: "每日日志清理",
  os: "linux",
  action: "运行程序",
  program: "/usr/local/bin/cleanup.sh",
  args: "--days 7",
  triggerId: "daily",
  time: "03:00",
  interval: 1,
  cron: "",
  clientIds: [c1.id, c2.id],
  enabled: true,
})
tasks.createTask({
  name: "Windows 补丁检查",
  os: "windows",
  action: "运行程序",
  program: "powershell.exe",
  args: "-File C:\\scripts\\patch-check.ps1",
  triggerId: "weekly",
  time: "08:00",
  interval: 1,
  cron: "",
  clientIds: [c3.id],
  enabled: true,
})

plugins.createPlugin({
  name: "系统资源采集器",
  version: "1.2.0",
  author: "NachoTeam",
  category: "监控",
  description: "定时采集 CPU / 内存 / 磁盘等资源指标并上报服务端。",
  size: "1.8 MB",
  icon: "activity",
  status: "installed",
  restartRestore: true,
  params: [{ id: "interval", label: "采集间隔(秒)", value: "30" }],
})
plugins.createPlugin({
  name: "日志收集器",
  version: "0.9.3",
  author: "NachoTeam",
  category: "日志",
  description: "打包指定路径日志并上传至服务端进行分析。",
  size: "2.4 MB",
  icon: "file-text",
  status: "available",
  restartRestore: false,
  params: [],
})

health.addFinding({
  host: "db-prod-01",
  severity: "warning",
  category: "资源",
  title: "内存使用率持续高于 80%",
  detail: "最近 15 分钟平均内存使用率 83%，建议排查慢查询。",
})
health.addPackage({ host: "web-prod-01", category: "系统日志", sizeMB: 12.4, findings: 3, status: "analyzed" })

recordLog("info", "seed", "演示数据初始化完成")
console.log("演示数据已写入。可启动服务端并在面板中查看。")
