import { NextRequest, NextResponse } from 'next/server'
// v4's types keep getToken in 'next-auth/jwt' (not the 'next-auth/next' barrel)
import { getToken } from 'next-auth/jwt'
import { db } from '@/backend/lib/db'
import { getSessionFromReq, unauthorized, type GuardSession } from '@/backend/lib/guard'
import { mutationSafetyDenied } from '@/backend/lib/mutation-safety'
import { createSqliteStores, resolveRateLimitSqlitePath } from '@/backend/lib/rate-limit-sqlite'
import { log } from './log'

/**
 * In-process security primitives: rate limiting, login lockout and the shared
 * /api/ai/* route policy (W1-SEC, spec Doc A §52 security hardening).
 *
 * STORE RESOLUTION (W3-b issue #33 → issue #158): the token buckets and
 * login lockout used to live in module-scope Maps of THIS Node process only —
 * fine for one Next.js server, silently wrong the moment several processes
 * share the traffic (a user effectively got `limit × instances` requests; a
 * login lockout only locked the instance that happened to serve the
 * failures). The seams are unchanged, but the backing stores are env-resolved
 * at startup (resolveRateLimitStores below):
 *   · RATE_LIMIT_STORE unset / "sqlite" (default, issue #158): ONE shared
 *     SQLite file per host (RATE_LIMIT_SQLITE_PATH, default db/ratelimit.db
 *     — a separate file, never the Prisma database) backing both the buckets
 *     and the lockout trackers: writes are durable immediately, reads compute
 *     allowance from the persisted state, so exhaustion/lockout on process A
 *     is seen by process B. Any init failure logs ONE warning and falls back to
 *     the in-memory stores — rate limiting never prevents boot (the CI/
 *     read-only-FS posture).
 *   · RATE_LIMIT_STORE=memory (explicit opt-out): in-process stores — the
 *     historical behavior, exact for ONE process (single-process dev where a
 *     sidecar file is unwanted). Unit tests run on this setting (see
 *     vitest.config.mts) so the suite stays hermetic; the default wiring is
 *     pinned explicitly in tests/unit/rate-limit-store.test.ts.
 * Multi-HOST still needs a Redis-backed implementation of these same seams
 * (INCR+TTL, or a Lua token-bucket script for this exact refill semantics) —
 * deliberately not built; no Redis dependency is added (the sqlite store
 * covers the single-host multi-process case, e.g. the compose stack).
 */

// ---------------------------------------------------------------- primitives

/**
 * TRUST_PROXY (W-AUDIT finding #1 → issue #156): x-forwarded-for is a
 * comma-separated chain the CLIENT can seed with arbitrary values ("spoof,
 * real" after one appending proxy). Which entry to believe therefore depends
 * on deployment:
 *   · UNSET (default, local dev / direct exposure): the header is IGNORED —
 *     '' is returned, collapsing every unauthenticated caller onto the ONE
 *     shared 'anon' bucket (issue #156). The historical first-value behavior
 *     let a client mint a fresh rate-limit bucket per request by rotating the
 *     forgeable left-most value, which is no throttle at all; a single honest
 *     bucket is fail-closed against that (and matches the website contact
 *     route's own default posture, issue #131).
 *   · SET (any non-empty value except 0/false): we sit behind exactly ONE
 *     appending reverse proxy (Caddy in the compose self-host). The LAST
 *     value is the entry OUR proxy appended — its view of the client — so
 *     spoofed values left of it cannot mint rate-limit buckets or fresh
 *     (email, ip) lockout identities. Set it only in that one-proxy topology;
 *     with a chain of proxies the last value is a proxy, not the client.
 *
 * AGGREGATOR-MULTIPLEXING TRADEOFF (kept honest next to the change): with
 * TRUST_PROXY unset, ALL callers share one 'anon' bucket per limit — right
 * for direct exposure (one hostile host cannot rotate buckets), blunt when a
 * real USSD/WhatsApp aggregator or relay multiplexes many MSISDNs through
 * one gateway IP and legitimately needs aggregate headroom. That deployment
 * must either set TRUST_PROXY=1 behind a proxy it controls (per-client keys)
 * or raise the route limit / key on the aggregator's authenticated identity
 * (X-Signature) — the per-IP bucket was never a per-aggregator entitlement.
 * The Daraja IP allowlist consumes this function too: with TRUST_PROXY unset
 * its resolved IP is '' → unresolvable → denied (fail closed; an allowlist
 * keyed on a forgeable header never actually filtered anything).
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
  // Untrusted header (no TRUST_PROXY) → no IP at all, never the first
  // (client-seeded) value — see the tradeoff note above (issue #156).
  if (!isTrustProxyEnabled()) return ''
  return values[values.length - 1]
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
 * Implementations: MemoryRateLimitStore (this process only — the explicit
 * RATE_LIMIT_STORE=memory opt-out) and SqliteRateLimitStore
 * (rate-limit-sqlite.ts, one shared file per host — the default since
 * issue #158).
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

/** In-process token buckets (the explicit memory opt-out — see the file header). */
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
 * in-memory store classes are declared). The DEFAULT (and every failure
 * path) is the failure ladder of issue #158: attempt the shared SQLite store
 * (multi-process safe on one host); ANY init failure logs ONE warning and
 * degrades to the in-memory stores — rate limiting never prevents boot, so
 * CI containers and read-only filesystems keep working (per-process
 * counters). `RATE_LIMIT_STORE=memory` is the explicit opt-out that restores
 * the historical single-process behavior; an unknown value warns and gets
 * the default ladder (not a silent memory downgrade — the warning names the
 * value and the valid options).
 */
