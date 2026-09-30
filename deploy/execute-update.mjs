#!/usr/bin/env node
// Root-owned systemd.path broker. The control service can only create a fixed request file.
import { createHash, randomUUID, verify } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

const root = "/usr/local/lib/nacho-updater"
const requestDir = "/var/lib/control-server/update-requests"
const requestFile = path.join(requestDir, "request.json")
const statusFile = "/var/lib/control-server/update-status/status.json"
const lockDir = path.join(requestDir, ".pending")
const updateOrigin = process.env.NACHO_UPDATE_ORIGIN || "https://updates.example.invalid"
const pub = fs.readFileSync(path.join(root, "release-public.pem"))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nacho-server-update-"))
let requestedVersion = null

function status(phase, error = null) {
  const result = { phase, version: requestedVersion, error, at: new Date().toISOString() }
  const temporary = path.join(path.dirname(statusFile), `.status-${randomUUID()}`)
  fs.writeFileSync(temporary, JSON.stringify(result), { mode: 0o644, flag: "wx" })
  fs.renameSync(temporary, statusFile)
}

async function download(url, max) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if (Number(response.headers.get("content-length")) > max) throw new Error("下载大小无效")
  const chunks = []
  let size = 0
  if (!response.body) throw new Error("下载响应为空")
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > max) throw new Error("下载大小无效")
    chunks.push(Buffer.from(chunk))
  }
  const bytes = Buffer.concat(chunks)
  if (!bytes.length || bytes.length > max) throw new Error("下载大小无效")
  return bytes
}

async function downloadArtifact(url, output, sizeBytes, digest) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`制品下载 HTTP ${response.status}`)
  const hash = createHash("sha256")
  let size = 0
  await pipeline(Readable.fromWeb(response.body), new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      if (size > sizeBytes) return callback(new Error("制品超过发布大小"))
      hash.update(chunk)
      callback(null, chunk)
    },
  }), fs.createWriteStream(output, { flags: "wx", mode: 0o600 }))
  if (size !== sizeBytes || hash.digest("hex") !== digest) throw new Error("服务端安装包校验失败")
}

try {
  if (fs.lstatSync(requestFile).isSymbolicLink()) throw new Error("升级请求不能是符号链接")
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8"))
  fs.rmSync(requestFile)
  requestedVersion = request.version
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(requestedVersion) ||
      !Number.isSafeInteger(request.sequence) || !["stable", "beta", "alpha"].includes(request.channel) ||
      !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(updateOrigin)) throw new Error("升级请求无效")
  status("downloading")
  const indexUrl = `${updateOrigin}/updates/${request.channel}/index.json`
  const [bytes, signature] = await Promise.all([download(indexUrl, 32 * 1024), download(`${indexUrl}.sig`, 128)])
  if (signature.length !== 64 || !verify(null, bytes, pub, signature)) throw new Error("索引签名无效")
  const index = JSON.parse(bytes)
  if (index.schemaVersion !== 2 || index.channel !== request.channel || index.sequence < request.sequence) throw new Error("索引版本倒退或频道不匹配")
  const item = index.releases?.server
  if (item?.version !== requestedVersion ||
      item?.fileName !== `control-server-${requestedVersion}-linux-x64.tar.gz` ||
      item?.url !== `${updateOrigin}/artifacts/server/${requestedVersion}/${item.sha256}/${item.fileName}` ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1 || item.sizeBytes > 2 * 1024 ** 3) {
    throw new Error("目标版本不是受信任的服务端发布")
  }
  const archivePath = path.join(tmp, item.fileName)
  await downloadArtifact(item.url, archivePath, item.sizeBytes, item.sha256)
  status("installing")
  const result = spawnSync("/bin/bash", [path.join(root, "napl"), "update", "install", archivePath], {
    stdio: "pipe", encoding: "utf8", timeout: 15 * 60_000,
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      NAPL_ENTRYPOINT: "/usr/local/bin/napl",
      NAPL_RELEASE_PUBLIC_KEY: path.join(root, "release-public.pem"),
      NACHO_UPDATE_ORIGIN: updateOrigin,
      NACHO_UPDATE_CHANNEL: request.channel,
    },
  })
  if (result.status !== 0) {
    const rolledBack = result.status === 4 && result.stderr?.includes("已恢复旧版本")
    status(rolledBack ? "rolled-back" : "failed", `napl 安装失败（exit=${result.status ?? "timeout"}）`)
    process.exitCode = 1
  } else {
    status("healthy")
  }
} catch (error) {
  status("failed", error instanceof Error ? error.message : "升级执行失败")
  process.exitCode = 1
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(lockDir, { recursive: true, force: true })
}
