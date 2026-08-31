// Invoices module — PURE 3-way match + A-1-lite ledger consistency math.
//
// No database, no React: the SAME functions run server-side (service.ts,
// authoritative for invoice.pay gating) and client-side (the Finder invoices
// section renders the matrix from the payload slices). One algorithm, one
// source of truth, no drift between what the server enforces and what the
// human sees.
//
// Honesty rules (Finder spec §13-15): the match never blocks anything silently
// and never accuses anyone — every discrepancy is "review required" language.
// AI/system recommends; an authorized human decides.

import type { LedgerCheck, MatchIssue, MatchLine, ThreeWayReport } from './types'

// ---------------- shared input shapes (plain, prisma-free) ----------------

export interface ThreeWayInvoiceLine {
  name: string
  qty: number
  unitPrice: number
  lineTotal: number
}

export interface ThreeWayOrderLine {
  id: string
  name: string
  qty: number
}

export interface ThreeWayDelivery {
  /** Newest first is NOT required — the latest by createdAt/desc is picked here. */
  createdAt: string | Date
  lines: { orderLineId: string; qtyReceived: number }[]
}

export interface ThreeWayOrder {
  orderCode: string | null
  deliveryFee: number
  lines: ThreeWayOrderLine[]
  deliveries: ThreeWayDelivery[]
}

/** Project-wide delivered quantities by material name (2-way mode only). */
export interface TwoWayDeliveryTotals {
  name: string
  qtyReceived: number
}

// ---------------- helpers ----------------

function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Fee-ish lines (delivery/transport) reconcile against the PO delivery fee, not a qty. */
function isFeeLine(name: string): boolean {
  const n = normName(name)
  return n.startsWith('delivery') || n.startsWith('transport') || n.startsWith('freight')
}

function latestDelivery(deliveries: ThreeWayDelivery[]): ThreeWayDelivery | null {
  if (!deliveries.length) return null
  const sorted = [...deliveries].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  return sorted[0]
}

// ---------------- the match ----------------

/**
 * PO ↔ invoice ↔ delivery per-line matrix.
 *
 * Matching strategy (documented, deterministic):
 *  1. invoice line ↔ PO line by normalized name (case/whitespace tolerant);
 *  2. no name match → positional fallback against unmatched PO lines, in order;
 *  3. fee-looking lines (delivery/transport) reconcile against the PO's
 *     deliveryFee by amount instead of quantity;
 *  4. delivered qty comes from the LATEST OrderDelivery on that order, keyed by
 *     orderLineId; no delivery rows at all → null (unknown, not zero).
 * Invoices without an order run a 2-way check (invoice vs project delivery
 * records by name) — noted honestly in the report.
 */
