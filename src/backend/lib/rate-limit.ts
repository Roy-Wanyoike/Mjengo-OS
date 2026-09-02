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
 * needs a shared store (Redis INCR + TTL, or a NATS/durable-object counter)
 * — listed as a migration trigger in ARCHITECTURE.md. Do not copy this
 * module's pattern into a multi-instance service without that.
 */

// ---------------------------------------------------------------- primitives

/** First x-forwarded-for value ('' when absent). Shared by rate keys + lockout keys. */
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
  return (xf ?? '').split(',')[0]?.trim() || ''
}

/**
 * Rate-limit principal: session email when a valid JWT cookie is present,
 * else the first x-forwarded-for IP, else 'anon' (no cookie, no forwarding
 * header — e.g. direct loopback traffic). Async because principal #1
 * requires decoding (and HMAC-verifying) the session JWT via getToken.
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

// ---------------------------------------------------------------- token bucket

/**
 * Token bucket: capacity = `limit` (burst), continuous refill of
 * `limit / windowMs` tokens per ms → sustained rate `limit` per `windowMs`.
 * One Map entry per (bucket:principal) key; expired entries are swept
 * periodically (see below) so the Map cannot grow without bound.
 */
type BucketState = { tokens: number; lastRefill: number; limit: number; refillPerMs: number }

const buckets = new Map<string, BucketState>()

const SWEEP_INTERVAL_MS = 5 * 60 * 1000
let opsSinceSweep = 0
let lastSweepAt = Date.now()

function sweepBuckets(now: number): void {
  for (const [key, s] of buckets) {
    // Fully refilled ⇒ nobody consumed anything for ≥ windowMs ⇒ dead entry.
    if (s.tokens + (now - s.lastRefill) * s.refillPerMs >= s.limit) buckets.delete(key)
  }
}

function sweepIfDue(now: number): void {
  // Lazy path: every 256th op, or whenever the periodic tick is overdue.
  opsSinceSweep += 1
  if (opsSinceSweep % 256 !== 0 && now - lastSweepAt < SWEEP_INTERVAL_MS) return
  opsSinceSweep = 0
  lastSweepAt = now
  sweepBuckets(now)
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
  const refillPerMs = safeLimit / Math.max(1, windowMs)
  const state = buckets.get(key)

  if (!state) {
    // Fresh bucket starts full; this request consumes the first token.
    buckets.set(key, { tokens: safeLimit - 1, lastRefill: now, limit: safeLimit, refillPerMs })
    return null
  }

  const tokens = Math.min(safeLimit, state.tokens + (now - state.lastRefill) * refillPerMs)
  state.lastRefill = now
  if (tokens >= 1) {
    state.tokens = tokens - 1
    return null
  }
  state.tokens = tokens // keep the fractional accrual (honest next-token math)
  const retryAfterSec = Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000))
  return NextResponse.json(
    { error: 'Too many requests', retryAfterSec },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  )
}

// ---------------------------------------------------------------- login lockout

/** 5 failed logins within 15 min (per email+IP) → 15-min lockout. */
export const LOGIN_FAILURE_LIMIT = 5
export const LOGIN_WINDOW_MS = 15 * 60 * 1000
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000

type LoginTracker = { failures: number; lastFailureAt: number; lockedUntil: number }

/** Same in-process store as the rate buckets (single-instance — see header). */
const loginTrackers = new Map<string, LoginTracker>()

function loginKey(email: string, ip: string): string {
  return `${email.trim().toLowerCase()}|${ip || 'unknown'}`
}

function sweepLoginTrackers(now: number): void {
  for (const [key, t] of loginTrackers) {
    const lockServed = !t.lockedUntil || t.lockedUntil <= now
    const windowCold = now - t.lastFailureAt > LOGIN_WINDOW_MS
    if (lockServed && windowCold) loginTrackers.delete(key)
  }
}

/** Is this (email, ip) currently locked out? `msLeft` > 0 while locked. */
export function checkLoginLockout(email: string, ip: string): { locked: boolean; msLeft: number } {
  const t = loginTrackers.get(loginKey(email, ip))
  if (!t) return { locked: false, msLeft: 0 }
  const now = Date.now()
  if (t.lockedUntil > now) return { locked: true, msLeft: t.lockedUntil - now }
  if (t.lockedUntil) loginTrackers.delete(loginKey(email, ip)) // lock served → clean slate
  return { locked: false, msLeft: 0 }
}

/**
 * Record a failed credentials attempt. When this failure reaches
 * LOGIN_FAILURE_LIMIT inside the window the lockout starts NOW — the return
 * value says so, so authorize() can throw the "Too many attempts" error on
 * the very attempt that tripped it.
 */
export function recordLoginFailure(email: string, ip: string): { locked: boolean; msLeft: number } {
  const now = Date.now()
  const key = loginKey(email, ip)
  const t = loginTrackers.get(key) ?? { failures: 0, lastFailureAt: 0, lockedUntil: 0 }
  if (now - t.lastFailureAt > LOGIN_WINDOW_MS) t.failures = 0 // stale window → restart the count
  t.failures += 1
  t.lastFailureAt = now
  const locked = t.failures >= LOGIN_FAILURE_LIMIT && !t.lockedUntil
  if (locked) t.lockedUntil = now + LOGIN_LOCKOUT_MS
  loginTrackers.set(key, t)
  return { locked, msLeft: Math.max(0, t.lockedUntil - now) }
}

/** Successful login resets the counter entirely. */
export function clearLoginFailures(email: string, ip: string): void {
  loginTrackers.delete(loginKey(email, ip))
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
