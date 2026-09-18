import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { afterNameId, cursorRowOr400 } from './keyset'
import { projectIdRef, projectWorkersQuery, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, membershipProjectDenied, supplierProjectDenied } from './scope'
import {
  todayStatusOf, weekEarningsOf, workerSummary, type AttendanceRow,
} from './worker-rows'

// /api/v1/projects/:id/workers (Phase D, read-only — the site-workforce
// family) — src/app/api/v1/projects/[id]/workers/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/projects/:id/workers — the project's workforce roster with its
 * attendance rollup (Doc A §14): identity, trade, terms, and the SAME
 * todayStatus/weekEarnings derivation the webapp Team tab renders.
 *
 * NO FEATURE FLAG gates this resource, deliberately: none of the five flags
 * (ai_progress, ai_voice, wallet, marketplace, land_verification) names the
 * workforce/attendance surface — gating it by an unrelated flag would be
 * dishonest (the projects-resource precedent, documented in flags.ts).
 *
 * ROLE SCOPING: same as /api/v1/projects/:id (client pinned to their own
 * project, foreign → 403; unknown project → 404). W5-3: supplier sessions
 * are not project readers — uniform 403, no project data returned.
 *
 * DATA (issue #154 / audit API-3): DIRECT READ — db.worker.findMany scoped
 * `where: { projectId }` (the same rows the webapp payload's workers read
 * returns). todayStatus and weekEarnings re-derive with the payload's EXACT
 * logic (worker-rows.ts — EAT "today" and trailing 7 calendar days — the
 * worker-detail precedent, so the list can never disagree with the webapp
 * read); the attendance rows they consume come from ONE bounded read of the
 * PAGE's workers over an 8-day window (today + trailing 7 days, one day of
 * slack on each side of the derivations' own boundaries — a strict superset,
 * the exact same JS predicates do the filtering), so the rollup is
 * byte-identical while the read is bounded by the page, not by the
 * project's whole attendance history. The old path materialized the whole
 * ~20-read getProjectPayload (every attendance row included) to slice the
 * roster out of it. HONEST LIMIT: the LIST carries the rollup
 * (todayStatus/weekEarnings) and NOT a total attendance count — the true
 * counts live on /api/v1/workers/:id, which reads the full attendance
 * history. ?active= (true|false — the one Worker boolean column, the
 * roster's live/inactive split) filters BEFORE pagination. Worker carries
 * NO createdAt column (honest absence — never fabricated), so the
 * deterministic keyset total order is the payload's own (name ASC, id ASC)
 * roster order — pushed into the findMany with take = limit + 1 (the #155
 * attendance pattern). Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'projects/:id/workers GET',
    rateLimit: { bucket: 'v1.projects.workers', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects/:id/workers GET', e, 'Project workers failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = projectIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, projectWorkersQuery)
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

    // ?active= pushed into the query (filter-before-pagination, unchanged).
    const active = q.data.active !== undefined ? q.data.active === 'true' : undefined

    // Keyset cursor (#155 convention): resolve by id, refuse unless the row
    // belongs to THIS filtered list (project + active filter).
    const cursor = q.data.cursor
    let boundary: { name: string; id: string } | null = null
    if (cursor) {
      const c = await cursorRowOr400(
        () =>
          db.worker.findFirst({
            where: {
              id: cursor,
              projectId: id,
              ...(active !== undefined ? { active } : {}),
            },
          }),
        'a worker',
      )
      if (!c.ok) return c.response
      boundary = { name: c.row.name, id: c.row.id }
    }

    // One query: scope + filter + boundary + (name ASC, id ASC) + take
    // limit+1 — the payload's own roster order with the id tiebreak the
    // keyset needs (Worker has no createdAt column to order by).
    const rows = await db.worker.findMany({
      where: {
        projectId: id,
        ...(active !== undefined ? { active } : {}),
        ...(boundary ? afterNameId(boundary) : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: q.data.limit + 1,
    })

    const hasMore = rows.length > q.data.limit
    const workers = rows.slice(0, q.data.limit)
    const nextCursor = hasMore ? workers[workers.length - 1]?.id ?? null : null

    // The rollup window: EAT "today" + the trailing 7 calendar days the
    // derivations consume (one day of slack on each side, so the fetched
    // set is a strict superset and todayStatusOf/weekEarningsOf — the
    // payload's exact predicates — do the precise filtering). Bounded by
    // the page's workers × 8 days, never the project's attendance history.
    const windowFloor = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
    const attendances = workers.length
      ? await db.attendance.findMany({
          where: {
            projectId: id,
            workerId: { in: workers.map((w) => w.id) },
            date: { gte: windowFloor },
          },
          orderBy: [{ date: 'desc' }, { id: 'desc' }],
        })
      : []
    const byWorker = new Map<string, AttendanceRow[]>()
    for (const a of attendances) {
      const list = byWorker.get(a.workerId)
      if (list) list.push(a)
      else byWorker.set(a.workerId, [a])
    }

    return v1Ok(
      workers.map((w) => {
        const rows = byWorker.get(w.id) ?? []
        return workerSummary(w, todayStatusOf(rows), weekEarningsOf(rows))
      }),
      { nextCursor, hasMore },
    )
  },
)
