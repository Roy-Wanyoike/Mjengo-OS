import { NextRequest, NextResponse } from 'next/server'
// v4's types keep getToken in 'next-auth/jwt' (not the 'next-auth/next' barrel)
import { getToken } from 'next-auth/jwt'
import { db } from '@/backend/lib/db'
import { getSessionFromReq, unauthorized, type GuardSession } from '@/backend/lib/guard'
import { createSqliteStores } from '@/backend/lib/rate-limit-sqlite'

/**
 * In-process security primitives: rate limiting, login lockout and the shared
 * /api/ai/* route policy (W1-SEC, spec Doc A §52 security hardening).
 *
 * STORE RESOLUTION (W3-b, issue #33): the token buckets and login lockout
 * used to live in module-scope Maps of THIS Node process only — fine for one
 * Next.js server, silently wrong the moment several processes share the
 * traffic (a user effectively got `limit × instances` requests; a login
 * lockout only locked the instance that happened to serve the failures).
 * The seams are unchanged, but the backing stores are now env-resolved at
 * startup (resolveRateLimitStores below):
 *   · RATE_LIMIT_STORE unset / "memory" (default): in-process stores —
 *     byte-identical historical behavior (MemoryRateLimitStore + the
 *     in-process login trackers). Nothing changes for existing deploys.
 *   · RATE_LIMIT_STORE=sqlite: ONE shared SQLite file per host
 *     (RATE_LIMIT_SQLITE_PATH, default db/ratelimit.db — a separate file,
 *     never the Prisma database) backing both the buckets and the lockout
 *     trackers: writes are durable immediately, reads compute allowance from
 *     the persisted state, so exhaustion/lockout on process A is seen by
 *     process B. Any init failure logs ONE warning and falls back to the
 *     in-memory stores — rate limiting never prevents boot. See
 *     rate-limit-sqlite.ts for the persistence choice and honest tradeoffs.
 * Multi-HOST still needs a Redis-backed implementation of these same seams
 * (INCR+TTL, or a Lua token-bucket script for this exact refill semantics) —
 * deliberately not built; no Redis dependency is added (the sqlite store
 * covers the single-host multi-process case, e.g. the compose stack).
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
 * best-effort hygiene for stores that keep rows (a TTL store would no-op).
 * Synchronous by design — the login lockout below is sync too, and callers
 * (enforceRateLimit, auth.ts lockout calls) rely on that.
 *
 * Implementations: MemoryRateLimitStore (default, this process only) and
 * SqliteRateLimitStore (rate-limit-sqlite.ts, one shared file per host).
 * REDIS-READY SEAM for multi-host (documented, deliberately not implemented
 * — no new external service in this repo): implement with `INCR key` +
 * `EXPIRE` for fixed windows, or a Lua script holding {tokens, lastRefill}
 * per key for this exact continuous-refill semantics; assign the instance
 * via the resolver below and every limiter call site follows. Keep the keys
 * namespaced per bucket and set TTLs from windowMs so foreign entries
 * cannot accumulate.
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

/** In-process token buckets (the default store — see the file header). */
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

/** Raw lockout tracker row — persisted as-is by the store seam below. */
export type LoginTracker = { failures: number; lastFailureAt: number; lockedUntil: number }

/** Which of the lockout key spaces a tracker belongs to ('ussd' = the USSD
 *  PIN lockout below — the same seam and lifecycle, a third key space). */
export type LoginTrackerKind = 'email' | 'pair' | 'ussd'

/**
 * Pluggable backing store for the lockout trackers (W3-b, issue #33): the
 * historical in-process Maps (MemoryLoginTrackerStore) or the shared SQLite
 * file (SqliteLoginTrackerStore in rate-limit-sqlite.ts). The lockout ENGINE
 * (createLoginLockout below) is store-agnostic and shared by both, so the
 * 5-strikes/window/lockout lifecycle cannot drift between implementations.
 * `transact` wraps read-modify-write cycles atomically where the store can
 * (BEGIN IMMEDIATE in SQLite; identity for the single-threaded memory map).
 */
