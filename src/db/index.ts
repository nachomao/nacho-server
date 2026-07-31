import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { config } from "../config"
import { logger } from "../lib/logger"

// 确保数据目录存在
const dir = path.dirname(config.databasePath)
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * 使用 Node 内置的 node:sqlite（Node 22+），无需任何原生编译步骤，
 * 极大简化在各类 Linux 发行版上的部署（无需 build-essential / python）。
 */
export const db = new DatabaseSync(config.databasePath)

// 提升并发与耐久性表现
db.exec("PRAGMA journal_mode = WAL;")
db.exec("PRAGMA foreign_keys = ON;")
db.exec("PRAGMA synchronous = NORMAL;")

/** 初始化建表（幂等） */
export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      hostname     TEXT NOT NULL DEFAULT '',
      ip           TEXT NOT NULL DEFAULT '',
      os           TEXT NOT NULL DEFAULT 'Linux',
      status       TEXT NOT NULL DEFAULT 'offline',
      tags         TEXT NOT NULL DEFAULT '[]',
      grp          TEXT NOT NULL DEFAULT '默认分组',
      version      TEXT NOT NULL DEFAULT '',
      token        TEXT NOT NULL,
      last_seen    INTEGER NOT NULL DEFAULT 0,
      registered_at INTEGER NOT NULL,
      metrics      TEXT
    );

    CREATE TABLE IF NOT EXISTS groups (
      name       TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      os          TEXT NOT NULL DEFAULT 'linux',
      action      TEXT NOT NULL DEFAULT '运行程序',
      program     TEXT NOT NULL DEFAULT '',
      args        TEXT NOT NULL DEFAULT '',
      trigger_id  TEXT NOT NULL DEFAULT 'daily',
      time        TEXT NOT NULL DEFAULT '06:00',
      interval    INTEGER NOT NULL DEFAULT 1,
      cron        TEXT NOT NULL DEFAULT '',
      client_ids  TEXT NOT NULL DEFAULT '[]',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commands (
      id          TEXT PRIMARY KEY,
      client_id   TEXT NOT NULL,
      task_id     TEXT,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL DEFAULT 'pending',
      result      TEXT,
      exit_code   INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_commands_client ON commands(client_id, status);

    CREATE TABLE IF NOT EXISTS logs (
      id       TEXT PRIMARY KEY,
      ts       INTEGER NOT NULL,
      level    TEXT NOT NULL DEFAULT 'info',
      source   TEXT NOT NULL DEFAULT 'server',
      message  TEXT NOT NULL,
      detail   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);

    CREATE TABLE IF NOT EXISTS plugins (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      version       TEXT NOT NULL DEFAULT '1.0.0',
      author        TEXT NOT NULL DEFAULT '',
      category      TEXT NOT NULL DEFAULT '工具',
      description   TEXT NOT NULL DEFAULT '',
      size          TEXT NOT NULL DEFAULT '—',
      icon          TEXT NOT NULL DEFAULT 'puzzle',
      status        TEXT NOT NULL DEFAULT 'available',
      restart_restore INTEGER NOT NULL DEFAULT 0,
      params        TEXT NOT NULL DEFAULT '[]',
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS health_findings (
      id        TEXT PRIMARY KEY,
      host      TEXT NOT NULL,
      severity  TEXT NOT NULL DEFAULT 'info',
      category  TEXT NOT NULL DEFAULT '系统日志',
      title     TEXT NOT NULL,
      detail    TEXT NOT NULL DEFAULT '',
      time      TEXT NOT NULL DEFAULT '',
      ts        INTEGER NOT NULL,
      read      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS log_packages (
      id        TEXT PRIMARY KEY,
      host      TEXT NOT NULL,
      category  TEXT NOT NULL DEFAULT '系统日志',
      size_mb   REAL NOT NULL DEFAULT 0,
      time      TEXT NOT NULL DEFAULT '',
      ts        INTEGER NOT NULL,
      findings  INTEGER NOT NULL DEFAULT 0,
      status    TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  logger.info("数据库结构已初始化：", config.databasePath)
}
