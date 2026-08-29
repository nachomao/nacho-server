// ------------------------------------------------------------------
// 服务端业务数据模型（与面板端类型保持对齐，便于前后端对接）
// ------------------------------------------------------------------

export type ClientOS = "Windows" | "macOS" | "Linux"
export type ClientStatus = "online" | "offline" | "warning"

/** 受管理设备（客户端 / Agent） */
export type Client = {
  id: string
  name: string
  hostname: string
  ip: string
  os: ClientOS
  /** 客户端上报的具体系统名（如 "Windows 11 Pro" / "ubuntu"），未上报时为空串 */
  osName: string
  status: ClientStatus
  tags: string[]
  group: string
  version: string
  /** 最近一次心跳的毫秒时间戳 */
  lastSeen: number
  registeredAt: number
  /** 最近一次上报的资源指标 */
  metrics: ClientMetrics | null
}

export type ClientMetrics = {
  cpu: number
  memory: number
  disk: number
  uptime: number
}

/** 计划任务定义 */
export type TaskOS = "windows" | "linux"
export type TriggerId = "daily" | "weekly" | "logon" | "startup" | "boot" | "cron"

export type ScheduledTask = {
  id: string
  name: string
  os: TaskOS
  action: string
  program: string
  args: string
  triggerId: TriggerId
  time: string
  interval: number
  cron: string
  clientIds: string[]
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** 下发到客户端的一次执行指令 */
export type CommandStatus = "pending" | "sent" | "running" | "success" | "failed" | "canceled"

export type Command = {
  id: string
  clientId: string
  taskId: string | null
  /** 指令类型，例如 run-program / restart / collect-logs / install-plugin */
  type: string
  payload: Record<string, unknown>
  status: CommandStatus
  result: string | null
  exitCode: number | null
  createdAt: number
  updatedAt: number
}

export type LogLevel = "error" | "warn" | "info" | "debug"

export type LogEntry = {
  id: string
  ts: number
  level: LogLevel
  source: string
  message: string
  detail: string | null
}

export type PluginStatus = "installed" | "available" | "disabled"
export type PluginParam = { id: string; label: string; value: string }

export type Plugin = {
  id: string
  name: string
  version: string
  author: string
  category: string
  description: string
  size: string
  icon: string
  status: PluginStatus
  restartRestore: boolean
  params: PluginParam[]
  createdAt: number
}

export type Severity = "critical" | "error" | "warning" | "info"

export type HealthFinding = {
  id: string
  packageId: string | null
  host: string
  severity: Severity
  category: string
  title: string
  detail: string
  time: string
  ts: number
  read: boolean
}

export type LogPackageStatus = "collecting" | "analyzing" | "analyzed" | "failed"

export type LogPackage = {
  id: string
  clientId: string | null
  commandId: string | null
  host: string
  category: string
  sizeMB: number
  time: string
  ts: number
  findings: number
  status: LogPackageStatus
  storageName: string | null
  sizeBytes: number
  sha256: string | null
  sources: string[]
  entryCount: number
  truncated: boolean
  error: string | null
  analyzedAt: number | null
  downloadable: boolean
}