export interface LoginTrackerStore {
  getTracker(kind: LoginTrackerKind, key: string): LoginTracker | undefined
  putTracker(kind: LoginTrackerKind, key: string, tracker: LoginTracker): void
  deleteTracker(kind: LoginTrackerKind, key: string): void
  /** Remove trackers whose lock is served AND whose window is cold. */
  pruneTrackers(now: number, windowMs: number): void
  /** Run fn atomically vs other processes when the store supports it. */
  transact<T>(fn: () => T): T
}

/**
 * In-process lockout trackers — the exact historical behavior of the two
 * module Maps (email-keyed and email|ip-keyed), namespaced into one Map by
 * kind (the kinds are disjoint key spaces; a NUL separator cannot appear in
 * an email or IP, so no key can ever collide across kinds).
 */
export class MemoryLoginTrackerStore implements LoginTrackerStore {
  private readonly rows = new Map<string, LoginTracker>()

  private namespaced(kind: LoginTrackerKind, key: string): string {
    return `${kind}\u0000${key}`
  }

  getTracker(kind: LoginTrackerKind, key: string): LoginTracker | undefined {
    return this.rows.get(this.namespaced(kind, key))
  }

  putTracker(kind: LoginTrackerKind, key: string, tracker: LoginTracker): void {
    this.rows.set(this.namespaced(kind, key), tracker)
  }

  deleteTracker(kind: LoginTrackerKind, key: string): void {
    this.rows.delete(this.namespaced(kind, key))
  }

  pruneTrackers(now: number, windowMs: number): void {
    for (const [namespaced, t] of this.rows) {
      const lockServed = !t.lockedUntil || t.lockedUntil <= now
      const windowCold = now - t.lastFailureAt > windowMs
      if (lockServed && windowCold) this.rows.delete(namespaced)
    }
  }

  transact<T>(fn: () => T): T {
    return fn() // single-threaded: already atomic
  }
}

// ------------------------------------------------------- store resolution

type ResolvedRateLimitStores = {
  kind: 'memory' | 'sqlite'
  rateLimitStore: RateLimitStore
  loginTrackerStore: LoginTrackerStore
}

/**
 * Env-driven store resolution, run ONCE at module init (startup — after both
 * in-memory store classes are declared). Default and every failure path end
 * at the in-memory stores — byte-identical historical behavior; the sqlite
 * path is strictly opt-in (issue #33: shared state for multi-process
 * single-host deployments). Fail-closed honest logging: any sqlite init
 * failure emits ONE warning and degrades to memory.
 */
function resolveRateLimitStores(env: NodeJS.ProcessEnv): ResolvedRateLimitStores {
  const wanted = (env.RATE_LIMIT_STORE ?? '').trim().toLowerCase()
  if (wanted === 'sqlite') {
    const sqlite = createSqliteStores(env) // null + one console.warn on ANY init failure
    if (sqlite) return { kind: 'sqlite', ...sqlite }
  } else if (wanted && wanted !== 'memory') {
    console.warn(
      `[rate-limit] RATE_LIMIT_STORE="${wanted}" is not a known store (memory | sqlite) — ` +
        `using the in-memory store (per-process counters).`,
    )
  }
  return {
    kind: 'memory',
    rateLimitStore: new MemoryRateLimitStore(),
    loginTrackerStore: new MemoryLoginTrackerStore(),
  }
}

const resolvedStores = resolveRateLimitStores(process.env)

/** Which backing store is live — observability for logs/tests ('memory' | 'sqlite'). */
export const rateLimitStoreKind: 'memory' | 'sqlite' = resolvedStores.kind

/** The live token-bucket store (memory by default; sqlite when opted in). */
export const rateLimitStore: RateLimitStore = resolvedStores.rateLimitStore

const loginTrackerStore: LoginTrackerStore = resolvedStores.loginTrackerStore

export interface LoginLockout {
  /** Is this login attempt currently locked out? `msLeft` > 0 while locked. */
  checkLoginLockout(email: string, ip: string): { locked: boolean; msLeft: number }
  /** Record a failed attempt against both trackers; reports when it trips. */
  recordLoginFailure(email: string, ip: string): { locked: boolean; msLeft: number }
  /** Successful login: wipe both trackers entirely. */
  clearLoginFailures(email: string, ip: string): void
}

