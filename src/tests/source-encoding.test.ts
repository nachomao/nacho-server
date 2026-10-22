import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

// 服务端源码编码校验随服务端迁入本仓库。
// 面板仓库不再持有服务端源码副本，只校验自身源码。
const repoDir = path.resolve(".")
const sourceRoots = ["src", "deploy"]
const textExtensions = new Set([
  ".cjs",
  ".cs",
  ".csproj",
  ".json",
  ".md",
  ".mjs",
  ".pem",
  ".ps1",
  ".sh",
  ".sql",
  ".ts",
  ".yaml",
  ".yml",
])
const generatedDirectories = new Set(["bin", "dist", "node_modules", "obj"])

function collectTextFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory() && !generatedDirectories.has(entry.name)) files.push(...collectTextFiles(fullPath))
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name))) files.push(fullPath)
  }
  return files
}

test("源码文本均为有效 UTF-8 且不含替换字符", () => {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const replacementCharacter = String.fromCodePoint(0xfffd)
  const failures: string[] = []

  for (const file of sourceRoots.flatMap((root) => collectTextFiles(path.join(repoDir, root)))) {
    try {
      const content = decoder.decode(readFileSync(file))
      if (content.includes(replacementCharacter)) failures.push(`${file}: 包含 U+FFFD 替换字符`)
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : "UTF-8 解码失败"}`)
    }
  }

  assert.deepEqual(failures, [])
})
