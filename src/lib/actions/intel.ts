// Intel actions — deterministic risk recompute, weekly digest generation,
// price-point recording, supplier reliability recompute. Dispatched from
// lib/mjengo.ts applyAction(), which auto-writes the AuditEvent for every
// success — never log manually here.
//
// House rules:
//  - Risk findings describe PATTERNS ("spend 12% ahead of plan"), never people
//    ("thief"). Scores are deterministic + rule-versioned.
//  - Price points come from real orders when they land (source 'order') or
//    manual entry (source 'manual').
//  - Reliability is computed from actual platform transaction history — no
//    anonymous ratings.
//
// STUB (F-1): every action throws until agent 2-e lands the module.

export const INTEL_ACTIONS = [
  'risk.recompute', // { } — re-run the 5 deterministic rules → RiskAssessment row
  'digest.generate', // { weekStart? } — weekly IntelDigest (summary + items)
  'price.record', // { materialName, region, unitPrice, source? } — append a PricePoint
  'reliability.recompute', // { supplierId? } — supplier scores from transaction history
] as const

// ---------------- dispatcher (stub) ----------------

export async function applyIntelAction(type: string, _payload: any, _projectId: string): Promise<any> {
  // Phase-2 (agent 2-e) implements the switch over INTEL_ACTIONS here.
  throw new Error(`Not implemented yet — landing with phase 2 (intel action: ${type})`)
}
