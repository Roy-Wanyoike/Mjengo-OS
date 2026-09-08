import { route } from '@/backend/lib/route-kit'
import { getProjectPayload } from '@/backend/lib/mjengo'
import { milestoneSummary } from './milestone-rows'
import { projectMilestonesQuery, projectIdRef, validateQuery } from './schemas'
import { mapServiceError, pageOfKind, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, supplierProjectDenied } from './scope'

// /api/v1/projects/:id/milestones (Phase C, read-only — the money-governance
// family) — src/app/api/v1/projects/[id]/milestones/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/projects/:id/milestones — the project's milestone release
 * ladder (MjengoPay, spec §28-29): locked → evidence_submitted →
 * release_requested → released | rejected, each rung's money proven by the
 * double-entry ledger. Read-only — every mutation (milestone.create /
 * evidence / requestRelease / decide) stays on POST /api/actions, documented
 * in the OpenAPI description.
 *
 * NO FEATURE FLAG gates this resource, deliberately: the `wallet` flag gates
 * the user-facing wallet & payment-request surface, but its documented
 * boundary (flags.ts) keeps the escrow/milestone governance ladder alive
 * while the flag is off — "the client's release flow must survive". The
 * OpenAPI description carries that honest boundary note.
 *
 * ROLE SCOPING: same as /api/v1/projects/:id (client pinned to their own
 * project, foreign → 403; unknown project → 404).
 *
 * DATA: the milestone rows come from getProjectPayload()'s milestones read
 * (db.milestone.findMany, createdAt ASC — the same query the webapp payload
 * runs; this is surface work, not new domain logic). The set is bounded, so
 * pagination is the wallet-list pattern: a deterministic (createdAt ASC,
 * id ASC) total order sliced in the route layer. ?status= (the six
 * documented column values) filters BEFORE pagination — a cursor that falls
 * out of the filtered list → 400. Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'projects/:id/milestones GET',
    rateLimit: { bucket: 'v1.projects.milestones', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects/:id/milestones GET', e, 'Project milestones failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = projectIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, projectMilestonesQuery)
    if (!q.ok) return q.response

    const payload = await getProjectPayload(id)
    if (!payload) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, payload.project.id)
    if (denied) return denied
    // W5-3: supplier sessions are not project readers (their surface is the
    // supplier-owned rows). Uniform 403 — no project data is returned.
    const supplierDenied = supplierProjectDenied(session)
    if (supplierDenied) return supplierDenied

    const phaseNames = new Map(payload.phases.map((ph) => [ph.id, ph.name]))
    let milestones = payload.milestones
    if (q.data.status) {
      milestones = milestones.filter((m) => m.status === q.data.status)
    }
    // Deterministic keyset order: (createdAt ASC, id ASC) — the ladder reads
    // oldest-first, matching the payload's own query order.
    milestones = [...milestones].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )

    // pageOfKind needs { id } rows; map the summary alongside.
    const rows = milestones.map((m) => ({
      id: m.id,
      item: milestoneSummary(m, m.phaseId ? phaseNames.get(m.phaseId) ?? null : null),
    }))
    const p = pageOfKind(rows, q.data.limit, q.data.cursor, 'a milestone')
    if (!p.ok) return p.response

    return v1Ok(
      p.page.items.map((r) => r.item),
      { nextCursor: p.page.nextCursor, hasMore: p.page.hasMore },
    )
  },
)
