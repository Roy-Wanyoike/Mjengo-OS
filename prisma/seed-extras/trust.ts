/**
 * MjengoOS — Workforce Trust seed extras (Task 6-a).
 * Run AFTER the base seed:  bun prisma/seed-extras/trust.ts
 *
 * Recreates attendance history for the 3 seeded projects with realistic
 * evidence levels (verified / reported / exception), append-only override log
 * sample, consistent wages, and deterministic kiosk PINs on ~half the workers.
 * Only Attendance rows for these projects are touched (+ Worker.pin updates).
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

/** EAT "today" — same convention as lib/mjengo.ts todayStr(). */
function eatToday(): string {
  return new Date(new Date().getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10)
}

/** The last n weekdays as ISO dates (index 0 = today if today is a weekday). */
function lastWeekdays(n: number): string[] {
  const out: string[] = []
  const cursor = new Date(`${eatToday()}T12:00:00Z`)
  while (out.length < n) {
    const dow = cursor.getUTCDay()
    if (dow !== 0 && dow !== 6) out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return out
}

function at(date: string, hour: number, minute: number): Date {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`)
}

function wageFor(status: string, dailyRate: number): number {
  return status === 'present' ? dailyRate : status === 'half_day' ? dailyRate * 0.5 : 0
}

function evidenceFor(method: string): string {
  if (method === 'ussd') return JSON.stringify(['ussd', 'device'])
  if (method === 'kiosk_pin') return JSON.stringify(['pin', 'device'])
  return JSON.stringify(['gps', 'device'])
}

type Cell = {
  status: 'present' | 'half_day' | 'absent' | 'excused'
  kind: 'verified' | 'reported' | 'exception'
  method?: string // for verified cells
  exceptionReason?: string
  exceptionNote?: string
  overrideLog?: string
}

interface WorkerSeed {
  id: string
  name: string
  dailyRate: number
}

async function insertAttendance(
  projectId: string,
  workers: WorkerSeed[],
  days: string[],
  /** cellFor(dayIndex, workerIndex) — deterministic plan */
  cellFor: (d: number, w: number) => Cell,
  paidFor: (d: number) => boolean,
  recordedBy = 'Mwangi Kariuki (Foreman)',
) {
  for (let d = 0; d < days.length; d++) {
    for (let w = 0; w < workers.length; w++) {
      const worker = workers[w]
      const c = cellFor(d, w)
      const verified = c.kind === 'verified'
      const method = verified ? c.method || 'geofence' : 'manager'
      await db.attendance.create({
        data: {
          workerId: worker.id,
          projectId,
          date: days[d],
          checkIn: verified ? at(days[d], 7, 40 + (w % 3) * 5) : null,
          checkOut: verified ? at(days[d], 17, 5 + (w % 4) * 5) : null,
          status: c.status,
          method,
          wage: wageFor(c.status, worker.dailyRate),
          paid: paidFor(d),
          verification: c.kind,
          evidence: verified ? evidenceFor(method) : c.kind === 'exception' ? JSON.stringify(['supervisor']) : null,
          exceptionReason: c.exceptionReason ?? null,
          exceptionNote: c.exceptionNote ?? null,
          overrideLog: c.overrideLog ?? null,
          recordedBy: c.kind === 'reported' ? recordedBy : null,
        },
      })
    }
  }
}

async function main() {
  const projects = await db.project.findMany({ orderBy: { createdAt: 'asc' } })
  if (projects.length < 3) throw new Error('Expected the 3 seeded projects — run `bun prisma/seed.ts` first')

  // ---- wipe attendance for the seeded projects (recreated below) ----
  const seededIds = projects.slice(0, 3).map((p) => p.id)
  const wiped = await db.attendance.deleteMany({ where: { projectId: { in: seededIds } } })
  console.log(`Wiped ${wiped.count} attendance rows across the 3 seeded projects`)

  // Workers carry no createdAt column — order them by the base seed's insertion
  // roster (name list), falling back to name-sorted if the roster drifted.
  const P1_ROSTER = ['Mwangi Kariuki', 'Otieno Odhiambo', 'Kevin Mutiso', 'Bernard Kimani', 'Ali Hassan', 'Joseph Mwenda', 'Peter Ochieng']
  const P2_ROSTER = ['Joseph Kimani', 'Peter Otieno', 'Brian Mwangi', 'Sarah Wanjiru']
  const P3_ROSTER = ['Mwakideu Chengo', 'Athman Salim', 'Neema Mwakembe']
  const ordered = async (projectId: string, roster: string[]): Promise<WorkerSeed[]> => {
    const found = await db.worker.findMany({ where: { projectId }, orderBy: { name: 'asc' } })
    const rows = found.map((w) => ({ id: w.id, name: w.name, dailyRate: w.dailyRate }))
    if (roster.every((name) => rows.some((r) => r.name === name))) {
      return roster.map((name) => rows.find((r) => r.name === name)!)
    }
    console.warn(`Roster drift for project ${projectId} — using name-sorted order`)
    return rows
  }
  const [p1Workers, p2Workers, p3Workers] = await Promise.all([
    ordered(projects[0].id, P1_ROSTER),
    ordered(projects[1].id, P2_ROSTER),
    ordered(projects[2].id, P3_ROSTER),
  ])

  // ==========================================================================
  // P1 — Nyumba Yangu (7 fundis): last 10 weekdays, ~70% verified (geofence /
  // ussd / kiosk_pin mix), ~20% manager-reported, 3 exceptions on earlier days.
  // Today: 5 verified + 2 reported (all present, unpaid).
  // ==========================================================================
  {
    const workers = p1Workers
    const days = lastWeekdays(10) // days[0] = today
    const workerMethods = ['kiosk_pin', 'geofence', 'geofence', 'geofence', 'geofence', 'ussd', 'ussd']

    await insertAttendance(
      projects[0].id,
      workers,
      days,
      (d, w) => {
        // Today: 5 verified + 2 reported
        if (d === 0) {
          return w < 5
            ? { status: 'present', kind: 'verified', method: workerMethods[w] }
            : { status: 'present', kind: 'reported' }
        }
        // Exceptions spread on earlier days (2-3 rows, resolved by now)
        if (d === 7 && w === 4) return { status: 'present', kind: 'exception', exceptionReason: 'battery_dead', exceptionNote: 'Phone died overnight — confirmed on site by foreman, charged by lunch' }
        if (d === 4 && w === 2) return { status: 'present', kind: 'exception', exceptionReason: 'network', exceptionNote: 'No Safaricom signal at the trench edge — checked in verbally' }
        if (d === 2 && w === 5) return { status: 'present', kind: 'exception', exceptionReason: 'phone_damaged', exceptionNote: 'Screen cracked over the weekend — kiosk PIN issued' }
        // Absences / half days
        if (d === 8 && w === 3) return { status: 'absent', kind: 'reported' }
        if (d === 6 && w === 5) return { status: 'absent', kind: 'reported' }
        if (d === 5 && w === 2) return { status: 'half_day', kind: 'reported' }
        if (d === 1 && w === 6) {
          return {
            status: 'half_day', kind: 'reported',
            overrideLog: JSON.stringify([
              { at: `${days[1]}T14:30:00.000Z`, by: 'Mwangi Kariuki (Foreman)', from: 'present', to: 'half_day', reason: 'Left early — school fees errand, half wage agreed' },
            ]),
          }
        }
        // ~20% manager-reported cells, rest worker-verified
        const reported = (d + w) % 5 === 0
        return reported
          ? { status: 'present', kind: 'reported' }
          : { status: 'present', kind: 'verified', method: workerMethods[w] }
      },
      (d) => d > 0, // history paid out weekly; today unpaid
    )

    // Kiosk PINs (deterministic) on ~half the crew
    const pins: Record<string, string> = { '0': '1234', '1': '2468', '4': '1357' }
    for (const [idx, pin] of Object.entries(pins)) {
      await db.worker.update({ where: { id: workers[Number(idx)].id }, data: { pin } })
    }
  }

  // ==========================================================================
  // P2 — Kiambu Road Duplex (4 fundis): last 8 weekdays mostly verified;
  // today 3 verified + 1 exception (network) — payroll gate demo.
  // ==========================================================================
  {
    const workers = p2Workers
    const days = lastWeekdays(8)
    const workerMethods = ['geofence', 'geofence', 'ussd', 'app']

    await insertAttendance(
      projects[1].id,
      workers,
      days,
      (d, w) => {
        if (d === 0) {
          return w === 3
            ? { status: 'present', kind: 'exception', exceptionReason: 'network', exceptionNote: 'Network down on Kiambu Road — confirmed on site by Joseph Kimani' }
            : { status: 'present', kind: 'verified', method: workerMethods[w] }
        }
        if (d === 5 && w === 2) return { status: 'absent', kind: 'reported' }
        if (d === 3 && w === 1) return { status: 'half_day', kind: 'reported' }
        if ((d + w) % 6 === 0) return { status: 'present', kind: 'reported' }
        return { status: 'present', kind: 'verified', method: workerMethods[w] }
      },
      (d) => d > 0,
      'Joseph Kimani (Foreman)',
    )

    const pins: Record<string, string> = { '0': '3690', '3': '4826' }
    for (const [idx, pin] of Object.entries(pins)) {
      await db.worker.update({ where: { id: workers[Number(idx)].id }, data: { pin } })
    }
  }

  // ==========================================================================
  // P3 — Diani Renovation (historical crew): fully verified, all paid.
  // ==========================================================================
  {
    const workers = p3Workers
    // last 5 weekdays shifted exactly 9 weeks back (63 days preserves weekdays)
    const days = lastWeekdays(5).map((iso) => {
      const d = new Date(`${iso}T12:00:00Z`)
      d.setUTCDate(d.getUTCDate() - 63)
      return d.toISOString().slice(0, 10)
    })
    const statuses = ['present', 'present', 'present', 'half_day', 'present'] as const
    await insertAttendance(
      projects[2].id,
      workers,
      days,
      (d, w) => ({ status: statuses[(d * 3 + w) % statuses.length], kind: 'verified', method: 'geofence' }),
      () => true,
    )
  }

  // ---- report ----
  for (const p of projects.slice(0, 3)) {
    const rows = await db.attendance.groupBy({
      by: ['verification'],
      where: { projectId: p.id },
      _count: { _all: true },
      _sum: { wage: true },
    })
    const parts = rows.map((r) => `${r.verification}: ${r._count._all} rows / KSh ${r._sum.wage ?? 0}`).join(' · ')
    const today = eatToday()
    const todayRows = await db.attendance.findMany({ where: { projectId: p.id, date: today } })
    const todayParts = ['verified', 'reported', 'exception']
      .map((v) => `${v}=${todayRows.filter((r) => r.verification === v).length}`)
      .join(' ')
    const withPins = await db.worker.count({ where: { projectId: p.id, pin: { not: null } } })
    console.log(`${p.name}: ${parts} | today(${today}): ${todayParts} unpaid=${todayRows.filter((r) => !r.paid).length} | workers with PIN: ${withPins}`)
  }
  console.log('Trust seed extras done.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
