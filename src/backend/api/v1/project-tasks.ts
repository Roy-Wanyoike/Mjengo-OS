import { route } from '@/backend/lib/route-kit'
import { getProjectPayload } from '@/backend/lib/mjengo'
import { projectTasksQuery, projectIdRef, validateQuery } from './schemas'
import { mapServiceError, pageOfKind, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied } from './scope'

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
 * DATA: the task rows come from getProjectPayload()'s phases read (phases
 * `order` ASC with tasks `createdAt` ASC — the same query the webapp payload
 * runs). The task set per project is bounded, so pagination is the
 * wallet-list pattern: a deterministic (createdAt ASC, id ASC) total order
 * sliced in the route layer. ?status= (pending|in_progress|done|blocked)
 * filters BEFORE pagination — a cursor that falls out of the filtered list →
 * 400. Rate limit: 120/min per principal.
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

    const payload = await getProjectPayload(id)
    if (!payload) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, payload.project.id)
    if (denied) return denied

    const phaseNames = new Map(payload.phases.map((ph) => [ph.id, ph.name]))
    let tasks = payload.phases.flatMap((ph) => ph.tasks)
    if (q.data.status) {
      tasks = tasks.filter((t) => t.status === q.data.status)
    }
    // Deterministic keyset order: (createdAt ASC, id ASC).
    tasks = [...tasks].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )

    // pageOfKind needs { id } rows; carry the phase name alongside.
    const rows = tasks.map((t) => ({ id: t.id, t }))
    const p = pageOfKind(rows, q.data.limit, q.data.cursor, 'a task')
    if (!p.ok) return p.response

    return v1Ok(
      p.page.items.map(({ t }) => ({
        id: t.id,
        phaseId: t.phaseId,
        phaseName: phaseNames.get(t.phaseId) ?? null,
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
      { nextCursor: p.page.nextCursor, hasMore: p.page.hasMore },
    )
  },
)
