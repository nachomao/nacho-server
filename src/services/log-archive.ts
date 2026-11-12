import fs from "node:fs"
import path from "node:path"
import { deflateRawSync } from "node:zlib"
import { config } from "../config"
import type { LogEntry } from "../types"

/**
 * 日志归档：把待清理的日志写成单条目 ZIP（JSON Lines），
 * 保存在数据库同级的 log-archives 目录，便于事后审计。
 */

export type LogArchiveResult = {
  filePath: string
  entryCount: number
  sizeBytes: number
}

export type LogArchiveOptions = {
  directory?: string
  now?: number
}

export function defaultLogArchiveDirectory(): string {
  return path.join(path.dirname(config.databasePath), "log-archives")
}

/** 归档一批日志；没有记录时不创建目录与文件。 */
export function archiveLogs(entries: LogEntry[], options: LogArchiveOptions = {}): LogArchiveResult | null {
  if (entries.length === 0) return null
  const now = options.now ?? Date.now()
  const directory = options.directory ?? defaultLogArchiveDirectory()
  fs.mkdirSync(directory, { recursive: true })

  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-")
  const entryName = `logs-${stamp}.jsonl`
  const filePath = uniqueArchivePath(directory, `logs-${stamp}.zip`)
  const content = Buffer.from(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8")
  const zip = buildZip(entryName, content, new Date(now))
  fs.writeFileSync(filePath, zip, { mode: 0o600 })
  return { filePath, entryCount: entries.length, sizeBytes: zip.byteLength }
}

function uniqueArchivePath(directory: string, fileName: string): string {
  const parsed = path.parse(fileName)
  let candidate = path.join(directory, fileName)
  for (let index = 1; fs.existsSync(candidate); index += 1) {
    candidate = path.join(directory, `${parsed.name}-${index}${parsed.ext}`)
  }
  return candidate
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value += 1) {
    let crc = value
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    table[value] = crc >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}

/** 生成包含单个 deflate 条目的最小 ZIP 文件（无第三方依赖）。 */
function buildZip(entryName: string, content: Buffer, modifiedAt: Date): Buffer {
  const name = Buffer.from(entryName, "utf8")
  const compressed = deflateRawSync(content)
  const checksum = crc32(content)
  const stamp = dosDateTime(modifiedAt)

  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(0x0800, 6) // UTF-8 文件名
  localHeader.writeUInt16LE(8, 8) // deflate
  localHeader.writeUInt16LE(stamp.time, 10)
  localHeader.writeUInt16LE(stamp.date, 12)
  localHeader.writeUInt32LE(checksum, 14)
  localHeader.writeUInt32LE(compressed.length, 18)
  localHeader.writeUInt32LE(content.length, 22)
  localHeader.writeUInt16LE(name.length, 26)
  localHeader.writeUInt16LE(0, 28)

  const centralOffset = localHeader.length + name.length + compressed.length
  const centralHeader = Buffer.alloc(46)
  centralHeader.writeUInt32LE(0x02014b50, 0)
  centralHeader.writeUInt16LE(20, 4)
  centralHeader.writeUInt16LE(20, 6)
  centralHeader.writeUInt16LE(0x0800, 8)
  centralHeader.writeUInt16LE(8, 10)
  centralHeader.writeUInt16LE(stamp.time, 12)
  centralHeader.writeUInt16LE(stamp.date, 14)
  centralHeader.writeUInt32LE(checksum, 16)
  centralHeader.writeUInt32LE(compressed.length, 20)
  centralHeader.writeUInt32LE(content.length, 24)
  centralHeader.writeUInt16LE(name.length, 28)
  centralHeader.writeUInt16LE(0, 30)
  centralHeader.writeUInt16LE(0, 32)
  centralHeader.writeUInt16LE(0, 34)
  centralHeader.writeUInt16LE(0, 36)
  centralHeader.writeUInt32LE(0, 38)
  centralHeader.writeUInt32LE(0, 42)

  const endOfCentral = Buffer.alloc(22)
  endOfCentral.writeUInt32LE(0x06054b50, 0)
  endOfCentral.writeUInt16LE(0, 4)
  endOfCentral.writeUInt16LE(0, 6)
  endOfCentral.writeUInt16LE(1, 8)
  endOfCentral.writeUInt16LE(1, 10)
  endOfCentral.writeUInt32LE(centralHeader.length + name.length, 12)
  endOfCentral.writeUInt32LE(centralOffset, 16)
  endOfCentral.writeUInt16LE(0, 20)

  return Buffer.concat([localHeader, name, compressed, centralHeader, name, endOfCentral])
}
