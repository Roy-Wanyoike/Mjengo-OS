import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { afterCreatedAtId, cursorRowOr400 } from './keyset'
import { projectTasksQuery, projectIdRef, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, membershipProjectDenied, supplierProjectDenied } from './scope'

// /api/v1/projects/:id/tasks (Phase B, read-only) —
// src/app/api/v1/projects/[id]/tasks/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/projects/:id/tasks — the project's task list.
 *
 * ROLE SCOPING: same as /api/v1/projects/:id (client pinned to their own
 * project, foreign → 403; unknown project → 404; no flag gates this
 * resource).
 *
 * DATA (issue #154 / audit API-3): DIRECT READ — db.task.findMany scoped
 * `phase: { projectId }`, with the phase name riding a select join (the only
 * relation the response needs). The old path materialized the whole ~20-read
 * getProjectPayload to slice one collection out of it in memory; the page
 * cost is now O(page), not O(payload): ?status=, the keyset boundary and
 * take = limit + 1 all ride the single query (the #155 attendance pattern),
 * ordered (createdAt ASC, id ASC) — the same total order the route's old
 * in-memory sort produced, so pagination contracts hold. getProjectPayload
 * stays the webapp's /api/project read, never a v1 building block.
 * Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'projects/:id/tasks GET',
    rateLimit: { bucket: 'v1.projects.tasks', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects/:id/tasks GET', e, 'Project tasks failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = projectIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, projectTasksQuery)
    if (!q.ok) return q.response

    // Unknown project → 404 (the attendance/deliveries resolve step — an
    // honest "nothing here", not an empty page).
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

    // Keyset cursor (#155 convention): the cursor row resolves by id and
    // must belong to THIS filtered list (a phase of this project + the
    // status filter) — unknown, foreign and filtered-out ids all answer
    // pageOfKind's exact 400.
    const cursor = q.data.cursor
    let boundary: { createdAt: Date; id: string } | null = null
    if (cursor) {
      const c = await cursorRowOr400(
        () =>
          db.task.findFirst({
            where: {
              id: cursor,
              phase: { projectId: id },
              ...(q.data.status ? { status: q.data.status } : {}),
            },
          }),
        'a task',
      )
      if (!c.ok) return c.response
      boundary = { createdAt: c.row.createdAt, id: c.row.id }
    }

    // One query: scope + filter + boundary + (createdAt ASC, id ASC) + take
    // limit+1 — the extra row reveals hasMore without a count (the
    // audit-route pattern).
    const rows = await db.task.findMany({
      where: {
        phase: { projectId: id },
        ...(q.data.status ? { status: q.data.status } : {}),
        ...(boundary ? afterCreatedAtId(boundary, 'asc') : {}),
      },
      include: { phase: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: q.data.limit + 1,
    })

    const hasMore = rows.length > q.data.limit
    const tasks = rows.slice(0, q.data.limit)
    const nextCursor = hasMore ? tasks[tasks.length - 1]?.id ?? null : null

    return v1Ok(
      tasks.map((t) => ({
        id: t.id,
        phaseId: t.phaseId,
        phaseName: t.phase.name,
        title: t.title,
        status: t.status,
        progress: t.progress,
        priority: t.priority,
        dueDate: t.dueDate ? t.dueDate.toISOString() : null,
        assignedToId: t.assignedToId,
        blockedById: t.blockedById,
        blockedReason: t.blockedReason,
        verifiedAt: t.verifiedAt ? t.verifiedAt.toISOString() : null,
        verifiedByName: t.verifiedByName,
        version: t.version, // offline-sync entity version (bumped by every applier)
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      })),
      { nextCursor, hasMore },
    )
  },
)
