// Source-IP allowlist matching for the Daraja webhook (issue #35) — a small
// PURE module: no env reads, no db, no logging. Callers (the webhook route)
// pass the raw DARAJA_ALLOWED_IPS value and the request's resolved IP.
//
// Scope, honestly:
//   · IPv4 CIDR (196.201.214.0/24) and bare IPv4 (treated as /32) are fully
//     supported — parsing and masking with BigInt arithmetic, no deps.
//   · IPv6 is EXACT-LITERAL match only (trim + lowercase). IPv6 CIDR is NOT
//     supported: an entry like 2001:db8::/32 is rejected as invalid (warned
//     by the caller and ignored), not silently mis-matched. IPv4-mapped
//     IPv6 (::ffff:196.201.214.5) is likewise only matched as a literal.
//
// Invalid-entry policy (documented contract with the route): every invalid
// entry is reported back to the caller, which warns once per request and
// IGNORES that entry — the remaining valid entries still apply. A value that
// is set but contains ZERO valid entries therefore allowlists NOTHING: the
// route denies every request (fail closed — an operator who asked for IP
// filtering never silently gets "allow all" because of a typo). A blank/
// whitespace-only value means "unset" and is the caller's signal to skip the
// gate entirely (the documented secret-path + reconcile posture).
//
// Which IP is matched is the caller's concern (x-forwarded-for semantics per
// TRUST_PROXY — see src/backend/lib/rate-limit.ts clientIpFromHeaders): this
// module only answers "is THIS string inside the allowlist".

/** A parsed allowlist entry — IPv4 CIDR (bare IPs are /32) or IPv6 literal. */
export type IpAllowlistEntry =
  | { kind: 'ipv4-cidr'; raw: string; net: bigint; mask: bigint }
  | { kind: 'ipv6-exact'; raw: string; literal: string }

const IPV4_PART = /^\d{1,3}$/
const IPV4_PREFIX = /^\d{1,3}(\.\d{1,3}){3}$/
/** 2^32-1 as a BigInt — literal BigInt syntax is avoided (tsconfig target is
 *  ES2017; BigInt() calls type-check everywhere and run on Node 20+). */
const IPV4_SPACE = BigInt('0xffffffff')

/** Strict dotted-quad parse → BigInt (e.g. '196.201.214.9' → 0xC4C9D609n). */
export function parseIpv4(ip: string): bigint | null {
  const v = String(ip ?? '').trim()
  if (!IPV4_PREFIX.test(v)) return null
  const parts = v.split('.')
  let value = BigInt(0)
  for (const part of parts) {
    if (!IPV4_PART.test(part)) return null
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    value = (value << BigInt(8)) | BigInt(n)
  }
  return value
}

/** IPv4 netmask for a prefix length (0–32); null outside that range. */
export function ipv4Mask(prefixLength: number): bigint | null {
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) return null
  if (prefixLength === 0) return BigInt(0)
  return (IPV4_SPACE << BigInt(32 - prefixLength)) & IPV4_SPACE
}

/**
 * Parse one allowlist entry (already trimmed). Accepted shapes:
 *   · a.b.c.d/len           — IPv4 CIDR
 *   · a.b.c.d               — bare IPv4 (exact, i.e. /32)
 *   · hex:colons literal    — IPv6 EXACT match only (no CIDR)
 * Returns null for anything else (caller warns + ignores).
 */
export function parseIpAllowlistEntry(raw: string): IpAllowlistEntry | null {
  const entry = String(raw ?? '').trim()
  if (!entry) return null
  const slash = entry.indexOf('/')
  if (slash >= 0) {
    // Only IPv4 CIDR is supported; an IPv6 CIDR (contains ':') is rejected
    // honestly instead of being mis-parsed.
    const addr = entry.slice(0, slash)
    const lenPart = entry.slice(slash + 1)
    const net = parseIpv4(addr)
    if (net === null || !/^\d{1,2}$/.test(lenPart)) return null
    const mask = ipv4Mask(Number(lenPart))
    if (mask === null) return null
    return { kind: 'ipv4-cidr', raw: entry, net: net & mask, mask }
  }
  if (entry.includes(':')) {
    // IPv6 literal: hex groups and colons only, at least two colons (a real
    // IPv6 literal is never 'a:b'). Compared EXACTLY after trim+lowercase.
    if (!/^[0-9a-fA-F:]+$/.test(entry)) return null
    const colons = (entry.match(/:/g) ?? []).length
    if (colons < 2) return null
    return { kind: 'ipv6-exact', raw: entry, literal: entry.toLowerCase() }
  }
  const net = parseIpv4(entry)
  if (net === null) return null
  return { kind: 'ipv4-cidr', raw: entry, net, mask: IPV4_SPACE }
}

/**
 * Parse the raw DARAJA_ALLOWED_IPS value (comma-separated). Blank/whitespace
 * → zero entries AND zero invalids (the caller treats that as "unset").
 * Every entry that fails to parse is returned in `invalid` so the caller can
 * warn honestly — invalid entries are ignored, valid ones still apply.
 */
export function parseIpAllowlist(raw: string | undefined | null): { entries: IpAllowlistEntry[]; invalid: string[] } {
  const value = String(raw ?? '')
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean)
  const entries: IpAllowlistEntry[] = []
  const invalid: string[] = []
  for (const part of parts) {
    const entry = parseIpAllowlistEntry(part)
    if (entry) entries.push(entry)
    else invalid.push(part)
  }
  return { entries, invalid }
}

/**
 * Is this resolved request IP inside the allowlist? An empty (but active)
 * allowlist never matches — fail closed is the caller's contract. IPv6
 * request values are compared exactly (trim + lowercase); IPv4 values are
 * matched against every IPv4 CIDR entry.
 */
export function ipAllowed(ip: string | null | undefined, entries: readonly IpAllowlistEntry[]): boolean {
  const value = String(ip ?? '').trim()
  if (!value) return false
  const v4 = parseIpv4(value)
  const v6 = value.toLowerCase()
  for (const entry of entries) {
    if (entry.kind === 'ipv4-cidr') {
      if (v4 !== null && (v4 & entry.mask) === (entry.net & entry.mask)) return true
    } else if (v6 === entry.literal) {
      return true
    }
  }
  return false
}
