/**
 * Rate-limit store persistence + parity (W3-b, closes issue #33:
 * "Rate-limit/lockout store is in-process only — multi-instance deploys
 * lose shared state").
 *
 * Three things are pinned here:
 *  1. CONTRACT PARITY — the key behavioral cases of the existing memory-store
 *     suite (tests/unit/rate-limit.test.ts, untouched — it stays the memory
 *     default's proof) re-run against BOTH RateLimitStore implementations and
 *     BOTH login-tracker stores through the same engine: identical allow/
 *     block/refill/window semantics, identical lockout lifecycle. The
 *     lockout ENGINE (createLoginLockout) is store-agnostic, so parity of the
 *     engine + stores together is what production actually runs.
 *  2. CROSS-PROCESS SHARING — the whole point of the sqlite store: two
 *     connections over one file (two "processes") share bucket counts and
 *     lockout strikes; state survives close/reopen and even a full module
 *     re-instantiation (dynamic re-import = simulated process restart).
 *  3. HONEST FAILURE MODES — bad path / unknown env / Bun runtime → memory
 *     fallback with exactly ONE warning; runtime statement failure → fail
 *     OPEN with a warning, never a throw.
 *
 * db is stubbed exactly like rate-limit.test.ts (only enforceAiRoutePolicy
 * touches Prisma). better-sqlite3 is imported directly for row-level
 * assertions against the store file (tests run under node — the runtime the
 * Docker CMD uses).
 */
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => ({ db: {} }))

import type { LoginTrackerStore, RateLimitStore } from '@/backend/lib/rate-limit'
import {
  LOGIN_FAILURE_LIMIT,
  LOGIN_LOCKOUT_MS,
  LOGIN_WINDOW_MS,
  MemoryLoginTrackerStore,
  MemoryRateLimitStore,
  createLoginLockout,
} from '@/backend/lib/rate-limit'
import {
  SqliteLoginTrackerStore,
  SqliteRateLimitStore,
  createSqliteStores,
  resolveRateLimitSqlitePath,
} from '@/backend/lib/rate-limit-sqlite'

const T0 = new Date('2026-01-05T09:00:00Z').getTime()

function req(ip?: string): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method: 'POST',
    headers: ip ? { 'x-forwarded-for': ip } : undefined,
  })
}

/** Open the real sqlite stores over a file; fail loudly if init unexpectedly
 *  failed (the init-failure cases are separate, deliberate tests below). */
function openStores(file: string) {
  const stores = createSqliteStores({ RATE_LIMIT_SQLITE_PATH: file })
  if (!stores) throw new Error(`createSqliteStores unexpectedly returned null for ${file}`)
  return stores
}

function bucketRowCount(file: string): number {
  const db = new Database(file)
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM rl_bucket').get() as { c: number }).c
  } finally {
    db.close()
  }
}

function trackerRowCount(file: string): number {
  const db = new Database(file)
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM rl_login_tracker').get() as { c: number }).c
  } finally {
    db.close()
  }
}

let dir: string

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  dir = mkdtempSync(join(tmpdir(), 'rl-store-'))
  process.env.NEXTAUTH_SECRET = 'unit-test-secret'
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.NEXTAUTH_SECRET
  delete process.env.RATE_LIMIT_STORE
  delete process.env.RATE_LIMIT_SQLITE_PATH
})

// ------------------------------------------------- token bucket contract parity

const bucketStoreFactories: Array<[string, () => RateLimitStore]> = [
  ['memory', () => new MemoryRateLimitStore()],
  ['sqlite', () => openStores(join(dir, 'buckets.db')).rateLimitStore],
]

