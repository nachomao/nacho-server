export type DownloadLogger = (line: string) => void
export type ProcessResult = { code: number; stdout: string; stderr: string }
export type ProcessOptions = {
  cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; onOutput?: DownloadLogger
}
export type TransportOptions = {
  signal?: AbortSignal
  onLog?: DownloadLogger
  probeTimeoutMs?: number
  fetcher?: typeof fetch
  headers?: HeadersInit
  processRunner?: (file: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>
}
export type DownloadOptions = TransportOptions & {
  sizeBytes?: number
  sha256?: string
  maxBytes?: number
  timeoutMs?: number
  platform?: string
  prepareAria2?: () => Promise<void>
  checksum?: { algorithm: "sha256" | "sha512" | "sha1"; value: string; encoding?: "hex" | "base64" }
  onProgress?: (bytes: number, total: number | null) => void
}
export type DownloadResult = { source: string; sizeBytes: number; sha256: string; connections: number }
export const PROBE_TIMEOUT_MS: number
export const PARALLEL_MIN_BYTES: number
export const MAX_CONNECTIONS: number
export const MIRRORS: readonly string[]
export function isGitHubFile(url: string): boolean
export function downloadFile(url: string, output: string, options?: DownloadOptions): Promise<DownloadResult>
export function fetchGitHubJson<T = unknown>(url: string,
  options?: TransportOptions & { validate?: (data: unknown) => boolean }): Promise<T>
export function cloneGitHub(repository: string, destination: string,
  options?: TransportOptions & { branch?: string; cwd?: string; timeoutMs?: number }): Promise<unknown>
export function gitCloneShell(repository: string, destination: string, branch?: string): string
export function hashFile(file: string, algorithm?: string): Promise<string>
export function aria2Available(options?: TransportOptions): Promise<boolean>
export function ensureAria2(options?: DownloadOptions): Promise<boolean>
export function runProcess(file: string, args: string[], options?: ProcessOptions): Promise<ProcessResult>