export function matchThreeWay(input: {
  invoiceLines: ThreeWayInvoiceLine[]
  order: ThreeWayOrder | null
  projectDeliveries?: TwoWayDeliveryTotals[]
}): ThreeWayReport {
  const { invoiceLines, order } = input
  const lines: MatchLine[] = []
  const mismatches: MatchIssue[] = []
  const hasOrder = Boolean(order)

  // ---- 3-way mode: PO + invoice + (latest) delivery ----
  if (order) {
    const delivery = latestDelivery(order.deliveries)
    const hasDelivery = Boolean(delivery)
    const receivedByLineId = new Map<string, number>()
    if (delivery) {
      for (const dl of delivery.lines) {
        receivedByLineId.set(dl.orderLineId, (receivedByLineId.get(dl.orderLineId) ?? 0) + dl.qtyReceived)
      }
    }

    const poPool: (ThreeWayOrderLine & { consumed?: boolean })[] = order.lines.map((l) => ({ ...l })) // consumed as matched

    for (const inv of invoiceLines) {
      // fee line → reconcile against the PO delivery fee by amount
      if (isFeeLine(inv.name)) {
        lines.push({ name: inv.name, poQty: null, invQty: inv.qty, deliveredQty: null, feeLine: true })
        if (order.deliveryFee > 0 && Math.abs(inv.lineTotal - order.deliveryFee) > 0.5) {
          mismatches.push({
            name: inv.name,
            po: null,
            inv: inv.qty,
            delivered: null,
            issue: `delivery billed ${inv.lineTotal.toLocaleString('en-KE')} but the purchase order carries ${(order.deliveryFee).toLocaleString('en-KE')} — review with the supplier`,
          })
        }
        continue
      }

      // name match, else positional fallback
      let poLine = poPool.find((l) => !l.consumed && normName(l.name) === normName(inv.name))
      let positional = false
      if (!poLine) {
        const next = poPool.find((l) => !l.consumed)
        if (next) {
          poLine = next
          positional = true
        }
      }
      if (!poLine) {
        lines.push({ name: inv.name, poQty: null, invQty: inv.qty, deliveredQty: null, feeLine: false })
        mismatches.push({
          name: inv.name,
          po: null,
          inv: inv.qty,
          delivered: null,
          issue: 'not on the purchase order — review with the supplier',
        })
        continue
      }
      poLine.consumed = true

      const deliveredQty = !hasDelivery
        ? null
        : receivedByLineId.has(poLine.id)
          ? (receivedByLineId.get(poLine.id) as number)
          : 0

      lines.push({ name: inv.name, poQty: poLine.qty, invQty: inv.qty, deliveredQty, feeLine: false })

      if (positional) {
        mismatches.push({
          name: inv.name,
          po: poLine.qty,
          inv: inv.qty,
          delivered: deliveredQty,
          issue: `matched to PO line "${poLine.name}" by position (names differ) — verify the line with the supplier`,
        })
      }
      if (inv.qty !== poLine.qty) {
        mismatches.push({
          name: inv.name,
          po: poLine.qty,
          inv: inv.qty,
          delivered: deliveredQty,
          issue: `purchase order has ${poLine.qty}, invoice bills ${inv.qty}`,
        })
      }
      if (deliveredQty === null) {
        mismatches.push({
          name: inv.name,
          po: poLine.qty,
          inv: inv.qty,
          delivered: null,
          issue: 'no delivery recorded yet — physical counts not verifiable',
        })
      } else if (deliveredQty < inv.qty) {
        mismatches.push({
          name: inv.name,
          po: poLine.qty,
          inv: inv.qty,
          delivered: deliveredQty,
          issue: `delivered ${deliveredQty} of ${inv.qty} billed — ${inv.qty - deliveredQty} short`,
        })
      } else if (deliveredQty > inv.qty) {
        mismatches.push({
          name: inv.name,
          po: poLine.qty,
          inv: inv.qty,
          delivered: deliveredQty,
          issue: `delivered ${deliveredQty} exceeds the ${inv.qty} billed — verify with the supplier`,
        })
      }
    }

    const note = hasDelivery
      ? `3-way match against ${order.orderCode ?? 'the purchase order'} — ${mismatches.length} open item(s)`
      : `3-way match against ${order.orderCode ?? 'the purchase order'} — no delivery recorded yet, counts not verifiable`

    return { mode: 'three-way', hasOrder: true, hasDelivery, lines, mismatches, note }
  }

  // ---- 2-way mode: no PO — invoice vs project delivery records by name ----
  const byName = new Map<string, number>()
  for (const d of input.projectDeliveries ?? []) {
    byName.set(normName(d.name), (byName.get(normName(d.name)) ?? 0) + d.qtyReceived)
  }
  for (const inv of invoiceLines) {
    if (isFeeLine(inv.name)) {
      lines.push({ name: inv.name, poQty: null, invQty: inv.qty, deliveredQty: null, feeLine: true })
      continue // no PO to reconcile a fee against — noted in the report
    }
    const deliveredQty = byName.get(normName(inv.name))
    lines.push({ name: inv.name, poQty: null, invQty: inv.qty, deliveredQty: deliveredQty ?? null, feeLine: false })
    if (deliveredQty === undefined) {
      mismatches.push({
        name: inv.name,
        po: null,
        inv: inv.qty,
        delivered: null,
        issue: 'no delivery record found for this line (2-way check — invoice has no purchase order)',
      })
    } else if (deliveredQty < inv.qty) {
      mismatches.push({
        name: inv.name,
        po: null,
        inv: inv.qty,
        delivered: deliveredQty,
        issue: `project delivery records show ${deliveredQty} of ${inv.qty} billed — ${inv.qty - deliveredQty} short (2-way check)`,
      })
    }
  }
  return {
    mode: 'two-way',
    hasOrder: false,
    hasDelivery: (input.projectDeliveries ?? []).length > 0,
    lines,
    mismatches,
    note: 'No purchase order linked — 2-way check (invoice vs project delivery records by name)',
  }
}

// ---------------- A-1-lite ledger consistency ----------------