describe.each(bucketStoreFactories)('RateLimitStore contract: %s', (_name, makeStore) => {
  it('allows exactly `limit` hits, then reports an honest wait', () => {
    const store = makeStore()
    const LIMIT = 3
    for (let i = 0; i < LIMIT; i++) {
      expect(store.hit('t-allow', LIMIT, 60_000, T0), `hit ${i + 1} should pass`).toBeNull()
    }
    const wait = store.hit('t-allow', LIMIT, 60_000, T0)
    expect(wait).not.toBeNull()
    expect(wait!).toBeGreaterThanOrEqual(1)
  })

  it('the wait is the honest next-token time (30s for limit 2 / 60s window drained dry)', () => {
    const store = makeStore()
    expect(store.hit('t-wait', 2, 60_000, T0)).toBeNull()
    expect(store.hit('t-wait', 2, 60_000, T0)).toBeNull()
    // tokens = 0; next token arrives after window/limit = 30s.
    expect(store.hit('t-wait', 2, 60_000, T0)).toBe(30)
  })

  it('refills fully after one window', () => {
    const store = makeStore()
    expect(store.hit('t-refill', 2, 60_000, T0)).toBeNull()
    expect(store.hit('t-refill', 2, 60_000, T0)).toBeNull()
    expect(store.hit('t-refill', 2, 60_000, T0)).toBe(30)
    expect(store.hit('t-refill', 2, 60_000, T0 + 60_000)).toBeNull()
  })

  it('partial refill: a quarter window buys one of four tokens back', () => {
    const store = makeStore()
    for (let i = 0; i < 4; i++) expect(store.hit('t-quarter', 4, 60_000, T0)).toBeNull()
    expect(store.hit('t-quarter', 4, 60_000, T0)).not.toBeNull()
    expect(store.hit('t-quarter', 4, 60_000, T0 + 15_000)).toBeNull()
    expect(store.hit('t-quarter', 4, 60_000, T0 + 15_000)).not.toBeNull()
  })

  it('fractional accrual persists: a half token completes across blocked hits', () => {
    const store = makeStore()
    expect(store.hit('t-half-token', 1, 60_000, T0)).toBeNull() // tokens → 0
    expect(store.hit('t-half-token', 1, 60_000, T0)).toBe(60) // dry
    // +30s → 0.5 tokens: still blocked, honest 30s wait, fraction kept.
    expect(store.hit('t-half-token', 1, 60_000, T0 + 30_000)).toBe(30)
    // +60s total → 0.5 + 0.5 = 1.0: the accrued half completes the token.
    expect(store.hit('t-half-token', 1, 60_000, T0 + 60_000)).toBeNull()
  })

  it('check() reports the same wait WITHOUT consuming a token', () => {
    const store = makeStore()
    expect(store.hit('t-check', 1, 60_000, T0)).toBeNull()
    expect(store.check('t-check', 1, 60_000, T0)).toBe(60)
    expect(store.check('t-check', 1, 60_000, T0)).toBe(60) // unchanged — nothing consumed
    expect(store.hit('t-check', 1, 60_000, T0)).toBe(60) // still dry for hit
  })

  it('check() on a key nobody hit is null (a fresh bucket is full)', () => {
    const store = makeStore()
    expect(store.check('t-unknown', 5, 60_000, T0)).toBeNull()
  })

  it("one key's exhaustion never blocks another key", () => {
    const store = makeStore()
    expect(store.hit('t-key-a', 1, 60_000, T0)).toBeNull()
    expect(store.hit('t-key-a', 1, 60_000, T0)).toBe(60)
    expect(store.hit('t-key-b', 1, 60_000, T0)).toBeNull()
  })

  it('changing the limit resets the bucket to a fresh, full one', () => {
    const store = makeStore()
    expect(store.hit('t-reset', 1, 60_000, T0)).toBeNull()
    expect(store.hit('t-reset', 1, 60_000, T0)).toBe(60) // dry at limit 1
    // Same key, new limit 5 → fresh bucket (memory parity: limit/rate change
    // restarts the state), so exactly 5 hits pass at the same instant.
    for (let i = 0; i < 5; i++) {
      expect(store.hit('t-reset', 5, 60_000, T0), `hit ${i + 1} at limit 5 should pass`).toBeNull()
    }
    expect(store.hit('t-reset', 5, 60_000, T0)).toBe(12) // (1-0)/(5/60000)/1000
  })

  it('sweep() never throws and leaves correct post-sweep behavior', () => {
    const store = makeStore()
    expect(store.hit('t-sweep', 1, 60_000, T0)).toBeNull()
    expect(() => store.sweep(T0)).not.toThrow()
    expect(() => store.sweep(T0 + 60_001)).not.toThrow()
    // Fully refilled (or swept): the bucket serves a fresh hit.
    expect(store.hit('t-sweep', 1, 60_000, T0 + 60_001)).toBeNull()
  })
})

// ------------------------------------------------------ sqlite cross-process

