const { createHash, randomUUID } = require("node:crypto")
const { spawn } = require("node:child_process")
const { createReadStream } = require("node:fs")
const fs = require("node:fs/promises")
const path = require("node:path")

const PROBE_TIMEOUT_MS = 5000
const PARALLEL_MIN_BYTES = 8 * 1024 * 1024
const MAX_CONNECTIONS = 4
const MIRRORS = ["https://gh-proxy.com/", "https://ghfast.top/"]
const FILE_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "codeload.github.com",
  "release-assets.githubusercontent.com", "objects.githubusercontent.com"])

class IntegrityError extends Error {}
class RangeErrorResponse extends Error {}

function canonicalUrl(value) {
  let parsed = new URL(value)
  if (MIRRORS.includes(`${parsed.origin}/`) && parsed.pathname.startsWith("/https://")) {
    parsed = new URL(value.slice(parsed.origin.length + 1))
  }
  if (parsed.username || parsed.password) throw new Error("公开下载地址不能包含凭据")
  return parsed.href
}

function isGitHubFile(value) {
  const parsed = new URL(canonicalUrl(value))
  return parsed.protocol === "https:" && FILE_HOSTS.has(parsed.hostname)
}

function candidates(value, kind = "file") {
  const url = canonicalUrl(value)
  const parsed = new URL(url)
  const eligible = parsed.protocol === "https:" &&
    (kind === "api" ? parsed.hostname === "api.github.com" : FILE_HOSTS.has(parsed.hostname))
  return [{ name: eligible ? "GitHub" : "原始地址", url, direct: true },
    ...(eligible ? (kind === "api" ? MIRRORS.slice(0, 1) : MIRRORS)
      .map((prefix) => ({ name: new URL(prefix).hostname, url: `${prefix}${url}`, direct: false })) : [])]
}

function publicHeaders(headers) {
  const result = new Headers({ "User-Agent": "Nacho-Downloader", "Accept-Encoding": "identity" })
  for (const [name, value] of new Headers(headers)) {
    if (["authorization", "cookie", "proxy-authorization"].includes(name.toLowerCase())) {
      throw new Error("公开 GitHub 下载不能携带认证凭据")
    }
    if (["accept", "user-agent"].includes(name.toLowerCase())) result.set(name, value)
  }
  return result
}

function combineSignals(...values) {
  const signals = values.filter(Boolean)
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

function log(options, message) {
  options.onLog?.(`[Nacho] ${message}`)
}

async function discard(response) {
  await response?.body?.cancel().catch(() => {})
}

function contentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value || "")
  if (!match) return null
  const [start, end, total] = match.slice(1).map(Number)
  return [start, end, total].every(Number.isSafeInteger) && start <= end && end < total
    ? { start, end, total } : null
}

