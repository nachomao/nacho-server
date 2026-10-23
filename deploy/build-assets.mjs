#!/usr/bin/env node
//
// tsc 只处理 TypeScript 输入，src/lib 下的 .cjs 运行时资源不会被复制到 dist。
// 服务端启动时会 require("../lib/github-download.cjs")，缺少该文件会让进程直接
// 崩溃，云部署的健康检查随之失败。因此构建后必须显式复制这些资源。
import { cp, mkdir, readdir } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const source = path.join(root, "src", "lib")
const dist = path.resolve(root, process.env.NACHO_DIST_DIR || "dist")
const target = path.join(dist, "lib")

await mkdir(target, { recursive: true })
const assets = (await readdir(source)).filter((entry) => entry.endsWith(".cjs"))
if (assets.length === 0) {
  console.error("未找到 src/lib/*.cjs 运行时资源")
  process.exit(1)
}
for (const asset of assets) await cp(path.join(source, asset), path.join(target, asset))
console.log(`已复制 ${assets.length} 个运行时资源到 ${target}`)
