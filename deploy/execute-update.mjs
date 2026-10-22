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
      !Number.isSafeInteger(request.sequence) || request.sequence < 1 ||
      (request.feed !== "recommended" && !["stable", "beta", "alpha"].includes(request.channel)) ||
      !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(updateOrigin)) throw new Error("升级请求无效")
  status("downloading")
  const recommended = request.feed === "recommended"
  const indexUrl = recommended ? `${updateOrigin}/updates/revisions/${request.sequence}/index.json` :
    `${updateOrigin}/updates/${request.channel}/index.json`
  const [bytes, signature] = await Promise.all([download(indexUrl, 32 * 1024), download(`${indexUrl}.sig`, 128)])
  if (signature.length !== 64 || !verify(null, bytes, pub, signature)) throw new Error("索引签名无效")
  const index = JSON.parse(bytes)
  if (recommended ? index.schemaVersion !== 4 || index.sequence !== request.sequence || index.channel !== undefined :
      ![2, 3].includes(index.schemaVersion) || index.channel !== request.channel || index.sequence < request.sequence) {
    throw new Error("索引序号或升级协议不匹配")
  }
  const item = index.releases?.server
  if (index.schemaVersion === 4 && (typeof item?.releaseType !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(item.releaseType))) throw new Error("服务端发布类型无效")
  if (index.schemaVersion === 3 || index.schemaVersion === 4) {
    const source = item?.source
    const expected = `nacho-server-source-${requestedVersion}.tar.gz`
    if (item?.version !== requestedVersion || !/^[0-9a-f-]{36}$/.test(request.stageId || "") ||
        source?.fileName !== expected ||
        source?.url !== `https://github.com/nachomao/nacho-server/releases/download/v${requestedVersion}/${expected}` ||
        !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.sizeBytes) ||
        source.sizeBytes < 1 || source.sizeBytes > 2 * 1024 ** 3) throw new Error("源码发布无效")
    const staged = path.join("/var/lib/control-server/update-staging", request.stageId, "payload")
    if (!fs.lstatSync(path.dirname(staged)).isDirectory() ||
        fs.lstatSync(staged).isSymbolicLink() || !fs.lstatSync(staged).isFile() ||
        fs.statSync(staged).size !== source.sizeBytes) {
      throw new Error("已上传源码大小无效")
    }
    const hash = createHash("sha256")
    for await (const chunk of fs.createReadStream(staged)) hash.update(chunk)
    if (hash.digest("hex") !== source.sha256) throw new Error("已上传源码 SHA-256 不匹配")
    status("building")
    const listing = spawnSync("tar", ["-tzf", staged], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
    const types = spawnSync("tar", ["-tvzf", staged], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
    const allowed = /^(src|deploy|client)(\/[A-Za-z0-9._/-]+)?$|^(package\.json|package-lock\.json|tsconfig\.json)$/
    if (listing.status !== 0 || types.status !== 0 ||
        listing.stdout.split("\n").filter(Boolean).some((name) =>
          name.startsWith("/") || name.split("/").includes("..") || !allowed.test(name.replace(/\/$/, ""))) ||
        types.stdout.split("\n").filter(Boolean).some((line) => !["-", "d"].includes(line[0]))) {
      throw new Error("源码归档包含无效文件")
    }
    const work = path.join(tmp, "source")
    fs.mkdirSync(work)
    const unpack = spawnSync("tar", ["-xzf", staged, "-C", work], { timeout: 60_000 })
    if (unpack.status !== 0) throw new Error("源码解包失败")
    const manifest = JSON.parse(fs.readFileSync(path.join(work, "package.json"), "utf8"))
    if (manifest.name !== "nacho-server" || manifest.version !== requestedVersion) throw new Error("源码版本无效")
    const agentUid = spawnSync("id", ["-u", "control"], { encoding: "utf8" })
    const agentGid = spawnSync("id", ["-g", "control"], { encoding: "utf8" })
    if (agentUid.status !== 0 || agentGid.status !== 0) throw new Error("构建用户不存在")
    fs.chmodSync(tmp, 0o711)
    fs.chownSync(work, Number(agentUid.stdout.trim()), Number(agentGid.stdout.trim()))
    const chown = spawnSync("chown", ["-R", "control:control", work], { timeout: 60_000 })
    if (chown.status !== 0) throw new Error("构建目录授权失败")
    for (const args of [["ci", "--no-audit", "--no-fund"], ["run", "build"]]) {
      const built = spawnSync("runuser", ["-u", "control", "--", "npm", ...args], {
        cwd: work, encoding: "utf8", timeout: 10 * 60_000,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: work },
      })
      if (built.status !== 0) throw new Error(`服务端源码构建失败（npm ${args[0]}）`)
    }
    fs.rmSync(path.join(work, "node_modules"), { recursive: true, force: true })
    const production = spawnSync("runuser", ["-u", "control", "--", "npm", "ci", "--omit=dev",
      "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: work, encoding: "utf8", timeout: 10 * 60_000,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: work },
    })
    if (production.status !== 0) throw new Error("生产依赖预检失败")
    const release = path.join(tmp, "release.tar.gz")
    const packed = spawnSync("tar", ["-czf", release, "-C", work,
      "dist", "node_modules", "package.json", "package-lock.json", "deploy"], { timeout: 60_000 })
    if (packed.status !== 0) throw new Error("构建包打包失败")
    status("installing")
    const installed = spawnSync("/bin/bash", [path.join(root, "napl"), "update", "install", release], {
      encoding: "utf8", timeout: 15 * 60_000,
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        NAPL_ENTRYPOINT: "/usr/local/bin/napl", NAPL_VERIFIED_SOURCE: "1",
        NAPL_RELEASE_PUBLIC_KEY: path.join(root, "release-public.pem"),
        NACHO_UPDATE_ORIGIN: updateOrigin, NAPL_LEGACY_CHANNEL: recommended ? "" : request.channel },
    })
    if (installed.status !== 0) {
      status(installed.stderr?.includes("已恢复") ? "rolled-back" : "failed",
        `napl 安装失败（exit=${installed.status ?? "timeout"}）`)
      process.exitCode = 1
    } else status("healthy")
  } else {
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
      NAPL_LEGACY_CHANNEL: request.channel,
    },
  })
  if (result.status !== 0) {
    const rolledBack = result.status === 4 && result.stderr?.includes("已恢复旧版本")
    status(rolledBack ? "rolled-back" : "failed", `napl 安装失败（exit=${result.status ?? "timeout"}）`)
    process.exitCode = 1
  } else {
    status("healthy")
  }
  }
} catch (error) {
  status("failed", error instanceof Error ? error.message : "升级执行失败")
  process.exitCode = 1
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(lockDir, { recursive: true, force: true })
}