const emailLockKey = (email: string): string => email.trim().toLowerCase()
const pairLockKey = (email: string, ip: string): string =>
  `${email.trim().toLowerCase()}|${ip || 'unknown'}`

/**
 * Lockout engine (W-AUDIT #1 fix, store-agnostic since W3-b): the failure
 * counter is keyed PRIMARILY by EMAIL — rotating the (spoofable or
 * distributed) source IP no longer resets the count, so 5 bad passwords for
 * one account lock that account. A SECONDARY (email|ip) tracker is kept so a
 * distributed attack still gets per-pair throttling and the historical
 * same-IP behavior is unchanged. All state goes through the injected store —
 * in-process by default, the shared SQLite file when RATE_LIMIT_STORE=sqlite.
 */
export function createLoginLockout(store: LoginTrackerStore): LoginLockout {
  const probes = (email: string, ip: string): Array<[LoginTrackerKind, string]> => [
    ['email', emailLockKey(email)],
    ['pair', pairLockKey(email, ip)],
  ]

  const bump = (kind: LoginTrackerKind, key: string, now: number): { locked: boolean; msLeft: number } => {
    const t = store.getTracker(kind, key) ?? { failures: 0, lastFailureAt: 0, lockedUntil: 0 }
    if (now - t.lastFailureAt > LOGIN_WINDOW_MS) t.failures = 0 // stale window → restart the count
    t.failures += 1
    t.lastFailureAt = now
    const locked = t.failures >= LOGIN_FAILURE_LIMIT && !t.lockedUntil
    if (locked) t.lockedUntil = now + LOGIN_LOCKOUT_MS
    store.putTracker(kind, key, t)
    return { locked, msLeft: Math.max(0, t.lockedUntil - now) }
  }

  return {
    checkLoginLockout(email, ip) {
      const now = Date.now()
      let msLeft = 0
      for (const [kind, key] of probes(email, ip)) {
        const t = store.getTracker(kind, key)
        if (!t) continue
        if (t.lockedUntil > now) {
          msLeft = Math.max(msLeft, t.lockedUntil - now)
        } else if (t.lockedUntil) {
          store.deleteTracker(kind, key) // this tracker's lock is served → clean slate for it
        }
      }
      return { locked: msLeft > 0, msLeft }
    },

    recordLoginFailure(email, ip) {
      const now = Date.now()
      return store.transact(() => {
        const byEmail = bump('email', emailLockKey(email), now)
        const byPair = bump('pair', pairLockKey(email, ip), now)
        return {
          locked: byEmail.locked || byPair.locked,
          msLeft: Math.max(byEmail.msLeft, byPair.msLeft),
        }
      })
    },

    clearLoginFailures(email, ip) {
      for (const [kind, key] of probes(email, ip)) store.deleteTracker(kind, key)
    },
  }
}

/** The live lockout engine — bound to the env-resolved tracker store. */
const defaultLoginLockout = createLoginLockout(loginTrackerStore)

// ------------------------------------------------------------- USSD PIN lockout

/**
 * USSD PIN brute-force lockout (issue #106 / audit BE-9): 5 wrong PINs for
 * one phone within 15 min → a 15-minute lock for that line.
 *
 * Design (issue #106 "keyed per phone" + "reuse the rate-limit store infra"):
 *   · SINGLE tracker, keyed by the CALLER-SUPPLIED phoneNumber — the phone
 *     IS the account under attack (a coworker who knows the number is the
 *     recorded threat model). No second (phone|ip) key, unlike the login
 *     lockout: the route's existing 40/min per-IP PIN throttle already
 *     covers the rotating-source case.
 *   · SAME LoginTrackerStore seam (in-process map, or the shared sqlite file
 *     when RATE_LIMIT_STORE=sqlite — the 5th failure on process A is visible
 *     to process B), tracked under the 'ussd' kind, same 5/15min/15min
 *     lifecycle shape as the login lockout so the semantics cannot drift.
 *     CONSECUTIVE-failure semantics: the route clears the tracker on every
 *     successful PIN resolution, so only 5 wrong PINs IN A ROW trip it.
 *   · `now` is injectable (default Date.now) so tests drive the window
 *     without sleeping — the engine is a pure function of (store, now).
 *   · Old sqlite store files created before the 'ussd' kind keep the legacy
 *     CHECK(kind IN ('email','pair')) schema: those rows fail the constraint,
 *     the store degrades to fail-open with its ONE warning, and deleting the
 *     disposable db/ratelimit.db while stopped restores enforcement (the
 *     store's documented reset semantics).
 */