/**
 * A-1-lite (roadmap §8): "the ledger is the source of financial truth;
 * balances are projections." Full ledger-derived balances need every inflow
 * and outflow ledgered. Under the CURRENT money.ts semantics this is only
 * partially possible, and the reasoning is documented here rather than hidden:
 *
 *  · money.ts `milestone.decide` (approve)  → EscrowWallet -= amount AND a
 *    Transaction row (type 'milestone', reference MJP-<id tail>) — ledgered.
 *  · THIS module's `invoice.pay` with method 'wallet' → EscrowWallet -=
 *    amount AND a Transaction row (type 'invoice') — ledgered.
 *  · `invoice.pay` on external rails (mpesa/bank/card/cash) → Transaction row,
 *    wallet untouched (external money, not escrow).
 *  · money.ts `escrow.topup` → wallet += amount but NO Transaction row — the
 *    inflow side is invisible to the Transaction ledger. Expenses/wages never
 *    touch the wallet at all.
 *
 * Consequence: the wallet balance cannot be reconstructed from the ledger
 * alone without inventing an unknowable "opening balance" (any choice would
 * either be circular — always consistent — or produce false drift after the
 * demo reseeds). So this check reconciles the DEBIT side, which the ledger
 * CAN prove: every wallet-debit ledger row must be backed 1:1 by a real
 * released milestone / paid invoice, and nothing may be debited twice.
 * drift = ledger money that entity states cannot back up (phantom rows,
 * double payments). Seeded history (paid invoices / released milestones
 * without rows) is pre-ledger and legitimate — same convention as money.ts.
 *
 * Read-only. NEVER mutates wallet values.
 */
export function computeLedgerConsistency(input: {
  walletBalance: number
  transactions: { type: string; method: string; amount: number; reference: string | null }[]
  releasedMilestoneIds: string[]
  paidInvoiceReferences: string[]
}): LedgerCheck {
  const milestoneRows = input.transactions.filter((t) => t.type === 'milestone')
  const invoiceRows = input.transactions.filter((t) => t.type === 'invoice')

  const releases = milestoneRows.reduce((s, t) => s + t.amount, 0)
  const walletInvoicePayments = invoiceRows
    .filter((t) => (t.method ?? '').toLowerCase() === 'wallet')
    .reduce((s, t) => s + t.amount, 0)
  const externalInvoicePayments = invoiceRows
    .filter((t) => (t.method ?? '').toLowerCase() !== 'wallet')
    .reduce((s, t) => s + t.amount, 0)

  const releasedTails = new Set(input.releasedMilestoneIds.map((id) => id.slice(-6)))
  const paidRefs = new Set(input.paidInvoiceReferences.filter(Boolean))

  const unreconciled: number[] = []
  let unreconciledCount = 0

  // milestone rows: reference MJP-<tail> must match a released milestone
  for (const t of milestoneRows) {
    const tail = (t.reference ?? '').replace(/^MJP-/i, '')
    if (!t.reference || !releasedTails.has(tail)) {
      unreconciled.push(t.amount)
      unreconciledCount++
    }
  }

  // invoice rows: reference must match exactly one PAID invoice's payment
  // reference, and each reference may carry only one row (no double payments)
  const byRef = new Map<string, number>()
  for (const t of invoiceRows) {
    const key = t.reference ?? ''
    byRef.set(key, (byRef.get(key) ?? 0) + 1)
  }
  for (const [ref, count] of byRef) {
    const rows = invoiceRows.filter((t) => (t.reference ?? '') === ref)
    const matched = ref && paidRefs.has(ref)
    if (!matched) {
      // ledger money with no paid invoice behind it — phantom payment record
      for (const t of rows) { unreconciled.push(t.amount); unreconciledCount++ }
    } else if (count > 1) {
      // same payment reference paying twice — double count
      for (const t of rows.slice(1)) { unreconciled.push(t.amount); unreconciledCount++ }
    }
  }

  const drift = Math.round(unreconciled.reduce((s, a) => s + a, 0))
  const consistent = Math.abs(drift) < 1 && input.walletBalance >= 0
  return {
    consistent,
    drift,
    breakdown: {
      releases,
      walletInvoicePayments,
      externalInvoicePayments,
      topups: null, // escrow.topup writes no ledger rows — see the doc comment
      unreconciledCount,
    },
    note: consistent
      ? 'Every wallet-debit ledger row is backed by a released milestone or a paid invoice — no double payments.'
      : `Drift KSh ${drift.toLocaleString('en-KE')} — ${unreconciledCount} ledger row(s) not backed by a released/paid entity. Investigate before relying on the stored balance.`,
  }
}
