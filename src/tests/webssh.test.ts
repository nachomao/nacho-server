import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import crypto from "node:crypto"
import express from "express"
import WebSocket from "ws"
import { after, before, test } from "node:test"

const databasePath = path.join(process.cwd(), "tmp-webssh-test.db")
let db: typeof import("../db").db
let server: http.Server
let baseUrl: string
let wsBase: string
let clients: typeof import("../services/clients")
let logs: typeof import("../services/logs")
let terminalSessions: typeof import("../services/terminal-sessions")
let fileSessions: typeof import("../services/file-sessions")
const sockets: WebSocket[] = []

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class WsInbox {
  private queued: Record<string, unknown>[] = []
  private waiters: Array<{ resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = []

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>
      const waiter = this.waiters.shift()
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve(message)
      } else {
        this.queued.push(message)
      }
    })
    ws.on("close", () => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error("WebSocket 已关闭"))
      }
    })
  }

  next(timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const queued = this.queued.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer)
        reject(new Error("等待 WebSocket 消息超时"))
      }, timeoutMs)
      this.waiters.push({ resolve, reject, timer })
    })
  }
}

function openSocket(url: string, headers?: Record<string, string>): Promise<{ ws: WebSocket; inbox: WsInbox }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    const inbox = new WsInbox(ws)
    sockets.push(ws)
    const timer = setTimeout(() => reject(new Error(`WebSocket 打开超时：${url}`)), 5_000)
    ws.once("open", () => {
      clearTimeout(timer)
      resolve({ ws, inbox })
    })
    ws.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    const timer = setTimeout(resolve, 2_000)
    ws.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
    ws.close()
  })
}

async function fetchJson(pathname: string, init: RequestInit = {}): Promise<{ status: number; body: { ok: boolean; data?: any; message?: string } }> {
  const response = await fetch(`${baseUrl}/api/panel${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.PANEL_API_KEY}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) as { ok: boolean; data?: any; message?: string } }
  } catch {
    throw new Error(`非 JSON 响应（${response.status}）${pathname}: ${text.slice(0, 120)}`)
  }
}

before(async () => {
  fs.rmSync(databasePath, { force: true })
  process.env.DATABASE_PATH = databasePath
  process.env.PANEL_API_KEY = "test-panel-key"
  process.env.ENROLLMENT_KEY = "test-enroll-key"
  ;({ db } = await import("../db"))
  const { initSchema } = await import("../db")
  initSchema()
  clients = await import("../services/clients")
  logs = await import("../services/logs")
  terminalSessions = await import("../services/terminal-sessions")
  fileSessions = await import("../services/file-sessions")
  const { panelRouter } = await import("../routes/panel")
  const { attachWebSocket } = await import("../ws")
  const app = express()
  app.use(express.json())
  app.use("/api/panel", panelRouter)
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500
    const message = error instanceof Error ? error.message : "服务器内部错误"
    res.status(status).json({ ok: false, message })
  })
  server = http.createServer(app)
  attachWebSocket(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  baseUrl = `http://127.0.0.1:${address.port}`
  wsBase = `ws://127.0.0.1:${address.port}`
})

after(async () => {
  for (const ws of sockets) {
    try { ws.close() } catch { /* 已关闭 */ }
  }
  terminalSessions.shutdownTerminalSessions()
  fileSessions.shutdownFileSessions()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await delay(50)
  db.close()
  fs.rmSync(databasePath, { force: true })
})

