import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test, { after, before, beforeEach } from "node:test"

const databasePath = path.join(process.cwd(), "tmp-notifications-test.db")
process.env.DATABASE_PATH = databasePath
process.env.LOG_RETENTION_MAX = "1000"

let db: typeof import("../db").db
let initSchema: typeof import("../db").initSchema
let notifications: typeof import("../services/notifications")
let plugins: typeof import("../services/plugins")

before(async () => {
  fs.rmSync(databasePath, { force: true })
  ;({ db, initSchema } = await import("../db"))
  notifications = await import("../services/notifications")
  plugins = await import("../services/plugins")
  initSchema()
})

beforeEach(() => {
  db.exec("DELETE FROM notifications; DELETE FROM health_findings; DELETE FROM commands; DELETE FROM tasks; DELETE FROM clients; DELETE FROM plugins; DELETE FROM logs;")
})

after(() => {
  db.close()
  fs.rmSync(databasePath, { force: true })
  fs.rmSync(`${databasePath}-shm`, { force: true })
  fs.rmSync(`${databasePath}-wal`, { force: true })
})

function insertClient(id: string, lastSeen: number): void {
  db.prepare("INSERT INTO clients (id,name,hostname,status,token,last_seen,registered_at) VALUES (?,?,?,'offline',?,?,?)")
    .run(id, id, `${id}-host`, `${id}-token`, lastSeen, lastSeen || Date.now())
}

test("警告与错误来源会生成通知且普通插件更新被过滤", () => {
  const now = Date.now()
  insertClient("online-before", now - 60_000)
  insertClient("never-online", 0)
  db.prepare("INSERT INTO health_findings (id,host,severity,category,title,detail,time,ts,read) VALUES ('finding-1','host-a','warning','系统','磁盘告警','空间不足','',?,0)").run(now - 30_000)
  db.prepare("INSERT INTO tasks (id,name,created_at,updated_at) VALUES ('task-1','每日检查',?,?)").run(now, now)
  db.prepare("INSERT INTO commands (id,client_id,task_id,type,status,created_at,updated_at) VALUES ('command-1','online-before','task-1','run-program','failed',?,?)").run(now, now)
  db.prepare("INSERT INTO plugins (id,name,version,created_at) VALUES ('plugin-1','示例插件','1.0.0',?)").run(now)
  plugins.updatePlugin("plugin-1", { version: "1.1.0" })

  const first = notifications.listNotifications(100)
  const second = notifications.listNotifications(100)
  assert.deepEqual(new Set(first.map((item) => item.type)), new Set(["offline", "health", "task"]))
  assert.equal(first.some((item) => item.id.startsWith("offline:never-online:")), false)
  assert.equal(second.length, first.length)
})

test("全部已读和清空会先物化来源且清空后不会复活", () => {
  insertClient("client-read", Date.now() - 60_000)
  assert.equal(notifications.markAllRead(), 1)
  assert.equal(notifications.listNotifications(10)[0]?.read, true)

  insertClient("client-clear", Date.now() - 90_000)
  assert.equal(notifications.clear(), 2)
  assert.deepEqual(notifications.listNotifications(10), [])
})

test("不存在的健康通知不会产生已读副作用", () => {
  db.prepare("INSERT INTO health_findings (id,host,severity,category,title,detail,time,ts,read) VALUES ('finding-hidden','host-a','warning','系统','告警','','',?,0)").run(Date.now())
  assert.equal(notifications.markRead("health:finding-hidden"), false)
  const row = db.prepare("SELECT read FROM health_findings WHERE id='finding-hidden'").get() as { read: number }
  assert.equal(row.read, 0)
})

test("插件版本变更不会写入通知中心", () => {
  const now = Date.now()
  db.prepare("INSERT INTO plugins (id,name,version,created_at) VALUES ('plugin-delete','待删除插件','1.0.0',?)").run(now)
  plugins.updatePlugin("plugin-delete", { version: "2.0.0" })
  assert.equal(notifications.listNotifications(10).length, 0)
  assert.equal(plugins.deletePlugin("plugin-delete"), true)
  assert.equal(notifications.listNotifications(10).length, 0)
})

