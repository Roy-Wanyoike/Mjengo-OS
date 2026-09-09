// /api/v1 Phase D (site reads) — row mappers shared by the two
// worker-resource handlers (project-workers.ts, worker-detail.ts), the
// milestone-rows.ts pattern applied to the workforce roster.
//
// Structural input types (no '@prisma/client' model imports): the rows come
// from EITHER lib/mjengo getProjectPayload().workers (the webapp's main read
// — WorkerWithAttendance, todayStatus/weekEarnings already derived) or the
// detail route's own findFirst-include; both satisfy these shapes.
// Field-for-field honest projection:
//   · Worker.pin (the 4-digit kiosk PIN — a worker's site-device identity) is
//     DELIBERATELY ABSENT: it is a bearer credential for the shared site
//     device, not a data field (the same honesty rule as project.shareToken).
//   · skills parses from the stored JSON string array (defensive: malformed
//     stored JSON → [], never a 500).
//   · Worker has NO createdAt, NO updatedAt and NO offline-sync version
//     column — those fields are deliberately absent (no fabricated data); the
//     keyset total order is therefore the payload's own (name ASC, id ASC)
//     roster order. Attendance DOES carry a version and it surfaces where
//     attendance rows do.
//   · todayStatus/weekEarnings mirror the payload's OWN derivation (EAT
//     "today", trailing 7 calendar days) — recomputed identically here so the
//     detail route (a direct read) can never disagree with the webapp read.

const iso = (v: Date | null): string | null => (v ? v.toISOString() : null)

/** Fields every worker DTO head carries (list item = detail head, structural). */
export interface WorkerRow {
  id: string
  projectId: string
  name: string
  role: string
  phone: string
  dailyRate: number
  active: boolean
  idNumber: string | null
  employmentType: string | null
  skills: string | null
  emergencyContactName: string | null
  emergencyContactPhone: string | null
}

/**
 * Parse the JSON-encoded skills array — the parseEvidencePhotoIds convention
 * (defensive: a malformed stored string parses to [], never a 500 on a read).
 */
export function parseSkills(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Parse the JSON-encoded evidence/override arrays' LENGTH (counts only, defensive). */
export function jsonArrayLength(raw: string | null): number {
  if (!raw) return 0
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

/** Nairobi/EAT date string (UTC+3) — the platform's "today" (mjengo.ts todayStr). */
export function todayEAT(): string {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)
}

/** One attendance day-row, as the payload/detail derivations consume it. */
export interface AttendanceRow {
  id: string
  date: string
  status: string
  checkIn: Date | null
  checkOut: Date | null
  method: string
  wage: number
  paid: boolean
  verification: string
  exceptionReason: string | null
  exceptionNote: string | null
  recordedBy: string | null
  evidence: string | null
  overrideLog: string | null
  version: number
  createdAt: Date
}

/** The payload's todayStatus shape (mjengo.ts WorkerWithAttendance), verbatim. */
export interface TodayStatus {
  status: string | null
  checkIn: string | null
  checkOut: string | null
  method: string | null
  wage: number
  paid: boolean
  verification: string | null
  exceptionReason: string | null
}

/** Derive todayStatus for one worker from their attendance rows (the payload logic). */
export function todayStatusOf(attendances: AttendanceRow[]): TodayStatus {
  const t = attendances.find((a) => a.date === todayEAT())
  return {
    status: t?.status ?? null,
    checkIn: iso(t?.checkIn ?? null),
    checkOut: iso(t?.checkOut ?? null),
    method: t?.method ?? null,
    wage: t?.wage ?? 0,
    paid: t?.paid ?? false,
    verification: t?.verification ?? null,
    exceptionReason: t?.exceptionReason ?? null,
  }
}

/** Trailing 7-day earnings (the payload's weekEarnings derivation, verbatim). */
export function weekEarningsOf(attendances: AttendanceRow[]): number {
  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 6)
  return attendances
    .filter((a) => new Date(a.date) >= weekAgo)
    .reduce((s, a) => s + a.wage, 0)
}

/** The worker summary (list item): identity + the payload's attendance rollup. */
export function workerSummary(
  w: WorkerRow,
  todayStatus: TodayStatus,
  weekEarnings: number,
) {
  return {
    id: w.id,
    projectId: w.projectId,
    name: w.name,
    role: w.role,
    phone: w.phone,
    dailyRate: w.dailyRate,
    active: w.active,
    employmentType: w.employmentType,
    skills: parseSkills(w.skills),
    todayStatus,
    weekEarnings,
  }
}
