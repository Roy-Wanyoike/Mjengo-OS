import { NextRequest, NextResponse } from 'next/server'

/**
 * In-memory sliding-window rate limiter.
 *
 * Deliberately local-memory (per the project's no-Redis constraint): one
 * Node process serves the app, so a Map is the honest, dependency-free
 * choice. Buckets self-clean opportunistically — no timers, no leaks.
 *
 * Limits are abuse guards, not quotas: they sit well above any legitimate
 * interactive use (see core/policy.ts).
 */

const MAX_TRACKED_KEYS = 10_000

const buckets = new Map<string, number[]>()

function sweep(windowMs: number) {
  const cutoff = Date.now() - windowMs
  for (const [key, hits] of buckets) {
    const alive = hits.filter((t) => t > cutoff)
    if (alive.length === 0) buckets.delete(key)
    else if (alive.length !== hits.length) buckets.set(key, alive)
  }
}

/**
 * Record one hit for `key` and report whether it is still within budget.
 * @returns true when allowed; false when the window budget is exhausted.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  if (buckets.size > MAX_TRACKED_KEYS) sweep(windowMs)
  const hits = (buckets.get(key) ?? []).filter((t) => t > now - windowMs)
  if (hits.length >= limit) {
    buckets.set(key, hits) // remember the window even when rejecting
    return false
  }
  hits.push(now)
  buckets.set(key, hits)
  return true
}

/** Best-effort client IP (this app sits behind the Caddy edge proxy). */
export function clientIpOf(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for')
  const first = fwd?.split(',')[0]?.trim()
  if (first) return first
  return req.headers.get('x-real-ip') ?? 'local'
}

/** Standard 429 body — the UI surfaces `error` as a toast. */
export function rateLimitedResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Too many requests — wait a moment and try again.' },
    { status: 429 },
  )
}

/** Convenience: check + response in one call for raw (non-guarded) routes. */
export function ipRateLimited(req: NextRequest, tag: string, limit: number, windowMs: number): NextResponse | null {
  return checkRateLimit(`${tag}:${clientIpOf(req)}`, limit, windowMs) ? null : rateLimitedResponse()
}
