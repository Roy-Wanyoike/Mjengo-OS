import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { taskIdRef, taskDetailQuery, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, supplierProjectDenied } from './scope'

// /api/v1/tasks/:id (Phase D, read-only — the projects/tasks family) —
// src/app/api/v1/tasks/[id]/route.ts is the shim. The LIST lives at
// /api/v1/projects/:id/tasks (Phase B); this is its detail leg.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/tasks/:id — one task of the v2 task model (Doc A §11):
 * priority, assignment (worker name joined), dependency chain (blocker task
 * title joined), the blocker's recorded reason, and the verification trail —
 * every field the /api/v1/projects/:id/tasks list item carries, plus the
 * detail-only joins.
 *
 * Read-only — every mutation (task.create/update/assign/block/verify …)
 * stays on POST /api/actions, documented in the OpenAPI description (Phase D
 * is the read surface; the actions layer owns mutations).
 *
 * NO FEATURE FLAG gates this resource (the projects/tasks precedent — none
 * of the five flags names the task surface).
 *
 * ROLE SCOPING: resolve first, pin second (the v1 payments precedent) — the
 * task resolves by id (cuid; tasks carry no human code), then a client-role
 * session must be pinned to the task's own project (else 403 'Not permitted
 * for this project'). Unknown task → 404. W5-3: supplier sessions are not
 * project readers — uniform 403.
 *
 * DATA (honest seam note): tasks have no public single-row read (the webapp
 * reads them through the payload's phases include), so the detail row is
 * read here with the same joins (phase, assigned worker, blocker task) — the
 * wallet-transactions precedent. Pagination does not apply (one object).
 * Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'tasks/:id GET',
    rateLimit: { bucket: 'v1.task.get', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('tasks/:id GET', e, 'Task detail failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = taskIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, taskDetailQuery)
    if (!q.ok) return q.response

    const task = await db.task.findFirst({
      where: { id },
      include: {
        phase: { select: { id: true, name: true, projectId: true } },
        assignedTo: { select: { id: true, name: true } },
        blockedBy: { select: { id: true, title: true } },
      },
    })
    if (!task) return v1Err(404, 'Task not found')
    const denied = clientProjectDenied(session, task.phase.projectId)
    if (denied) return denied
    // W5-3: supplier sessions are not project readers. Uniform 403 — no
    // project data is returned.
    const supplierDenied = supplierProjectDenied(session)
    if (supplierDenied) return supplierDenied

    return v1Ok({
      id: task.id,
      projectId: task.phase.projectId,
      phaseId: task.phaseId,
      phaseName: task.phase?.name ?? null,
      title: task.title,
      status: task.status,
      progress: task.progress,
      priority: task.priority,
      dueDate: task.dueDate ? task.dueDate.toISOString() : null,
      assignedToId: task.assignedToId,
      assignedToName: task.assignedTo?.name ?? null,
      blockedById: task.blockedById,
      blockedByTitle: task.blockedBy?.title ?? null,
      blockedReason: task.blockedReason,
      verifiedAt: task.verifiedAt ? task.verifiedAt.toISOString() : null,
      verifiedByName: task.verifiedByName,
      version: task.version, // offline-sync entity version (bumped by every applier)
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    })
  },
)
