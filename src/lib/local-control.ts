import { createHash, timingSafeEqual } from "node:crypto"

function tokenDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest()
}

export function isLoopbackAddress(address: string | undefined) {
  if (!address) return false
  const normalized = address.toLowerCase().split("%", 1)[0]
  return normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.") || normalized === "::ffff:127.0.0.1"
}

export function authorizeLocalControl(input: {
  configuredToken: string
  providedToken: string | undefined
  remoteAddress: string | undefined
}) {
  if (!input.configuredToken || !input.providedToken || !isLoopbackAddress(input.remoteAddress)) return false
  return timingSafeEqual(tokenDigest(input.configuredToken), tokenDigest(input.providedToken))
}
