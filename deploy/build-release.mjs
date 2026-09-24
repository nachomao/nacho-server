import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import os from "node:os"

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith("--")) args.set(process.argv[i].slice(2), process.argv[++i])
}

const output = resolve(args.get("output") || join(serverDir, "artifacts", "releases"))
const privateKey = args.get("private-key") || process.env.NAPL_RELEASE_SIGNING_KEY_FILE
if (!privateKey) throw new Error("请通过 --private-key 或 NAPL_RELEASE_SIGNING_KEY_FILE 指定 Ed25519 私钥")

const packageJson = JSON.parse(await readFile(join(serverDir, "package.json"), "utf8"))
const version = packageJson.version
const work = await mkdtemp(join(os.tmpdir(), "nacho-release-"))
const payload = join(work, "payload")
const releaseRoot = join(work, "release")
await mkdir(payload, { recursive: true })
await mkdir(releaseRoot, { recursive: true })

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("linux-x64 发布包必须在 Linux x64 环境中制作（Windows 可通过 WSL2）。")
}
const npm = "npm"
execFileSync(npm, ["ci", "--no-audit", "--no-fund"], { cwd: serverDir, stdio: "inherit" })
execFileSync(npm, ["run", "build"], { cwd: serverDir, stdio: "inherit" })
for (const item of ["dist", "package.json", "package-lock.json", "deploy", "artifacts/windows"]) {
  await cp(join(serverDir, item), join(payload, item), { recursive: true })
}
execFileSync(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: payload, stdio: "inherit" })
await rm(join(payload, "node_modules", ".bin"), { recursive: true, force: true })

const files = []
async function walk(root, current = root) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const file = join(current, entry.name)
    if (entry.isDirectory()) await walk(root, file)
    else {
      const bytes = await readFile(file)
      files.push({
        path: relative(root, file).replaceAll("\\", "/"),
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
    }
  }
}
await walk(payload)
files.sort((a, b) => a.path.localeCompare(b.path))
const manifest = JSON.stringify({ format: 1, version, platform: "linux-x64", files }, null, 2) + "\n"
await writeFile(join(releaseRoot, "manifest.json"), manifest, { mode: 0o600 })
execFileSync("openssl", ["pkeyutl", "-sign", "-rawin", "-inkey", resolve(privateKey), "-in", join(releaseRoot, "manifest.json"), "-out", join(releaseRoot, "manifest.sig")], { stdio: "inherit" })
await cp(payload, releaseRoot, { recursive: true })
await mkdir(output, { recursive: true })
const archive = join(output, `control-server-${version}-linux-x64.tar.gz`)
execFileSync("tar", ["-czf", archive, "-C", releaseRoot, "manifest.json", "manifest.sig", "dist", "node_modules", "package.json", "package-lock.json", "deploy", "artifacts"], { stdio: "inherit" })
await cp(join(releaseRoot, "manifest.json"), join(output, "manifest.json"))
await cp(join(releaseRoot, "manifest.sig"), join(output, "manifest.sig"))
console.log(JSON.stringify({ version, archive, manifest: join(output, "manifest.json"), signature: join(output, "manifest.sig") }, null, 2))
await rm(work, { recursive: true, force: true })
