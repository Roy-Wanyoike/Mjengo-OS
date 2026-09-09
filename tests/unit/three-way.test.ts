/**
 * Invariants of the pure 3-way match engine
 * (src/backend/modules/invoices/three-way.ts).
 *
 * One algorithm runs server-side (invoice.pay gating) and client-side (the
 * matrix the human reviews) — so its decision outcomes are a contract.
 * Pinned here:
 *  · PO↔invoice↔delivery agreement produces a clean report;
 *  · quantity / price / delivery discrepancies each surface an honest
 *    "review" issue (never a silent pass, never an accusation);
 *  · missing data degrades to "not verifiable", not to "zero";
 *  · the LATEST delivery record is authoritative;
 *  · the A-1-lite ledger consistency math flags phantom and double payments.
 */
import { describe, expect, it } from 'vitest'
import {
  computeLedgerConsistency, matchThreeWay,
  type ThreeWayInvoiceLine, type ThreeWayOrder,
} from '@/backend/modules/invoices/three-way'

const inv = (name: string, qty: number, unitPrice = 100, lineTotal = qty * unitPrice): ThreeWayInvoiceLine => ({
  name, qty, unitPrice, lineTotal,
})

const order = (overrides: Partial<ThreeWayOrder> = {}): ThreeWayOrder => ({
  orderCode: 'PO-2026-000001',
  deliveryFee: 0,
  lines: [
    { id: 'l-cement', name: 'Cement', qty: 50 },
    { id: 'l-steel', name: 'Steel bars', qty: 20 },
  ],
  deliveries: [
    { createdAt: '2026-01-02T10:00:00Z', lines: [{ orderLineId: 'l-cement', qtyReceived: 50 }, { orderLineId: 'l-steel', qtyReceived: 20 }] },
  ],
  ...overrides,
})

describe('matchThreeWay — clean 3-way match', () => {
  it('matching PO, invoice and delivery yields no mismatches', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Cement', 50), inv('Steel bars', 20)],
      order: order(),
    })
    expect(report.mode).toBe('three-way')
    expect(report.hasOrder).toBe(true)
    expect(report.hasDelivery).toBe(true)
    expect(report.mismatches).toEqual([])
    expect(report.lines).toHaveLength(2)
    expect(report.lines[0]).toMatchObject({ poQty: 50, invQty: 50, deliveredQty: 50, feeLine: false })
  })

  it('name matching tolerates case and whitespace drift', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('  CEMENT   bags ', 50)],
      // no delivery yet → the ONLY issue should be the missing delivery, not a
      // failed name match
      order: { ...order(), lines: [{ id: 'l-cement', name: 'cement bags', qty: 50 }], deliveries: [] },
    })
    expect(report.mismatches.map((m) => m.issue)).toEqual(['no delivery recorded yet — physical counts not verifiable'])
    expect(report.lines[0].poQty).toBe(50)
  })
})

describe('matchThreeWay — quantity discrepancies', () => {
  it('invoice billing more than the PO is flagged with both quantities', () => {
    const report = matchThreeWay({ invoiceLines: [inv('Cement', 60)], order: order() })
    const qtyIssue = report.mismatches.find((m) => m.issue.includes('purchase order has'))
    expect(qtyIssue).toBeDefined()
    expect(qtyIssue!.po).toBe(50)
    expect(qtyIssue!.inv).toBe(60)
  })

  it('delivered short of the billed quantity is flagged with the gap', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Cement', 50)],
      order: { ...order(), deliveries: [{ createdAt: '2026-01-02T10:00:00Z', lines: [{ orderLineId: 'l-cement', qtyReceived: 40 }] }] },
    })
    const short = report.mismatches.find((m) => m.issue.includes('short'))
    expect(short).toBeDefined()
    expect(short!.delivered).toBe(40)
    expect(short!.issue).toContain('10 short')
  })

  it('over-delivery is flagged too (supplier may be owed, or counting is off)', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Cement', 50)],
      order: { ...order(), deliveries: [{ createdAt: '2026-01-02T10:00:00Z', lines: [{ orderLineId: 'l-cement', qtyReceived: 55 }] }] },
    })
    expect(report.mismatches.some((m) => m.issue.includes('exceeds the 50 billed'))).toBe(true)
  })
})

describe('matchThreeWay — price (fee) discrepancies', () => {
  it('a delivery fee line reconciles by AMOUNT against the PO fee', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Delivery fee', 1, 2000, 2000)],
      order: { ...order(), deliveryFee: 1500 },
    })
    expect(report.lines[0].feeLine).toBe(true)
    expect(report.lines[0].poQty).toBeNull()
    expect(report.mismatches.some((m) => m.issue.includes('delivery billed 2,000 but the purchase order carries 1,500'))).toBe(true)
  })

  it('a fee that matches the PO fee passes silently', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Transport', 1, 1500, 1500)],
      order: { ...order(), deliveryFee: 1500 },
    })
    expect(report.mismatches).toEqual([])
    expect(report.lines[0].feeLine).toBe(true)
  })

  it('a PO with no fee never fee-flags (nothing to reconcile against)', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Freight', 1, 2000, 2000)],
      order: { ...order(), deliveryFee: 0 },
    })
    expect(report.mismatches).toEqual([])
  })
})

