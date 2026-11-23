import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * 测试工作区：把数据库、制品与日志归档目录全部放在系统临时目录下，并在 after() 里整体删除。
 *
 * 背景（DEF-03）：测试曾把 DATABASE_PATH 指向仓库根（process.cwd()/tmp-*.db），
 * 而 `defaultLogArchiveDirectory()` 取 `path.dirname(config.databasePath)`，
 * 于是 `npm test` 会在仓库根生成未跟踪的 `log-archives/` 与 zip 归档。
 * 这里让每个测试文件使用独立的临时根目录，测试结束后清理，
 * 从根上保证 `npm test` 不再污染工作树（`.gitignore` 只是兜底）。
 */
export type TestWorkspace = {
  /** 该测试独占的临时根目录（位于 os.tmpdir() 下）。 */
  root: string
  /** SQLite 数据库路径。 */
  databasePath: string
  /** 制品目录路径。 */
  artifactsPath: string
  /** 日志归档目录；默认与数据库同级，因此落在临时根目录内。 */
  logArchiveDirectory: string
  /** 写入 DATABASE_PATH / ARTIFACTS_PATH，需在导入 ../config 之前调用。 */
  applyEnv(extra?: Record<string, string | undefined>): void
  /** 递归删除临时根目录；在 after() 中调用。 */
  cleanup(): void
}

export function createTestWorkspace(prefix: string): TestWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  const databasePath = path.join(root, "test.db")
  const artifactsPath = path.join(root, "artifacts")
  return {
    root,
    databasePath,
    artifactsPath,
    logArchiveDirectory: path.join(root, "log-archives"),
    applyEnv(extra: Record<string, string | undefined> = {}) {
      process.env.DATABASE_PATH = databasePath
      process.env.ARTIFACTS_PATH = artifactsPath
      for (const [key, value] of Object.entries(extra)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}
