/**
 * Invariants of the in-process security primitives
 * (src/backend/lib/rate-limit.ts — W1-SEC).
 *
 * Two stateful engines are pinned here, under fake timers so the math is
 * deterministic:
 *  · Token bucket (enforceRateLimit): the first `limit` requests pass, the
 *    next gets an honest 429 + Retry-After, tokens refill continuously with
 *    time, and (bucket, principal) keys never bleed into each other.
 *  · Login lockout: 5 failures in 15 min (per email+IP) lock for 15 min —
 *    not one failure earlier, not after the lock is served, and a cold
 *    window restarts the count. Success resets everything.
 *
 * db is stubbed: only enforceAiRoutePolicy touches Prisma, and these tests
 * exercise the primitives, not the AI route policy.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => ({ db: {} }))

import {
  LOGIN_FAILURE_LIMIT, LOGIN_LOCKOUT_MS, LOGIN_WINDOW_MS,
  checkLoginLockout, clearLoginFailures, clientIpFromHeaders, enforceRateLimit,
  recordLoginFailure,
} from '@/backend/lib/rate-limit'

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
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.NEXTAUTH_SECRET
})

describe('clientIpFromHeaders', () => {
  it('reads the FIRST x-forwarded-for hop, trimmed', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' }))).toBe('203.0.113.7')
  })

  it('accepts plain records too (lower- and upper-case)', () => {
    expect(clientIpFromHeaders({ 'x-forwarded-for': '198.51.100.9, 10.0.0.2' })).toBe('198.51.100.9')
    expect(clientIpFromHeaders({ 'X-Forwarded-For': '198.51.100.10' })).toBe('198.51.100.10')
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

  it('separates principals: one IP exhausting its bucket does not block another', async () => {
    const LIMIT = 1
    expect(await enforceRateLimit(req('10.9.1.1'), 't-keysep', LIMIT, 60_000)).toBeNull()
    expect(await enforceRateLimit(req('10.9.1.1'), 't-keysep', LIMIT, 60_000)).not.toBeNull()
    // different principal, same bucket name — fresh bucket
    expect(await enforceRateLimit(req('10.9.1.2'), 't-keysep', LIMIT, 60_000)).toBeNull()
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
