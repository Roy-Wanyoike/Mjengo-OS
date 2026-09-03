import { NextRequest, NextResponse } from 'next/server'
// v4's types keep getToken in 'next-auth/jwt' (not the 'next-auth/next' barrel)
import { getToken } from 'next-auth/jwt'
import { db } from '@/backend/lib/db'
import { getSessionFromReq, unauthorized, type GuardSession } from '@/backend/lib/guard'

/**
 * In-process security primitives: rate limiting, login lockout and the shared
 * /api/ai/* route policy (W1-SEC, spec Doc A §52 security hardening).
 *
 * HONEST LIMITATION — SINGLE INSTANCE ONLY. All state lives in module-scope
 * Maps in THIS Node process (ARCHITECTURE.md: the current deployment is one
 * Next.js server). If the app is ever load-balanced or run serverless/edge,
 * every instance keeps its OWN counters — a user would effectively get
 * `limit × instances` requests, and a login lockout would only lock the
 * instance that happened to serve the failures. Multi-instance deployment
 * needs a shared store — the RateLimitStore interface below is the seam:
 * swap `rateLimitStore` for a Redis-backed implementation (INCR+TTL for fixed
 * windows, or a Lua token-bucket script for this exact refill semantics) and
 * the lockout Maps would follow the same pattern. No Redis dependency is
 * added in this wave (comments only — see MemoryRateLimitStore).
 */

// ---------------------------------------------------------------- primitives

/**
 * TRUST_PROXY (W-AUDIT finding #1): x-forwarded-for is a comma-separated
 * chain the CLIENT can seed with arbitrary values ("spoof, real" after one
 * appending proxy). Which entry to believe therefore depends on deployment:
 *   · UNSET (default, local dev / direct exposure): take the FIRST value —
 *     the historical behavior. With no trusted proxy in front the header is
 *     client-controlled either way, and loopback dev traffic has none.
 *   · SET (any non-empty value except 0/false): we sit behind exactly ONE
 *     appending reverse proxy (Caddy in the compose self-host). The LAST
 *     value is the entry OUR proxy appended — its view of the client — so
 *     spoofed values left of it cannot mint rate-limit buckets or fresh
 *     (email, ip) lockout identities. Set it only in that one-proxy topology;
 *     with a chain of proxies the last value is a proxy, not the client.
 */
export function clientIpFromHeaders(
  headers: Headers | Record<string, string> | undefined | null,
): string {
  if (!headers) return ''
  let xf: string | null | undefined
  if (typeof (headers as Headers).get === 'function') {
    xf = (headers as Headers).get('x-forwarded-for')
  } else {
    const rec = headers as Record<string, string | undefined>
    xf = rec['x-forwarded-for'] ?? rec['X-Forwarded-For']
  }
  const values = (xf ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  if (values.length === 0) return ''
  return isTrustProxyEnabled() ? values[values.length - 1] : values[0]
}

/** True when TRUST_PROXY is explicitly enabled (non-empty, not 0/false). */
function isTrustProxyEnabled(): boolean {
  const v = process.env.TRUST_PROXY
  if (!v || !v.trim()) return false
  const lower = v.trim().toLowerCase()
  return lower !== '0' && lower !== 'false'
}

/**
 * Rate-limit principal: session email when a valid JWT cookie is present,
 * else the x-forwarded-for IP (per TRUST_PROXY), else 'anon' (no cookie, no
 * forwarding header — e.g. direct loopback traffic). Async because principal
 * #1 requires decoding (and HMAC-verifying) the session JWT via getToken.
 */
export async function principalFor(req: NextRequest): Promise<string> {
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (token?.email) return `user:${String(token.email).toLowerCase()}`
  } catch {
    // fall through to IP — an unsigned/garbage cookie is not a principal
  }
  const ip = clientIpFromHeaders(req.headers)
  return ip ? `ip:${ip}` : 'anon'
}

// ---------------------------------------------------------------- store seam