export const USSD_PIN_FAILURE_LIMIT = 5
export const USSD_PIN_WINDOW_MS = 15 * 60 * 1000
export const USSD_PIN_LOCKOUT_MS = 15 * 60 * 1000

export interface UssdPinLockout {
  /** Is this line currently locked out? `msLeft` > 0 while locked. */
  checkUssdPinLockout(phone: string): { locked: boolean; msLeft: number }
  /** Record a wrong-PIN attempt; reports when THIS attempt trips the lock. */
  recordUssdPinFailure(phone: string): { locked: boolean; msLeft: number }
  /** A correct PIN: wipe the tracker (consecutive-failure semantics). */
  clearUssdPinFailures(phone: string): void
}

const ussdPhoneLockKey = (phone: string): string => phone.trim()

/** Lockout engine for the USSD line — mirrors createLoginLockout, phone-keyed.
 * (`now` defaults to a CLOSURE over Date.now, not the Date.now reference, so
 * vitest fake timers — which replace the global Date per test — are honored.) */
export function createUssdPinLockout(
  store: LoginTrackerStore,
  now: () => number = () => Date.now(),
): UssdPinLockout {
  const kind: LoginTrackerKind = 'ussd'

  const bump = (key: string, at: number): { locked: boolean; msLeft: number } => {
    const t = store.getTracker(kind, key) ?? { failures: 0, lastFailureAt: 0, lockedUntil: 0 }
    if (at - t.lastFailureAt > USSD_PIN_WINDOW_MS) t.failures = 0 // stale window → restart
    t.failures += 1
    t.lastFailureAt = at
    const locked = t.failures >= USSD_PIN_FAILURE_LIMIT && !t.lockedUntil
    if (locked) t.lockedUntil = at + USSD_PIN_LOCKOUT_MS
    store.putTracker(kind, key, t)
    return { locked, msLeft: Math.max(0, t.lockedUntil - at) }
  }

  return {
    checkUssdPinLockout(phone) {
      const key = ussdPhoneLockKey(phone)
      const t = store.getTracker(kind, key)
      if (!t) return { locked: false, msLeft: 0 }
      const at = now()
      if (t.lockedUntil > at) return { locked: true, msLeft: t.lockedUntil - at }
      if (t.lockedUntil) store.deleteTracker(kind, key) // lock served → clean slate
      return { locked: false, msLeft: 0 }
    },

    recordUssdPinFailure(phone) {
      const key = ussdPhoneLockKey(phone)
      const at = now()
      return store.transact(() => bump(key, at))
    },

    clearUssdPinFailures(phone) {
      store.deleteTracker(kind, ussdPhoneLockKey(phone))
    },
  }
}

/** The live USSD PIN lockout — bound to the env-resolved tracker store. */
const defaultUssdPinLockout = createUssdPinLockout(loginTrackerStore)

/** Is this USSD line currently locked out? `msLeft` > 0 while locked. */
export function checkUssdPinLockout(phone: string): { locked: boolean; msLeft: number } {
  return defaultUssdPinLockout.checkUssdPinLockout(phone)
}

/**
 * Record a wrong-PIN attempt against the phone-keyed tracker. When the count
 * reaches USSD_PIN_FAILURE_LIMIT inside the window the lock starts NOW — the
 * return value says so, so the route can answer the honest locked reply on
 * the very attempt that tripped it.
 */
export function recordUssdPinFailure(phone: string): { locked: boolean; msLeft: number } {
  return defaultUssdPinLockout.recordUssdPinFailure(phone)
}

/** A correct PIN resolution wipes the tracker (consecutive-failure semantics). */
export function clearUssdPinFailures(phone: string): void {
  defaultUssdPinLockout.clearUssdPinFailures(phone)
}

