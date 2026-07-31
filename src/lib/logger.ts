/** 轻量控制台日志：带时间戳与级别，输出到 stdout/stderr（便于 systemd/journalctl 采集） */
type Level = "info" | "warn" | "error" | "debug"

function ts(): string {
  return new Date().toISOString()
}

function emit(level: Level, args: unknown[]) {
  const prefix = `[${ts()}] [${level.toUpperCase()}]`
  if (level === "error") console.error(prefix, ...args)
  else if (level === "warn") console.warn(prefix, ...args)
  else console.log(prefix, ...args)
}

export const logger = {
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
  debug: (...args: unknown[]) => {
    if (process.env.NODE_ENV !== "production") emit("debug", args)
  },
}