async function readJson(response, max = 1024 * 1024) {
  if (!response.ok || !response.body) throw new Error(`公开 API HTTP ${response.status}`)
  let bytes = 0
  const chunks = []
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > max) throw new Error("公开 API 响应过大")
      chunks.push(Buffer.from(chunk))
    }
  } catch (error) {
    await discard(response)
    throw error
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

async function probeFile(source, options, signal) {
  const headers = publicHeaders(options.headers)
  // 一个字节的真实 GET 同时验证端点、重定向与 Range，避免 HEAD 假阳性。
  headers.set("Range", "bytes=0-0")
  const response = await (options.fetcher || fetch)(source.url, {
    headers, signal, redirect: "follow", credentials: "omit", cache: "no-store",
  })
  try {
    if (![200, 206].includes(response.status) || !response.body ||
        /text\/html/i.test(response.headers.get("content-type") || "")) {
      throw new Error(`下载端点 HTTP ${response.status} 或返回非文件内容`)
    }
    const range = contentRange(response.headers.get("content-range"))
    if (response.status === 206 && (!range || range.start !== 0 || range.end !== 0)) {
      throw new Error("下载端点返回错误 Content-Range")
    }
    const declared = Number(response.headers.get("content-length"))
    if (response.status === 206 && response.headers.has("content-length") && declared !== 1) {
      throw new Error("下载端点返回错误分段大小")
    }
    const sizeBytes = range?.total || (Number.isSafeInteger(declared) && declared > 0 ? declared : null)
    if (sizeBytes && sizeBytes > (options.maxBytes || 2 * 1024 ** 3)) {
      throw new Error("下载端点文件超过允许大小")
    }
    if (options.sizeBytes && sizeBytes && sizeBytes !== options.sizeBytes) {
      throw new Error("下载端点总大小与发布记录不符")
    }
    const encoding = response.headers.get("content-encoding")
    const reader = response.body.getReader()
    try {
      const first = await reader.read()
      if (first.done || !first.value?.length) throw new Error("下载端点没有返回文件数据")
      if (response.status === 206 && first.value.length !== 1) {
        throw new Error("下载端点未正确响应单字节 Range")
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    return { ...source, sizeBytes, ranges: response.status === 206 && (!encoding || encoding === "identity") }
  } finally { await discard(response) }
}

async function probeApi(source, options, signal) {
  const response = await (options.fetcher || fetch)(source.url, {
    headers: publicHeaders(options.headers), signal, credentials: "omit", redirect: "follow", cache: "no-store",
  })
  const data = await readJson(response)
  if (options.validate && options.validate(data) === false) throw new Error("公开 API 数据结构无效")
  return { ...source, data }
}

async function selectSource(sources, probe, options = {}) {
  if (!sources.length) throw new Error("没有剩余下载源")
  options.signal?.throwIfAborted()
  log(options, `检测 GitHub 连接（最多 ${Math.min(options.probeTimeoutMs || PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS)} 毫秒）`)
  const controller = new AbortController()
  const signal = combineSignals(controller.signal, options.signal)
  const states = sources.map((source) => ({ source, done: false, result: null, error: null }))
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (result, error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", aborted)
      controller.abort(new Error("连接检测结束"))
      if (error) reject(error)
      else {
        log(options, `使用 ${result.name}${result.direct ? " 直连" : " 镜像"}`)
        resolve(result)
      }
    }
    const choose = () => {
      if (finished) return
      const first = states.find((state) => !state.done || state.result)
      if (first?.result) finish(first.result)
      else if (!first) finish(null, new Error(`GitHub 与镜像均不可用：${states
        .map((state) => `${state.source.name} ${state.error?.message || "连接失败"}`).join("；")}`))
    }
    const aborted = () => finish(null, options.signal.reason || new Error("下载已取消"))
    const timer = setTimeout(() => {
      for (const state of states) if (!state.done) {
        state.done = true
        state.error = new Error("连接检测超时")
        log(options, `${state.source.name} 连接检测超时`)
      }
      choose()
    }, Math.min(options.probeTimeoutMs || PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS))
    options.signal?.addEventListener("abort", aborted, { once: true })
    for (const state of states) {
      Promise.resolve().then(() => probe(state.source, options, signal)).then((result) => {
        if (finished || state.done) return
        state.result = result
        state.done = true
        choose()
      }, (error) => {
        if (finished || state.done) return
        state.error = error
        state.done = true
        log(options, `${state.source.name} 连接不可用：${error.message}`)
        choose()
      })
    }
  })
}

async function fetchGitHubJson(url, options = {}) {
  publicHeaders(options.headers)
  const remaining = candidates(url, "api")
  return (await selectSource(remaining, probeApi, options)).data
}

function terminateProcess(child) {
  if (!child.pid) return
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore",
    })
    killer.once("error", () => child.kill())
  } else {
    try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
  }
}

function runProcess(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    const child = spawn(file, args, {
      cwd: options.cwd, env: options.env || process.env, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "", stderr = "", finished = false
    const finish = (error, code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", aborted)
      if (error) {
        terminateProcess(child)
        child.stdout.destroy()
        child.stderr.destroy()
        reject(error)
      } else resolve({ code: code ?? -1, stdout, stderr })
    }
    const aborted = () => finish(options.signal.reason || new Error("命令已取消"))
    const timer = setTimeout(() => finish(new Error("命令执行超时")), options.timeoutMs || 15 * 60_000)
    options.signal?.addEventListener("abort", aborted, { once: true })
    const append = (kind, chunk) => {
      const text = chunk.toString("utf8")
      if (kind === "stdout") stdout = (stdout + text).slice(-65536)
      else stderr = (stderr + text).slice(-65536)
      options.onOutput?.(text)
    }
    child.stdout.on("data", (chunk) => append("stdout", chunk))
    child.stderr.on("data", (chunk) => append("stderr", chunk))
    child.once("error", (error) => finish(error))
    child.once("close", (code) => finish(null, code))
  })
}

