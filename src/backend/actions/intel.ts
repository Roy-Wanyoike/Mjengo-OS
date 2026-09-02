// Intel actions — deterministic risk recompute, weekly digest generation,
// price-point recording, supplier reliability recompute. Dispatched from
// lib/mjengo.ts applyAction(), which auto-writes the AuditEvent for every
// success — never log manually here.
//
// House rules:
//  - Risk findings describe PATTERNS ("spend 12% ahead of plan"), never people
//    ("thief"). Scores are deterministic + rule-versioned.
//  - Price points come from real orders when they land (source 'order') or
//    manual entry (source 'manual' — this action always writes MANUAL).
//  - Reliability is computed from actual platform transaction history — no
//    anonymous ratings (Finder spec §16).

import {
  recomputeRisk, generateDigest, recordPrice, recomputeReliability,
} from '@/backend/modules/intel/service'

export const INTEL_ACTIONS = [
  'risk.recompute', // { } — re-run the 5 deterministic rules → RiskAssessment row
  'digest.generate', // { weekStart? } — weekly IntelDigest (summary + items)
  'price.record', // { materialName, region, unitPrice } — append a manual PricePoint
  'reliability.recompute', // { supplierId? } — supplier scores from transaction history (omit = all)
] as const

// ---------------- dispatcher ----------------

export async function applyIntelAction(type: string, payload: any, projectId: string): Promise<any> {
  switch (type) {
    case 'risk.recompute': {
      // Fresh 5-rule pass over the live rows; history is preserved (latest wins in UI).
      const result = await recomputeRisk(projectId)
      return {
        id: result.id,
        overallScore: result.overallScore,
        findingsCount: result.findings.length,
        ruleVersion: result.ruleVersion,
      }
    }

    case 'digest.generate': {
      // Regenerates THIS week's digest (Monday-based weekStart) + emits the
      // digest.weekly event row.
      const result = await generateDigest(projectId)
      return { id: result.id, weekStart: result.weekStart, summary: result.summary }
    }

    case 'price.record': {
      const result = await recordPrice(projectId, payload ?? {})
      return { id: result.id, materialName: result.materialName, region: result.region, unitPrice: result.unitPrice }
    }

    case 'reliability.recompute': {
      const result = await recomputeReliability(projectId, payload ?? {})
      return {
        updated: result.updated,
        scores: result.results.map((r) => ({ supplier: r.businessName, score: r.score })),
      }
    }

    default:
      throw new Error(`Unknown intel action: ${type}`)
  }
}
