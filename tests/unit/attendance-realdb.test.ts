/**
 * Attendance day-rows under real constraints (issue #184 / audit TEST-2) —
 * the critical-path companion of the attendance coverage inside
 * v1-attendance-tasks.test.ts (stub suite, unchanged and still green).
 *
 * A worker's day-row is the wage source of truth (payroll reads it), and the
 * offline sync protocol leans on TWO database-level properties the stubs can
 * only pretend: the (workerId, date) UNIQUE constraint from migration 10
 * (a double check-in can never mint a second row), and the entity `version`
 * column every mutation bumps (the stale-version conflict metadata the sync
 * route's pre-check reads). Pinned here against the real engine, through the
 * REAL appliers (lib/mjengo.ts applyAction → actions/trust.ts — the same
 * dispatch production uses, AuditEvent included):
 *
 *  · the bulk muster (attendance.record) writes one day-row per worker with
 *    BigInt-exact wages (present = dailyRate, half_day = rate/2, absent = 0);
 *  · re-recording the SAME statuses is a no-op — a re-saved muster never
 *    downgrades verified evidence and never bumps the version;
 *  · a status CORRECTION updates the row in place: version +1 and the
 *    overrideLog grows append-only (history is never truncated);
 *  · the (workerId, date) unique constraint rejects a second row through
 *    Prisma (P2002) AND through the raw handle — the appliers' findFirst-
 *    then-create can't race into duplicates on this engine;
 *  · attendance.exception / attendance.override / attendance.checkin all
 *    bump the version — the number the sync stale-check compares against;
 *  · worker-verified check-in evidence (the JSON evidence column) survives
 *    a manager re-record of the same status.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

import { disposeRealDb, getRealTestDb, seedProject, seedWorker } from '../helpers/db'
import { applyAction } from '@/backend/lib/mjengo'

const { prisma, sqlite } = getRealTestDb()
afterAll(disposeRealDb)

/** EAT "today" — the same derivation the appliers use. */
const today = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)

describe('the bulk muster roll (attendance.record) on real tables', () => {
  it('writes one day-row per worker with exact BigInt wages', async () => {
    const project = await seedProject(prisma)
    const w1 = await seedWorker(prisma, project.id, { name: 'Wanjala Otieno', dailyRate: 80000n })
    const w2 = await seedWorker(prisma, project.id, { name: 'Achieng Milka', dailyRate: 75000n })

    const result = await applyAction(
      'attendance.record',
      { records: [{ workerId: w1.id, status: 'present' }, { workerId: w2.id, status: 'half_day' }] },
      project.id,
    )
    expect(result).toEqual({ count: 2 })

    const rows = await prisma.attendance.findMany({ where: { projectId: project.id } })
    expect(rows).toHaveLength(2)
    const r1 = rows.find((r) => r.workerId === w1.id)!
    const r2 = rows.find((r) => r.workerId === w2.id)!
    expect(r1.date).toBe(today())
    expect(r1.status).toBe('present')
    expect(r1.wage).toBe(80000n) // full day, cents
    expect(r1.version).toBe(1)
    expect(r2.status).toBe('half_day')
    expect(r2.wage).toBe(37500n) // exact BigInt halving of 75000 cents
    expect(r2.version).toBe(1)

    // Every dispatched action left its AuditEvent (the Bias-Free Ledger) —
    // real rows on the real engine.
    expect(await prisma.auditEvent.count({ where: { projectId: project.id } })).toBeGreaterThanOrEqual(1)
  })

  it('re-recording the SAME statuses is a true no-op (no version bump, no override entry)', async () => {
    const project = await seedProject(prisma)
    const worker = await seedWorker(prisma, project.id, { dailyRate: 90000n })
    await applyAction('attendance.record', { records: [{ workerId: worker.id, status: 'present' }] }, project.id)

    await applyAction(
      'attendance.record',
      { records: [{ workerId: worker.id, status: 'present' }], verification: 'reported' },
      project.id,
    )
    const row = await prisma.attendance.findFirstOrThrow({ where: { workerId: worker.id } })
    expect(row.version).toBe(1) // untouched — evidence not downgraded
    expect(row.overrideLog).toBeNull()
  })

  it('a status CORRECTION bumps the version and appends to the override log — history is never truncated', async () => {
    const project = await seedProject(prisma)
    const worker = await seedWorker(prisma, project.id, { dailyRate: 60000n })
    await applyAction('attendance.record', { records: [{ workerId: worker.id, status: 'present' }] }, project.id)

    await applyAction(
      'attendance.record',
      { records: [{ workerId: worker.id, status: 'absent' }], recordedBy: 'Foreman Njeri' },
      project.id,
    )
    let row = await prisma.attendance.findFirstOrThrow({ where: { workerId: worker.id } })
    expect(row.status).toBe('absent')
    expect(row.wage).toBe(0n)
    expect(row.version).toBe(2)
    const log1 = JSON.parse(row.overrideLog!) as Array<Record<string, unknown>>
    expect(log1).toHaveLength(1)
    expect(log1[0]).toMatchObject({ by: 'Foreman Njeri', from: 'present', to: 'absent', reason: 'Daily muster correction' })

    // …and again — the log APPENDS, the version keeps climbing.
    await applyAction('attendance.record', { records: [{ workerId: worker.id, status: 'half_day' }] }, project.id)
    row = await prisma.attendance.findFirstOrThrow({ where: { workerId: worker.id } })
    expect(row.version).toBe(3)
    expect(row.wage).toBe(30000n)
    expect((JSON.parse(row.overrideLog!) as unknown[])).toHaveLength(2)
  })
})

