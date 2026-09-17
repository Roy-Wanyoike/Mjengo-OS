import { db } from '@/backend/lib/db'
import { centsToKes, sumCents } from '@/backend/lib/money'
import { maySeeWorkerPii } from '@/backend/lib/membership-scope'
import { route } from '@/backend/lib/route-kit'
import { validateQuery, workerDetailQuery, workerIdRef } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, supplierProjectDenied } from './scope'
import {
  todayStatusOf, weekEarningsOf, workerSummary, type AttendanceRow, type WorkerRow,
} from './worker-rows'

// /api/v1/workers/:id (Phase D, read-only — the site-workforce family) —
// src/app/api/v1/workers/[id]/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/workers/:id — one worker with the FULL attendance summary the
 * list honestly cannot carry: true counts over the worker's whole attendance
 * history (by status and by verification), paid/unpaid wage totals, and the
 * recent day rows.
 *
 * HONEST OMISSION: Worker.pin (the 4-digit kiosk PIN) is deliberately NOT
 * exposed — it is the worker's site-device identity (a bearer credential),
 * not a data field; the same rule that keeps project.shareToken out of v1.
 *
 * NO FEATURE FLAG gates this resource (the workers-family precedent — none
 * of the five flags names the workforce surface).
 *
 * ROLE SCOPING: resolve first, pin second (the v1 payments precedent) — the
 * worker resolves by id (cuid; workers carry no human code), then a
 * client-role session must be pinned to the worker's own project (else 403
 * 'Not permitted for this project'). Unknown worker → 404. W5-3: supplier
 * sessions are not project readers — uniform 403.
 *
 * WORKER PII (SEC-6, issue #174): idNumber / emergencyContactName /
 * emergencyContactPhone are served ONLY to membership-holders of the
 * worker's project, contractor/admin (the portfolio grant) and the
 * project's own client — every other reader (a supervisor/procurement/qs/
 * finance session WITHOUT a membership row on that project) still gets the
 * worker's roster + attendance data but the three PII fields read as NULLS.
 * The null is byte-identical to a worker with no PII recorded (the OpenAPI
 * schema is ['string','null'] either way), so the strip is not an oracle;
 * the field SHAPE never changes for the legit readers (issue #174: changing
 * what fields appear must not change shapes for the legit cases).
 *
 * DATA (honest seam note): the workforce module has no public single-worker
 * read (the webapp reads workers through the whole-project payload), so the
 * detail row is read here with the same include (attendances, date DESC) —
 * the wallet-transactions precedent ("route-layer implementation; the module
 * is left untouched"). todayStatus/weekEarnings re-derive with the payload's
 * exact logic (EAT "today", trailing 7 calendar days) so this read can never
 * disagree with the webapp's. Pagination does not apply (one object).
 * Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'workers/:id GET',
    rateLimit: { bucket: 'v1.worker.get', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('workers/:id GET', e, 'Worker detail failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = workerIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, workerDetailQuery)
    if (!q.ok) return q.response

    const worker = await db.worker.findFirst({
      where: { id },
      include: { attendances: { orderBy: { date: 'desc' } } },
    })
    if (!worker) return v1Err(404, 'Worker not found')
    const denied = clientProjectDenied(session, worker.projectId)
    if (denied) return denied
    // W5-3: supplier sessions are not project readers. Uniform 403 — no
    // project data is returned.
    const supplierDenied = supplierProjectDenied(session)
    if (supplierDenied) return supplierDenied

    // Raw CENTS rows — the worker-rows helpers convert at their boundaries.
    const attendances: AttendanceRow[] = worker.attendances
    const workerRow: WorkerRow = { ...worker, dailyRate: centsToKes(worker.dailyRate) }
    // SEC-6 (issue #174): the PII gate — resolved once, applied to the three
    // fields below (nulls for everyone else, the honest no-PII shape).
    const pii = await maySeeWorkerPii(session, worker.projectId)
    const present = attendances.filter((a) => a.status === 'present')
    const absent = attendances.filter((a) => a.status === 'absent')
    const halfDay = attendances.filter((a) => a.status === 'half_day')
    const excused = attendances.filter((a) => a.status === 'excused')
    const verified = attendances.filter((a) => a.verification === 'verified')
    const reported = attendances.filter((a) => a.verification === 'reported')
    const exception = attendances.filter((a) => a.verification === 'exception')
    const unpaid = attendances.filter((a) => !a.paid)

    return v1Ok({
      ...workerSummary(workerRow, todayStatusOf(attendances), weekEarningsOf(attendances)),
      // SEC-6 (issue #174): PII only for membership-holders of this
      // worker's project (+ contractor/admin, + the project's own client) —
      // nulls otherwise, indistinguishable from a worker with no PII on file.
      idNumber: pii ? worker.idNumber : null,
      emergencyContactName: pii ? worker.emergencyContactName : null,
      emergencyContactPhone: pii ? worker.emergencyContactPhone : null,
      attendanceSummary: {
        records: attendances.length,
        present: present.length,
        absent: absent.length,
        halfDay: halfDay.length,
        excused: excused.length,
        verified: verified.length,
        reported: reported.length,
        exception: exception.length,
        // Cents-exact (issue #122): rows carry wage in cents — sum exactly,
        // convert once at the boundary.
        paidWages: centsToKes(sumCents(attendances.map((a) => a.wage)) - sumCents(unpaid.map((a) => a.wage))),
        unpaidWages: centsToKes(sumCents(unpaid.map((a) => a.wage))),
        unpaidRecords: unpaid.length,
        firstDate: attendances.length ? attendances[attendances.length - 1].date : null,
        lastDate: attendances.length ? attendances[0].date : null,
      },
      recentAttendance: attendances.slice(0, 14).map((a) => ({
        id: a.id,
        date: a.date,
        status: a.status,
        checkIn: a.checkIn ? a.checkIn.toISOString() : null,
        checkOut: a.checkOut ? a.checkOut.toISOString() : null,
        method: a.method,
        wage: centsToKes(a.wage),
        paid: a.paid,
        verification: a.verification,
        exceptionReason: a.exceptionReason,
        version: a.version, // offline-sync entity version (bumped by every applier)
        createdAt: a.createdAt.toISOString(),
      })),
    })
  },
)