describe('SqliteRateLimitStore — cross-process sharing (issue #33)', () => {
  it('exhaustion on one connection is immediately visible on a second connection', () => {
    const file = join(dir, 'shared.db')
    const processA = openStores(file)
    const processB = openStores(file) // a second, independent connection
    expect(processA.rateLimitStore.hit('k', 1, 60_000, T0)).toBeNull()
    // The very next hit from the OTHER "process" is blocked.
    expect(processB.rateLimitStore.hit('k', 1, 60_000, T0)).toBe(60)
  })

  it('two processes share one count: 3 + 2 hits of a 5-limit, the 6th is blocked', () => {
    const file = join(dir, 'counted.db')
    const a = openStores(file)
    const b = openStores(file)
    for (let i = 0; i < 3; i++) expect(a.rateLimitStore.hit('ai:digest', 5, 60_000, T0)).toBeNull()
    for (let i = 0; i < 2; i++) expect(b.rateLimitStore.hit('ai:digest', 5, 60_000, T0)).toBeNull()
    expect(a.rateLimitStore.hit('ai:digest', 5, 60_000, T0)).toBe(12) // (1-0)/(5/60000)/1000
  })

  it('durability across close/reopen: blocked now, allowed after refill — from persisted state', () => {
    const file = join(dir, 'durable.db')
    const first = openStores(file)
    expect(first.rateLimitStore.hit('k', 2, 60_000, T0)).toBeNull()
    expect(first.rateLimitStore.hit('k', 2, 60_000, T0)).toBeNull()
    expect(first.rateLimitStore.hit('k', 2, 60_000, T0)).toBe(30)
    // "Restart": a brand-new store instance over the same file.
    const reopened = openStores(file)
    expect(reopened.rateLimitStore.check('k', 2, 60_000, T0)).toBe(30) // persisted dryness
    expect(reopened.rateLimitStore.hit('k', 2, 60_000, T0)).toBe(30)
    // Refill computed from the PERSISTED lastRefill: a full window later it passes.
    expect(reopened.rateLimitStore.hit('k', 2, 60_000, T0 + 60_000)).toBeNull()
  })

  it('sweep prunes fully-refilled rows from the shared file (lazy, no timer)', () => {
    const file = join(dir, 'sweep.db')
    const store = openStores(file).rateLimitStore
    expect(store.hit('k1', 1, 60_000, T0)).toBeNull() // row, tokens 0
    expect(store.hit('k2', 2, 60_000, T0)).toBeNull() // row, tokens 1
    expect(store.hit('k2', 2, 60_000, T0)).toBeNull() // row, tokens 0
    expect(bucketRowCount(file)).toBe(2)
    store.sweep(T0) // nothing fully refilled yet
    expect(bucketRowCount(file)).toBe(2)
    store.sweep(T0 + 60_001) // both fully refilled by now
    expect(bucketRowCount(file)).toBe(0)
  })
})

// --------------------------------------------------- login lockout parity

const trackerStoreFactories: Array<[string, () => LoginTrackerStore]> = [
  ['memory', () => new MemoryLoginTrackerStore()],
  ['sqlite', () => openStores(join(dir, 'lockout.db')).loginTrackerStore],
]

