import { db } from "../db"
import { config } from "../config"
import { markRead as markHealthRead, markAllRead as markAllHealthRead } from "./health"

export type NotificationSeverity = "info" | "warning" | "error" | "critical"
export type NotificationType = "offline" | "health" | "task" | "log"
export type Notification = {
  id: string; type: NotificationType; severity: NotificationSeverity; title: string; desc: string; detail: string
  code: string | null; source: string; deviceId: string | null; time: string; ts: number; read: boolean
  snoozedUntil: number | null; groupKey: string
}
export type GroupedNotification = Notification & { count: number; items?: Notification[] }
type Row = Record<string, unknown>
type LogRow = { id: string; ts: number; level: string; source: string; message: string; detail: string | null }

const now = () => Date.now()
const severityOf = (value: unknown): NotificationSeverity => value === "critical" || value === "error" || value === "info" ? value : "warning"
const logSeverityOf = (level: string): NotificationSeverity => level === "error" ? "critical" : level === "warn" ? "warning" : "info"
const text = (v: unknown) => typeof v === "string" ? v : ""
function resultDetail(result: string | null, exitCode: number | null): string {
  if (!result) return `退出码：${exitCode ?? "未知"}`
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>
    const value = parsed.error ?? parsed.message ?? parsed.rollbackReason
    if (typeof value === "string" && value.trim()) return value.slice(0, 4096)
  } catch { /* 使用受限文本摘要 */ }
  return result.replace(/[\r\n]+/g, " ").slice(0, 1024)
}
function logDeviceId(detail: string | null): string | null {
  const match = detail?.match(/(?:^|;)(?:clientId|client|id)=([^;]+)/)
  return match?.[1]?.replace(/^"|"$/g, "").slice(0, 240) || null
}
function map(row: Row): Notification {
  const ts = Number(row.ts) || now()
  return { id: text(row.id), type: text(row.type) as NotificationType, severity: severityOf(row.severity), title: text(row.title),
    desc: text(row.description), detail: text(row.detail) || text(row.description), code: row.code == null ? null : text(row.code),
    source: text(row.source) || "server", deviceId: row.device_id == null ? null : text(row.device_id), time: new Date(ts).toLocaleString("zh-CN", { hour12: false }),
    ts, read: Number(row.read) === 1, snoozedUntil: row.snoozed_until == null ? null : Number(row.snoozed_until), groupKey: text(row.group_key) || `${text(row.type)}:${text(row.source_id)}` }
}
function insert(n: { id: string; type: NotificationType; severity: NotificationSeverity; title: string; desc: string; detail?: string; code?: string | null; source?: string; deviceId?: string | null; ts?: number; sourceId?: string | null; groupKey: string }) {
  db.prepare(`INSERT OR IGNORE INTO notifications (id,type,severity,title,description,detail,code,source,device_id,group_key,ts,read,dismissed,source_id,snoozed_until)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,NULL)`).run(n.id, n.type, n.severity, n.title, n.desc, (n.detail ?? n.desc).slice(0, 65536), n.code ?? null, n.source ?? "server", n.deviceId ?? null, n.groupKey, n.ts ?? now(), 0, n.sourceId ?? null)
}
function syncSources() {
  const ts = now()
  const clients = db.prepare("SELECT id,name,hostname,last_seen FROM clients WHERE status!='unregistered' AND last_seen > 0 AND last_seen <= ?").all(ts-config.offlineThreshold*1000) as Array<{id:string;name:string;hostname:string;last_seen:number}>
  for (const c of clients) { const label = c.name || c.hostname || c.id; insert({ id:`offline:${c.id}:${c.last_seen}`, type:"offline", severity:"error", title:"客户端已离线", desc:`${label} 未在预期时间内上报心跳`, detail:`设备 ${label} 在 ${new Date(c.last_seen).toLocaleString("zh-CN", {hour12:false})} 后失去心跳。`, code:"CLIENT_OFFLINE", source:"clients", deviceId:c.id, sourceId:c.id, groupKey:`device:${c.id}:offline`, ts:c.last_seen || ts }) }
  const findings = db.prepare("SELECT hf.id,hf.host,hf.severity,hf.category,hf.title,hf.detail,hf.ts,hf.read,hf.package_id,lp.client_id FROM health_findings hf LEFT JOIN log_packages lp ON lp.id=hf.package_id WHERE hf.severity IN ('critical','error','warning')").all() as Array<{id:string;host:string;severity:string;category:string;title:string;detail:string;ts:number;read:number;package_id:string|null;client_id:string|null}>
  for (const f of findings) { insert({ id:`health:${f.id}`, type:"health", severity:severityOf(f.severity), title:f.title, desc:`${f.host}${f.detail ? `：${f.detail}` : ""}`, detail:f.detail || f.title, code:f.category, source:"health", deviceId:f.client_id, sourceId:f.id, groupKey:`health:${f.category}:${f.host}:${f.title}`, ts:f.ts }); if (f.read) db.prepare("UPDATE notifications SET read=1 WHERE id=?").run(`health:${f.id}`) }
  const failures = db.prepare("SELECT c.id,c.updated_at,c.client_id,c.result,c.exit_code,t.id AS task_id,t.name AS task_name FROM commands c LEFT JOIN tasks t ON t.id=c.task_id WHERE c.status='failed'").all() as Array<{id:string;updated_at:number;client_id:string;result:string|null;exit_code:number|null;task_id:string|null;task_name:string|null}>
  for (const f of failures) insert({ id:`task:${f.id}`, type:"task", severity:"error", title:"任务执行失败", desc:`${f.task_name || "命令"} 在客户端 ${f.client_id} 上执行失败`, detail:resultDetail(f.result,f.exit_code), code:f.exit_code == null ? "TASK_FAILED" : `EXIT_${f.exit_code}`, source:"tasks", deviceId:f.client_id, sourceId:f.id, groupKey:`task:${f.task_id || f.task_name || "unknown"}:${f.client_id}:${f.exit_code ?? "failed"}`, ts:f.updated_at || ts })
  const logs = db.prepare("SELECT id,ts,level,source,message,detail FROM logs ORDER BY ts DESC LIMIT 100").all() as LogRow[]
  for (const log of logs) insert({ id:`log:${log.id}`, type:"log", severity:logSeverityOf(log.level), title:log.message, desc:log.source, detail:log.detail || log.message, code:`LOG_${log.level.toUpperCase()}`, source:log.source, deviceId:logDeviceId(log.detail), sourceId:log.id, groupKey:`log:${log.source}:${log.message}`.slice(0, 240), ts:log.ts })
}
function tx<T>(fn:()=>T):T { db.exec("BEGIN IMMEDIATE"); try { const v=fn(); db.exec("COMMIT"); return v } catch(e){ db.exec("ROLLBACK"); throw e } }
function purge(retentionDays=30, maxItems=500, enabled=true) { if (!enabled) return; const days=Math.max(1,Math.min(90,retentionDays)); const max=Math.max(100,Math.min(1000,maxItems)); db.prepare("UPDATE notifications SET dismissed=1 WHERE dismissed=0 AND read=1 AND ts < ?").run(now()-days*86400000); const active=Number((db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE dismissed=0").get() as {count:number}).count); const excess=Math.max(0,active-max); if(excess>0) db.prepare("UPDATE notifications SET dismissed=1 WHERE id IN (SELECT id FROM notifications WHERE dismissed=0 AND read=1 ORDER BY ts ASC LIMIT ?)").run(excess) }
export function purgeRead(retentionDays=30) { return Number(db.prepare("UPDATE notifications SET dismissed=1,read=1 WHERE dismissed=0 AND (read=1 OR ts < ?)").run(now()-Math.max(1,Math.min(90,retentionDays))*86400000).changes) }
export function addNotification(id:string,type:NotificationType,title:string,desc:string,sourceId?:string, extra?:Partial<Pick<Notification,"severity"|"detail"|"code"|"source"|"deviceId"|"groupKey">>) { insert({id,type,severity:extra?.severity||"warning",title,desc,detail:extra?.detail,code:extra?.code,source:extra?.source,deviceId:extra?.deviceId,sourceId,groupKey:extra?.groupKey || `${type}:${sourceId || id}`}) }
export function listNotifications(limit=100, retentionDays=30, maxItems=500, autoPurge=true):Notification[] { const safe=Math.max(1,Math.min(5000,Math.floor(limit))); return tx(()=>{ syncSources(); purge(retentionDays,maxItems,autoPurge); return (db.prepare("SELECT * FROM notifications WHERE dismissed=0 AND (snoozed_until IS NULL OR snoozed_until<=?) ORDER BY ts DESC LIMIT ?").all(now(),safe) as Row[]).map(map) }) }
export function listNotificationsGrouped(limit=100, retentionDays=30, maxItems=500, autoPurge=true):GroupedNotification[] { const rows=listNotifications(limit,retentionDays,maxItems,autoPurge); const groups=new Map<string,Notification[]>(); for(const n of rows){const a=groups.get(n.groupKey)||[]; a.push(n); groups.set(n.groupKey,a)} return [...groups.values()].map(items=>items.length===1?{...items[0],count:1}:{...items[0],count:items.length,items}).sort((a,b)=>b.ts-a.ts) }
export function listExportNotifications(limit=5000, retentionDays=30, maxItems=500, autoPurge=true):Notification[] { return tx(()=>{ syncSources(); purge(retentionDays,maxItems,autoPurge); return (db.prepare("SELECT * FROM notifications WHERE dismissed=0 ORDER BY ts DESC LIMIT ?").all(Math.max(1,Math.min(5000,limit))) as Row[]).map(map) }) }
export function markRead(id:string){ const changed=db.prepare("UPDATE notifications SET read=1 WHERE id=? AND dismissed=0").run(id).changes>0; if(changed&&id.startsWith("health:")) markHealthRead(id.slice(7)); return changed }
export function markAllRead(){ return tx(()=>{syncSources(); const n=Number(db.prepare("UPDATE notifications SET read=1 WHERE read=0 AND dismissed=0").run().changes); markAllHealthRead(); return n }) }
export function clear(){ return tx(()=>{syncSources(); return Number(db.prepare("UPDATE notifications SET dismissed=1,read=1 WHERE dismissed=0").run().changes) }) }
export function snooze(id:string, until:number){ return db.prepare("UPDATE notifications SET snoozed_until=? WHERE id=? AND dismissed=0").run(until,id).changes>0 }
export function snoozeGroup(groupKey:string, until:number){ return Number(db.prepare("UPDATE notifications SET snoozed_until=? WHERE group_key=? AND dismissed=0").run(until,groupKey).changes) }
export function markGroupRead(groupKey:string){ return Number(db.prepare("UPDATE notifications SET read=1 WHERE group_key=? AND dismissed=0 AND read=0").run(groupKey).changes) }
export function unreadCount(){ return listNotifications(500).filter(n=>!n.read).length }
export function deleteBySource(type:NotificationType, sourceId:string){ return Number(db.prepare("DELETE FROM notifications WHERE type=? AND source_id=?").run(type,sourceId).changes) }
export function deleteBySources(type:NotificationType, sourceIds:string[]){ const s=db.prepare("DELETE FROM notifications WHERE type=? AND source_id=?"); return sourceIds.reduce((n,id)=>n+Number(s.run(type,id).changes),0) }
