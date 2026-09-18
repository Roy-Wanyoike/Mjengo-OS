/**
 * Invariants of the in-process security primitives
 * (src/backend/lib/rate-limit.ts — W1-SEC).
 *
 * Three stateful surfaces are pinned here, under fake timers (or injected
 * `now`) so the math is deterministic:
 *  · Token bucket (enforceRateLimit): the first `limit` requests pass, the
 *    next gets an honest 429 + Retry-After, tokens refill continuously with
 *    time, and (bucket, principal) keys never bleed into each other.
 *  · Login lockout: 5 failures in 15 min (per email+IP) lock for 15 min —
 *    not one failure earlier, not after the lock is served, and a cold
 *    window restarts the count. Success resets everything.
 *  · USSD PIN lockout (issue #106 / BE-9, rekeyed by issue #176 / SEC-9): the
 *    same 5/15min/15min lifecycle, keyed on the CLIENT-IP principal (the
 *    unrefreshable budget — '' is the one shared anon principal) plus the
 *    resolved worker identity (the per-worker lock), driven through
 *    createUssdPinLockout with an injected clock — no sleeping, no fake
 *    timers needed.
 * Also pinned: the /api/ai/* policy gate's per-route raw-body caps
 * (issue #105 / BE-5) — default 128 KB, 13 MB voice-log, 6 MB analyze-photo,
 * declared-Content-Length precheck + post-read count, whatsapp-family error.
 *
 * db is stubbed ({}): the cap tests send no projectId, so the gate never
 * touches Prisma; guard is stubbed with a controllable session (the
 * ai-authenticity / flags-gating idioms).
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => ({ db: {} }))

// Controllable session for the enforceAiRoutePolicy cap tests (the
// ai-authenticity / flags-gating mock idiom — only the two exports the
// gate reads).
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))
vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
  return {
    getSessionFromReq: vi.fn(async () => h.session),
    unauthorized: () => NextResponse.json({ error: 'Sign in required' }, { status: 401 }),
  }
})

import {
  AI_PHOTO_MAX_BODY_BYTES,
  AI_ROUTE_DEFAULT_MAX_BODY_BYTES,
  AI_VOICE_LOG_MAX_BODY_BYTES,
  LOGIN_FAILURE_LIMIT, LOGIN_LOCKOUT_MS, LOGIN_WINDOW_MS,
  MemoryLoginTrackerStore,
  USSD_PIN_FAILURE_LIMIT, USSD_PIN_LOCKOUT_MS, USSD_PIN_WINDOW_MS,
  checkLoginLockout, clearLoginFailures, clientIpFromHeaders, enforceAiRoutePolicy,
  enforceRateLimit, formatByteCap, recordLoginFailure,
} from '@/backend/lib/rate-limit'
import { createUssdPinLockout } from '@/backend/lib/rate-limit'

const T0 = new Date('2026-01-05T09:00:00Z')

function req(ip?: string): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method: 'POST',
    headers: ip ? { 'x-forwarded-for': ip } : undefined,
  })
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  process.env.NEXTAUTH_SECRET = 'unit-test-secret'
  h.session = { user: { id: 'u-1', email: 'site@test.dev', name: 'site', role: 'contractor', projectId: null } }
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.NEXTAUTH_SECRET
})

describe('clientIpFromHeaders — trust-aware since issue #156', () => {
  let prevTrustProxy: string | undefined

  beforeEach(() => {
    prevTrustProxy = process.env.TRUST_PROXY
    delete process.env.TRUST_PROXY
  })
  afterEach(() => {
    if (prevTrustProxy === undefined) delete process.env.TRUST_PROXY
    else process.env.TRUST_PROXY = prevTrustProxy
  })

  it('TRUST_PROXY unset → "" even when x-forwarded-for is present — the forgeable header is ignored (issue #156)', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' }))).toBe('')
    expect(clientIpFromHeaders({ 'x-forwarded-for': '198.51.100.9, 10.0.0.2' })).toBe('')
    expect(clientIpFromHeaders({ 'X-Forwarded-For': '198.51.100.10' })).toBe('')
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe('')
  })

  it('TRUST_PROXY set → the LAST (proxy-appended) hop, trimmed', () => {
    process.env.TRUST_PROXY = '1'
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' }))).toBe('10.0.0.1')
    expect(clientIpFromHeaders({ 'x-forwarded-for': '198.51.100.9, 10.0.0.2' })).toBe('10.0.0.2')
    // a single value is the proxy-appended view too
    expect(clientIpFromHeaders({ 'X-Forwarded-For': '198.51.100.10' })).toBe('198.51.100.10')
  })

  it('TRUST_PROXY=0/false → same as unset (the header stays ignored)', () => {
    process.env.TRUST_PROXY = '0'
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe('')
    process.env.TRUST_PROXY = 'false'
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe('')
  })

  it('returns "" for missing headers or missing values (never throws)', () => {
    expect(clientIpFromHeaders(undefined)).toBe('')
    expect(clientIpFromHeaders(null)).toBe('')
    expect(clientIpFromHeaders(new Headers())).toBe('')
    expect(clientIpFromHeaders({})).toBe('')
  })
})

describe('enforceRateLimit token bucket', () => {
  it('allows exactly `limit` requests, then 429s with honest Retry-After', async () => {
    const LIMIT = 3
    for (let i = 0; i < LIMIT; i++) {
      const res = await enforceRateLimit(req('10.9.0.1'), 't-allow', LIMIT, 60_000)
      expect(res, `request ${i + 1} should pass`).toBeNull()
    }
    const blocked = await enforceRateLimit(req('10.9.0.1'), 't-allow', LIMIT, 60_000)
    expect(blocked).not.toBeNull()
    expect(blocked!.status).toBe(429)
    expect(blocked!.headers.get('retry-after')).toMatch(/^\d+$/)
    const body = (await blocked!.json()) as { error: string; retryAfterSec: number }
    expect(body.error).toBe('Too many requests')
    expect(body.retryAfterSec).toBeGreaterThanOrEqual(1)
  })

  it('refills continuously: one window later the bucket is full again', async () => {
    const LIMIT = 2
    for (let i = 0; i < LIMIT; i++) {
      expect(await enforceRateLimit(req('10.9.0.2'), 't-refill', LIMIT, 60_000)).toBeNull()
    }
    expect(await enforceRateLimit(req('10.9.0.2'), 't-refill', LIMIT, 60_000)).not.toBeNull()

    vi.advanceTimersByTime(60_000) // one full window refills every token
    expect(await enforceRateLimit(req('10.9.0.2'), 't-refill', LIMIT, 60_000)).toBeNull()
  })

  it('partial refill: half a window buys half the burst back', async () => {
    const LIMIT = 4
    for (let i = 0; i < LIMIT; i++) {
      expect(await enforceRateLimit(req('10.9.0.3'), 't-half', LIMIT, 60_000)).toBeNull()
    }
    expect(await enforceRateLimit(req('10.9.0.3'), 't-half', LIMIT, 60_000)).not.toBeNull()

    vi.advanceTimersByTime(15_000) // 1/4 window → 1 of 4 tokens
    expect(await enforceRateLimit(req('10.9.0.3'), 't-half', LIMIT, 60_000)).toBeNull()
    expect(await enforceRateLimit(req('10.9.0.3'), 't-half', LIMIT, 60_000)).not.toBeNull()
  })

  it('separates principals behind a trusted proxy (TRUST_PROXY=1): one IP exhausting its bucket does not block another', async () => {
    // Distinct x-forwarded-for values are distinct principals ONLY in the
    // trusted-proxy posture — the one topology where per-client keys are
    // honest (issue #156 made the untrusted header ignorable, see below).
    const prev = process.env.TRUST_PROXY
    process.env.TRUST_PROXY = '1'
    try {
      const LIMIT = 1
      expect(await enforceRateLimit(req('10.9.1.1'), 't-keysep', LIMIT, 60_000)).toBeNull()
      expect(await enforceRateLimit(req('10.9.1.1'), 't-keysep', LIMIT, 60_000)).not.toBeNull()
      // different principal, same bucket name — fresh bucket
      expect(await enforceRateLimit(req('10.9.1.2'), 't-keysep', LIMIT, 60_000)).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY
      else process.env.TRUST_PROXY = prev
    }
  })

  it('issue #156: TRUST_PROXY unset → XFF ROTATION does not refresh the bucket — all callers share the one anon principal', async () => {
    // The old first-XFF semantics let a client mint a fresh bucket per
    // request by rotating the (forgeable) left-most value. Now the header is
    // ignored entirely without TRUST_PROXY: every request lands on the same
    // anon bucket, so the limit actually binds.
    const prev = process.env.TRUST_PROXY
    delete process.env.TRUST_PROXY
    try {
      const LIMIT = 3
      for (let i = 0; i < LIMIT; i++) {
        const rotating = `198.51.100.${i + 1}` // a DIFFERENT spoofed XFF per request
        expect(await enforceRateLimit(req(rotating), 't-xff-rotation', LIMIT, 60_000), `request ${i + 1} should pass`).toBeNull()
      }
      // a brand-new "IP" is still the same anon principal → blocked
      expect(await enforceRateLimit(req('198.51.99.99'), 't-xff-rotation', LIMIT, 60_000)).not.toBeNull()
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY
      else process.env.TRUST_PROXY = prev
    }
  })

  it('issue #156: TRUST_PROXY unset → no XFF at all shares that same anon bucket (one honest bucket)', async () => {
    const prev = process.env.TRUST_PROXY
    delete process.env.TRUST_PROXY
    try {
      const LIMIT = 2
      expect(await enforceRateLimit(req('203.0.113.5'), 't-anon-collapse', LIMIT, 60_000)).toBeNull()
      expect(await enforceRateLimit(req(undefined), 't-anon-collapse', LIMIT, 60_000)).toBeNull()
      expect(await enforceRateLimit(req(undefined), 't-anon-collapse', LIMIT, 60_000)).not.toBeNull()
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY
      else process.env.TRUST_PROXY = prev
    }
  })

  it('separates buckets: exhausting bucket A leaves bucket B untouched', async () => {
    const LIMIT = 1
    expect(await enforceRateLimit(req('10.9.2.1'), 't-bucketA', LIMIT, 60_000)).toBeNull()
    expect(await enforceRateLimit(req('10.9.2.1'), 't-bucketA', LIMIT, 60_000)).not.toBeNull()
    expect(await enforceRateLimit(req('10.9.2.1'), 't-bucketB', LIMIT, 60_000)).toBeNull()
  })

  it('a sub-1 limit is clamped to 1 (Math.max floor), not zero', async () => {
    const res = await enforceRateLimit(req('10.9.3.1'), 't-clamp', 0.5, 60_000)
    expect(res).toBeNull() // first request passes — the clamp made the bucket size 1
    expect(await enforceRateLimit(req('10.9.3.1'), 't-clamp', 0.5, 60_000)).not.toBeNull()
  })
})

describe('login lockout (5 failures / 15 min, per email+IP)', () => {
  it('does not lock before the failure limit is reached', () => {
    for (let i = 1; i < LOGIN_FAILURE_LIMIT; i++) {
      const { locked } = recordLoginFailure('a@x.co', '10.1.0.1')
      expect(locked, `failure #${i} must not lock`).toBe(false)
      expect(checkLoginLockout('a@x.co', '10.1.0.1').locked).toBe(false)
    }
  })

  it('locks exactly on the 5th failure for 15 minutes', () => {
    for (let i = 1; i < LOGIN_FAILURE_LIMIT; i++) recordLoginFailure('b@x.co', '10.1.0.2')
    const tripped = recordLoginFailure('b@x.co', '10.1.0.2')
    expect(tripped.locked).toBe(true)
    expect(tripped.msLeft).toBeGreaterThan(0)
    expect(tripped.msLeft).toBeLessThanOrEqual(LOGIN_LOCKOUT_MS)

    const state = checkLoginLockout('b@x.co', '10.1.0.2')
    expect(state.locked).toBe(true)
    expect(state.msLeft).toBeGreaterThan(0)
  })

  it('dual-tracked: the lock is keyed by email AND by (email, IP) — distributed guessing still locks the account', () => {
    // 5 failures for one account from ONE IP trip BOTH trackers: the account
    // is locked (email key — defeats distributed password-guessing across
    // IPs) and the (email|IP) pair is locked.
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) recordLoginFailure('c@x.co', '10.1.0.3')
    expect(checkLoginLockout('c@x.co', '10.1.0.3').locked).toBe(true)
    // Same account, different IP: still locked via the email-keyed tracker.
    expect(checkLoginLockout('c@x.co', '10.1.0.4').locked).toBe(true)
    // A DIFFERENT account from the same IP: a different (email|IP) pair and a
    // different email key — not locked (the lock never leaks across accounts).
    expect(checkLoginLockout('d@x.co', '10.1.0.3').locked).toBe(false)
  })

  it('serves the lock: after 15 min the account is unlocked with a clean slate', () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) recordLoginFailure('e@x.co', '10.1.0.5')
    expect(checkLoginLockout('e@x.co', '10.1.0.5').locked).toBe(true)

    vi.advanceTimersByTime(LOGIN_LOCKOUT_MS + 1)
    expect(checkLoginLockout('e@x.co', '10.1.0.5').locked).toBe(false)
    // clean slate: failures counter was reset with the served lock
    const again = recordLoginFailure('e@x.co', '10.1.0.5')
    expect(again.locked).toBe(false)
  })

  it('a cold window restarts the count (4 failures + 15 min idle + 1 ≠ lock)', () => {
    for (let i = 1; i < LOGIN_FAILURE_LIMIT; i++) recordLoginFailure('f@x.co', '10.1.0.6')
    vi.advanceTimersByTime(LOGIN_WINDOW_MS + 1)
    const fresh = recordLoginFailure('f@x.co', '10.1.0.6')
    expect(fresh.locked).toBe(false)
    expect(checkLoginLockout('f@x.co', '10.1.0.6').locked).toBe(false)
  })

  it('a successful login wipes the tracker entirely', () => {
    for (let i = 1; i < LOGIN_FAILURE_LIMIT; i++) recordLoginFailure('g@x.co', '10.1.0.7')
    clearLoginFailures('g@x.co', '10.1.0.7')
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i++) recordLoginFailure('g@x.co', '10.1.0.7')
    expect(checkLoginLockout('g@x.co', '10.1.0.7').locked).toBe(false)
  })

  it('email matching is case/whitespace tolerant (same tracker)', () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) recordLoginFailure('  H@X.CO ', '10.1.0.8')
    expect(checkLoginLockout('h@x.co', '10.1.0.8').locked).toBe(true)
  })
})

// -------------------------------------------------------- USSD PIN lockout

describe('USSD PIN lockout engine (createUssdPinLockout, issue #106 / BE-9; keying per issue #176)', () => {
  /** A fresh engine over a fresh store with an INJECTED clock — deterministic. */
  function makeEngine() {
    let at = new Date('2026-01-05T09:00:00Z').getTime()
    return {
      lock: createUssdPinLockout(new MemoryLoginTrackerStore(), () => at),
      advance: (ms: number) => { at += ms },
      now: () => at,
    }
  }

  it('does not lock before the failure limit is reached (one ip principal)', () => {
    const { lock } = makeEngine()
    for (let i = 1; i < USSD_PIN_FAILURE_LIMIT; i++) {
      const { locked } = lock.recordUssdPinFailure({ ip: '203.0.113.7' })
      expect(locked, `failure #${i} must not lock`).toBe(false)
      expect(lock.checkUssdPinLockout({ ip: '203.0.113.7' }).locked).toBe(false)
    }
  })

  it('locks exactly on the 5th failure for 15 minutes', () => {
    const { lock } = makeEngine()
    for (let i = 1; i < USSD_PIN_FAILURE_LIMIT; i++) lock.recordUssdPinFailure({ ip: '203.0.113.7' })
    const tripped = lock.recordUssdPinFailure({ ip: '203.0.113.7' })
    expect(tripped.locked).toBe(true)
    expect(tripped.msLeft).toBeGreaterThan(0)
    expect(tripped.msLeft).toBeLessThanOrEqual(USSD_PIN_LOCKOUT_MS)
    const state = lock.checkUssdPinLockout({ ip: '203.0.113.7' })
    expect(state.locked).toBe(true)
    expect(state.msLeft).toBeGreaterThan(0)
  })

  it('issue #176 AC1 — keyed on the CLIENT IP: the budget is one per principal (rotating phones/ip-adjacent noise cannot mint fresh budgets)', () => {
    const { lock } = makeEngine()
    // The engine never sees the phone: 5 wrong PINs land on the same ip key
    // regardless of what phone the route carried them on.
    for (let i = 0; i < USSD_PIN_FAILURE_LIMIT; i++) lock.recordUssdPinFailure({ ip: '203.0.113.7' })
    expect(lock.checkUssdPinLockout({ ip: '203.0.113.7' }).locked).toBe(true)
    // A DIFFERENT principal has its own budget — never blocked by another's.
    expect(lock.checkUssdPinLockout({ ip: '198.51.100.4' }).locked).toBe(false)
    expect(lock.recordUssdPinFailure({ ip: '198.51.100.4' }).locked).toBe(false)
  })

  it("ip '' (TRUST_PROXY unset) = the ONE shared anon principal — every untrusted caller shares one budget", () => {
    const { lock } = makeEngine()
    for (let i = 0; i < USSD_PIN_FAILURE_LIMIT; i++) lock.recordUssdPinFailure({ ip: '' })
    expect(lock.checkUssdPinLockout({ ip: '' }).locked).toBe(true)
    // every caller collapses onto the same '' principal — even with a
    // differently-trimmed value (whitespace-tolerant, same tracker).
    expect(lock.checkUssdPinLockout({ ip: '  ' }).locked).toBe(true)
  })

  it('issue #176 AC2 — per-worker tracker: attributed wrong PINs accumulate on the worker REGARDLESS of which ip (hence phone) sent them', () => {
    const { lock } = makeEngine()
    for (let i = 0; i < 2; i++) lock.recordUssdPinFailure({ ip: '203.0.113.7', workerId: 'w-9' })
    for (let i = 0; i < 2; i++) lock.recordUssdPinFailure({ ip: '198.51.100.4', workerId: 'w-9' })
    expect(lock.checkUssdPinLockout({ ip: '198.51.100.4', workerId: 'w-9' }).locked).toBe(false)
    // the 5th attributed strike — from a THIRD ip — trips the WORKER lock…
    const tripped = lock.recordUssdPinFailure({ ip: '192.0.2.9', workerId: 'w-9' })
    expect(tripped.locked).toBe(true)
    // …which follows the worker identity from ANY ip/phone ("regardless of
    // which phone sent them" — the check refuses the resolution, not the line).
    expect(lock.checkUssdPinLockout({ ip: '203.0.113.7', workerId: 'w-9' }).locked).toBe(true)
    expect(lock.checkUssdPinLockout({ ip: '198.51.100.4', workerId: 'w-9' }).locked).toBe(true)
    expect(lock.checkUssdPinLockout({ ip: '192.0.2.9', workerId: 'w-9' }).locked).toBe(true)
    // another worker resolving from the same ips is untouched.
    expect(lock.checkUssdPinLockout({ ip: '203.0.113.7', workerId: 'w-other' }).locked).toBe(false)
  })

  it('clear({workerId}) wipes ONLY the worker tracker — the ip-keyed budget stays sticky (the #176 refresh exploit stays closed)', () => {
    const { lock } = makeEngine()
    for (let i = 0; i < USSD_PIN_FAILURE_LIMIT; i++) {
      lock.recordUssdPinFailure({ ip: '203.0.113.7', workerId: 'w-9' })
    }
    lock.clearUssdPinFailures({ workerId: 'w-9' }) // a correct kiosk PIN, per the route
    // the WORKER's own count restarted: resolving w-9 from a FRESH ip is fine…
    expect(lock.checkUssdPinLockout({ ip: '192.0.2.9', workerId: 'w-9' }).locked).toBe(false)
    // …but the ip principal is STILL locked — a success cannot refresh the
    // attacker's guessing budget (the phone-tail refresh vehicle is dead).
    expect(lock.checkUssdPinLockout({ ip: '203.0.113.7' }).locked).toBe(true)
  })

  it('a cold window restarts the count (4 failures + 15 min idle + 1 ≠ lock)', () => {
    const { lock, advance } = makeEngine()
    for (let i = 1; i < USSD_PIN_FAILURE_LIMIT; i++) lock.recordUssdPinFailure({ ip: '203.0.113.7' })
    advance(USSD_PIN_WINDOW_MS + 1)
    expect(lock.recordUssdPinFailure({ ip: '203.0.113.7' }).locked).toBe(false)
    expect(lock.checkUssdPinLockout({ ip: '203.0.113.7' }).locked).toBe(false)
  })

  it('serves the lock: after 15 min the principal is unlocked with a clean slate', () => {
    const { lock, advance } = makeEngine()
    for (let i = 0; i < USSD_PIN_FAILURE_LIMIT; i++) lock.recordUssdPinFailure({ ip: '203.0.113.7' })
    expect(lock.checkUssdPinLockout({ ip: '203.0.113.7' }).locked).toBe(true)
    advance(USSD_PIN_LOCKOUT_MS + 1)
    expect(lock.checkUssdPinLockout({ ip: '203.0.113.7' }).locked).toBe(false)
    // clean slate: the counter restarted with the served lock
    expect(lock.recordUssdPinFailure({ ip: '203.0.113.7' }).locked).toBe(false)
  })

  it('checking does not consume or extend the lock (a probe during the lock)', () => {
    const { lock, advance } = makeEngine()
    for (let i = 0; i < USSD_PIN_FAILURE_LIMIT; i++) lock.recordUssdPinFailure({ ip: '203.0.113.7' })
    const before = lock.checkUssdPinLockout({ ip: '203.0.113.7' }).msLeft
    for (let i = 0; i < 10; i++) expect(lock.checkUssdPinLockout({ ip: '203.0.113.7' }).locked).toBe(true)
    advance(1000)
    expect(lock.checkUssdPinLockout({ ip: '203.0.113.7' }).msLeft).toBe(before - 1000)
  })

  it('an empty scope is a programmer error, not a silent no-op (throws — never an unbounded budget)', () => {
    const { lock } = makeEngine()
    expect(() => lock.checkUssdPinLockout({})).toThrow()
    expect(() => lock.recordUssdPinFailure({})).toThrow()
    expect(() => lock.clearUssdPinFailures({})).toThrow()
  })
})