function resolveRateLimitStores(env: NodeJS.ProcessEnv): ResolvedRateLimitStores {
  const wanted = (env.RATE_LIMIT_STORE ?? '').trim().toLowerCase()
  if (wanted === 'memory') {
    return {
      kind: 'memory',
      rateLimitStore: new MemoryRateLimitStore(),
      loginTrackerStore: new MemoryLoginTrackerStore(),
    }
  }
  if (wanted && wanted !== 'sqlite') {
    log.warn(
      'rate-limit',
      `RATE_LIMIT_STORE="${wanted}" is not a known store (memory | sqlite) — ` +
        `using the default sqlite store (one shared file per host; init failure falls back to memory).`,
      { wanted },
    )
  }
  const sqlite = createSqliteStores(env) // null + one console.warn on ANY init failure
  if (sqlite) return { kind: 'sqlite', ...sqlite }
  return {
    kind: 'memory',
    rateLimitStore: new MemoryRateLimitStore(),
    loginTrackerStore: new MemoryLoginTrackerStore(),
  }
}

const resolvedStores = resolveRateLimitStores(process.env)

// Boot-time observability (issue #158): ONE line stating which store is live.
// Skipped under vitest (process.env.VITEST) — a test import is not a boot, and
// the suite pins the resolution matrix explicitly in rate-limit-store.test.ts.
if (!process.env.VITEST) {
  log.info(
    'rate-limit',
    resolvedStores.kind === 'sqlite'
      ? `store: sqlite (${resolveRateLimitSqlitePath(process.env)}) — shared per host, multi-process safe`
      : 'store: memory — per-process counters (set RATE_LIMIT_STORE=sqlite for multi-process sharing)',
    { store: resolvedStores.kind },
  )
}

/** Which backing store is live — observability for logs/tests ('memory' | 'sqlite'). */
export const rateLimitStoreKind: 'memory' | 'sqlite' = resolvedStores.kind