/**
 * Pluggable backing store for the token buckets. `hit` consumes one token
 * (returning the wait in seconds when the bucket is empty); `check` reports
 * the same answer WITHOUT consuming (for headers/probes); `sweep` is
 * best-effort memory hygiene (a Redis store would use TTLs and no-op).
 *
 * REDIS-READY SEAM (documented, deliberately not implemented — no new deps
 * in this wave): implement with `INCR key` + `EXPIRE` for fixed windows, or
 * a Lua script holding {tokens, lastRefill} per key for this exact
 * continuous-refill semantics; assign the instance to `rateLimitStore` below
 * and every limiter call site follows. Keep the keys namespaced per bucket
 * and set TTLs from windowMs so foreign entries cannot accumulate.
 */
export interface RateLimitStore {
  /** Consume one token; null = allowed, else seconds until a token refills. */
  hit(key: string, limit: number, windowMs: number, now: number): number | null
  /** Report whether a token is available without consuming one. */
  check(key: string, limit: number, windowMs: number, now: number): number | null
  /** Best-effort removal of fully-refilled entries (no-op for TTL stores). */
  sweep(now: number): void
}

type BucketState = { tokens: number; lastRefill: number; limit: number; refillPerMs: number }

/** Current in-process store (single-instance honesty note in the header). */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState>()

  private refill(key: string, limit: number, windowMs: number, now: number): BucketState {
    const refillPerMs = limit / Math.max(1, windowMs)
    let state = this.buckets.get(key)
    if (!state || state.limit !== limit || state.refillPerMs !== refillPerMs) {
      state = { tokens: limit, lastRefill: now, limit, refillPerMs }
      this.buckets.set(key, state)
    }
    return state
  }

  hit(key: string, limit: number, windowMs: number, now: number): number | null {
    const state = this.refill(key, limit, windowMs, now)
    const tokens = Math.min(state.limit, state.tokens + (now - state.lastRefill) * state.refillPerMs)
    state.lastRefill = now
    if (tokens >= 1) {
      state.tokens = tokens - 1
      return null
    }
    state.tokens = tokens // keep the fractional accrual (honest next-token math)
    return Math.max(1, Math.ceil((1 - tokens) / state.refillPerMs / 1000))
  }

  check(key: string, limit: number, windowMs: number, now: number): number | null {
    const state = this.buckets.get(key)
    if (!state) return null // a bucket nobody hit is full
    const tokens = Math.min(state.limit, state.tokens + (now - state.lastRefill) * state.refillPerMs)
    return tokens >= 1 ? null : Math.max(1, Math.ceil((1 - tokens) / state.refillPerMs / 1000))
  }

  sweep(now: number): void {
    for (const [key, s] of this.buckets) {
      // Fully refilled ⇒ nobody consumed anything for ≥ windowMs ⇒ dead entry.
      if (s.tokens + (now - s.lastRefill) * s.refillPerMs >= s.limit) this.buckets.delete(key)
    }
  }
}

/** Swap this for a shared-store implementation when going multi-instance. */
export const rateLimitStore: RateLimitStore = new MemoryRateLimitStore()

const SWEEP_INTERVAL_MS = 5 * 60 * 1000
let opsSinceSweep = 0
let lastSweepAt = Date.now()

function sweepIfDue(now: number): void {
  // Lazy path: every 256th op, or whenever the periodic tick is overdue.
  opsSinceSweep += 1
  if (opsSinceSweep % 256 !== 0 && now - lastSweepAt < SWEEP_INTERVAL_MS) return
  opsSinceSweep = 0
  lastSweepAt = now
  rateLimitStore.sweep(now)
  sweepLoginTrackers(now)
}