describe('the (workerId, date) unique constraint — migration 10, real', () => {
  it('rejects a second day-row through Prisma (P2002) and the raw handle', async () => {
    const project = await seedProject(prisma)
    const worker = await seedWorker(prisma, project.id)
    await applyAction('attendance.record', { records: [{ workerId: worker.id, status: 'present' }] }, project.id)

    await expect(
      prisma.attendance.create({
        data: { workerId: worker.id, projectId: project.id, date: today(), status: 'absent', wage: 0n },
      }),
    ).rejects.toThrow(/Unique constraint failed/)
    expect(() =>
      sqlite
        .prepare(`INSERT INTO Attendance (id, workerId, projectId, date, status, wage, version) VALUES ('att-dupe', ?, ?, ?, 'absent', 0, 1)`)
        .run(worker.id, project.id, today()),
    ).toThrow(/UNIQUE constraint failed/)
    // Still exactly one row for this worker today.
    expect(await prisma.attendance.count({ where: { workerId: worker.id } })).toBe(1)
  })

  it('a different worker the same day (and the same worker another day) stay legal', async () => {
    const project = await seedProject(prisma)
    const w1 = await seedWorker(prisma, project.id, { name: 'Day Mate A' })
    const w2 = await seedWorker(prisma, project.id, { name: 'Day Mate B' })
    await applyAction('attendance.record', { records: [{ workerId: w1.id, status: 'present' }] }, project.id)
    await expect(
      applyAction('attendance.record', { records: [{ workerId: w2.id, status: 'present' }] }, project.id),
    ).resolves.toBeTruthy()
    // Another day for w1: a direct row (the historical shape).
    await expect(
      prisma.attendance.create({
        data: { workerId: w1.id, projectId: project.id, date: '2026-01-15', status: 'present', wage: 80000n },
      }),
    ).resolves.toBeTruthy()
    expect(await prisma.attendance.count({ where: { projectId: project.id } })).toBe(3)
  })
})

describe('version bumps across every mutation path (the sync conflict metadata)', () => {
  it('check-in → check-out → exception → override each climb the version', async () => {
    const project = await seedProject(prisma)
    const worker = await seedWorker(prisma, project.id, { dailyRate: 70000n })

    // Worker-verified check-in (device evidence).
    const checkin = await applyAction('attendance.checkin', { workerId: worker.id, toggle: 'in' }, project.id)
    let row = await prisma.attendance.findFirstOrThrow({ where: { workerId: worker.id } })
    expect(row.status).toBe('present')
    expect(row.verification).toBe('verified')
    expect(JSON.parse(row.evidence!)).toContain('device')
    expect(row.version).toBe(1)

    // A manager re-record of the SAME status keeps the verified evidence…
    await applyAction('attendance.record', { records: [{ workerId: worker.id, status: 'present' }] }, project.id)
    row = await prisma.attendance.findFirstOrThrow({ where: { workerId: worker.id } })
    expect(row.verification).toBe('verified')
    expect(row.version).toBe(1)

    // …an exception report rides the same row (version +1)…
    await applyAction('attendance.exception', { workerId: worker.id, reason: 'battery_dead', note: 'phone died on site' }, project.id)
    row = await prisma.attendance.findFirstOrThrow({ where: { workerId: worker.id } })
    expect(row.verification).toBe('exception')
    expect(row.exceptionReason).toBe('battery_dead')
    expect(row.version).toBe(2)

    // …an explicit override (with a reason) appends + bumps again…
    await applyAction('attendance.override', { id: row.id, to: 'excused', reason: 'family emergency, sanctioned' }, project.id)
    row = await prisma.attendance.findFirstOrThrow({ where: { workerId: worker.id } })
    expect(row.status).toBe('excused')
    expect(row.wage).toBe(0n)
    expect(row.version).toBe(3)
    expect(JSON.parse(row.overrideLog!)).toHaveLength(1)

    // …and the check-out closes the day (version +1 more).
    await applyAction('attendance.checkin', { workerId: worker.id, toggle: 'out' }, project.id)
    row = await prisma.attendance.findFirstOrThrow({ where: { workerId: worker.id } })
    expect(row.checkOut).not.toBeNull()
    expect(row.version).toBe(4)

    // The stale-version arithmetic the sync route performs on this column:
    // a client holding baseVersion 2 against serverVersion 4 IS stale.
    expect(2 < row.version).toBe(true)
    expect(checkin.id).toBe(row.id) // one row, one identity, all day
  })
})