function gitOptions() {
  return ["-c", "credential.helper=", "-c", "core.askPass=", "-c", "http.sslVerify=true",
    ...(process.platform === "win32" ? ["-c", "http.sslBackend=schannel"] : [])]
}

function gitEnvironment() {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
}

async function probeGit(source, options, signal) {
  const result = await (options.processRunner || runProcess)("git", [
    ...gitOptions(), "ls-remote", "--heads", source.url, `refs/heads/${options.branch || "main"}`,
  ], { signal, env: gitEnvironment(), timeoutMs: PROBE_TIMEOUT_MS, cwd: options.cwd })
  const match = /^([a-f0-9]{40})\s+refs\/heads\/(.+)$/m.exec(result.stdout)
  if (result.code !== 0 || !match || match[2] !== (options.branch || "main")) {
    throw new Error("Git 仓库分支查询失败")
  }
  return { ...source, commit: match[1] }
}

async function cloneGitHub(repository, destination, options = {}) {
  if (!/^[A-Za-z0-9._/-]+$/.test(options.branch || "main")) throw new Error("Git 分支无效")
  const absolute = path.resolve(destination)
  if (absolute === path.parse(absolute).root || absolute === process.cwd()) throw new Error("克隆目录无效")
  if (await fs.lstat(absolute).then(() => true, () => false)) throw new Error("克隆暂存目录已存在")
  const signal = combineSignals(options.signal, AbortSignal.timeout(options.timeoutMs || 15 * 60_000))
  const remaining = candidates(repository, "git")
  const processRunner = options.processRunner || runProcess
  let lastError
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  while (remaining.length) {
    const source = await selectSource(remaining, probeGit, { ...options, signal })
    remaining.splice(remaining.findIndex((item) => item.url === source.url), 1)
    try {
      const cloned = await processRunner("git", [...gitOptions(), "clone", "--depth", "1", "--branch",
        options.branch || "main", "--progress", source.url, absolute],
      { cwd: options.cwd, env: gitEnvironment(), signal, onOutput: options.onLog })
      if (cloned.code !== 0) throw new Error("Git 克隆失败")
      const restored = await processRunner("git", ["-C", absolute, "remote", "set-url", "origin", canonicalUrl(repository)],
        { signal, env: gitEnvironment(), timeoutMs: PROBE_TIMEOUT_MS })
      if (restored.code !== 0) throw new Error("无法恢复 GitHub 官方远程地址")
      return source
    } catch (error) {
      lastError = error
      await fs.rm(absolute, { recursive: true, force: true })
      signal.throwIfAborted()
      log(options, `${source.name} 克隆失败，尝试剩余源`)
    }
  }
  throw lastError || new Error("GitHub 源码获取失败")
}

async function hashFile(file, algorithm = "sha256") {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function writeBody(response, handle, start, expected, signal, options, progress) {
  let received = 0
  if (!response.body) throw new Error("下载响应为空")
  try {
    for await (const value of response.body) {
      signal.throwIfAborted()
      const chunk = Buffer.from(value)
      received += chunk.length
      if ((expected != null && received > expected) || received > (options.maxBytes || 2 * 1024 ** 3)) {
        throw new IntegrityError("下载超过允许大小")
      }
      let offset = 0
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset,
          start + received - chunk.length + offset)
        if (!bytesWritten) throw new Error("写入下载文件失败")
        offset += bytesWritten
      }
      progress.bytes += chunk.length
      options.onProgress?.(progress.bytes, progress.total)
    }
  } catch (error) {
    await discard(response)
    throw error
  }
  if (expected != null && received !== expected) throw new Error("下载连接提前结束，文件不完整")
}

async function singleDownload(source, file, options, signal) {
  const response = await (options.fetcher || fetch)(source.url, {
    headers: publicHeaders(options.headers), signal, credentials: "omit", redirect: "follow",
  })
  if (!response.ok || response.status === 206) {
    await discard(response)
    throw new Error(`文件下载 HTTP ${response.status}`)
  }
  const size = options.sizeBytes || source.sizeBytes || null
  const declared = Number(response.headers.get("content-length"))
  if (size && response.headers.has("content-length") && declared !== size) {
    await discard(response)
    throw new IntegrityError("下载响应大小与预期不符")
  }
  const handle = await fs.open(file, "wx", 0o600)
  try { await writeBody(response, handle, 0, size, signal, options, { bytes: 0, total: size }) }
  finally { await handle.close() }
}

