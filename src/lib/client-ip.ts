/**
 * 客户端地址解析（注册限流与设备 IP 记录共用）。
 *
 * 规则：
 * 1. 只有 `TRUST_PROXY` 开启、且直连对端本身是可信代理（默认为回环或私有网段地址）时，
 *    才解析 `X-Forwarded-For`；否则一律使用直连对端地址。
 * 2. 转发链从右侧（最靠近本机、由可信代理刚刚追加的条目）向左读取，
 *    取第一个非代理地址；左侧可能由客户端伪造，靠右的真值优先。
 * 3. 整条链都是回环/私有地址时，退回链尾（可信代理实际看到的对端），
 *    它比代理自身地址更接近真实客户端。
 * 4. IPv6 的方括号、端口、zone 以及 `::ffff:` 映射地址统一归一化后再比较。
 */

/** 单条 X-Forwarded-For 头部最多解析的跳数，避免超长头部拖慢解析。 */
const MAX_FORWARDED_HOPS = 32

/** IPv4 点分十进制（0-255），用于识别 IPv4 / IPv4 映射地址。 */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** 去掉方括号、端口、IPv6 zone，并把 `::ffff:` 映射地址还原成 IPv4。 */
export function normalizeAddress(raw: string | undefined | null): string {
  if (typeof raw !== "string") return ""
  let value = raw.trim().toLowerCase()
  if (!value) return ""
  const bracketEnd = value.startsWith("[") ? value.indexOf("]") : -1
  if (bracketEnd > 0) value = value.slice(1, bracketEnd)
  else if (IPV4_PATTERN.test(value.slice(0, value.lastIndexOf(":"))) && /:\d+$/.test(value)) {
    // 形如 203.0.113.9:4434（部分代理会在转发头里带端口）
    value = value.slice(0, value.lastIndexOf(":"))
  }
  const zoneIndex = value.indexOf("%")
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex)
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length)
    if (mapped.includes(".")) value = mapped
    else {
      // 十六进制写法，例如 ::ffff:7f00:1
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped)
      if (hex) {
        const high = Number.parseInt(hex[1], 16)
        const low = Number.parseInt(hex[2], 16)
        value = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
      }
    }
  }
  return value
}

function isPrivateIpv4(address: string): boolean {
  const matched = IPV4_PATTERN.exec(address)
  if (!matched) return false
  const octets = matched.slice(1).map((part) => Number.parseInt(part, 10))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [first, second] = octets
  if (first === 10 || first === 127) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 169 && second === 254) return true
  // 运营商级 NAT（RFC 6598），同样不是公网可路由地址
  if (first === 100 && second >= 64 && second <= 127) return true
  return false
}

function isPrivateIpv6(address: string): boolean {
  if (address === "::1" || address === "::") return true
  // fc00::/7 唯一本地地址、fe80::/10 链路本地地址
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true
  return false
}

/** 判断一个已归一化地址是否属于回环或私有网段（默认的可信代理判定规则）。 */
export function isLoopbackOrPrivateAddress(address: string | undefined): boolean {
  const normalized = normalizeAddress(address)
  if (!normalized) return false
  return isPrivateIpv4(normalized) || isPrivateIpv6(normalized)
}

/** 解析 X-Forwarded-For：拆逗号、归一化、丢弃空项，最多保留 MAX_FORWARDED_HOPS 跳。 */
export function parseForwardedFor(header: string | undefined | null): string[] {
  if (typeof header !== "string" || !header.trim()) return []
  return header
    .split(",")
    .slice(-MAX_FORWARDED_HOPS)
    .map((entry) => normalizeAddress(entry))
    .filter((entry) => entry.length > 0)
}

export type ClientIpInput = {
  remoteAddress?: string | undefined
  forwardedFor?: string | undefined
  trustProxy: boolean
}

/**
 * 解析请求的客户端地址。
 * `trustProxy` 为 false（默认）或直连对端不是可信代理时，转发头完全不被信任。
 */
export function resolveClientIp(input: ClientIpInput): string {
  const direct = normalizeAddress(input.remoteAddress)
  if (!input.trustProxy) return direct
  if (!isLoopbackOrPrivateAddress(direct)) return direct
  const chain = parseForwardedFor(input.forwardedFor)
  if (chain.length === 0) return direct
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!isLoopbackOrPrivateAddress(chain[index])) return chain[index]
  }
  // 整条链都是回环/私有地址：链尾是可信代理实际看到的对端，比代理自身地址更具体。
  return chain[chain.length - 1]
}