test("listNotificationsGrouped 按 (type, source_id) 正确聚合", () => {
  const now = Date.now()
  // 同一设备的 3 条 offline 通知（模拟多次掉线）
  insertClient("client-a", now - 90_000)
  db.prepare("INSERT OR IGNORE INTO notifications (id,type,title,description,ts,read,dismissed,source_id) VALUES (?,?,?,?,?,0,0,?)").run(
    `offline:client-a:${now - 90_000}`, "offline", "客户端已离线", "client-a 未在预期时间内上报心跳", now - 90_000, "client-a"
  )
  db.prepare("INSERT OR IGNORE INTO notifications (id,type,title,description,ts,read,dismissed,source_id) VALUES (?,?,?,?,?,0,0,?)").run(
    `offline:client-a:${now - 60_000}`, "offline", "客户端已离线", "client-a 再次离线", now - 60_000, "client-a"
  )
  db.prepare("INSERT OR IGNORE INTO notifications (id,type,title,description,ts,read,dismissed,source_id) VALUES (?,?,?,?,?,0,0,?)").run(
    `offline:client-a:${now - 30_000}`, "offline", "客户端已离线", "client-a 第三次离线", now - 30_000, "client-a"
  )
  
  // 不同设备的 offline 通知
  insertClient("client-b", now - 50_000)
  db.prepare("INSERT OR IGNORE INTO notifications (id,type,title,description,ts,read,dismissed,source_id) VALUES (?,?,?,?,?,0,0,?)").run(
    `offline:client-b:${now - 50_000}`, "offline", "客户端已离线", "client-b 未在预期时间内上报心跳", now - 50_000, "client-b"
  )
  
  const grouped = notifications.listNotificationsGrouped(100)
  
  // 应该有 2 个聚合组（client-a 堆叠，client-b 单条）
  assert.equal(grouped.length, 2)
  
  // 找到 client-a 的聚合组
  const clientAGroup = grouped.find(g => g.id.includes("client-a"))
  assert.ok(clientAGroup, "应该存在 client-a 的聚合组")
  assert.equal(clientAGroup.count, 3, "client-a 应该聚合 3 条通知")
  assert.ok(clientAGroup.items, "聚合组应该包含 items 子列表")
  assert.equal(clientAGroup.items?.length, 3, "items 子列表应该包含 3 条通知")
  
  // 找到 client-b 的单条通知
  const clientBGroup = grouped.find(g => g.id.includes("client-b"))
  assert.ok(clientBGroup, "应该存在 client-b 的通知")
  assert.equal(clientBGroup.count, 1, "client-b 只有 1 条通知")
  assert.equal(clientBGroup.items, undefined, "单条通知不应该有 items")
})

test("listNotificationsGrouped 空列表时返回空数组", () => {
  const grouped = notifications.listNotificationsGrouped(100)
  assert.deepEqual(grouped, [])
})

test("grouped=false 保持原有平铺行为", () => {
  const now = Date.now()
  insertClient("client-flat", now - 60_000)
  db.prepare("INSERT OR IGNORE INTO notifications (id,type,title,description,ts,read,dismissed,source_id) VALUES (?,?,?,?,?,0,0,?)").run(
    `offline:client-flat:${now - 60_000}`, "offline", "客户端已离线", "client-flat 未在预期时间内上报心跳", now - 60_000, "client-flat"
  )
  db.prepare("INSERT OR IGNORE INTO notifications (id,type,title,description,ts,read,dismissed,source_id) VALUES (?,?,?,?,?,0,0,?)").run(
    `offline:client-flat:${now - 30_000}`, "offline", "客户端已离线", "client-flat 再次离线", now - 30_000, "client-flat"
  )
  
  const flat = notifications.listNotifications(100)
  assert.equal(flat.length, 2, "平铺模式应该返回 2 条独立通知")
  assert.equal(flat.every(n => !("count" in n)), true, "平铺模式的通知不应该有 count 字段")
})

test("通知包含结构化字段且支持单条与整组暂缓", () => {
  notifications.addNotification("structured-1", "task", "任务失败", "摘要", "cmd-1", {
    severity: "error", detail: "stack trace", code: "EXIT_2", source: "tasks", deviceId: "client-x", groupKey: "task:t:client-x:EXIT_2",
  })
  const item = notifications.listNotifications(10)[0]
  assert.equal(item.code, "EXIT_2")
  assert.equal(item.detail, "stack trace")
  assert.equal(item.deviceId, "client-x")
  assert.equal(notifications.snooze(item.id, Date.now() + 3_600_000), true)
  assert.equal(notifications.listNotifications(10).length, 0)
})

test("整组已读、暂缓和清理保持幂等", () => {
  const extra = { severity: "warning" as const, source: "health", groupKey: "health:disk:host:full" }
  notifications.addNotification("group-1", "health", "磁盘告警", "a", "finding-a", extra)
  notifications.addNotification("group-2", "health", "磁盘告警", "b", "finding-b", extra)
  assert.equal(notifications.listNotificationsGrouped(10)[0]?.count, 2)
  assert.equal(notifications.markGroupRead(extra.groupKey), 2)
  assert.equal(notifications.markGroupRead(extra.groupKey), 0)
  assert.equal(notifications.snoozeGroup(extra.groupKey, Date.now() + 10000), 2)
  assert.equal(notifications.listNotifications(10).length, 0)
  assert.equal(notifications.snoozeGroup(extra.groupKey, 0), 2)
  assert.equal(notifications.purgeRead(30), 2)
  assert.equal(notifications.listNotifications(10).length, 0)
})