/** The live token-bucket store (the shared sqlite file by default; memory when opted out). */
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
 * the shared SQLite file by default, in-process when RATE_LIMIT_STORE=memory.
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
 * USSD PIN brute-force lockout (issue #106 / audit BE-9; REKEYED by issue
 * #176 / SEC-9): 5 wrong PINs within 15 min → a 15-minute lock.
 *
 * KEYING (issue #176 — "key the lockout on a value the attacker cannot
 * freely choose"): the historical engine keyed its single tracker on the
 * CALLER-SUPPLIED phoneNumber, so rotating MSISDNs minted a fresh budget per
 * guess (the per-IP 40/min throttle was the only real bound), a correct
 * phone-tail PIN could CLEAR the count (a refresh vehicle in the open
 * posture), and 5 wrong PINs spoofing a victim's number locked the victim's
 * line. The engine now mirrors createLoginLockout's dual-key architecture
 * over the same 'ussd' tracker kind:
 *
 *   · PRIMARY — the CLIENT-IP principal (`ip:` keys): every wrong PIN
 *     records here and the pre-resolution gate checks here, so rotating the
 *     phone number (or the worker target) can never refresh the budget
 *     (issue #176 AC1). The principal is the trust-aware
 *     clientIpFromHeaders value: with TRUST_PROXY unset it is '' → the ONE
 *     shared 'anon' budget for every untrusted caller (the strongest honest
 *     bound for the demo posture — rotating a forgeable x-forwarded-for
 *     changes nothing); with TRUST_PROXY=1 it is the proxy-appended client
 *     IP. DEPLOYMENT REALITY, documented honestly: a real USSD aggregator
 *     multiplexes many MSISDNs through one gateway IP, so the ip-keyed
 *     budget is shared per gateway — one malicious caller can keep the
 *     gateway's PIN attempts locked out (availability traded for brute-force
 *     resistance). Wiring a real aggregator means raising the per-IP bucket
 *     and re-keying on the aggregator's authenticated identity (the same
 *     honesty note the route contract already carries for the throttle).
 *   · SECONDARY — the RESOLVED WORKER identity (`worker:` keys), the
 *     per-worker lock for kiosk-PIN attempts (issue #176 AC2): a wrong PIN
 *     attributed to a worker (the caller's line maps to that worker —
 *     aggregator-vouched under the shared secret; spoofable in the open
 *     posture, where the ip key is the real bound) accumulates on the
 *     worker's tracker REGARDLESS of which phone/IP sent it, and once
 *     locked, attempts that would resolve that worker are refused from ANY
 *     phone. A CORRECT kiosk PIN clears the worker's tracker (consecutive
 *     semantics, keyed on the identity that proved itself) — it does NOT
 *     clear the ip tracker (that was the refresh exploit), and a correct
 *     phone-tail PIN clears nothing (the 10^4 demo identity proves nothing
 *     about the kiosk PIN). HONEST LIMIT, documented rather than pretended:
 *     a MISSED kiosk-PIN guess names no target worker (a wrong 4-digit
 *     string carries zero target information), so per-worker accumulation
 *     keys on what the deployment can attribute — the caller's line; every
 *     miss also lands on the unrefreshable ip key either way.
 *
 *   · SAME LoginTrackerStore seam (the shared sqlite file by default — the
 *     5th failure on process A is visible to process B; in-process map when
 *     RATE_LIMIT_STORE=memory), tracked under the 'ussd' kind with PREFIXED
 *     keys ('ip:<principal>' / 'worker:<id>') — deliberately NOT new tracker
 *     kinds, so existing ratelimit.db files (CHECK kind IN
 *     ('email','pair','ussd')) keep enforcing with zero migration; legacy
 *     bare-phone 'ussd' rows from the #106 engine become dead letters (the
 *     new engine never reads them) and age out via the sweep.
 *   · `now` is injectable (default Date.now) so tests drive the window
 *     without sleeping — the engine is a pure function of (store, now).
 */

/** Which non-attacker-supplied identities a USSD PIN attempt is keyed on.
 * Either field may be absent (the engine consults/clears exactly the keys
 * present); at least one MUST be present — an empty scope is a programmer
 * error and throws rather than silently recording nothing. */
export interface UssdPinLockoutScope {
  /** Trust-aware client-IP principal ('' = the shared anon bucket). */
  ip?: string
  /** The worker the attempt belongs to, when attributable/resolved. */
  workerId?: string
}

export const USSD_PIN_FAILURE_LIMIT = 5
export const USSD_PIN_WINDOW_MS = 15 * 60 * 1000
export const USSD_PIN_LOCKOUT_MS = 15 * 60 * 1000

export interface UssdPinLockout {
  /** Is this attempt currently locked out? `msLeft` > 0 while locked. */
  checkUssdPinLockout(scope: UssdPinLockoutScope): { locked: boolean; msLeft: number }
  /** Record a wrong-PIN attempt on every present key; reports when THIS
   *  attempt trips a lock. */
  recordUssdPinFailure(scope: UssdPinLockoutScope): { locked: boolean; msLeft: number }
  /** Wipe the trackers for the present keys ONLY (the route clears the
   *  worker key on a correct kiosk PIN while leaving the ip budget sticky). */
  clearUssdPinFailures(scope: UssdPinLockoutScope): void
}

const ussdIpLockKey = (ip: string): string => `ip:${ip.trim() || 'anon'}`
const ussdWorkerLockKey = (workerId: string): string => `worker:${workerId}`

/** Lockout engine for the USSD line — mirrors createLoginLockout's
 * dual-key shape, keyed on the client-IP principal + resolved worker id.
 * (`now` defaults to a CLOSURE over Date.now, not the Date.now reference, so
 * vitest fake timers — which replace the global Date per test — are honored.) */
