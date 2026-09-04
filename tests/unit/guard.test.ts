/**
 * Invariants of the server-side guard (src/backend/lib/guard.ts).
 *
 * guard.ts is the enforcement point for every owner API. Two families:
 *  1. ROLE MIRROR SYNC — src/shared/permissions.ts is documented as a mirror
 *     of guard.ts's role sets ("keep in sync", both headers). If one side
 *     drifts, the UI shows buttons the server rejects (or hides real
 *     features). These tests pin the exported sets and the capability
 *     projections to the guard's truth.
 *  2. ERROR REDACTION (S-SEC) — isInternalError/safeErrorMessage decide what
 *     reaches a client body. Framework internals must NEVER pass; the
 *     appliers' own single-line domain errors must ALWAYS pass.
 */
import { describe, expect, it } from 'vitest'
import {
  FINANCE_ROLES, KNOWN_ROLES as GUARD_KNOWN, OWNER_ROLES as GUARD_OWNER,
  PAYMENT_ROLES, isInternalError, safeErrorMessage,
} from '@/backend/lib/guard'
import { KNOWN_ROLES, OWNER_ROLES, can, isKnownRole } from '@/shared/permissions'

const sorted = (xs: readonly string[]) => [...xs].sort()

describe('role registry mirrors guard.ts (W1-PERM contract)', () => {
  it('KNOWN_ROLES is identical on both sides', () => {
    expect(sorted(KNOWN_ROLES)).toEqual(sorted(GUARD_KNOWN))
  })

  it('OWNER_ROLES is identical on both sides', () => {
    expect(sorted(OWNER_ROLES)).toEqual(sorted(GUARD_OWNER))
  })

  it('every guard role is known to the client mirror (and vice versa)', () => {
    for (const role of GUARD_KNOWN) expect(isKnownRole(role)).toBe(true)
  })
})

describe('capability projections track the guard allowlists', () => {
  it("can(role, 'finance.queue') === FINANCE_ROLES membership, for every role", () => {
    for (const role of KNOWN_ROLES) {
      expect(can(role, 'finance.queue')).toBe(FINANCE_ROLES.includes(role))
    }
  })

  it("can(role, 'payments.execute') === PAYMENT_ROLES membership, for every role", () => {
    for (const role of KNOWN_ROLES) {
      expect(can(role, 'payments.execute')).toBe(PAYMENT_ROLES.includes(role))
    }
  })

  it("can(role, 'owner.app') === OWNER_ROLES membership, for every role", () => {
    for (const role of KNOWN_ROLES) {
      expect(can(role, 'owner.app')).toBe(GUARD_OWNER.includes(role))
    }
  })
})

describe('isInternalError — framework internals are detected', () => {
  it('flags Prisma-shaped errors by constructor name', () => {
    // Real Prisma errors are instances of Prisma* classes — the check reads
    // e.constructor.name, so a genuine subclass trips it.
    class PrismaClientKnownRequestError extends Error {}
    expect(isInternalError(new PrismaClientKnownRequestError('boom'))).toBe(true)
  })

  it('ignores a hand-set .name property (constructor is the truth)', () => {
    const e = new Error('business rule text')
    e.name = 'PrismaClientValidationError'
    expect(isInternalError(e)).toBe(false)
  })

  it('flags Prisma error codes (P####)', () => {
    const e = new Error('Record not found')
    Object.assign(e, { code: 'P2025' })
    expect(isInternalError(e)).toBe(true)
  })

  it('flags the Prisma "invocation in" validation banner', () => {
    expect(isInternalError(new Error('Invalid `prisma.task.findMany()` invocation in /app/src/x.ts'))).toBe(true)
  })

  it('flags multi-line / stack-like messages', () => {
    expect(isInternalError(new Error('line one\nline two'))).toBe(true)
  })

  it('lets single-line domain errors through', () => {
    expect(isInternalError(new Error('Task not found'))).toBe(false)
    expect(isInternalError(new Error('Too many skills — at most 20 are allowed'))).toBe(false)
  })

  it('non-Error values are not internal', () => {
    expect(isInternalError('string')).toBe(false)
    expect(isInternalError(null)).toBe(false)
    expect(isInternalError({ message: 'x' })).toBe(false)
  })
})

describe('safeErrorMessage — clients see domain truth, never internals', () => {
  it('passes single-line domain errors verbatim', () => {
    expect(safeErrorMessage(new Error('Delivery not found in this project'), 'fallback')).toBe(
      'Delivery not found in this project',
    )
  })

  it('replaces Prisma internals with the fallback', () => {
    const e = new Error('prisma internals\nwith paths')
    expect(safeErrorMessage(e, 'Request failed')).toBe('Request failed')
  })

  it('replaces non-Errors with the fallback', () => {
    expect(safeErrorMessage(undefined, 'Request failed')).toBe('Request failed')
    expect(safeErrorMessage('oops', 'Request failed')).toBe('Request failed')
  })
})
