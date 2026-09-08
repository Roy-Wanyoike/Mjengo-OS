import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { projectIdRef, projectAttendanceQuery, validateQuery } from './schemas'
import { mapServiceError, pageOfKind, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, supplierProjectDenied } from './scope'
import { jsonArrayLength } from './worker-rows'

// /api/v1/projects/:id/attendance (Phase D, read-only — the site-workforce
// family) — src/app/api/v1/projects/[id]/attendance/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/projects/:id/attendance — the project's attendance day-rows
 * (Doc A §15-16), the Workforce Trust surface: reported vs verified presence,
 * exceptions and their reasons, and the paid state the payroll gate consumes.
 *
 * NO FEATURE FLAG gates this resource (the workers-family precedent — none
 * of the five flags names the workforce/attendance surface).
 *
 * ROLE SCOPING: same as /api/v1/projects/:id (client pinned to their own
 * project, foreign → 403; unknown project → 404). W5-3: supplier sessions
 * are not project readers — uniform 403.
 *
 * QUERY: ?workerId= (a worker of this project — a foreign or unknown id
 * matches no rows and answers an honest empty page, the never-written-status
 * precedent), ?status= (present|absent|half_day|excused), ?date= (an exact
 * YYYY-MM-DD calendar day — the column IS a date string). All three filter
 * BEFORE pagination. Pagination is the wallet-list pattern: a deterministic
 * (createdAt DESC, id DESC) total order (newest day-rows first) sliced in
 * the route layer; a cursor that falls out of the filtered list → 400.
 *
 * DATA (honest seam note): attendance rows are read here with a route-layer
 * include (worker name/role join — the wallet-transactions precedent; the
 * webapp reads them inside getProjectPayload's worker include). Evidence and
 * the append-only override log are JSON arrays in storage — they surface as
 * COUNTS ONLY (evidenceCount/overrideCount), never raw payloads. Rate limit:
 * 120/min per principal.
 */
export const GET = route(
  {
    scope: 'projects/:id/attendance GET',
    rateLimit: { bucket: 'v1.projects.attendance', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects/:id/attendance GET', e, 'Project attendance failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = projectIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, projectAttendanceQuery)
    if (!q.ok) return q.response

    // Unknown project → 404 (an honest "nothing here", not an empty page).
    const project = await db.project.findUnique({ where: { id } })
    if (!project) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, id)
    if (denied) return denied
    // W5-3: supplier sessions are not project readers. Uniform 403 — no
    // project data is returned.
    const supplierDenied = supplierProjectDenied(session)
    if (supplierDenied) return supplierDenied

    const rows = await db.attendance.findMany({
      where: {
        projectId: id,
        ...(q.data.workerId ? { workerId: q.data.workerId } : {}),
        ...(q.data.status ? { status: q.data.status } : {}),
        ...(q.data.date ? { date: q.data.date } : {}),
      },
      include: { worker: { select: { name: true, role: true } } },
    })
    // Deterministic keyset order: (createdAt DESC, id DESC) — the day-sheet
    // reads newest-first, the invoices-list precedent.
    const attendance = [...rows].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )

    const p = pageOfKind(attendance, q.data.limit, q.data.cursor, 'an attendance record')
    if (!p.ok) return p.response

    return v1Ok(
      p.page.items.map((a) => ({
        id: a.id,
        projectId: a.projectId,
        workerId: a.workerId,
        workerName: a.worker?.name ?? null,
        workerRole: a.worker?.role ?? null,
        date: a.date,
        status: a.status,
        checkIn: a.checkIn ? a.checkIn.toISOString() : null,
        checkOut: a.checkOut ? a.checkOut.toISOString() : null,
        method: a.method,
        wage: a.wage,
        paid: a.paid,
        verification: a.verification,
        evidenceCount: jsonArrayLength(a.evidence),
        overrideCount: jsonArrayLength(a.overrideLog),
        exceptionReason: a.exceptionReason,
        exceptionNote: a.exceptionNote,
        recordedBy: a.recordedBy,
        version: a.version, // offline-sync entity version (bumped by every applier)
        createdAt: a.createdAt.toISOString(),
      })),
      { nextCursor: p.page.nextCursor, hasMore: p.page.hasMore },
    )
  },
)
