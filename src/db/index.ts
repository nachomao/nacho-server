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
      os_name      TEXT NOT NULL DEFAULT '',
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

    CREATE TABLE IF NOT EXISTS managed_artifacts (
      id                 TEXT PRIMARY KEY,
      kind               TEXT NOT NULL,
      display_name       TEXT NOT NULL,
      version            TEXT NOT NULL DEFAULT '',
      original_file_name TEXT NOT NULL,
      storage_name       TEXT NOT NULL UNIQUE,
      size_bytes         INTEGER NOT NULL,
      sha256             TEXT,
      installer_type     TEXT,
      arguments          TEXT NOT NULL DEFAULT '[]',
      success_exit_codes TEXT NOT NULL DEFAULT '[0]',
      status             TEXT NOT NULL DEFAULT 'draft',
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_managed_artifacts_kind_status ON managed_artifacts(kind, status);

    CREATE TABLE IF NOT EXISTS deployment_batches (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      total_items INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deployment_batches_kind_created ON deployment_batches(kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS deployment_items (
      id          TEXT PRIMARY KEY,
      batch_id    TEXT NOT NULL,
      command_id  TEXT NOT NULL UNIQUE,
      artifact_id TEXT NOT NULL,
      client_id   TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      FOREIGN KEY(batch_id) REFERENCES deployment_batches(id),
      FOREIGN KEY(command_id) REFERENCES commands(id),
      FOREIGN KEY(artifact_id) REFERENCES managed_artifacts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_deployment_items_batch ON deployment_items(batch_id);
    CREATE INDEX IF NOT EXISTS idx_deployment_items_download ON deployment_items(client_id, command_id, artifact_id);

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
      package_id TEXT,
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
      client_id TEXT,
      command_id TEXT,
      host      TEXT NOT NULL,
      category  TEXT NOT NULL DEFAULT '系统日志',
      size_mb   REAL NOT NULL DEFAULT 0,
      time      TEXT NOT NULL DEFAULT '',
      ts        INTEGER NOT NULL,
      findings  INTEGER NOT NULL DEFAULT 0,
      status    TEXT NOT NULL DEFAULT 'collecting',
      storage_name TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT,
      sources TEXT NOT NULL DEFAULT '[]',
      entry_count INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      analyzed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      severity    TEXT NOT NULL DEFAULT 'warning',
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      detail      TEXT NOT NULL DEFAULT '',
      code        TEXT,
      source      TEXT NOT NULL DEFAULT 'server',
      device_id   TEXT,
      group_key   TEXT NOT NULL DEFAULT '',
      ts          INTEGER NOT NULL,
      read        INTEGER NOT NULL DEFAULT 0,
      dismissed   INTEGER NOT NULL DEFAULT 0,
      source_id   TEXT,
      snoozed_until INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts DESC);

    CREATE TABLE IF NOT EXISTS install_profiles (
      id                         TEXT PRIMARY KEY,
      name                       TEXT NOT NULL,
      run_mode                   TEXT NOT NULL DEFAULT 'menu',
      agent_server_url           TEXT,
      heartbeat_seconds          INTEGER NOT NULL DEFAULT 20,
      poll_seconds               INTEGER NOT NULL DEFAULT 15,
      client_name                TEXT,
      grp                        TEXT NOT NULL DEFAULT '默认分组',
      tags                       TEXT NOT NULL DEFAULT '[]',
      overwrite_existing         INTEGER NOT NULL DEFAULT 0,
      re_enroll_on_server_change INTEGER NOT NULL DEFAULT 0,
      is_default                 INTEGER NOT NULL DEFAULT 0,
      revision                   INTEGER NOT NULL DEFAULT 1,
      active_revision            INTEGER NOT NULL DEFAULT 1,
      created_at                 INTEGER NOT NULL,
      updated_at                 INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_install_profiles_single_default
      ON install_profiles(is_default) WHERE is_default = 1;

    CREATE TABLE IF NOT EXISTS install_profile_revisions (
      profile_id TEXT NOT NULL,
      revision   INTEGER NOT NULL,
      snapshot   TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY(profile_id, revision),
      FOREIGN KEY(profile_id) REFERENCES install_profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_install_profile_revisions_profile
      ON install_profile_revisions(profile_id, revision DESC);
  `)
  // 旧库补列：CREATE TABLE IF NOT EXISTS 不会为已存在的表添加新字段
  ensureColumn("clients", "os_name", "TEXT NOT NULL DEFAULT ''")
  ensureColumn("health_findings", "package_id", "TEXT")
  ensureColumn("notifications", "dismissed", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn("notifications", "source_id", "TEXT")
  ensureColumn("notifications", "severity", "TEXT NOT NULL DEFAULT 'warning'")
  ensureColumn("notifications", "detail", "TEXT NOT NULL DEFAULT ''")
  ensureColumn("notifications", "code", "TEXT")
  ensureColumn("notifications", "source", "TEXT NOT NULL DEFAULT 'server'")
  ensureColumn("notifications", "device_id", "TEXT")
  ensureColumn("notifications", "group_key", "TEXT NOT NULL DEFAULT ''")
  ensureColumn("notifications", "snoozed_until", "INTEGER")
  ensureColumn("log_packages", "client_id", "TEXT")
  ensureColumn("log_packages", "command_id", "TEXT")
  ensureColumn("log_packages", "storage_name", "TEXT")
  ensureColumn("log_packages", "size_bytes", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn("log_packages", "sha256", "TEXT")
  ensureColumn("log_packages", "sources", "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn("log_packages", "entry_count", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn("log_packages", "truncated", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn("log_packages", "error", "TEXT")
  ensureColumn("log_packages", "analyzed_at", "INTEGER")
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_log_packages_command
      ON log_packages(command_id) WHERE command_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_health_findings_package ON health_findings(package_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_source ON notifications(type, source_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_group ON notifications(group_key, ts DESC);
  `)
  if (ensureColumn("install_profiles", "active_revision", "INTEGER NOT NULL DEFAULT 1")) {
    db.exec("UPDATE install_profiles SET active_revision = revision")
  }
  logger.info("数据库结构已初始化：", config.databasePath)
}

/** 幂等地为已存在的表补充列 */
function ensureColumn(table: string, column: string, definition: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (cols.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  logger.info(`数据库已补充字段：${table}.${column}`)
  return true
}
