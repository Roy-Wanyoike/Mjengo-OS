import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { milestoneSummary } from './milestone-rows'
import { afterCreatedAtId, cursorRowOr400 } from './keyset'
import { projectMilestonesQuery, projectIdRef, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, membershipProjectDenied, supplierProjectDenied } from './scope'

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
 * DATA (issue #154 / audit API-3): DIRECT READ — db.milestone.findMany
 * scoped `where: { projectId }` (the same rows the webapp payload's
 * milestones read returns), plus the one related collection the response
 * needs: the project's phase id→name pairs (id + name only — a project's
 * phases are a handful, bounded by the domain shape). The old path
 * materialized the whole ~20-read getProjectPayload to slice the ladder out
 * of it; the page cost is now O(page): ?status=, the keyset boundary and
 * take = limit + 1 all ride the single query (the #155 attendance pattern),
 * ordered (createdAt ASC, id ASC) — the same total order the route's old
 * in-memory sort produced. Rate limit: 120/min per principal.
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

    // Unknown project → 404 (the attendance/deliveries resolve step).
    const project = await db.project.findUnique({ where: { id } })
    if (!project) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, id)
    if (denied) return denied
    // SEC-6 (issue #174): the site-team membership pin — supervisor /
    // procurement / qs / finance read only the projects they hold a
    // ProjectMembership row on (fail closed on zero rows); contractor/admin
    // keep the explicit portfolio-wide grant. Same uniform 403 body as the
    // client pin, after the resolve (resolve-then-pin, the v1 precedent).
    const membershipDenied = await membershipProjectDenied(session, id)
    if (membershipDenied) return membershipDenied
    // W5-3: supplier sessions are not project readers (their surface is the
    // supplier-owned rows). Uniform 403 — no project data is returned.
    const supplierDenied = supplierProjectDenied(session)
    if (supplierDenied) return supplierDenied

    // The ladder summaries join the phase name — the one related read this
    // response needs (bounded: a project's phases are a handful).
    const phases = await db.phase.findMany({
      where: { projectId: id },
      select: { id: true, name: true },
    })
    const phaseNames = new Map(phases.map((ph) => [ph.id, ph.name]))

    // Keyset cursor (#155 convention): resolve by id, refuse unless the row
    // belongs to THIS filtered list (project + status filter).
    const cursor = q.data.cursor
    let boundary: { createdAt: Date; id: string } | null = null
    if (cursor) {
      const c = await cursorRowOr400(
        () =>
          db.milestone.findFirst({
            where: {
              id: cursor,
              projectId: id,
              ...(q.data.status ? { status: q.data.status } : {}),
            },
          }),
        'a milestone',
      )
      if (!c.ok) return c.response
      boundary = { createdAt: c.row.createdAt, id: c.row.id }
    }

    // One query: scope + filter + boundary + (createdAt ASC, id ASC) + take
    // limit+1 — the ladder reads oldest-first (the payload query's own
    // order) with the id tiebreak the keyset needs.
    const rows = await db.milestone.findMany({
      where: {
        projectId: id,
        ...(q.data.status ? { status: q.data.status } : {}),
        ...(boundary ? afterCreatedAtId(boundary, 'asc') : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: q.data.limit + 1,
    })

    const hasMore = rows.length > q.data.limit
    const milestones = rows.slice(0, q.data.limit)
    const nextCursor = hasMore ? milestones[milestones.length - 1]?.id ?? null : null

    return v1Ok(
      milestones.map((m) =>
        milestoneSummary(m, m.phaseId ? phaseNames.get(m.phaseId) ?? null : null),
      ),
      { nextCursor, hasMore },
    )
  },
)
