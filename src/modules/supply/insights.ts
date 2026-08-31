// Supply module — PURE procurement insights (Finder §18 BOQ-lite + §20 dashboard).
//
// No database, no React: the same math feeds the `supply` section UI (client,
// from the payload slices) and can be used server-side. Deterministic and
// documented:
//
//   estimateRequestTotal:
//     · RECEIVED quotes exist → the BEST (lowest) totalLanded is the estimate
//     · otherwise → per line, the AVERAGE catalog unitPrice across every
//       supplier fuzzy-matching the material name (case-insensitive contains)
//       × qty, summed. Unmatched lines contribute 0 and are listed in
//       `unpricedLines` so the UI can label the estimate honestly.
//
//   Procurement totals (§20):
//     · required  = Σ est totals of requests in submitted/approved/converted
//     · purchased = Σ totals of orders delivered/closed
//     · committed = Σ totals of orders sent/confirmed/delivering
//     · remaining = required − purchased (floored at 0 for display)
//
//   BOQ-lite per material (§18): required (request lines of
//   submitted/approved/converted requests) vs purchased (qtyReceived from
//   delivery lines of delivered/closed orders) vs remaining — normalized
//   material names group supplier wording variants ("Cement 50kg (32.5N)"
//   ↔ "Cement 50kg").

import { materialMatches } from './compare'
import type { BoqMaterialRow, EstimateBasis, ProcurementTotals } from './types'

export interface EstimateLine {
  materialName: string
  qty: number
}

export interface EstimateSupplier {
  catalogItems: Array<{ name: string; unitPrice: number }>
}

