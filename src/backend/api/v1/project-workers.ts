import { route } from '@/backend/lib/route-kit'
import { getProjectPayload } from '@/backend/lib/mjengo'
import { projectIdRef, projectWorkersQuery, validateQuery } from './schemas'
import { mapServiceError, pageOfKind, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, supplierProjectDenied } from './scope'
import { workerSummary } from './worker-rows'

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
 * DATA: the rows come from getProjectPayload()'s workers read (db.worker.
 * findMany name ASC + attendances — the same query the webapp payload runs;
 * todayStatus and weekEarnings are the payload's OWN derivations, EAT
 * "today" and trailing 7 calendar days, projected verbatim). HONEST LIMIT:
 * the payload's per-worker attendance window is the recent slice, so the
 * LIST carries the rollup (todayStatus/weekEarnings) and NOT a total
 * attendance count — the true counts live on /api/v1/workers/:id, which
 * reads the full attendance history. ?active= (true|false — the one Worker
 * boolean column, the roster's live/inactive split) filters BEFORE
 * pagination. The roster is bounded, so pagination is the wallet-list
 * pattern. Worker carries NO createdAt column (honest absence — never
 * fabricated), so the deterministic keyset total order is the payload's own
 * (name ASC, id ASC) roster order. Rate limit: 120/min per principal.
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

    const payload = await getProjectPayload(id)
    if (!payload) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, payload.project.id)
    if (denied) return denied
    // W5-3: supplier sessions are not project readers (their surface is the
    // supplier-owned rows). Uniform 403 — no project data is returned.
    const supplierDenied = supplierProjectDenied(session)
    if (supplierDenied) return supplierDenied

    let workers = payload.workers
    if (q.data.active) {
      workers = workers.filter((w) => w.active === (q.data.active === 'true'))
    }
    // Deterministic keyset order: (name ASC, id ASC) — the payload's own
    // roster order (db.worker.findMany name ASC) with the id tiebreak the
    // keyset needs. Worker has no createdAt column to order by.
    workers = [...workers].sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )

    // pageOfKind needs { id } rows; the summary is derived from the payload's
    // own rollup fields (todayStatus/weekEarnings — projected verbatim).
    const rows = workers.map((w) => ({
      id: w.id,
      item: workerSummary(
        w,
        {
          status: w.todayStatus.status,
          checkIn: w.todayStatus.checkIn,
          checkOut: w.todayStatus.checkOut,
          method: w.todayStatus.method,
          wage: w.todayStatus.wage,
          paid: w.todayStatus.paid,
          verification: w.todayStatus.verification,
          exceptionReason: w.todayStatus.exceptionReason,
        },
        w.weekEarnings,
      ),
    }))
    const p = pageOfKind(rows, q.data.limit, q.data.cursor, 'a worker')
    if (!p.ok) return p.response

    return v1Ok(
      p.page.items.map((r) => r.item),
      { nextCursor: p.page.nextCursor, hasMore: p.page.hasMore },
    )
  },
)
