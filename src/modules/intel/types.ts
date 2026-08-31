// Intel module — types for the `intel` slice.
//
// Carries the latest risk assessment, recent weekly digests and regional price
// points (global market intelligence, not project-scoped), PLUS read-side
// computations done in the repository (price trends, procurement suggestions,
// supplier reliability breakdowns) so the UI stays presentation-only.
//
// Every number in this module is deterministic and traceable to real rows —
// no anonymous ratings, no opaque "AI scores".

import type { RiskAssessment, IntelDigest, PricePoint, Supplier } from '@prisma/client'

// ---- domain enums ----

export type PriceSource = 'order' | 'manual' | 'seed'
export type FindingSeverity = 'info' | 'warning' | 'critical'

/**
 * One rule hit inside RiskAssessment.findings (JSON string array).
 * Written by the risk engine (2-e); v1 seed rows carried a single `detail`
 * line — parseRiskFindings normalizes both shapes into this interface.
 */
export interface RiskFinding {
  rule: string // e.g. 'budget_pace' | 'schedule_watch' | 'procurement_watch' | 'price_trend' | 'attendance_watch'
  severity: FindingSeverity
  title: string
  message: string
  evidence: string // the rows behind the number, e.g. "3 transactions · 12 deliveries"
  score?: number // severity weight contributed (info 5 · warning 15 · critical 30)
}

/** Raw finding as stored (seed v1 or engine output) before normalization. */
interface RawRiskFinding {
  rule?: unknown
  severity?: unknown
  title?: unknown
  message?: unknown
  evidence?: unknown
  detail?: unknown
  score?: unknown
}

/** Human labels for known rule keys (unknown keys fall back to the raw rule). */
export const RULE_LABELS: Record<string, string> = {
  budget_pace: 'Budget pace',
  delivery_discrepancy: 'Delivery discrepancy',
  attendance_verification: 'Attendance verification',
  pending_decisions: 'Pending decisions',
  schedule_watch: 'Schedule',
  procurement_watch: 'Procurement',
  price_trend: 'Price trend',
  attendance_watch: 'Attendance',
}

function isSeverity(v: unknown): v is FindingSeverity {
  return v === 'info' || v === 'warning' || v === 'critical'
}

/** Parse a RiskAssessment.findings JSON string safely + normalize to RiskFinding. */
export function parseRiskFindings(raw: string): RiskFinding[] {
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  return list
    .map((item): RiskFinding | null => {
      if (!item || typeof item !== 'object') return null
      const f = item as RawRiskFinding
      const rule = typeof f.rule === 'string' ? f.rule : 'unknown'
      const severity = isSeverity(f.severity) ? f.severity : 'info'
      const detail = typeof f.detail === 'string' ? f.detail : ''
      const message = typeof f.message === 'string' && f.message ? f.message : detail
      return {
        rule,
        severity,
        title: typeof f.title === 'string' && f.title ? f.title : (RULE_LABELS[rule] ?? rule),
        message,
        evidence: typeof f.evidence === 'string' ? f.evidence : '',
        score: typeof f.score === 'number' ? f.score : undefined,
      }
    })
    .filter((f): f is RiskFinding => f !== null)
}

/** One item inside IntelDigest.items (JSON string array). */
export interface DigestItem {
  kind: string // e.g. price_trend, risk, pending_approval, discrepancy
  title: string
  detail: string
}

/** Parse an IntelDigest.items JSON string safely. */
export function parseDigestItems(raw: string): DigestItem[] {
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v
      .map((item): DigestItem | null => {
        if (!item || typeof item !== 'object') return null
        const it = item as Record<string, unknown>
        if (typeof it.title !== 'string') return null
        return {
          kind: typeof it.kind === 'string' ? it.kind : 'note',
          title: it.title,
          detail: typeof it.detail === 'string' ? it.detail : '',
        }
      })
      .filter((x): x is DigestItem => x !== null)
  } catch {
    return []
  }
}

// ---- read-side computations (computed in repository, never in the UI) ----

/** One material+region price trend row for the prices section. */
export interface PriceTrendRow {
  materialName: string
  region: string
  current: number // latest unitPrice (KES)
  previous: number | null // most recent point recorded ≥30d ago (null if history <30d)
  deltaPct: number | null // (current-previous)/previous × 100 over ~30d
  points: Array<{ t: string; price: number }> // chronological sparkline series
  lastRecordedAt: string // ISO
  source: string // source of the latest point (order | manual | seed)
  pointCount: number
}

/** §19-lite procurement cover check per price-tracked material. */
export interface ProcurementSuggestion {
  materialName: string
  status: 'covered' | 'uncovered'
  coverDetail: string | null // e.g. "PO-2026-000012 (delivering) × 50 bag"
  hint: string
}

/** One reliability component in a supplier breakdown. */
export interface ReliabilityComponent {
  key: 'deliveryAccuracy' | 'onTime' | 'completion' | 'disputes' | 'response'
  label: string
  weight: number // 0-1, weights sum to 1
  value: number | null // 0-100, null = no data yet (counts as neutral 50)
  detail: string // the rows behind the number
}

/** Supplier reliability computed from ACTUAL platform history (spec §16 — no anonymous ratings). */
export interface SupplierReliability {
  supplierId: string
  businessName: string
  county: string
  score: number // 0-100
  storedScore: number // Supplier.reliabilityScore as last persisted
  responseHours: number
  ordersCount: number
  deliveriesCount: number
  discrepanciesCount: number
  components: ReliabilityComponent[]
  note: string
}

/** Reliability breakdown keyed for the recompute action's return value. */
export interface ReliabilityResult extends SupplierReliability {
  updated: boolean
}

// ---- slice shapes ----

/**
 * The `intel` slice of ProjectPayload — populated by repository.loadIntelSlice.
 * The first three fields are raw rows; the rest are read-side computations so
 * the client never derives numbers itself.
 */
export interface IntelSlice {
  risk: RiskAssessment | null
  digests: IntelDigest[]
  pricePoints: PricePoint[]
  // computed (server-side) by the repository:
  priceTrends: PriceTrendRow[]
  suggestions: ProcurementSuggestion[]
  reliability: SupplierReliability[]
}

export const EMPTY_INTEL_SLICE: IntelSlice = {
  risk: null,
  digests: [],
  pricePoints: [],
  priceTrends: [],
  suggestions: [],
  reliability: [],
}

/** Supplier row shape the engine needs (subset of the Prisma Supplier model). */
export type SupplierLike = Pick<Supplier, 'id' | 'businessName' | 'county' | 'responseHours' | 'reliabilityScore'>