describe.each(trackerStoreFactories)('login lockout lifecycle on %s trackers', (_name, makeStore) => {
  it('does not lock before the failure limit is reached', () => {
    const lock = createLoginLockout(makeStore())
    for (let i = 1; i < LOGIN_FAILURE_LIMIT; i++) {
      const { locked } = lock.recordLoginFailure('a@x.co', '10.1.0.1')
      expect(locked, `failure #${i} must not lock`).toBe(false)
      expect(lock.checkLoginLockout('a@x.co', '10.1.0.1').locked).toBe(false)
    }
  })

  it('locks exactly on the 5th failure for 15 minutes', () => {
    const lock = createLoginLockout(makeStore())
    for (let i = 1; i < LOGIN_FAILURE_LIMIT; i++) lock.recordLoginFailure('b@x.co', '10.1.0.2')
    const tripped = lock.recordLoginFailure('b@x.co', '10.1.0.2')
    expect(tripped.locked).toBe(true)
    expect(tripped.msLeft).toBeGreaterThan(0)
    expect(tripped.msLeft).toBeLessThanOrEqual(LOGIN_LOCKOUT_MS)
    const state = lock.checkLoginLockout('b@x.co', '10.1.0.2')
    expect(state.locked).toBe(true)
    expect(state.msLeft).toBeGreaterThan(0)
  })

  it('dual-tracked: the email key survives IP rotation; other accounts are untouched', () => {
    const lock = createLoginLockout(makeStore())
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) lock.recordLoginFailure('c@x.co', '10.1.0.3')
    expect(lock.checkLoginLockout('c@x.co', '10.1.0.3').locked).toBe(true)
    // Different IP, same account: still locked via the email-keyed tracker.
    expect(lock.checkLoginLockout('c@x.co', '10.1.0.4').locked).toBe(true)
    // Different account from the same IP: a different pair AND email key.
    expect(lock.checkLoginLockout('d@x.co', '10.1.0.3').locked).toBe(false)
  })

  it('serves the lock: after 15 min the account is unlocked with a clean slate', () => {
    const lock = createLoginLockout(makeStore())
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) lock.recordLoginFailure('e@x.co', '10.1.0.5')
    expect(lock.checkLoginLockout('e@x.co', '10.1.0.5').locked).toBe(true)
    vi.advanceTimersByTime(LOGIN_LOCKOUT_MS + 1)
    expect(lock.checkLoginLockout('e@x.co', '10.1.0.5').locked).toBe(false)
    const again = lock.recordLoginFailure('e@x.co', '10.1.0.5')
    expect(again.locked).toBe(false) // clean slate: the counter restarted
  })

  it('a cold window restarts the count (4 failures + 15 min idle + 1 ≠ lock)', () => {
    const lock = createLoginLockout(makeStore())
    for (let i = 1; i < LOGIN_FAILURE_LIMIT; i++) lock.recordLoginFailure('f@x.co', '10.1.0.6')
    vi.advanceTimersByTime(LOGIN_WINDOW_MS + 1)
    const fresh = lock.recordLoginFailure('f@x.co', '10.1.0.6')
    expect(fresh.locked).toBe(false)
    expect(lock.checkLoginLockout('f@x.co', '10.1.0.6').locked).toBe(false)
  })

  it('a successful login wipes both trackers entirely', () => {
    const lock = createLoginLockout(makeStore())
    for (let i = 1; i < LOGIN_FAILURE_LIMIT; i++) lock.recordLoginFailure('g@x.co', '10.1.0.7')
    lock.clearLoginFailures('g@x.co', '10.1.0.7')
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i++) lock.recordLoginFailure('g@x.co', '10.1.0.7')
    expect(lock.checkLoginLockout('g@x.co', '10.1.0.7').locked).toBe(false)
  })

  it('email matching is case/whitespace tolerant (same tracker)', () => {
    const lock = createLoginLockout(makeStore())
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) lock.recordLoginFailure('  H@X.CO ', '10.1.0.8')
    expect(lock.checkLoginLockout('h@x.co', '10.1.0.8').locked).toBe(true)
  })
})

describe('SqliteLoginTrackerStore — cross-process sharing (issue #33)', () => {
  it('4 failures on connection A + the 5th from B trips the lock; A sees it', () => {
    const file = join(dir, 'lockout-shared.db')
    const processA = createLoginLockout(openStores(file).loginTrackerStore)
    const processB = createLoginLockout(openStores(file).loginTrackerStore)
    for (let i = 1; i < LOGIN_FAILURE_LIMIT; i++) {
      expect(processA.recordLoginFailure('acct@x.co', '10.2.0.1').locked).toBe(false)
    }
    expect(processB.recordLoginFailure('acct@x.co', '10.2.0.2').locked).toBe(true)
    expect(processA.checkLoginLockout('acct@x.co', '10.2.0.1').locked).toBe(true)
  })

  it('lockout survives restart and clear propagates to a fresh engine', () => {
    const file = join(dir, 'lockout-durable.db')
    const first = createLoginLockout(openStores(file).loginTrackerStore)
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) first.recordLoginFailure('acct2@x.co', '10.2.0.3')
    const restarted = createLoginLockout(openStores(file).loginTrackerStore)
    expect(restarted.checkLoginLockout('acct2@x.co', '10.2.0.3').locked).toBe(true)
    restarted.clearLoginFailures('acct2@x.co', '10.2.0.3')
    const third = createLoginLockout(openStores(file).loginTrackerStore)
    expect(third.checkLoginLockout('acct2@x.co', '10.2.0.3').locked).toBe(false)
  })

  it('prune removes served-lock + cold-window tracker rows, keeps live locks', () => {
    const file = join(dir, 'lockout-prune.db')
    const store = openStores(file).loginTrackerStore
    const t = Date.now()
    // Live lock: still locked at the later prune time (t + window + 1).
    store.putTracker('email', 'live@x.co', { failures: 5, lastFailureAt: t, lockedUntil: t + LOGIN_WINDOW_MS + 10_000 })
    store.putTracker('email', 'served@x.co', { failures: 5, lastFailureAt: t, lockedUntil: t })
    store.putTracker('pair', 'served@x.co|10.0.0.1', { failures: 2, lastFailureAt: t, lockedUntil: 0 })
    expect(trackerRowCount(file)).toBe(3)
    store.pruneTrackers(t, LOGIN_WINDOW_MS) // locks not served, windows not cold
    expect(trackerRowCount(file)).toBe(3)
    store.pruneTrackers(t + LOGIN_WINDOW_MS + 1, LOGIN_WINDOW_MS) // served + cold
    expect(trackerRowCount(file)).toBe(1) // only the live lock survives
    expect(store.getTracker('email', 'live@x.co')).toBeDefined()
    expect(store.getTracker('email', 'served@x.co')).toBeUndefined()
  })
})