function sweepLoginTrackers(now: number): void {
  loginTrackerStore.pruneTrackers(now, LOGIN_WINDOW_MS)
}

/** Is this login attempt currently locked out? `msLeft` > 0 while locked. */
export function checkLoginLockout(email: string, ip: string): { locked: boolean; msLeft: number } {
  return defaultLoginLockout.checkLoginLockout(email, ip)
}

/**
 * Record a failed credentials attempt against BOTH the email-primary tracker
 * and the (email|ip) pair. When either reaches LOGIN_FAILURE_LIMIT inside the
 * window the lockout starts NOW — the return value says so, so authorize()
 * can throw the "Too many attempts" error on the very attempt that tripped it.
 */
export function recordLoginFailure(email: string, ip: string): { locked: boolean; msLeft: number } {
  return defaultLoginLockout.recordLoginFailure(email, ip)
}

/** Successful login resets the counters entirely (both trackers). */
export function clearLoginFailures(email: string, ip: string): void {
  defaultLoginLockout.clearLoginFailures(email, ip)
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

/**
 * Per-route raw-body caps for /api/ai/* (issue #105 / audit BE-5): the gate
 * used to `await req.text()` UNBOUNDED before any size check — voice-log's
 * 12 MB audioBase64 check ran only AFTER the whole body was buffered, and
 * analyze-photo's dataUrl had no cap at all. Defaults small, opts up:
 *   · 128 KB — every text/JSON route (parse-text, extract-document, recap,
 *     anomaly-scan, authenticity-screen): prompts and hints, not payloads.
 *   · 13 MB — voice-log: transport headroom over the route's own 12 MB
 *     audioBase64 domain cap (JSON envelope + base64 overhead).
 *   · 6 MB — analyze-photo: a dataUrl photo upload ceiling.
 * Enforcement mirrors the whatsapp/ussd S2 gate exactly: declared
 * Content-Length precheck (an oversized header is refused before the read)
 * + actual byte count after the read, BEFORE JSON.parse.
 */
export const AI_ROUTE_DEFAULT_MAX_BODY_BYTES = 128 * 1024
/** voice-log transport cap — headroom over its 12 MB audioBase64 domain cap. */
export const AI_VOICE_LOG_MAX_BODY_BYTES = 13 * 1024 * 1024
/** analyze-photo transport cap for dataUrl uploads. */
export const AI_PHOTO_MAX_BODY_BYTES = 6 * 1024 * 1024

/** '64 KB' / '13 MB' style label for the honest body-cap message. */
export function formatByteCap(bytes: number): string {
  const MB = 1024 * 1024
  if (bytes >= MB && bytes % MB === 0) return `${bytes / MB} MB`
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KB`
  return `${bytes} bytes`
}

/**
 * 400 with the honest size message (the whatsapp/ussd bodyTooLarge family —
 * same wording, same status, so every raw-body cap in the repo answers alike).
 */
function aiBodyTooLarge(maxBytes: number): NextResponse {
  return NextResponse.json(
    { error: `Request body too large — this endpoint accepts at most ${formatByteCap(maxBytes)}` },
    { status: 400 },
  )
}

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
 *   4. raw-body byte cap (default 128 KB, per-route `maxBytes` override for
 *      the media routes — declared Content-Length precheck + post-read byte
 *      count, BEFORE JSON.parse) → 400 honest size error
 *   5. body shape: unknown top-level fields and mistyped fields → 400;
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
    /** Per-route raw-body cap (default AI_ROUTE_DEFAULT_MAX_BODY_BYTES). */
    maxBytes?: number
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

  // 4. Body shape — the byte cap first (BE-5, issue #105): the declared
  //    Content-Length precheck refuses an oversized request before the body
  //    is buffered at all; the post-read count catches a lying small header.
  const maxBytes = opts.maxBytes ?? AI_ROUTE_DEFAULT_MAX_BODY_BYTES
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: aiBodyTooLarge(maxBytes) }
  }
  let body: unknown
  try {
    const raw = await req.text()
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      return { ok: false, response: aiBodyTooLarge(maxBytes) }
    }
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