// -------------------------------------------------- /api/ai/* body caps (BE-5)

describe('enforceAiRoutePolicy — per-route raw-body caps (issue #105 / BE-5)', () => {
  const MB = 1024 * 1024
  let ipSeq = 0

  /** A gate request with a JSON body of EXACTLY `bytes` utf-8 bytes. */
  function gateReq(bytes: number, opts: { declaredContentLength?: string } = {}): NextRequest {
    ipSeq += 1
    // {"text":"…"} — measure the envelope so the body is EXACTLY `bytes`.
    const envelope = JSON.stringify({ text: '' }).length
    const inner = bytes - envelope
    const raw = JSON.stringify({ text: 'a'.repeat(inner) })
    if (Buffer.byteLength(raw, 'utf8') !== bytes) {
      throw new Error(`fixture math: wanted ${bytes} bytes, built ${Buffer.byteLength(raw, 'utf8')}`)
    }
    return new NextRequest('http://localhost/api/ai/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `10.44.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`,
        ...(opts.declaredContentLength !== undefined
          ? { 'content-length': opts.declaredContentLength }
          : {}),
      },
      body: raw,
    })
  }

  const fields = [{ name: 'text', type: 'string' as const }]

  it('DEFAULT cap is 128 KB: a body AT the cap passes the gate (ok: true)', async () => {
    const gate = await enforceAiRoutePolicy(gateReq(AI_ROUTE_DEFAULT_MAX_BODY_BYTES), {
      bucket: 'ai:cap-default-at', fields,
    })
    expect(gate.ok).toBe(true)
    if (gate.ok) {
      const envelope = JSON.stringify({ text: '' }).length
      expect(gate.body.text).toHaveLength(AI_ROUTE_DEFAULT_MAX_BODY_BYTES - envelope)
    }
  })

  it('DEFAULT cap: one byte over 128 KB → 400 with the honest size message', async () => {
    const gate = await enforceAiRoutePolicy(gateReq(AI_ROUTE_DEFAULT_MAX_BODY_BYTES + 1), {
      bucket: 'ai:cap-default-over', fields,
    })
    expect(gate.ok).toBe(false)
    if (!gate.ok) {
      expect(gate.response.status).toBe(400)
      expect(await gate.response.json()).toEqual({
        error: 'Request body too large — this endpoint accepts at most 128 KB',
      })
    }
  })

  it('a DECLARED Content-Length beyond the cap is refused before the body is read', async () => {
    ipSeq += 1
    const gate = await enforceAiRoutePolicy(new NextRequest('http://localhost/api/ai/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '10.44.77.7',
        'content-length': String(129 * 1024), // the lie: claims 129 KB, ships 10 bytes
      },
      body: '{"text":"x"}',
    }), { bucket: 'ai:cap-declared', fields })
    expect(gate.ok).toBe(false)
    if (!gate.ok) {
      expect(gate.response.status).toBe(400)
      expect(await gate.response.json()).toMatchObject({ error: expect.stringContaining('128 KB') })
    }
  })

  it('a LYING small Content-Length over a big body is caught by the post-read count', async () => {
    const gate = await enforceAiRoutePolicy(gateReq(AI_ROUTE_DEFAULT_MAX_BODY_BYTES + 500, { declaredContentLength: '10' }), {
      bucket: 'ai:cap-lie', fields,
    })
    expect(gate.ok).toBe(false)
    if (!gate.ok) {
      expect(gate.response.status).toBe(400)
      expect(await gate.response.json()).toMatchObject({ error: expect.stringContaining('128 KB') })
    }
  })

  it('voice-log cap (13 MB): a 12.9 MB body passes the gate', async () => {
    const gate = await enforceAiRoutePolicy(gateReq(Math.floor(12.9 * MB)), {
      bucket: 'ai:cap-voice-under', fields, maxBytes: AI_VOICE_LOG_MAX_BODY_BYTES,
    })
    expect(gate.ok).toBe(true)
  })

  it('voice-log cap (13 MB): a 13.1 MB body → 400 naming 13 MB', async () => {
    const gate = await enforceAiRoutePolicy(gateReq(Math.floor(13.1 * MB)), {
      bucket: 'ai:cap-voice-over', fields, maxBytes: AI_VOICE_LOG_MAX_BODY_BYTES,
    })
    expect(gate.ok).toBe(false)
    if (!gate.ok) {
      expect(gate.response.status).toBe(400)
      expect(await gate.response.json()).toEqual({
        error: 'Request body too large — this endpoint accepts at most 13 MB',
      })
    }
  })

  it('analyze-photo cap (6 MB): a 5.9 MB body passes, a 6.1 MB body → 400 naming 6 MB', async () => {
    const under = await enforceAiRoutePolicy(gateReq(Math.floor(5.9 * MB)), {
      bucket: 'ai:cap-photo-under', fields, maxBytes: AI_PHOTO_MAX_BODY_BYTES,
    })
    expect(under.ok).toBe(true)

    const over = await enforceAiRoutePolicy(gateReq(Math.floor(6.1 * MB)), {
      bucket: 'ai:cap-photo-over', fields, maxBytes: AI_PHOTO_MAX_BODY_BYTES,
    })
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.response.status).toBe(400)
      expect(await over.response.json()).toEqual({
        error: 'Request body too large — this endpoint accepts at most 6 MB',
      })
    }
  })

  it('the cap does not disturb the other gate checks: invalid JSON still → 400 Invalid JSON body', async () => {
    ipSeq += 1
    const res = await enforceAiRoutePolicy(new NextRequest('http://localhost/api/ai/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `10.44.99.9`,
      },
      body: '{not json',
    }), { bucket: 'ai:cap-badjson', fields })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(await res.response.json()).toEqual({ error: 'Invalid JSON body' })
  })
})

describe('formatByteCap — the honest size label', () => {
  it('renders the repo cap vocabulary (KB / MB / bytes)', () => {
    expect(formatByteCap(64 * 1024)).toBe('64 KB')
    expect(formatByteCap(128 * 1024)).toBe('128 KB')
    expect(formatByteCap(6 * 1024 * 1024)).toBe('6 MB')
    expect(formatByteCap(13 * 1024 * 1024)).toBe('13 MB')
    expect(formatByteCap(1000)).toBe('1000 bytes')
    expect(formatByteCap(1536)).toBe('1536 bytes') // not a clean multiple → honest bytes
  })
})