export interface EstimateQuote {
  status: string
  totalLanded: number
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Short, human grouping key for a material name (first 2 meaningful words). */
export function materialKey(name: string): string {
  const words = norm(name)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(' ')
    .filter((w) => w && !['the', 'kg', '50kg', '12m', '2m', '9'].includes(w))
  return words.slice(0, 2).join(' ') || norm(name)
}

/** Average catalog unit price across ALL suppliers matching the material name. */
export function avgCatalogPrice(materialName: string, suppliers: EstimateSupplier[]): number | null {
  const prices: number[] = []
  for (const s of suppliers) {
    for (const item of s.catalogItems) {
      if (materialMatches(item.name, materialName)) prices.push(item.unitPrice)
    }
  }
  if (!prices.length) return null
  return prices.reduce((a, b) => a + b, 0) / prices.length
}

/** Estimate a request's total — quotes first, catalog average fallback. */
export function estimateRequestTotal(
  lines: EstimateLine[],
  suppliers: EstimateSupplier[],
  quotes: EstimateQuote[],
): EstimateBasis {
  const received = quotes.filter((q) => q.status === 'received' && q.totalLanded > 0)
  if (received.length) {
    return { total: Math.min(...received.map((q) => q.totalLanded)), source: 'quotes', unpricedLines: [] }
  }
  let total = 0
  const unpricedLines: string[] = []
  for (const line of lines) {
    const avg = avgCatalogPrice(line.materialName, suppliers)
    if (avg === null) {
      unpricedLines.push(line.materialName)
      continue
    }
    total += avg * line.qty
  }
  return { total: Math.round(total * 100) / 100, source: 'catalog', unpricedLines }
}

export interface InsightRequest {
  status: string
  lines: Array<{ materialName: string; unit: string; qty: number }>
  quotes: EstimateQuote[]
}

export interface InsightOrder {
  status: string
  total: number
  lines: Array<{ id: string; name: string; unit: string; qty: number }>
  deliveries: Array<{ status: string; lines: Array<{ orderLineId: string; qtyReceived: number }> }>
}

export interface InsightApproval {
  decision: string
}

/** The §20 dashboard tile math. */
export function procurementTotals(
  requests: InsightRequest[],
  orders: InsightOrder[],
  approvals: InsightApproval[],
  suppliers: EstimateSupplier[],
): ProcurementTotals {
  const REQUIREMENT_STATUSES = ['submitted', 'approved', 'converted']
  const inFlightRequests = requests.filter((r) => REQUIREMENT_STATUSES.includes(r.status))

  let required = 0
  for (const r of inFlightRequests) {
    required += estimateRequestTotal(r.lines, suppliers, r.quotes).total
  }

  const purchased = orders
    .filter((o) => ['delivered', 'closed'].includes(o.status))
    .reduce((s, o) => s + o.total, 0)
  const committed = orders
    .filter((o) => ['sent', 'confirmed', 'delivering'].includes(o.status))
    .reduce((s, o) => s + o.total, 0)

  return {
    required: Math.round(required),
    purchased: Math.round(purchased),
    committed: Math.round(committed),
    remaining: Math.max(0, Math.round(required - purchased)),
    pendingRequests: requests.filter((r) => r.status === 'submitted').length,
    pendingApprovals: approvals.filter((a) => a.decision === 'pending').length,
    ordersInTransit: orders.filter((o) => o.status === 'delivering').length,
    discrepancies: orders.reduce(
      (s, o) => s + o.deliveries.filter((d) => d.status === 'discrepancy').length,
      0,
    ),
  }
}

/** §18 BOQ-lite: required vs purchased vs remaining per normalized material. */
export function boqRows(
  requests: InsightRequest[],
  orders: InsightOrder[],
): BoqMaterialRow[] {
  const REQUIREMENT_STATUSES = ['submitted', 'approved', 'converted']
  const map = new Map<string, BoqMaterialRow>()

  for (const r of requests) {
    if (!REQUIREMENT_STATUSES.includes(r.status)) continue
    for (const line of r.lines) {
      const key = materialKey(line.materialName)
      const row =
        map.get(key) ??
        { materialKey: key, displayNames: [], unit: line.unit, required: 0, purchased: 0, remaining: 0 }
      if (!row.displayNames.includes(line.materialName)) row.displayNames.push(line.materialName)
      if (!row.unit) row.unit = line.unit
      row.required += line.qty
      map.set(key, row)
    }
  }

  for (const o of orders) {
    if (!['delivered', 'closed'].includes(o.status)) continue
    for (const d of o.deliveries) {
      for (const dl of d.lines) {
        const line = o.lines.find((l) => l.id === dl.orderLineId)
        if (!line) continue
        const key = materialKey(line.name)
        const row = map.get(key)
        if (row) {
          row.purchased += dl.qtyReceived
        }
      }
    }
  }

  const rows = [...map.values()]
  for (const row of rows) {
    row.remaining = Math.max(0, Math.round((row.required - row.purchased) * 100) / 100)
  }
  return rows.sort((a, b) => b.remaining - a.remaining || a.materialKey.localeCompare(b.materialKey))
}

// ---------------- price alert (read-only, Finder §17 / §20) ----------------

export interface PricePointLike {
  materialName: string
  region: string
  unitPrice: number
  recordedAt: string | Date
}

export interface PriceDelta {
  materialLabel: string
  windowDays: number
  pct: number
  from: number
  to: number
}

/**
 * 30-day price delta for a material across regions (avg of the latest point
 * vs the point ~windowDays old per region). Read-only — the intel module owns
 * trends; this chip just surfaces the headline number.
 */
export function priceDelta(
  points: PricePointLike[],
  materialQuery: string,
  windowDays = 30,
): PriceDelta | null {
  const relevant = points.filter((p) => materialMatches(p.materialName, materialQuery))
  if (!relevant.length) return null
  const byRegion = new Map<string, PricePointLike[]>()
  for (const p of relevant) {
    const list = byRegion.get(p.region) ?? []
    list.push(p)
    byRegion.set(p.region, list)
  }
  const now = Date.now()
  let fromSum = 0
  let toSum = 0
  let regions = 0
  for (const list of byRegion.values()) {
    const sorted = [...list].sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime())
    const latest = sorted[sorted.length - 1]
    const cutoff = now - windowDays * 86400000
    const old = [...sorted].reverse().find((p) => new Date(p.recordedAt).getTime() <= cutoff) ?? sorted[0]
    if (!latest || !old) continue
    fromSum += old.unitPrice
    toSum += latest.unitPrice
    regions++
  }
  if (!regions || fromSum === 0) return null
  const from = fromSum / regions
  const to = toSum / regions
  return {
    materialLabel: materialQuery,
    windowDays,
    pct: Math.round(((to - from) / from) * 1000) / 10,
    from: Math.round(from),
    to: Math.round(to),
  }
}