async function parallelDownload(source, file, options, signal) {
  const total = options.sizeBytes || source.sizeBytes
  const handle = await fs.open(file, "wx", 0o600)
  const controller = new AbortController()
  const combined = combineSignals(signal, controller.signal)
  const progress = { bytes: 0, total }
  const jobs = []
  try {
    await handle.truncate(total)
    for (let index = 0; index < MAX_CONNECTIONS; index++) {
      const start = Math.floor(total * index / MAX_CONNECTIONS)
      const end = Math.floor(total * (index + 1) / MAX_CONNECTIONS) - 1
      jobs.push((async () => {
        const headers = publicHeaders(options.headers)
        headers.set("Range", `bytes=${start}-${end}`)
        const response = await (options.fetcher || fetch)(source.url, {
          headers, signal: combined, credentials: "omit", redirect: "follow",
        })
        const range = contentRange(response.headers.get("content-range"))
        if (response.status !== 206 || !range || range.start !== start || range.end !== end ||
            range.total !== total || ![null, "identity"].includes(response.headers.get("content-encoding"))) {
          await discard(response)
          throw new RangeErrorResponse("分段响应无效")
        }
        await writeBody(response, handle, start, end - start + 1, combined, options, progress)
      })().catch((error) => { controller.abort(error); throw error }))
    }
    const outcomes = await Promise.allSettled(jobs)
    // 保留真正的分段错误，避免被其他分段的取消错误遮蔽。
    const invalid = outcomes.find((item) => item.status === "rejected" && item.reason instanceof RangeErrorResponse)
    const failed = invalid || outcomes.find((item) => item.status === "rejected")
    if (failed) throw failed.reason
  } finally { controller.abort(); await handle.close() }
}

async function aria2Available(options = {}) {
  try {
    const result = await (options.processRunner || runProcess)("aria2c", ["--version"], { timeoutMs: 2000 })
    return result.code === 0
  } catch { return false }
}

async function ensureAria2(options = {}) {
  if (await aria2Available(options)) return true
  log(options, "Linux 缺少 aria2，正在自动准备下载工具")
  try {
    if (options.prepareAria2) {
      await options.prepareAria2()
    } else if (process.getuid?.() === 0) {
      // 固定包名和命令，不接受下载 URL 或外部参数作为安装输入。
      const script = "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; " +
        "if command -v apt-get >/dev/null; then export DEBIAN_FRONTEND=noninteractive; " +
        "apt-get update -y && apt-get install -y aria2; " +
        "elif command -v dnf >/dev/null; then dnf install -y aria2; " +
        "elif command -v yum >/dev/null; then yum install -y aria2; else exit 1; fi"
      const result = await (options.processRunner || runProcess)("/bin/sh", ["-c", script], {
        timeoutMs: 180000, signal: options.signal, onOutput: (text) => log(options, text.trim()),
      })
      if (result.code !== 0) throw new Error("aria2 软件包安装失败")
    } else {
      throw new Error("缺少固定 root 依赖准备入口")
    }
    if (await aria2Available(options)) return true
  } catch (error) {
    options.signal?.throwIfAborted()
    log(options, `aria2 准备失败：${error.message}`)
  }
  log(options, "本次文件下载使用单连接")
  return false
}

async function aria2Download(source, file, options, signal) {
  const args = ["--no-conf", "--split=4", "--max-connection-per-server=4", "--min-split-size=2M",
    "--max-concurrent-downloads=1", "--file-allocation=none", "--auto-file-renaming=false",
    "--allow-overwrite=true", "--continue=false", "--check-certificate=true", "--connect-timeout=5",
    "--max-tries=1", "--lowest-speed-limit=0", "--http-accept-gzip=false", "--summary-interval=0",
    "--console-log-level=warn", "--dir", path.dirname(file), "--out", path.basename(file)]
  if (options.sha256) args.push(`--checksum=sha-256=${options.sha256}`)
  args.push(source.url)
  const result = await (options.processRunner || runProcess)("aria2c", args, {
    signal, onOutput: (text) => log(options, text.trim()),
  })
  if ([8, 22].includes(result.code)) throw new RangeErrorResponse("aria2 分段响应不受支持")
  if (result.code !== 0) throw new Error(`aria2 下载失败（退出码 ${result.code}）`)
}

