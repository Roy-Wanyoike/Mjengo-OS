import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { projectIdRef, projectAttendanceQuery, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, membershipProjectDenied, supplierProjectDenied } from './scope'
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
 * BEFORE pagination. Pagination is the wallet-list order — a deterministic
 * (createdAt DESC, id DESC) total order (newest day-rows first) — but since
 * issue #155 (audit API-4) it is pushed INTO the findMany: the filters, the
 * keyset boundary (the cursor row's createdAt/id pair, the audit-route
 * pattern) and take = limit + 1 all ride the single query, so page 2 never
 * re-reads page 1 rows at the DB level and the scan is bounded by the page,
 * not the table. A cursor that falls out of the filtered list → 400 (the
 * pageOfKind message, byte-identical).
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
    // SEC-6 (issue #174): the site-team membership pin — supervisor /
    // procurement / qs / finance read only the projects they hold a
    // ProjectMembership row on (fail closed on zero rows); contractor/admin
    // keep the explicit portfolio-wide grant. Same uniform 403 body as the
    // client pin, after the resolve (resolve-then-pin, the v1 precedent).
    const membershipDenied = await membershipProjectDenied(session, id)
    if (membershipDenied) return membershipDenied
    // W5-3: supplier sessions are not project readers. Uniform 403 — no
    // project data is returned.
    const supplierDenied = supplierProjectDenied(session)
    if (supplierDenied) return supplierDenied

    // The filters, applied identically to the page query and the cursor
    // membership check below (filter-before-pagination, unchanged).
    const filters = {
      projectId: id,
      ...(q.data.workerId ? { workerId: q.data.workerId } : {}),
      ...(q.data.status ? { status: q.data.status } : {}),
      ...(q.data.date ? { date: q.data.date } : {}),
    }
    const inFilteredSet = (a: { projectId: string; workerId: string; status: string; date: string }) =>
      a.projectId === filters.projectId &&
      (filters.workerId === undefined || a.workerId === filters.workerId) &&
      (filters.status === undefined || a.status === filters.status) &&
      (filters.date === undefined || a.date === filters.date)

    // Keyset boundary (#155): resolve the cursor row by id, then refuse it
    // unless it belongs to THIS filtered list — the exact pageOfKind rule
    // ("the id of an attendance record in this list"), same 400 body.
    let boundary: { createdAt: Date; id: string } | null = null
    if (q.data.cursor) {
      const cursorRow = await db.attendance.findUnique({ where: { id: q.data.cursor } })
      if (!cursorRow || !inFilteredSet(cursorRow)) {
        return v1Err(400, 'Unknown cursor — it must be the id of an attendance record in this list', 'cursor')
      }
      boundary = { createdAt: cursorRow.createdAt, id: cursorRow.id }
    }

    // One query: filters + boundary + (createdAt DESC, id DESC) + take
    // limit+1 — the extra row reveals hasMore without a count (the
    // audit-route pattern). The full load + in-memory sort + slice this
    // replaced read EVERY day-row of the project per page (API-4).
    const rows = await db.attendance.findMany({
      where: {
        ...filters,
        ...(boundary
          ? {
              OR: [
                { createdAt: { lt: boundary.createdAt } },
                { createdAt: boundary.createdAt, id: { lt: boundary.id } },
              ],
            }
          : {}),
      },
      include: { worker: { select: { name: true, role: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.data.limit + 1,
    })

    const hasMore = rows.length > q.data.limit
    const attendance = rows.slice(0, q.data.limit)
    const nextCursor = hasMore ? attendance[attendance.length - 1]?.id ?? null : null

    return v1Ok(
      attendance.map((a) => ({
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
      { nextCursor, hasMore },
    )
  },
)