export function createUssdPinLockout(
  store: LoginTrackerStore,
  now: () => number = () => Date.now(),
): UssdPinLockout {
  const kind: LoginTrackerKind = 'ussd'

  const keys = (scope: UssdPinLockoutScope): string[] => {
    const ks: string[] = []
    if (scope.ip !== undefined) ks.push(ussdIpLockKey(scope.ip))
    if (scope.workerId !== undefined) ks.push(ussdWorkerLockKey(scope.workerId))
    if (ks.length === 0) {
      // A security primitive must never silently no-op: a scope with no key
      // would record nothing and check nothing (an unbounded budget).
      throw new Error('createUssdPinLockout: scope must carry an ip and/or a workerId')
    }
    return ks
  }

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
    checkUssdPinLockout(scope) {
      const at = now()
      let msLeft = 0
      for (const key of keys(scope)) {
        const t = store.getTracker(kind, key)
        if (!t) continue
        if (t.lockedUntil > at) {
          msLeft = Math.max(msLeft, t.lockedUntil - at)
        } else if (t.lockedUntil) {
          store.deleteTracker(kind, key) // this tracker's lock is served → clean slate for it
        }
      }
      return { locked: msLeft > 0, msLeft }
    },

    recordUssdPinFailure(scope) {
      const at = now()
      return store.transact(() => {
        let locked = false
        let msLeft = 0
        for (const key of keys(scope)) {
          const r = bump(key, at)
          locked = locked || r.locked
          msLeft = Math.max(msLeft, r.msLeft)
        }
        return { locked, msLeft }
      })
    },

    clearUssdPinFailures(scope) {
      for (const key of keys(scope)) store.deleteTracker(kind, key)
    },
  }
}

/** The live USSD PIN lockout — bound to the env-resolved tracker store. */
const defaultUssdPinLockout = createUssdPinLockout(loginTrackerStore)

/** Is this USSD PIN attempt currently locked out? `msLeft` > 0 while locked. */
export function checkUssdPinLockout(scope: UssdPinLockoutScope): { locked: boolean; msLeft: number } {
  return defaultUssdPinLockout.checkUssdPinLockout(scope)
}

/**
 * Record a wrong-PIN attempt against the client-IP principal (always) and
 * the resolved worker identity (when attributable). When a count reaches
 * USSD_PIN_FAILURE_LIMIT inside the window the lock starts NOW — the return
 * value says so, so the route can answer the honest locked reply on the very
 * attempt that tripped it.
 */
export function recordUssdPinFailure(scope: UssdPinLockoutScope): { locked: boolean; msLeft: number } {
  return defaultUssdPinLockout.recordUssdPinFailure(scope)
}

/** Wipe the trackers for the scope's present keys (a correct kiosk PIN
 * clears the worker's own count; the ip-keyed budget is deliberately sticky). */
export function clearUssdPinFailures(scope: UssdPinLockoutScope): void {
  defaultUssdPinLockout.clearUssdPinFailures(scope)
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
 *   3. mutation safety (SEC-1 — same default-on gate as route-kit's
 *      pipeline: same-origin browsers pass, cross-site browsers 403,
 *      non-browser bodies need the JSON content type) → 403/415
 *   4. rate limit (default 10/min per user, per route) → 429
 *   5. raw-body byte cap (default 128 KB, per-route `maxBytes` override for
 *      the media routes — declared Content-Length precheck + post-read byte
 *      count, BEFORE JSON.parse) → 400 honest size error
 *   6. body shape: unknown top-level fields and mistyped fields → 400;
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

  // 3. Mutation safety (SEC-1) — the AI routes are browser-reachable
  //    POST/PUT surfaces; the gate is the SAME one route-kit's pipeline
  //    applies (mirrors the auth-then-gate ordering there).
  const unsafe = mutationSafetyDenied(req)
  if (unsafe) return { ok: false, response: unsafe }

  // 4. Rate limit before parsing the body — malformed spam counts too.
  const limited = await enforceRateLimit(
    req,
    opts.bucket,
    opts.limit ?? AI_RATE_LIMIT_PER_MIN,
    opts.windowMs ?? 60_000,
  )
  if (limited) return { ok: false, response: limited }

  // 5. Body shape — the byte cap first (BE-5, issue #105): the declared
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

  // 6. projectId must reference a real project when supplied.
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
