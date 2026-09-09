// /api/v1 Phase C (money governance) — row mappers shared by the two
// milestone-resource handlers (project-milestones.ts, milestone-detail.ts),
// the supply-rows.ts pattern applied to the escrow/milestone release ladder.
//
// Structural input types (no '@prisma/client' model imports): the rows come
// from EITHER lib/mjengo getProjectPayload().milestones (the webapp's main
// read — db.milestone.findMany) or the detail route's own findFirst; both
// satisfy this shape. Field-for-field honest projection:
//   · evidence photos surface as SitePhoto IDS ONLY (Milestone.
//     evidencePhotoIds is a JSON string array of photo ids — no bytes, no
//     storage URLs in /api/v1; the OpenAPI description says so).
//   · the ladder timestamps are the three the model actually persists
//     (requestedAt / decidedAt / releasedAt — null until the milestone
//     reaches that rung; there is no evidenceSubmittedAt column, the honest
//     signal for that rung is status itself plus evidencePhotoIds length).
//   · Milestone has NO updatedAt and NO offline-sync version column — those
//     fields are deliberately absent here (no fabricated data).

const iso = (v: Date | null): string | null => (v ? v.toISOString() : null)

/** Fields every milestone DTO carries (list item = detail head, structural). */
export interface MilestoneRow {
  id: string
  projectId: string
  phaseId: string | null
  name: string
  amount: number
  status: string
  evidencePhotoIds: string
  requestedAt: Date | null
  decidedAt: Date | null
  decidedBy: string | null
  decisionNote: string | null
  releasedAt: Date | null
  createdAt: Date
}

/**
 * Parse the JSON-encoded evidence photo ids — the money.ts parseEvidenceIds
 * convention (defensive: a malformed stored string parses to [], never a 500
 * on a read route).
 */
export function parseEvidencePhotoIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** The milestone summary (list item): ladder rungs + evidence count. */
export function milestoneSummary(m: MilestoneRow, phaseName: string | null) {
  return {
    id: m.id,
    phaseId: m.phaseId,
    phaseName,
    name: m.name,
    amount: m.amount,
    status: m.status,
    evidencePhotoCount: parseEvidencePhotoIds(m.evidencePhotoIds).length,
    requestedAt: iso(m.requestedAt),
    decidedAt: iso(m.decidedAt),
    releasedAt: iso(m.releasedAt),
    createdAt: iso(m.createdAt),
  }
}
