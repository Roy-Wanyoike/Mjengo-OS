/**
 * Integer-cents money core (src/backend/lib/money.ts) — issue #122.
 *
 * Pins the properties the whole money stack leans on:
 *  · parsing accepts every true ≤2-dp value INCLUDING the IEEE-754 traps
 *    the old float check rejected (0.29, 0.57, 1234567.89) and refuses
 *    every >2-dp value (0.005, 0.295, 1e9+0.01 …);
 *  · cents ↔ KSh conversion round-trips every representable amount;
 *  · sums are exact for adversarial float-drift inputs (0.1+0.2 class);
 *  · qty × unit price is exact with half-up rounding at the half-cent;
 *  · formatting is stable (no float artifacts);
 *  · optional non-negative prices (the #285 BoqLine.estUnitPrice contract)
 *    convert at write boundaries: nullish/empty/zero → 0n, everything
 *    unverifiable refused with the honest error.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_MONEY_CENTS,
  MAX_MONEY_KES,
  assertMoneyCents,
  centsToKes,
  centsToKesString,
  fmtKes,
  mulQtyCents,
  nonNegativeKesToCents,
  parseMoneyCents,
  parseQtyMilli,
  parseSignedMoneyCents,
  snapCents,
  sumCents,
} from '@/backend/lib/money'

describe('parseMoneyCents — the 2-dp contract', () => {
  it('accepts every true 2-dp value, including the float-era rejections', () => {
    // These were REJECTED by the old Math.round(v*100) !== v*100 check.
    for (const v of [0.29, 0.57, 1234567.89, 0.01, 0.99, 65000.55, 999999999.99]) {
      expect(parseMoneyCents(v), `parseMoneyCents(${v})`).not.toBeNull()
    }
    expect(parseMoneyCents(0.29)).toBe(29n)
    expect(parseMoneyCents(0.57)).toBe(57n)
    expect(parseMoneyCents(1234567.89)).toBe(123456789n)
    expect(parseMoneyCents(65000.55)).toBe(6500055n)
  })

  it('accepts numeric strings ("65000.50") and float-noise numbers (0.1+0.2)', () => {
    expect(parseMoneyCents('65000.50')).toBe(6500050n)
    expect(parseMoneyCents(0.1 + 0.2)).toBe(30n) // 0.30000000000000004 → 30 cents
    expect(parseMoneyCents(' 42 ')).toBe(4200n)
  })

  it('refuses >2-dp values', () => {
    for (const v of [0.005, 0.295, 1.001, 65000.555, '0.333']) {
      expect(parseMoneyCents(v), `parseMoneyCents(${v})`).toBeNull()
    }
  })

  it('refuses non-positive, non-finite, out-of-bound and coercible-but-wrong input', () => {
    for (const v of [0, -1, -0.01, NaN, Infinity, -Infinity, MAX_MONEY_KES + 0.01, 1e12, '', '  ', 'abc', '12,5', true, false, null, undefined, {}, [], [5], new Date(0)]) {
      expect(parseMoneyCents(v), `parseMoneyCents(${JSON.stringify(String(v))})`).toBeNull()
    }
  })

  it('accepts exactly the bound, refuses one cent more', () => {
    expect(parseMoneyCents(MAX_MONEY_KES)).toBe(MAX_MONEY_CENTS)
    expect(parseMoneyCents(MAX_MONEY_KES + 0.01)).toBeNull()
  })

  it('assertMoneyCents throws the shared honest error', () => {
    expect(() => assertMoneyCents(0.005)).toThrow(/at most 1000000000 \(KSh\)/)
    expect(() => assertMoneyCents(-3, 'budget')).toThrow(/^budget: /)
    expect(assertMoneyCents(12.34)).toBe(1234n)
  })
})

describe('parseSignedMoneyCents — variation-order budget impact', () => {
  it('keeps the sign and refuses zero', () => {
    expect(parseSignedMoneyCents(-45000.5)).toBe(-4500050n)
    expect(parseSignedMoneyCents(45000.5)).toBe(4500050n)
    expect(parseSignedMoneyCents(0)).toBeNull()
    expect(parseSignedMoneyCents(-0.29)).toBe(-29n) // the float trap, signed
  })

  it('applies the same 2-dp + bound rules to the absolute value', () => {
    expect(parseSignedMoneyCents(-0.005)).toBeNull()
    expect(parseSignedMoneyCents(-(MAX_MONEY_KES + 0.01))).toBeNull()
    expect(parseSignedMoneyCents(-MAX_MONEY_KES)).toBe(-MAX_MONEY_CENTS)
  })
})

describe('nonNegativeKesToCents — optional price fields at write boundaries (#285)', () => {
  it('converts every valid non-negative KSh value (number or numeric string)', () => {
    expect(nonNegativeKesToCents(650)).toBe(65000n) // the #285 repro: KSh 650/u cement
    expect(nonNegativeKesToCents(3250.5)).toBe(325050n)
    expect(nonNegativeKesToCents('90.25')).toBe(9025n) // outbox replays JSON
    expect(nonNegativeKesToCents('0.00')).toBe(0n)
    expect(nonNegativeKesToCents(MAX_MONEY_KES)).toBe(MAX_MONEY_CENTS)
  })

  it('treats nullish / empty / zero as "no price on file" → 0n (legacy Number(x ?? 0) lenience)', () => {
    expect(nonNegativeKesToCents(undefined)).toBe(0n)
    expect(nonNegativeKesToCents(null)).toBe(0n)
    expect(nonNegativeKesToCents(0)).toBe(0n)
    expect(nonNegativeKesToCents('')).toBe(0n)
    expect(nonNegativeKesToCents('   ')).toBe(0n)
  })

  it('refuses what integer cents cannot represent — with the field-named honest error', () => {
    for (const bad of [-650, 650.555, NaN, Infinity, true, { kes: 650 }, ['650']]) {
      expect(() => nonNegativeKesToCents(bad)).toThrow('estUnitPrice: must be a non-negative number')
    }
    // The bound rule rides through: a price above the platform cap refuses.
    expect(() => nonNegativeKesToCents(MAX_MONEY_KES + 0.01)).toThrow(/at most 1000000000/)
    // The field name is a parameter — callers name their own payload field.
    expect(() => nonNegativeKesToCents(-1, 'unitPrice')).toThrow('unitPrice: must be a non-negative number')
  })
})

describe('snapCents / centsToKes — conversion round-trips', () => {
  it('round-trips every 2-dp KSh value through cents exactly', () => {
    for (const kes of [0.01, 0.29, 0.99, 123.45, 65000.5, 999999999.99]) {
      expect(centsToKes(snapCents(kes))).toBe(kes)
    }
  })

  it('snapCents tolerates pure float noise and throws on garbage', () => {
    expect(snapCents(0.1 + 0.2)).toBe(30n)
    expect(snapCents(1234567.89)).toBe(123456789n)
    expect(() => snapCents(NaN)).toThrow()
    expect(() => snapCents(Infinity)).toThrow()
  })

  it('centsToKesString never emits float artifacts', () => {
    expect(centsToKesString(6500050n)).toBe('65000.50')
    expect(centsToKesString(29n)).toBe('0.29')
    expect(centsToKesString(0n)).toBe('0.00')
    expect(centsToKesString(-4500050n)).toBe('-45000.50')
    expect(centsToKesString(123456789n)).toBe('1234567.89')
  })

  it('fmtKes groups thousands', () => {
    expect(fmtKes(6500050n)).toBe('KSh 65,000.50')
    expect(fmtKes(-123456789n)).toBe('KSh -1,234,567.89')
  })
})

describe('sumCents — exact accumulation', () => {
  it('sums the classic drift case exactly (0.1+0.2 × many)', () => {
    // 10 × KSh 0.10 + 10 × KSh 0.20 must be exactly KSh 3.00
    const entries = [...Array(10)].flatMap(() => [10n, 20n])
    expect(sumCents(entries)).toBe(300n)
  })

  it('stays exact where float accumulation drifts', () => {
    let floatSum = 0
    const cents: bigint[] = []
    for (let i = 0; i < 1000; i++) {
      floatSum += 0.29
      cents.push(29n)
    }
    expect(sumCents(cents)).toBe(29000n)
    expect(floatSum).not.toBe(290) // the float era actually drifts — proof the fix matters
  })

  it('empty sum is 0n', () => {
    expect(sumCents([])).toBe(0n)
  })
})

describe('mulQtyCents — qty × unit price', () => {
  it('multiplies whole quantities exactly', () => {
    expect(mulQtyCents(10, 12500n)).toBe(125000n) // 10 bags @ KSh 125.00
  })

  it('multiplies fractional (≤3-dp) quantities exactly', () => {
    expect(mulQtyCents(2.5, 12550n)).toBe(31375n) // 2.5 @ KSh 125.50
    expect(mulQtyCents(0.125, 8000n)).toBe(1000n) // 0.125 @ KSh 80.00 → KSh 10.00
    expect(mulQtyCents(1.005, 100000n)).toBe(100500n) // 1.005 @ KSh 1000.00
  })

  it('rounds the half-cent UP (half-up policy)', () => {
    // 0.025 @ KSh 1.00 → 2.5 cents → 3 cents (half-up)
    expect(mulQtyCents(0.025, 100n)).toBe(3n)
    // 0.015 @ KSh 1.00 → 1.5 cents → 2 cents
    expect(mulQtyCents(0.015, 100n)).toBe(2n)
  })

  it('refuses >3-dp quantities, zero, negatives and overflow past the bound', () => {
    expect(() => mulQtyCents(0.0005, 100n)).toThrow(/at most 3 decimal places/)
    expect(() => mulQtyCents(0, 100n)).toThrow()
    expect(() => mulQtyCents(-1, 100n)).toThrow()
    expect(() => mulQtyCents(1000, MAX_MONEY_CENTS)).toThrow(/at most 1000000000/)
  })

  it('parseQtyMilli lifts and validates quantities', () => {
    expect(parseQtyMilli(2.5)).toBe(2500n)
    expect(parseQtyMilli('3')).toBe(3000n)
    expect(parseQtyMilli(0.001)).toBe(1n)
    expect(parseQtyMilli(0.0001)).toBeNull()
    expect(parseQtyMilli(0)).toBeNull()
    expect(parseQtyMilli(-2)).toBeNull()
    expect(parseQtyMilli(true)).toBeNull()
    expect(parseQtyMilli('abc')).toBeNull()
  })
})

describe('the money invariants the ledger depends on', () => {
  it('balanced legs compare exactly — no 0.005 tolerance', () => {
    const debits = [29n, 0n + 57n, 123456789n]
    const credits = [123456789n, 86n]
    const d = sumCents(debits)
    const c = sumCents(credits)
    expect(d === c).toBe(true) // 123456875n both sides — the float era needed a tolerance for this
  })

  it('a one-cent imbalance is detectable', () => {
    expect(sumCents([100n, 200n]) === sumCents([100n, 201n])).toBe(false)
  })
})
