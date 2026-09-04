import { route } from '@/backend/lib/route-kit'
import { getProjectsList } from '@/backend/lib/mjengo'
import { projectsListQuery, validateQuery } from './schemas'
import { mapServiceError, pageOfKind, v1Ok, V1_READ_LIMIT } from './respond'

// /api/v1/projects (Phase B, read-only) — src/app/api/v1/projects/route.ts is
// the shim.

/**
 * GET /api/v1/projects — every project as the lightweight roster row
 * (ProjectListItem — the SAME derivation the webapp project switcher renders:
 * budgetTotal = Σ Phase.budget, budgetSpent = Σ Transaction.amount,
 * progressPct = budget-weighted phase progress).
 *
 * ROLE SCOPING mirrors the webapp guard (api/projects GET): every signed-in
 * role sees the portfolio; a CLIENT-role session sees exactly its own project
 * (a client without a pinned project sees an empty list — never the
 * portfolio). No role allowlist beyond the session itself.
 *
 * NO FEATURE FLAG gates this resource: none of the five flags (ai_progress,
 * ai_voice, wallet, marketplace, land_verification) names the projects
 * surface — gating it by an unrelated flag would be dishonest. Documented
 * here so the decision is auditable.
 *
 * QUERY: ?q= free-text search on project name/client (in-memory contains,
 * ASCII case-insensitive); ?status= one of active|completed|on_hold (the
 * column is free-form — undocumented values stay visible unfiltered and
 * never match); ?limit (1-200, default 50) + ?cursor (project id of the last
 * item of the previous page). Filters apply BEFORE pagination, so a cursor
 * that falls out of the filtered list → 400 (honest: stale or wrong).
 *
 * Pagination is the wallet-list pattern: the project set is bounded, so the
 * route slices the full service-ordered list (getProjectsList returns
 * createdAt ASC — the keyset order). Rate limit: 120 reads/min per principal.
 */
export const GET = route(
  {
    scope: 'projects GET',
    rateLimit: { bucket: 'v1.projects.list', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects GET', e, 'Failed to list projects'),
  },
  async (req, session) => {
    const q = validateQuery(req, projectsListQuery)
    if (!q.ok) return q.response

    let projects = await getProjectsList()
    // Client-role tenant pin — the webapp filter, verbatim.
    if (session.user.role === 'client') {
      projects = session.user.projectId
        ? projects.filter((p) => p.id === session.user.projectId)
        : []
    }
    if (q.data.status) {
      projects = projects.filter((p) => p.status === q.data.status)
    }
    if (q.data.q) {
      const needle = q.data.q.toLowerCase()
      projects = projects.filter(
        (p) => p.name.toLowerCase().includes(needle) || p.client.toLowerCase().includes(needle),
      )
    }
    const p = pageOfKind(projects, q.data.limit, q.data.cursor, 'a project')
    if (!p.ok) return p.response
    return v1Ok(p.page.items, { nextCursor: p.page.nextCursor, hasMore: p.page.hasMore })
  },
)
