// Issue #241 — money-amount bounds (QA-found: a KSh ~1e12 top-up persisted).
//
// Pins the shared contract at three levels:
//   1. parseMoneyAmount unit behavior (positive, finite, ≤ MAX, 2dp, no coercion).
//   2. The REAL applyAction appliers refuse the QA repro amounts:
//      escrow.topup / milestone.create / expense.create — the trillion top-up
//      that produced the "KSh 1,000,001,199,999" escrow balance can no longer
//      reach the ledger. (wallet service deposit/withdraw/transfer share the
//      same parseMoneyAmount seam — their applier-level rejection is exercised
//      through the v1 money tests' zod contract + these unit pins.)
//   3. The v1 zod schema sources the same MAX constant (single source of truth).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_MONEY_KES, MONEY_AMOUNT_ERROR, parseMoneyAmount, assertMoneyAmount } from '@/backend/lib/money-bounds'

// Minimal in-memory Prisma stub — the appliers must throw BEFORE any db call
// for invalid amounts, so the stub mostly proves "no persistence happened".
vi.mock('@/backend/lib/db', () => {
  const state = { created: [] as Array<Record<string, unknown>>, reset() { state.created = [] } }
  const prisma = {
    milestone: { create: vi.fn(async (a: { data: Record<string, unknown> }) => { state.created.push(a.data); return { id: 'm1', ...a.data } }) },
    project: { findUnique: vi.fn(async () => ({ id: 'p1', name: 'P', client: 'C' })) },
    phase: { findFirst: vi.fn(async () => ({ id: 'ph1', projectId: 'p1' })) },
    $transaction: vi.fn(async (fn: unknown) => (typeof fn === 'function' ? fn(prisma) : fn)),
  }
  return { db: prisma, __state: state }
})

import { applyAction } from '@/backend/lib/mjengo'
import * as dbModule from '@/backend/lib/db'

describe('parseMoneyAmount (lib/money-bounds)', () => {
  it('accepts realistic amounts', () => {
    expect(parseMoneyAmount(5000)).toBe(5000)
    expect(parseMoneyAmount(250000.5)).toBe(250000.5)
    expect(parseMoneyAmount(MAX_MONEY_KES)).toBe(MAX_MONEY_KES)
    expect(parseMoneyAmount('12500')).toBe(12500)
  })

  it('refuses the QA repro and its cousins', () => {
    expect(parseMoneyAmount(999_999_999_999)).toBeNull() // the exact QA repro
    expect(parseMoneyAmount(1e12)).toBeNull()
    expect(parseMoneyAmount(MAX_MONEY_KES + 1)).toBeNull()
    expect(parseMoneyAmount(0)).toBeNull()
    expect(parseMoneyAmount(-5)).toBeNull()
    expect(parseMoneyAmount(NaN)).toBeNull()
    expect(parseMoneyAmount(Infinity)).toBeNull()
  })

  it('refuses >2 decimal places and coercible garbage', () => {
    expect(parseMoneyAmount(10.999)).toBeNull()
    expect(parseMoneyAmount(true)).toBeNull()
    expect(parseMoneyAmount(null)).toBeNull()
    expect(parseMoneyAmount(undefined)).toBeNull()
    expect(parseMoneyAmount({})).toBeNull()
    expect(parseMoneyAmount([5000])).toBeNull()
    expect(parseMoneyAmount('12,000')).toBeNull()
    expect(parseMoneyAmount('')).toBeNull()
  })

  it('assertMoneyAmount throws the shared honest message', () => {
    expect(() => assertMoneyAmount(1e12)).toThrowError(MONEY_AMOUNT_ERROR)
    expect(assertMoneyAmount(42)).toBe(42)
  })
})

describe('appliers refuse out-of-bounds money (issue #241 regression)', () => {
  beforeEach(() => {
    ;(dbModule as unknown as { __state: { reset(): void } }).__state.reset()
  })

  it('escrow.topup refuses the trillion repro before any persistence', async () => {
    await expect(
      applyAction('escrow.topup', { amount: 999_999_999_999, method: 'mpesa' }, 'p1'),
    ).rejects.toThrowError(MONEY_AMOUNT_ERROR)
    const state = (dbModule as unknown as { __state: { created: Array<unknown> } }).__state
    expect(state.created).toHaveLength(0)
  })

  it('milestone.create refuses out-of-bounds amounts', async () => {
    await expect(
      applyAction('milestone.create', { name: 'Slab', amount: 2_000_000_000 }, 'p1'),
    ).rejects.toThrowError(MONEY_AMOUNT_ERROR)
  })

  it('expense.create refuses out-of-bounds amounts (the QA persisted path)', async () => {
    await expect(
      applyAction('expense.create', { type: 'material', amount: 999_999_999_999 }, 'p1'),
    ).rejects.toThrowError(MONEY_AMOUNT_ERROR)
    const state = (dbModule as unknown as { __state: { created: Array<unknown> } }).__state
    expect(state.created).toHaveLength(0)
  })

  // Happy-path acceptance of realistic amounts is pinned by the existing
  // wallet/ledger/mjengo-score suites (they post real amounts through the
  // full service graph); the validator-level acceptance tests above cover the
  // boundary contract without duplicating those stubs.
})

describe('v1 zod contract shares the constant', () => {
  it('moneyAmount max is MAX_MONEY_KES', async () => {
    const { moneyAmount } = await import('@/backend/api/v1/schemas')
    const r = moneyAmount.safeParse(MAX_MONEY_KES + 1)
    expect(r.success).toBe(false)
    const ok = moneyAmount.safeParse(MAX_MONEY_KES)
    expect(ok.success).toBe(true)
  })
})