// ------------------------------------------------------ module-level wiring

describe('module-level store resolution (env wiring at import time)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('RATE_LIMIT_STORE unset → in-memory store, zero warnings', async () => {
    const mod = await import('@/backend/lib/rate-limit')
    expect(mod.rateLimitStoreKind).toBe('memory')
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('RATE_LIMIT_STORE=memory (explicit) → in-memory store, zero warnings', async () => {
    process.env.RATE_LIMIT_STORE = 'memory'
    const mod = await import('@/backend/lib/rate-limit')
    expect(mod.rateLimitStoreKind).toBe('memory')
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('RATE_LIMIT_STORE=sqlite → module wires the sqlite store; state survives a full module re-instantiation (simulated process restart)', async () => {
    process.env.RATE_LIMIT_STORE = 'sqlite'
    process.env.RATE_LIMIT_SQLITE_PATH = join(dir, 'wired.db')
    const first = await import('@/backend/lib/rate-limit')
    expect(first.rateLimitStoreKind).toBe('sqlite')
    expect(console.warn).not.toHaveBeenCalled()
    // Through the real public surface: first hit allowed, second limited.
    expect(await first.enforceRateLimit(req('10.9.0.1'), 'wired', 1, 60_000)).toBeNull()
    const limited = await first.enforceRateLimit(req('10.9.0.1'), 'wired', 1, 60_000)
    expect(limited!.status).toBe(429)
    // "Process restart": fresh module instance, same file — still exhausted.
    vi.resetModules()
    const second = await import('@/backend/lib/rate-limit')
    expect(second.rateLimitStoreKind).toBe('sqlite')
    const afterRestart = await second.enforceRateLimit(req('10.9.0.1'), 'wired', 1, 60_000)
    expect(afterRestart!.status).toBe(429)
    // ...and refills from the persisted timestamp one window later.
    vi.advanceTimersByTime(60_000)
    expect(await second.enforceRateLimit(req('10.9.0.1'), 'wired', 1, 60_000)).toBeNull()
  })

  it('RATE_LIMIT_STORE=sqlite + bad path → memory fallback with exactly ONE warning; limiting still works', async () => {
    process.env.RATE_LIMIT_STORE = 'sqlite'
    process.env.RATE_LIMIT_SQLITE_PATH = join(dir, 'no-such-dir', 'rl.db')
    const mod = await import('@/backend/lib/rate-limit')
    expect(mod.rateLimitStoreKind).toBe('memory')
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(String((console.warn as unknown as (m: string) => void).mock.calls[0])).toContain('not active')
    // The fallback store behaves exactly like the historical default.
    expect(await mod.enforceRateLimit(req('10.9.0.2'), 'fell', 1, 60_000)).toBeNull()
    expect(await mod.enforceRateLimit(req('10.9.0.2'), 'fell', 1, 60_000)).not.toBeNull()
  })

  it('unknown RATE_LIMIT_STORE value → memory + one honest warning naming the value', async () => {
    process.env.RATE_LIMIT_STORE = 'redis'
    const mod = await import('@/backend/lib/rate-limit')
    expect(mod.rateLimitStoreKind).toBe('memory')
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(String((console.warn as unknown as (m: string) => void).mock.calls[0])).toContain('redis')
  })
})

// ------------------------------------------------------- init failure honesty

describe('createSqliteStores init honesty', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates the store file eagerly (fail-fast init, not first-request failure)', () => {
    const file = join(dir, 'eager.db')
    expect(existsSync(file)).toBe(false)
    expect(createSqliteStores({ RATE_LIMIT_SQLITE_PATH: file })).not.toBeNull()
    expect(existsSync(file)).toBe(true)
  })

  it('an unwritable path returns null with ONE warning (caller falls back to memory)', () => {
    const before = (console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    const stores = createSqliteStores({ RATE_LIMIT_SQLITE_PATH: join(dir, 'missing', 'rl.db') })
    expect(stores).toBeNull()
    expect((console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before + 1)
  })

  it('refuses the native addon under the Bun runtime instead of crashing (memory fallback)', () => {
    const versions = process.versions as { bun?: string }
    const had = versions.bun
    versions.bun = '1.3.14' // the runtime that hard-crashes on better-sqlite3
    try {
      const stores = createSqliteStores({ RATE_LIMIT_SQLITE_PATH: join(dir, 'bun.db') })
      expect(stores).toBeNull()
      const msg = String((console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls.at(-1))
      expect(msg).toContain('Bun')
    } finally {
      if (had === undefined) delete versions.bun
      else versions.bun = had
    }
  })

  it('path resolution: default, file: prefix tolerated, blank → default', () => {
    expect(resolveRateLimitSqlitePath({})).toBe('db/ratelimit.db')
    expect(resolveRateLimitSqlitePath({ RATE_LIMIT_SQLITE_PATH: '  ' })).toBe('db/ratelimit.db')
    expect(resolveRateLimitSqlitePath({ RATE_LIMIT_SQLITE_PATH: 'file:/tmp/rl.db' })).toBe('/tmp/rl.db')
    expect(resolveRateLimitSqlitePath({ RATE_LIMIT_SQLITE_PATH: '/tmp/rl.db' })).toBe('/tmp/rl.db')
  })
})

// ----------------------------------------------------- runtime failure honesty

/** A db whose statements and exec all explode AFTER a successful open —
 *  simulates runtime disk failure (init succeeded, the store later broke). */
function brokenDb(): { exec: () => never; prepare: () => { run: () => never; get: () => never }; pragma: () => undefined } {
  const boom = (): never => {
    throw new Error('disk exploded')
  }
  const throwingStatement = { run: boom, get: boom }
  return { exec: boom, prepare: () => throwingStatement, pragma: () => undefined }
}

describe('runtime statement failure — fail OPEN with a warning, never throw', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('SqliteRateLimitStore: hit/check/sweep degrade to allowed/null/no-op + ONE warning', () => {
    const store = new SqliteRateLimitStore(brokenDb())
    expect(store.hit('k', 5, 60_000, Date.now())).toBeNull() // fail-open: allowed
    expect(store.check('k', 5, 60_000, Date.now())).toBeNull()
    expect(() => store.sweep(Date.now())).not.toThrow()
    expect(store.hit('k2', 5, 60_000, Date.now())).toBeNull() // still no throw…
    expect(console.warn).toHaveBeenCalledTimes(1) // …but the warning is throttled to one
  })

  it('SqliteLoginTrackerStore: reads → no tracker, writes/prunes no-op, transact still runs', () => {
    const trackers = new SqliteLoginTrackerStore(brokenDb())
    expect(trackers.getTracker('email', 'a@x.co')).toBeUndefined()
    expect(() => trackers.putTracker('email', 'a@x.co', { failures: 1, lastFailureAt: 1, lockedUntil: 0 })).not.toThrow()
    expect(() => trackers.deleteTracker('email', 'a@x.co')).not.toThrow()
    expect(() => trackers.pruneTrackers(Date.now(), LOGIN_WINDOW_MS)).not.toThrow()
    let ran = false
    expect(trackers.transact(() => { ran = true; return 42 })).toBe(42) // degraded, not dead
    expect(ran).toBe(true)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
