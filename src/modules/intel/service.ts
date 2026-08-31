// Intel module — service layer (stub, phase-2 agent 2-e fills this in).
//
// Purpose: the deterministic intelligence engines, called from
// src/lib/actions/intel.ts:
//   - risk.recompute: 5 deterministic rules over the project's real data
//     (budget pace, attendance verification levels, delivery discrepancies,
//     approval backlog, evidence coverage) → RiskAssessment row with findings
//     JSON; overallScore 0-100; ruleVersion-tagged, re-runnable
//   - digest.generate: weekly IntelDigest (progress, spend, prices, risks,
//     pending decisions) as summary + items JSON
//   - price.record: append a PricePoint (from orders when they land, or manual)
//   - price trend math per material/region (last 4/8 weeks, % change, direction)
//   - supplier reliability recompute from actual transaction history
//     (delivery accuracy, on-time, price consistency, disputes, response time —
//     no anonymous ratings)
//
// Intel describes patterns; humans decide. Findings never accuse.

import { db } from '@/lib/db'

/** Recompute the project risk assessment. Stub — phase 2 (agent 2-e). */
export async function recomputeRisk(_projectId: string, _payload: Record<string, unknown>) {
  await db.$queryRaw`SELECT 1` // placeholder so the db import is used; remove when implementing
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Generate the weekly digest. Stub — landing with phase 2 (agent 2-e). */
export async function generateDigest(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Record a price point (order-derived or manual). Stub — phase 2 (2-e). */
export async function recordPrice(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Recompute supplier reliability scores from transaction history. Stub. */
export async function recomputeReliability(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Price trend per material/region (read-side helper). Stub — phase 2 (2-e). */
export async function priceTrend(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}