test("terminal sessions relay input/output, clamp size, replay on reconnect and enforce limits", async () => {
  const registered = clients.registerClient({
    name: "Windows 测试机",
    hostname: "win-test",
    ip: "127.0.0.1",
    os: "Windows",
  })
  const { inbox: agentInbox } = await openSocket(`${wsBase}/agent/ws?token=${encodeURIComponent(registered.token)}`)
  assert.equal((await agentInbox.next()).kind, "ready")

  const offline = clients.registerClient({ name: "离线机", hostname: "offline", ip: "10.0.0.9", os: "Windows" })
  const offlineAttempt = await fetchJson("/terminal/sessions", {
    method: "POST",
    body: JSON.stringify({ clientId: offline.client.id, shell: "powershell", cols: 100, rows: 30 }),
  })
  assert.equal(offlineAttempt.status, 409)

  const linux = clients.registerClient({ name: "Linux 机", hostname: "linux", ip: "10.0.0.10", os: "Linux" })
  const linuxAttempt = await fetchJson("/terminal/sessions", {
    method: "POST",
    body: JSON.stringify({ clientId: linux.client.id, shell: "powershell", cols: 100, rows: 30 }),
  })
  assert.equal(linuxAttempt.status, 400)

  const created = await fetchJson("/terminal/sessions", {
    method: "POST",
    body: JSON.stringify({ clientId: registered.client.id, shell: "powershell", cols: 300, rows: 1 }),
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.data.session.cols, 240)
  assert.equal(created.body.data.session.rows, 5)
  assert.match(created.body.data.wsPath, /^\/api\/panel\/terminal\/ws\?ticket=/)
  const sessionId = created.body.data.session.id as string

  const opened = await agentInbox.next()
  assert.equal(opened.kind, "terminal-open")
  assert.equal(opened.sessionId, sessionId)
  assert.equal(opened.shell, "powershell")
  assert.equal(opened.cols, 240)
  assert.equal(opened.rows, 5)
  const agentTicket = opened.ticket as string

  const duplicate = await fetchJson("/terminal/sessions", {
    method: "POST",
    body: JSON.stringify({ clientId: registered.client.id, shell: "cmd", cols: 100, rows: 30 }),
  })
  assert.equal(duplicate.status, 409)

  const { ws: agentTerminal, inbox: agentTerminalInbox } = await openSocket(
    `${wsBase}/agent/terminal?session=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(agentTicket)}`,
    { Authorization: `Bearer ${registered.token}` },
  )
  const { ws: panelTerminal, inbox: panelInbox } = await openSocket(`${wsBase}${created.body.data.wsPath}`)

  const ready = await panelInbox.next()
  assert.equal(ready.kind, "ready")
  assert.equal(ready.agentAttached, true)
  assert.equal(ready.reconnected, false)

  await agentTerminal.send(JSON.stringify({ kind: "ready", shell: "powershell", pid: 4242, cwd: "C:\\", cols: 100, rows: 20 }))
  const agentReady = await panelInbox.next()
  assert.equal(agentReady.kind, "agent-ready")
  assert.equal(agentReady.cwd, "C:\\")

  await panelTerminal.send(JSON.stringify({ kind: "input", data: "whoami\r\n" }))
  assert.deepEqual(await agentTerminalInbox.next(), { kind: "input", data: "whoami\r\n" })

  await panelTerminal.send(JSON.stringify({ kind: "input", data: "x".repeat(9_000) }))
  const oversized = await panelInbox.next()
  assert.equal(oversized.kind, "error")
  assert.equal(oversized.code, "INVALID_MESSAGE")

  await agentTerminal.send(JSON.stringify({ kind: "output", data: "desktop-test\\admin\r\n" }))
  const output = await panelInbox.next()
  assert.equal(output.kind, "output")
  assert.equal(output.seq, 1)
  assert.equal(output.data, "desktop-test\\admin\r\n")

  await panelTerminal.send(JSON.stringify({ kind: "resize", cols: 500, rows: 1 }))
  assert.deepEqual(await agentTerminalInbox.next(), { kind: "resize", cols: 240, rows: 5 })
  await agentTerminal.send(JSON.stringify({ kind: "resize-ack", cols: 240, rows: 5 }))
  assert.equal((await panelInbox.next()).kind, "resize-ack")

  await closeSocket(panelTerminal)
  await delay(50)

  const reconnected = await fetchJson(`/terminal/sessions/${encodeURIComponent(sessionId)}/reconnect`, { method: "POST" })
  assert.equal(reconnected.status, 200)
  const { inbox: panelInbox2 } = await openSocket(`${wsBase}${reconnected.body.data.wsPath}&since=0`)
  const ready2 = await panelInbox2.next()
  assert.equal(ready2.kind, "ready")
  assert.equal(ready2.reconnected, true)
  const replay = await panelInbox2.next()
  assert.equal(replay.kind, "output")
  assert.equal(replay.seq, 1)

  const deleted = await fetchJson(`/terminal/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
  assert.equal(deleted.status, 200)
  const closed = await agentTerminalInbox.next()
  assert.equal(closed.kind, "close")

  await delay(100)
  const terminalLogs = logs.listLogs({ source: "terminal", limit: 50 })
  assert.ok(terminalLogs.some((entry) => entry.message.includes("WebSSH 终端会话已创建") && entry.detail?.includes(sessionId)))
  assert.ok(terminalLogs.some((entry) => entry.message.includes("WebSSH 终端会话结束：panel-closed") && entry.detail?.includes(sessionId)))
})

test("file sessions relay directory jobs, upload chunks and enforce per-client limits", async () => {
  const registered = clients.registerClient({
    name: "文件测试机",
    hostname: "file-test",
    ip: "127.0.0.1",
    os: "Windows",
  })
  const { inbox: agentInbox } = await openSocket(`${wsBase}/agent/ws?token=${encodeURIComponent(registered.token)}`)
  assert.equal((await agentInbox.next()).kind, "ready")

  const created = await fetchJson(`/clients/${encodeURIComponent(registered.client.id)}/files/sessions`, { method: "POST", body: JSON.stringify({}) })
  assert.equal(created.status, 201)
  assert.match(created.body.data.wsPath, /^\/api\/panel\/files\/ws\?ticket=/)
  const sessionId = created.body.data.session.id as string

  const opened = await agentInbox.next()
  assert.equal(opened.kind, "file-open")
  assert.equal(opened.sessionId, sessionId)
  const agentTicket = opened.ticket as string

  const { ws: agentFiles, inbox: agentFilesInbox } = await openSocket(
    `${wsBase}/agent/files?session=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(agentTicket)}`,
    { Authorization: `Bearer ${registered.token}` },
  )
  const { ws: panelFiles, inbox: panelInbox } = await openSocket(`${wsBase}${created.body.data.wsPath}`)
  const ready = await panelInbox.next()
  assert.equal(ready.kind, "ready")
  assert.equal(ready.agentAttached, true)

  const duplicate = await fetchJson(`/clients/${encodeURIComponent(registered.client.id)}/files/sessions`, { method: "POST", body: JSON.stringify({}) })
  assert.equal(duplicate.status, 409)

  await panelFiles.send(JSON.stringify({ kind: "roots", id: "r1" }))
  assert.deepEqual(await agentFilesInbox.next(), { kind: "roots", id: "r1" })
  await agentFiles.send(JSON.stringify({
    kind: "rootsResult",
    id: "r1",
    roots: [{ path: "C:\\", label: "C:", freeBytes: 1024, totalBytes: 2048 }],
  }))
  const roots = await panelInbox.next()
  assert.equal(roots.kind, "rootsResult")
  assert.equal((roots as { roots: Array<{ path: string }> }).roots[0].path, "C:\\")

  await panelFiles.send(JSON.stringify({ kind: "list", id: "r2", path: "C:\\temp" }))
  assert.deepEqual(await agentFilesInbox.next(), { kind: "list", id: "r2", path: "C:\\temp" })
  await agentFiles.send(JSON.stringify({
    kind: "listResult",
    id: "r2",
    path: "C:\\temp",
    entries: [{ name: "a.txt", type: "file", size: 5, mtimeUtc: "2026-11-01T00:00:00Z" }],
    truncated: false,
  }))
  const listed = await panelInbox.next()
  assert.equal(listed.kind, "listResult")
  assert.equal((listed as { entries: Array<{ name: string }> }).entries[0].name, "a.txt")

  const transferId = "11111111-1111-4111-8111-111111111111"
  await panelFiles.send(JSON.stringify({ kind: "upload", id: "r3", transferId, path: "C:\\temp\\a.txt", size: 5, offset: 0 }))
  assert.equal((await agentFilesInbox.next()).kind, "upload")
  await agentFiles.send(JSON.stringify({ kind: "uploadReady", id: "r3", transferId, receivedBytes: 0 }))
  const uploadReady = await panelInbox.next()
  assert.equal(uploadReady.kind, "uploadReady")
  assert.equal(uploadReady.receivedBytes, 0)

  const chunk = Buffer.from("hello")
  const hash = crypto.createHash("sha256").update(chunk).digest("hex")
  await panelFiles.send(JSON.stringify({
    kind: "uploadChunk",
    id: "r4",
    transferId,
    offset: 0,
    data: chunk.toString("base64"),
    sha256: hash,
  }))
  assert.equal((await agentFilesInbox.next()).kind, "uploadChunk")
  await agentFiles.send(JSON.stringify({ kind: "uploadAck", id: "r4", transferId, receivedBytes: 5 }))
  const ack = await panelInbox.next()
  assert.equal(ack.kind, "uploadAck")
  assert.equal(ack.receivedBytes, 5)

  await panelFiles.send(JSON.stringify({
    kind: "uploadChunk",
    id: "r5",
    transferId,
    offset: 5,
    data: "A".repeat(370 * 1024),
    sha256: hash,
  }))
  const invalid = await panelInbox.next()
  assert.equal(invalid.kind, "error")
  assert.equal(invalid.code, "INVALID_MESSAGE")

  const deleted = await fetchJson(`/files/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
  assert.equal(deleted.status, 200)
  const closed = await agentFilesInbox.next()
  assert.equal(closed.kind, "close")
})