describe('matchThreeWay — missing data degrades honestly', () => {
  it('no delivery rows → deliveredQty null + "not verifiable" (unknown ≠ zero)', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Cement', 50)],
      order: { ...order(), deliveries: [] },
    })
    expect(report.hasDelivery).toBe(false)
    expect(report.lines[0].deliveredQty).toBeNull()
    expect(report.mismatches.some((m) => m.issue.includes('no delivery recorded yet'))).toBe(true)
  })

  it('an invoice line that is not on the PO at all is flagged', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Cement', 50), inv('Wheelbarrow', 5)],
      order: { ...order(), lines: [{ id: 'l-cement', name: 'Cement', qty: 50 }] },
    })
    const notOnPo = report.mismatches.find((m) => m.name === 'Wheelbarrow')
    expect(notOnPo!.issue).toContain('not on the purchase order')
    expect(notOnPo!.po).toBeNull()
  })

  it('unmatched names fall back to POSITIONAL matching but say so', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Portland cement', 50)],
      order: { ...order(), lines: [{ id: 'l-cement', name: 'Cement', qty: 50 }] },
    })
    const positional = report.mismatches.find((m) => m.issue.includes('by position'))
    expect(positional).toBeDefined()
    expect(positional!.issue).toContain('verify the line with the supplier')
  })

  it('the LATEST delivery is authoritative (recounts supersede originals)', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Cement', 50)],
      order: {
        ...order(),
        deliveries: [
          { createdAt: '2026-01-01T08:00:00Z', lines: [{ orderLineId: 'l-cement', qtyReceived: 10 }] },
          { createdAt: '2026-01-03T08:00:00Z', lines: [{ orderLineId: 'l-cement', qtyReceived: 30 }] },
        ],
      },
    })
    expect(report.lines[0].deliveredQty).toBe(30)
  })
})

describe('matchThreeWay — 2-way mode (no purchase order)', () => {
  it('runs a 2-way check against project delivery totals by name', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Cement', 50)],
      order: null,
      projectDeliveries: [{ name: 'Cement', qtyReceived: 50 }],
    })
    expect(report.mode).toBe('two-way')
    expect(report.hasOrder).toBe(false)
    expect(report.note).toContain('No purchase order linked')
    expect(report.mismatches).toEqual([])
  })

  it('flags lines with no delivery record at all (2-way)', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Cement', 50)],
      order: null,
      projectDeliveries: [{ name: 'Balloons', qtyReceived: 3 }],
    })
    expect(report.mismatches.some((m) => m.issue.includes('no delivery record found'))).toBe(true)
  })

  it('flags shortages against project delivery totals (2-way)', () => {
    const report = matchThreeWay({
      invoiceLines: [inv('Cement', 50)],
      order: null,
      projectDeliveries: [{ name: 'Cement', qtyReceived: 45 }],
    })
    expect(report.mismatches.some((m) => m.issue.includes('5 short (2-way check)'))).toBe(true)
  })
})

describe('computeLedgerConsistency — A-1-lite wallet-debit reconciliation', () => {
  it('fully-backed ledger is consistent', () => {
    const check = computeLedgerConsistency({
      walletBalance: 10_000,
      transactions: [
        { type: 'milestone', method: 'wallet', amount: 5000, reference: 'MJP-123456' },
        { type: 'invoice', method: 'wallet', amount: 2000, reference: 'PAY-INV-1' },
        { type: 'invoice', method: 'mpesa', amount: 3000, reference: 'PAY-INV-2' },
      ],
      releasedMilestoneIds: ['cproj-mjp-123456'],
      paidInvoiceReferences: ['PAY-INV-1', 'PAY-INV-2'],
    })
    expect(check.consistent).toBe(true)
    expect(check.drift).toBe(0)
    expect(check.breakdown.unreconciledCount).toBe(0)
    expect(check.breakdown.releases).toBe(5000)
    expect(check.breakdown.walletInvoicePayments).toBe(2000)
    expect(check.breakdown.externalInvoicePayments).toBe(3000)
  })

  it('a milestone row with no released milestone behind it is drift (phantom)', () => {
    const check = computeLedgerConsistency({
      walletBalance: 100,
      transactions: [{ type: 'milestone', method: 'wallet', amount: 7000, reference: 'MJP-999999' }],
      releasedMilestoneIds: ['cproj-mjp-123456'],
      paidInvoiceReferences: [],
    })
    expect(check.consistent).toBe(false)
    expect(check.drift).toBe(7000)
    expect(check.breakdown.unreconciledCount).toBe(1)
  })

  it('paying the same invoice reference twice is drift (double payment)', () => {
    const check = computeLedgerConsistency({
      walletBalance: 100,
      transactions: [
        { type: 'invoice', method: 'wallet', amount: 2000, reference: 'PAY-INV-1' },
        { type: 'invoice', method: 'wallet', amount: 2000, reference: 'PAY-INV-1' },
      ],
      releasedMilestoneIds: [],
      paidInvoiceReferences: ['PAY-INV-1'],
    })
    expect(check.consistent).toBe(false)
    expect(check.drift).toBe(2000) // exactly the duplicated row
  })

  it('an invoice row nothing paid backs is drift', () => {
    const check = computeLedgerConsistency({
      walletBalance: 100,
      transactions: [{ type: 'invoice', method: 'wallet', amount: 1500, reference: 'PAY-GHOST' }],
      releasedMilestoneIds: [],
      paidInvoiceReferences: ['PAY-REAL'],
    })
    expect(check.consistent).toBe(false)
    expect(check.drift).toBe(1500)
  })

  it('a negative wallet balance is never consistent, even with zero drift', () => {
    const check = computeLedgerConsistency({
      walletBalance: -1,
      transactions: [],
      releasedMilestoneIds: [],
      paidInvoiceReferences: [],
    })
    expect(check.consistent).toBe(false)
    expect(check.drift).toBe(0)
  })
})