async function downloadFile(url, output, options = {}) {
  publicHeaders(options.headers)
  if (options.sizeBytes != null && (!Number.isSafeInteger(options.sizeBytes) || options.sizeBytes < 1 ||
      options.sizeBytes > (options.maxBytes || 2 * 1024 ** 3))) throw new Error("预期文件大小无效")
  if (options.sha256 != null && !/^[a-f0-9]{64}$/i.test(options.sha256)) throw new Error("SHA-256 无效")
  const github = isGitHubFile(url)
  const remaining = candidates(url)
  const destination = path.resolve(output)
  const temporary = `${destination}.download-${randomUUID()}`
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const totalController = new AbortController()
  let timer
  const signal = combineSignals(options.signal, totalController.signal)
  let lastError
  let aria2Ready
  try {
    while (remaining.length) {
      const source = github
        ? await selectSource(remaining, probeFile, { ...options, signal })
        : { ...remaining[0], sizeBytes: options.sizeBytes || null, ranges: false }
      remaining.splice(remaining.findIndex((item) => item.url === source.url), 1)
      const size = options.sizeBytes || source.sizeBytes
      let parallel = github && source.ranges && size >= PARALLEL_MIN_BYTES
      if (parallel && (options.platform || process.platform) === "linux") {
        if (aria2Ready === undefined) aria2Ready = await ensureAria2({ ...options, signal })
        parallel = aria2Ready
      }
      // 工具准备独立计时，文件下载与后续换源共同使用原有总预算。
      timer ||= setTimeout(() => totalController.abort(new Error("文件下载超过总时间限制")),
        options.timeoutMs || 15 * 60_000)
      try {
        log(options, `从 ${source.name} 下载文件（${parallel ? "最多 4 路分段" : "单连接"}）`)
        if (parallel) {
          try {
            if ((options.platform || process.platform) === "linux") await aria2Download(source, temporary, options, signal)
            else await parallelDownload(source, temporary, options, signal)
          } catch (error) {
            if (!(error instanceof RangeErrorResponse)) throw error
            signal.throwIfAborted()
            await fs.rm(temporary, { force: true })
            await fs.rm(`${temporary}.aria2`, { force: true })
            log(options, "下载端点不支持正确分段，本次改为单连接")
            parallel = false
            await singleDownload(source, temporary, options, signal)
          }
        } else await singleDownload(source, temporary, options, signal)
        const actual = (await fs.stat(temporary)).size
        if ((size && actual !== size) || actual < 1 || actual > (options.maxBytes || 2 * 1024 ** 3)) {
          throw new IntegrityError("下载文件大小不匹配")
        }
        const sha256 = await hashFile(temporary)
        if (options.sha256 && sha256 !== options.sha256.toLowerCase()) throw new IntegrityError("下载文件 SHA-256 不匹配")
        if (options.checksum) {
          const algorithm = options.checksum.algorithm
          if (!["sha256", "sha512", "sha1"].includes(algorithm)) throw new IntegrityError("校验算法无效")
          const expected = options.checksum.encoding === "base64"
            ? Buffer.from(options.checksum.value, "base64").toString("hex") : options.checksum.value.toLowerCase()
          if (await hashFile(temporary, algorithm) !== expected) throw new IntegrityError("构建依赖文件校验失败")
        }
        signal.throwIfAborted()
        await fs.rename(temporary, destination)
        log(options, "文件下载和完整性校验完成")
        return { source: source.name, sizeBytes: actual, sha256, connections: parallel ? MAX_CONNECTIONS : 1 }
      } catch (error) {
        lastError = error
        await fs.rm(temporary, { force: true })
        await fs.rm(`${temporary}.aria2`, { force: true })
        signal.throwIfAborted()
        if (error instanceof IntegrityError) throw error
        log(options, `${source.name} 下载失败，尝试剩余源：${error.message}`)
      }
    }
    throw lastError || new Error("文件下载失败")
  } finally {
    clearTimeout(timer)
    totalController.abort()
    await fs.rm(temporary, { force: true })
    await fs.rm(`${temporary}.aria2`, { force: true })
  }
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'` }

function gitCloneShell(repository, destination, branch = "main") {
  if (!/^\/tmp\/nacho-deploy\.[A-Za-z0-9]+\/nacho-server$/.test(destination) ||
      !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error("远程克隆暂存目录或分支无效")
  const urls = candidates(repository, "git").map((source) => source.url)
  const script = `set -eu
command -v timeout >/dev/null 2>&1 || { echo '[Nacho] 目标系统缺少 timeout，无法限定连接检测时间' >&2; exit 44; }
probe_dir=$(mktemp -d ${shellQuote(`${path.posix.dirname(destination)}/github-probe.XXXXXXXXXX`)})
probe_pids=''
clone_pid=''
stop_probes() {
  for pid in $probe_pids; do /bin/kill -KILL -- "-$pid" 2>/dev/null || true; done
  for pid in $probe_pids; do wait "$pid" 2>/dev/null || true; done
  probe_pids=''
}
cleanup_probes() {
  stop_probes
  if [ -n "$clone_pid" ]; then /bin/kill -KILL -- "-$clone_pid" 2>/dev/null || true; wait "$clone_pid" 2>/dev/null || true; fi
  case "$probe_dir" in ${shellQuote(`${path.posix.dirname(destination)}/github-probe.`)}*) rm -rf -- "$probe_dir";; esac
}
trap cleanup_probes EXIT
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
urls=(${urls.map(shellQuote).join(" ")})
deadline=$((SECONDS+900))
while [ "\${#urls[@]}" -gt 0 ]; do
  echo '[Nacho] 检测目标服务器的 GitHub 连接（最多5秒）'
  index=0
  for url in "\${urls[@]}"; do
    timeout --signal=KILL 5s git -c credential.helper= -c core.askPass= -c http.sslVerify=true ls-remote --heads "$url" ${shellQuote(`refs/heads/${branch}`)} >"$probe_dir/$index.refs" 2>"$probe_dir/$index.err" &
    pid=$!
    probe_pids="$probe_pids $pid"
    printf '%s\\n' "$pid" >"$probe_dir/$index.pid"
    index=$((index+1))
  done
  selected=''
  tick=0
  while [ "$tick" -lt 50 ]; do
    index=0
    for url in "\${urls[@]}"; do
      if grep -Eq ${shellQuote(`^[0-9a-f]{40}[[:space:]]+refs/heads/${branch}$`)} "$probe_dir/$index.refs"; then selected="$url"; break; fi
      pid=$(cat "$probe_dir/$index.pid")
      if kill -0 "$pid" 2>/dev/null; then break; fi
      index=$((index+1))
    done
    [ -z "$selected" ] || break
    tick=$((tick+1))
    sleep 0.1
  done
  # 到截止时间后，按优先级选择已经返回有效分支的候选。
  if [ -z "$selected" ]; then
    index=0
    for url in "\${urls[@]}"; do
      if grep -Eq ${shellQuote(`^[0-9a-f]{40}[[:space:]]+refs/heads/${branch}$`)} "$probe_dir/$index.refs"; then selected="$url"; break; fi
      index=$((index+1))
    done
  fi
  stop_probes
  if [ -z "$selected" ]; then echo '[Nacho] GitHub 与镜像连接检测均失败' >&2; exit 45; fi
  case "$selected" in https://github.com/*) echo '[Nacho] 使用 GitHub 直连';; *) printf '[Nacho] 使用镜像 %s\\n' "$selected";; esac
  remaining=()
  for url in "\${urls[@]}"; do [ "$url" = "$selected" ] || remaining+=("$url"); done
  urls=("\${remaining[@]}")
  budget=$((deadline-SECONDS))
  [ "$budget" -gt 0 ] || { echo '[Nacho] 源码下载超过总时间限制' >&2; exit 46; }
  rm -rf -- ${shellQuote(destination)}
  timeout --signal=KILL "\${budget}s" git -c credential.helper= -c core.askPass= -c http.sslVerify=true clone --depth 1 --branch ${shellQuote(branch)} --progress "$selected" ${shellQuote(destination)} &
  clone_pid=$!
  if wait "$clone_pid"; then
    clone_pid=''
    git -C ${shellQuote(destination)} remote set-url origin ${shellQuote(canonicalUrl(repository))}
    exit 0
  fi
  clone_pid=''
  echo '[Nacho] 当前源克隆失败，清理暂存目录并尝试剩余源'
done
rm -rf -- ${shellQuote(destination)}
exit 46`
  return `bash -c ${shellQuote(script)}`
}

module.exports = {
  PROBE_TIMEOUT_MS, PARALLEL_MIN_BYTES, MAX_CONNECTIONS, MIRRORS,
  IntegrityError, candidates, isGitHubFile, contentRange, selectSource,
  fetchGitHubJson, downloadFile, cloneGitHub, gitCloneShell, hashFile,
  runProcess, aria2Available, ensureAria2,
}
