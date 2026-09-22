type FailureBucket = {
  startedAt: number
  count: number
  lastLoggedAt: number
}

const WINDOW_MS = 60_000
const BLOCK_MS = 60_000
const MAX_FAILURES_PER_IP = 20
const MAX_FAILURES_PER_DEVICE = 5
const LOG_INTERVAL_MS = 15_000
const buckets = new Map<string, FailureBucket>()

function normalize(value: string | undefined): string {
  return value?.trim().slice(0, 200) || "-"
}

function consume(key: string, limit: number, now: number): { allowed: boolean; count: number; retryAfter: number } {
  const previous = buckets.get(key)
  const bucket = !previous || now - previous.startedAt >= WINDOW_MS
    ? { startedAt: now, count: 0, lastLoggedAt: 0 }
    : previous
  bucket.count += 1
  buckets.set(key, bucket)
  if (buckets.size > 10_000) {
    for (const [oldKey, oldBucket] of buckets) {
      if (now - oldBucket.startedAt >= WINDOW_MS) buckets.delete(oldKey)
    }
  }
  if (bucket.count <= limit) return { allowed: true, count: bucket.count, retryAfter: 0 }
  return { allowed: false, count: bucket.count, retryAfter: Math.max(1, Math.ceil((BLOCK_MS - (now - bucket.startedAt)) / 1000)) }
}

export function checkEnrollmentAttempt(ip: string | undefined, deviceId: string | undefined, now = Date.now()) {
  const ipKey = `ip:${normalize(ip)}`
  const deviceKey = `device:${normalize(deviceId)}`
  const ipResult = consume(ipKey, MAX_FAILURES_PER_IP, now)
  const deviceResult = deviceId?.trim()
    ? consume(deviceKey, MAX_FAILURES_PER_DEVICE, now)
    : { allowed: true, count: 0, retryAfter: 0 }
  const blocked = !ipResult.allowed || !deviceResult.allowed
  const lastLoggedAt = Math.max(buckets.get(ipKey)?.lastLoggedAt ?? 0, buckets.get(deviceKey)?.lastLoggedAt ?? 0)
  const shouldLog = ipResult.count === 1 || (deviceResult.count === 1) || now - lastLoggedAt >= LOG_INTERVAL_MS
  if (shouldLog) {
    for (const key of [ipKey, deviceKey]) {
      const bucket = buckets.get(key)
      if (bucket) bucket.lastLoggedAt = now
    }
  }
  return {
    blocked,
    shouldLog,
    retryAfter: Math.max(ipResult.retryAfter, deviceResult.retryAfter),
    count: Math.max(ipResult.count, deviceResult.count),
  }
}

export function resetEnrollmentGuard() {
  buckets.clear()
}
