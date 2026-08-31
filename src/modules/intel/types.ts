// Intel module — types for the `intel` slice.
//
// Carries the latest risk assessment, recent weekly digests and regional price
// points (global market intelligence, not project-scoped). The risk engine
// (5 deterministic rules) and digest generator land with agent 2-e.

import type { RiskAssessment, IntelDigest, PricePoint } from '@prisma/client'

// ---- domain enums ----

export type PriceSource = 'order' | 'manual' | 'seed'
export type FindingSeverity = 'info' | 'warning' | 'critical'

/** One rule hit inside RiskAssessment.findings (JSON string array). */
export interface RiskFinding {
  rule: string
  severity: FindingSeverity
  detail: string
  score: number // contribution to the overall score
}

/** One item inside IntelDigest.items (JSON string array). */
export interface DigestItem {
  kind: string // e.g. price_trend, risk, pending_approval, discrepancy
  title: string
  detail: string
}

// ---- slice shapes ----

/** The `intel` slice of ProjectPayload — populated by repository.loadIntelSlice. */
export interface IntelSlice {
  risk: RiskAssessment | null
  digests: IntelDigest[]
  pricePoints: PricePoint[]
}

export const EMPTY_INTEL_SLICE: IntelSlice = { risk: null, digests: [], pricePoints: [] }

/** Parse a RiskAssessment.findings JSON string safely. */
export function parseRiskFindings(raw: string): RiskFinding[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as RiskFinding[]) : []
  } catch {
    return []
  }
}

/** Parse an IntelDigest.items JSON string safely. */
export function parseDigestItems(raw: string): DigestItem[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as DigestItem[]) : []
  } catch {
    return []
  }
}