// Periodic cleanup of expired windows — fires every 5 minutes in this single
// Node process; unref'd so it never keeps the process alive on its own.
if (typeof setInterval === 'function') {
  const timer = setInterval(() => sweepIfDue(Date.now()), SWEEP_INTERVAL_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

/**
 * Enforce a per-principal token bucket. Returns a 429 JSON response
 * `{ error: 'Too many requests', retryAfterSec }` with a `Retry-After`
 * header (seconds until one token refills) when the bucket is empty, and
 * `null` when the request is allowed — callers just `if (res) return res`.
 */
export async function enforceRateLimit(
  req: NextRequest,
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<NextResponse | null> {
  const safeLimit = Math.max(1, Math.floor(limit))
  const now = Date.now()
  sweepIfDue(now)

  const key = `${bucket}:${await principalFor(req)}`
  const retryAfterSec = rateLimitStore.hit(key, safeLimit, windowMs, now)
  if (retryAfterSec === null) return null
  return NextResponse.json(
    { error: 'Too many requests', retryAfterSec },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  )
}

// ---------------------------------------------------------------- login lockout

/** 5 failed logins within 15 min → 15-min lockout. */
export const LOGIN_FAILURE_LIMIT = 5
export const LOGIN_WINDOW_MS = 15 * 60 * 1000
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000

type LoginTracker = { failures: number; lastFailureAt: number; lockedUntil: number }

/**
 * Lockout trackers (W-AUDIT #1 fix): the failure counter is keyed PRIMARILY
 * by EMAIL — rotating the (spoofable or distributed) source IP no longer
 * resets the count, so 5 bad passwords for one account lock that account.
 * A SECONDARY (email|ip) tracker is kept so a distributed attack still gets
 * per-pair throttling and the historical same-IP behavior is unchanged.
 * Same in-process store as the rate buckets (single-instance — see header).
 */
const loginTrackers = new Map<string, LoginTracker>() // key: email
const loginIpTrackers = new Map<string, LoginTracker>() // key: email|ip

const emailLockKey = (email: string): string => email.trim().toLowerCase()
const pairLockKey = (email: string, ip: string): string =>
  `${email.trim().toLowerCase()}|${ip || 'unknown'}`

function sweepLoginTrackers(now: number): void {
  for (const map of [loginTrackers, loginIpTrackers]) {
    for (const [key, t] of map) {
      const lockServed = !t.lockedUntil || t.lockedUntil <= now
      const windowCold = now - t.lastFailureAt > LOGIN_WINDOW_MS
      if (lockServed && windowCold) map.delete(key)
    }
  }
}

/** Is this login attempt currently locked out? `msLeft` > 0 while locked. */
export function checkLoginLockout(email: string, ip: string): { locked: boolean; msLeft: number } {
  const now = Date.now()
  let msLeft = 0
  const probes: Array<[Map<string, LoginTracker>, string]> = [
    [loginTrackers, emailLockKey(email)],
    [loginIpTrackers, pairLockKey(email, ip)],
  ]
  for (const [map, key] of probes) {
    const t = map.get(key)
    if (!t) continue
    if (t.lockedUntil > now) {
      msLeft = Math.max(msLeft, t.lockedUntil - now)
    } else if (t.lockedUntil) {
      map.delete(key) // this tracker's lock is served → clean slate for it
    }
  }
  return { locked: msLeft > 0, msLeft }
}

/**
 * Record a failed credentials attempt against BOTH the email-primary tracker
 * and the (email|ip) pair. When either reaches LOGIN_FAILURE_LIMIT inside the
 * window the lockout starts NOW — the return value says so, so authorize()
 * can throw the "Too many attempts" error on the very attempt that tripped it.
 */
export function recordLoginFailure(email: string, ip: string): { locked: boolean; msLeft: number } {
  const now = Date.now()
  const bump = (map: Map<string, LoginTracker>, key: string): { locked: boolean; msLeft: number } => {
    const t = map.get(key) ?? { failures: 0, lastFailureAt: 0, lockedUntil: 0 }
    if (now - t.lastFailureAt > LOGIN_WINDOW_MS) t.failures = 0 // stale window → restart the count
    t.failures += 1
    t.lastFailureAt = now
    const locked = t.failures >= LOGIN_FAILURE_LIMIT && !t.lockedUntil
    if (locked) t.lockedUntil = now + LOGIN_LOCKOUT_MS
    map.set(key, t)
    return { locked, msLeft: Math.max(0, t.lockedUntil - now) }
  }
  const byEmail = bump(loginTrackers, emailLockKey(email))
  const byPair = bump(loginIpTrackers, pairLockKey(email, ip))
  return { locked: byEmail.locked || byPair.locked, msLeft: Math.max(byEmail.msLeft, byPair.msLeft) }
}

/** Successful login resets the counters entirely (both trackers). */
export function clearLoginFailures(email: string, ip: string): void {
  loginTrackers.delete(emailLockKey(email))
  loginIpTrackers.delete(pairLockKey(email, ip))
}

// ---------------------------------------------------------------- /api/ai/* policy

/**
 * Roles allowed on the /api/ai/* routes (Doc A §52): the site team that
 * operates the AI tooling. Client/finance/unknown roles are rejected —
 * clients receive AI output (recaps, digests) through the project-pinned
 * client surfaces, never by picking a projectId on these endpoints.
 */
export const AI_ROUTE_ROLES: readonly string[] = ['contractor', 'admin', 'supervisor']

/** Default AI route limit: 10 requests/min/user per route (Doc A §52). */
export const AI_RATE_LIMIT_PER_MIN = 10

export type AiBodyField = { name: string; type: 'string' | 'boolean' }

export type AiPolicyResult =
  | { ok: true; session: NonNullable<GuardSession>; body: Record<string, unknown>; projectId: string | undefined }
  | { ok: false; response: NextResponse }

/**
 * Shared gate for the five /api/ai/* routes — each route used to accept an
 * arbitrary `projectId` with no session pinning and no role allowlist, which
 * let any logged-in account (e.g. a client) read another project's digest /
 * anomaly data. This gate enforces, in order:
 *   1. session via getSessionFromReq (guard.ts) → 401
 *   2. role allowlist AI_ROUTE_ROLES → 403 (honest message)
 *   3. rate limit (default 10/min per user, per route) → 429
 *   4. body shape: unknown top-level fields and mistyped fields → 400;
 *      a `projectId` that is present but not an existing Project → 404.
 * It lives in this module (not guard.ts) because wave-1 file ownership pins
 * guard.ts to W1-PERM — guard.ts is imported read-only here.
 *
 * `allowEmptyBody` keeps the legacy contract of anomaly-scan / recap, which
 * accept a POST with NO JSON body at all (they then default to the first
 * project). Non-empty-but-unparseable JSON is still rejected with 400 — it
 * silently acting on a DIFFERENT project was the very hole this closes.
 * An empty-string projectId normalizes to undefined (all downstream
 * resolvers treat falsy as "default project", unchanged behavior).
 */
export async function enforceAiRoutePolicy(
  req: NextRequest,
  opts: {
    bucket: string
    fields: readonly AiBodyField[]
    allowEmptyBody?: boolean
    limit?: number
    windowMs?: number
  },
): Promise<AiPolicyResult> {
  // 1. Session — no cookie, no AI.
  const session = await getSessionFromReq(req)
  if (!session) return { ok: false, response: unauthorized() }

  // 2. Role allowlist — site team only.
  if (!AI_ROUTE_ROLES.includes(session.user.role)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            `AI tools are limited to site-team roles (contractor, supervisor, admin) — ` +
            `signed in as "${session.user.role}". Client-facing AI output (recaps, digests) ` +
            `is served through the project-pinned client APIs, not these routes.`,
        },
        { status: 403 },
      ),
    }
  }

  // 3. Rate limit before parsing the body — malformed spam counts too.
  const limited = await enforceRateLimit(
    req,
    opts.bucket,
    opts.limit ?? AI_RATE_LIMIT_PER_MIN,
    opts.windowMs ?? 60_000,
  )
  if (limited) return { ok: false, response: limited }

  // 4. Body shape.
  let body: unknown
  try {
    const raw = await req.text()
    body = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    if (opts.allowEmptyBody && body === null) body = {}
    else return { ok: false, response: NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 }) }
  }
  const obj = body as Record<string, unknown>

  const allowed = new Set(opts.fields.map((f) => f.name))
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: `Unknown field "${key}" — allowed: ${[...allowed].sort().join(', ')}` },
          { status: 400 },
        ),
      }
    }
  }
  for (const field of opts.fields) {
    const v = obj[field.name]
    if (v === undefined) continue
    if (v === null || typeof v !== field.type) {
      return {
        ok: false,
        response: NextResponse.json({ error: `Field "${field.name}" must be a ${field.type}` }, { status: 400 }),
      }
    }
  }

  // 5. projectId must reference a real project when supplied.
  const rawProjectId = obj.projectId
  const projectId = typeof rawProjectId === 'string' && rawProjectId ? rawProjectId : undefined
  if (projectId !== undefined) {
    const exists = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
    if (!exists) {
      return { ok: false, response: NextResponse.json({ error: 'Project not found' }, { status: 404 }) }
    }
  }

  return { ok: true, session, body: obj, projectId }
}
