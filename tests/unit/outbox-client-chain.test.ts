/**
 * #183 — the CLIENT half of the offline conflict chain, unit-pinned on the
 * real use-mjengo module (same conventions as outbox-auto-retry.test.ts /
 * outbox-auth-drain.test.ts: sonner mocked, the zustand store imported real —
 * persist is inert in node).
 *
 * THE BUG this file guards against (issue #183): the server versions
 * attendance.override, but the client's stampBaseVersion never stamped it —
 * an offline override queued WITHOUT baseVersion sailed past the server's
 * detectStaleVersion (null) and applied silently, i.e. last-write-wins for
 * exactly that action type. Pinned here:
 *
 *  · stampBaseVersion stamps EVERY type the server versions — task.* by row
 *    id, attendance day-actions by the worker's day-row, attendance.override
 *    by the attendance ROW id, the bulk muster per record (JSON-string AND
 *    array shapes — the server accepts both), and NO stamp when the row is
 *    unknown/versionless (legacy applies as today). A source pin extracts
 *    the route's VERSIONED_*_TYPES from sync.ts and drives the stamping
 *    assertions off the SERVER's set — a future versioned type the client
 *    forgets to stamp fails loudly;
 *  · bumpLocalAttendanceVersion bumps the worker's today-row (the optimistic
 *    mirror of the server appliers' version bump);
 *  · reduceLocal's optimistic task.version bump + the attendance mirrors
 *    (#183 adjacent gap: record / exception / override now show
 *    optimistically in the Fundis tab instead of only as a queued toast);
 *  · normalizeOutboxItem migrates stale persisted items to the current
 *    shape (v0 → v2 lifecycle fields, #132 retry fields);
 *  · THE invariant, end-to-end through the real store's offline dispatch:
 *    the SECOND offline edit of the same row stamps the NEWER baseVersion —
 *    for a task (id path) and for an attendance override (row-id path) — or
 *    the device would reject its own queued sequence on flush.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import {
  useMjengo,
  stampBaseVersion,
  reduceLocal,
  bumpLocalAttendanceVersion,
  normalizeOutboxItem,
  type OutboxItem,
} from '@/frontend/hooks/use-mjengo'
import type { ProjectPayload, WorkerWithAttendance } from '@/backend/lib/mjengo'

// ---------------- fixtures ----------------

/** EAT "today" — mirrors the module's todayEAT() so day-row lookups line up. */
const todayEAT = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)

const yesterdayEAT = () =>
  new Date(Date.now() + 3 * 3600 * 1000 - 86_400_000).toISOString().slice(0, 10)

/** A minimal payload carrying exactly the rows the conflict chain keys on. */
function payloadFixture() {
  return {
    project: { id: 'p-1', name: 'Test Build' },
    phases: [
      {
        id: 'ph-1',
        name: 'Foundations',
        budget: 100_000,
        progress: 30,
        tasks: [
          {
            id: 't-1', phaseId: 'ph-1', title: 'Pour slab', status: 'in_progress', progress: 30,
            priority: 'normal', assignedToId: null, blockedById: null, blockedReason: null,
            verifiedAt: null, verifiedByName: null, dueDate: null, version: 5,
          },
        ],
      },
    ],
    workers: [
      {
        id: 'w-1', projectId: 'p-1', name: 'Kamau', role: 'Fundi', phone: '+254700000001',
        dailyRate: 800, active: true, weekEarnings: 0,
        attendances: [
          { id: 'a-today', workerId: 'w-1', date: todayEAT(), status: 'present', wage: 800, version: 2, paid: false },
          { id: 'a-yday', workerId: 'w-1', date: yesterdayEAT(), status: 'present', wage: 800, version: 7, paid: true },
        ],
        todayStatus: {
          status: 'present', checkIn: '2026-09-18T07:00:00.000Z', checkOut: null, method: 'app',
          wage: 800, paid: false, verification: 'reported', exceptionReason: null,
        },
      },
      {
        // A worker with NO attendance rows — the unknown-row stamping arm.
        id: 'w-2', projectId: 'p-1', name: 'Njeri', role: 'Mtumishi (Labourer)', phone: '',
        dailyRate: 600, active: true, weekEarnings: 0,
        attendances: [],
        todayStatus: { status: null, checkIn: null, checkOut: null, method: null, wage: 0, paid: false, verification: null, exceptionReason: null },
      },
    ],
    summary: {
      dayCount: 10, daysRemaining: 80, progressPct: 30, budgetTotal: 100_000, budgetSpent: 0,
      budgetSpentPct: 0, plannedSpendPct: 0, spendVsPlanDelta: 0, fundisToday: 1, fundisExpected: 2,
      wagesToday: 800, wagesUnpaid: 800, fundisVerified: 0, fundisReported: 1, fundisException: 0,
      wagesVerified: 0, wagesPendingReview: 0, materialSpend: 0, spendTrend: [], unackedAlerts: 0,
    },
    // Slices reduceLocal never touches on these paths — present for shape honesty.
    materials: [], consumptions: [], deliveries: [], photos: [], alerts: [], transactions: [],
    recaps: [], escrow: null, milestones: [], variations: [], zones: [], notifications: [],
    auditEvents: [], photoComments: [],
  } as unknown as ProjectPayload
}

const taskOf = (d: ProjectPayload) => (d.phases[0].tasks[0] as unknown as Record<string, unknown>)
const worker1 = (d: ProjectPayload) => d.workers[0]
const todayRow = (d: ProjectPayload) =>
  worker1(d).attendances.find((a) => a.date === todayEAT()) as unknown as Record<string, unknown>

// ---------------- source pin: the SERVER's versioned sets ----------------

const syncSrc = readFileSync(fileURLToPath(new URL('../../src/backend/api/sync.ts', import.meta.url)), 'utf8')

const setOf = (name: string): string[] => {
  const body = syncSrc.match(new RegExp(`const ${name} = new Set<string>\\(\\[([^\\]]+)\\]`))?.[1] ?? ''
  return body.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

const SERVER_TASK_TYPES = setOf('VERSIONED_TASK_TYPES')
const SERVER_ATTENDANCE_TYPES = setOf('VERSIONED_ATTENDANCE_TYPES')

// ---------------- stampBaseVersion ----------------

describe('#183 stampBaseVersion — the client stamps every type the server versions', () => {
  const data = payloadFixture()

  it('task.* by row id: every server-versioned task type stamps the task row\'s version', () => {
    expect(SERVER_TASK_TYPES.length).toBeGreaterThanOrEqual(6)
    for (const type of SERVER_TASK_TYPES) {
      const stamped = stampBaseVersion(data, type, { id: 't-1' })
      expect(
        stamped.baseVersion,
        `#183: server versions "${type}" but the client did not stamp it by task id`,
      ).toBe(5)
    }
  })

  it('attendance day-actions (checkin/setStatus/exception) stamp the worker\'s today-row version', () => {
    for (const type of ['attendance.checkin', 'attendance.setStatus', 'attendance.exception']) {
      const stamped = stampBaseVersion(data, type, { workerId: 'w-1' })
      expect(stamped.baseVersion).toBe(2)
    }
  })

  it('attendance.override stamps the TARGET ROW\'s version (row-id path — the #183 fix)', () => {
    const stamped = stampBaseVersion(data, 'attendance.override', { id: 'a-today', to: 'absent', reason: 'sick' })
    expect(stamped.baseVersion).toBe(2)
    // A past row is keyed by its OWN id, not the today-row.
    const past = stampBaseVersion(data, 'attendance.override', { id: 'a-yday', to: 'absent', reason: 'sick' })
    expect(past.baseVersion).toBe(7)
  })

  it('bulk muster stamps each record with the worker\'s today-row version (JSON-string shape preserved)', () => {
    const records = JSON.stringify([
      { workerId: 'w-1', status: 'absent' },
      { workerId: 'w-2', status: 'present' }, // no local row — left unstamped
    ])
    const stamped = stampBaseVersion(data, 'attendance.record', { records, verification: 'reported' })
    expect(typeof stamped.records).toBe('string')
    const parsed = JSON.parse(stamped.records) as Array<Record<string, unknown>>
    expect(parsed[0].baseVersion).toBe(2)
    expect(parsed[1].baseVersion).toBeUndefined()
  })

  it('bulk muster stamps ARRAY-shaped records too and keeps the array shape (the server accepts both)', () => {
    const stamped = stampBaseVersion(data, 'attendance.record', {
      records: [{ workerId: 'w-1', status: 'absent' }],
      verification: 'reported',
    })
    expect(Array.isArray(stamped.records)).toBe(true)
    expect(stamped.records[0].baseVersion).toBe(2)
  })

  it('no stamp when the row is unknown or versionless (legacy applies as today)', () => {
    // Unknown task id → payload untouched.
    expect(stampBaseVersion(data, 'task.update', { id: 't-404', progress: 50 })).not.toHaveProperty('baseVersion')
    // Task without a version field → nothing honest to stamp.
    const bare = payloadFixture()
    delete (taskOf(bare) as { version?: number }).version
    expect(stampBaseVersion(bare, 'task.block', { id: 't-1', reason: 'x' })).not.toHaveProperty('baseVersion')
    // Worker with no today-row → day-actions unstamped.
    expect(stampBaseVersion(data, 'attendance.setStatus', { workerId: 'w-2', status: 'absent' }))
      .not.toHaveProperty('baseVersion')
    // Override of a row the client does not know → unstamped.
    expect(stampBaseVersion(data, 'attendance.override', { id: 'a-404', to: 'absent', reason: 'x' }))
      .not.toHaveProperty('baseVersion')
  })

  it('non-object payloads pass through untouched', () => {
    expect(stampBaseVersion(data, 'task.update', null)).toBeNull()
    expect(stampBaseVersion(data, 'attendance.setStatus', 'workerId')).toBe('workerId')
  })

  it('the day-action date key is honoured (a stamped past date uses that row, not today)', () => {
    const stamped = stampBaseVersion(data, 'attendance.setStatus', { workerId: 'w-1', status: 'absent', date: yesterdayEAT() })
    expect(stamped.baseVersion).toBe(7)
  })

  it('source pin: every server-versioned ATTENDANCE type is stamped by the client (fails loudly on a new type)', () => {
    expect(SERVER_ATTENDANCE_TYPES.length).toBeGreaterThanOrEqual(5)
    // One sample payload per known attendance keying. A NEW server-versioned
    // attendance type is absent here → the expectation below fails with the
    // type named, demanding a stamping arm + sample.
    const SAMPLES: Record<string, () => Record<string, unknown>> = {
      'attendance.checkin': () => ({ workerId: 'w-1', toggle: 'in' }),
      'attendance.setStatus': () => ({ workerId: 'w-1', status: 'absent' }),
      'attendance.exception': () => ({ workerId: 'w-1', reason: 'forgot' }),
      'attendance.record': () => ({ records: JSON.stringify([{ workerId: 'w-1', status: 'absent' }]) }),
      'attendance.override': () => ({ id: 'a-today', to: 'absent', reason: 'sick' }),
    }
    const stampedVersionOf = (type: string, stamped: Record<string, unknown>): unknown =>
      type === 'attendance.record'
        ? (JSON.parse(String(stamped.records)) as Array<{ baseVersion?: number }>)[0]?.baseVersion
        : stamped.baseVersion
    for (const type of SERVER_ATTENDANCE_TYPES) {
      const sample = SAMPLES[type]
      expect(sample, `#183: no client stamp sample for new server-versioned type "${type}"`).toBeDefined()
      expect(stampedVersionOf(type, stampBaseVersion(data, type, sample!()))).toBe(2)
    }
  })
})

// ---------------- bumpLocalAttendanceVersion ----------------

describe('#183 bumpLocalAttendanceVersion — the optimistic day-row bump', () => {
  it('bumps the worker\'s today-row version (known version → +1)', () => {
    const w = { attendances: [{ date: todayEAT(), version: 2 }] } as unknown as WorkerWithAttendance
    bumpLocalAttendanceVersion(w)
    expect((w.attendances[0] as unknown as { version: number }).version).toBe(3)
  })

  it('no today-row → no-op (nothing to bump; the server creates the row)', () => {
    const w = { attendances: [] } as unknown as WorkerWithAttendance
    expect(() => bumpLocalAttendanceVersion(w)).not.toThrow()
    expect(w.attendances).toHaveLength(0)
  })

  it('a versionless today-row is treated as version 1 and bumped to 2 (schema default parity)', () => {
    const w = { attendances: [{ date: todayEAT() }] } as unknown as WorkerWithAttendance
    bumpLocalAttendanceVersion(w)
    expect((w.attendances[0] as unknown as { version?: number }).version).toBe(2)
  })
})

// ---------------- reduceLocal ----------------

describe('#183 reduceLocal — optimistic version bumps + the attendance mirrors', () => {
  it('task.update bumps the local Task.version so the second offline edit stamps the newer baseVersion', () => {
    const d = reduceLocal(payloadFixture(), 'task.update', { id: 't-1', progress: 50 })
    expect(taskOf(d)).toMatchObject({ progress: 50, version: 6 })
    // The reducer is pure — the input payload is not mutated.
    expect(taskOf(payloadFixture())).toMatchObject({ progress: 30, version: 5 })
  })

  it('attendance.record mirror: a DIFFERENT status corrects todayStatus + bumps the day-row version', () => {
    const records = JSON.stringify([{ workerId: 'w-1', status: 'absent' }])
    const d = reduceLocal(payloadFixture(), 'attendance.record', { records, verification: 'reported' })
    expect(todayRow(d)).toMatchObject({ status: 'absent', version: 3 })
    expect(worker1(d).todayStatus).toMatchObject({ status: 'absent', wage: 0, paid: false })
    expect(d.summary.wagesToday).toBe(0) // 800 → 0
  })

  it('attendance.record mirror: a same-status record is a NO-OP (evidence protection — no bump)', () => {
    const records = JSON.stringify([{ workerId: 'w-1', status: 'present' }])
    const d = reduceLocal(payloadFixture(), 'attendance.record', { records, verification: 'reported' })
    expect(todayRow(d)).toMatchObject({ status: 'present', version: 2 })
    expect(worker1(d).todayStatus).toMatchObject({ status: 'present', wage: 800 })
  })

  it('attendance.record mirror: a worker with no today-row gets one (check-in stamped, wage counted)', () => {
    const records = JSON.stringify([{ workerId: 'w-2', status: 'present' }])
    const d = reduceLocal(payloadFixture(), 'attendance.record', { records, verification: 'reported' })
    const w2 = d.workers.find((w) => w.id === 'w-2')!
    expect(w2.todayStatus).toMatchObject({ status: 'present', wage: 600, method: 'manager', verification: 'reported' })
    expect(w2.todayStatus.checkIn).not.toBeNull()
    expect(d.summary.fundisToday).toBe(2)
    expect(d.summary.wagesToday).toBe(1400)
  })

  it('attendance.exception mirror: verification exception + reason on an existing row', () => {
    const d = reduceLocal(payloadFixture(), 'attendance.exception', { workerId: 'w-1', reason: 'forgot' })
    expect(todayRow(d)).toMatchObject({ status: 'present', version: 3, verification: 'exception', exceptionReason: 'forgot' })
    expect(worker1(d).todayStatus).toMatchObject({ status: 'present', verification: 'exception', exceptionReason: 'forgot' })
  })

  it('attendance.exception mirror: a worker with no row becomes present at full wage', () => {
    const d = reduceLocal(payloadFixture(), 'attendance.exception', { workerId: 'w-2', reason: 'network' })
    const w2 = d.workers.find((w) => w.id === 'w-2')!
    expect(w2.todayStatus).toMatchObject({ status: 'present', wage: 600, verification: 'exception', exceptionReason: 'network' })
    expect(d.summary.fundisToday).toBe(2)
    expect(d.summary.wagesToday).toBe(1400)
  })

  it('attendance.override mirror: the target row is updated + bumped, and todayStatus follows (the #183 gap)', () => {
    const d = reduceLocal(payloadFixture(), 'attendance.override', { id: 'a-today', to: 'half_day', reason: 'Left at noon', by: 'Site Manager' })
    expect(todayRow(d)).toMatchObject({ status: 'half_day', wage: 400, version: 3 })
    expect(worker1(d).todayStatus).toMatchObject({ status: 'half_day', wage: 400, paid: false })
    expect(d.summary.wagesToday).toBe(400)
  })

  it('attendance.override mirror: an exception row overridden to a non-excused status becomes reported (applier rule)', () => {
    const base = payloadFixture()
    worker1(base).todayStatus.verification = 'exception'
    const d = reduceLocal(base, 'attendance.override', { id: 'a-today', to: 'absent', reason: 'Not on site', by: 'Site Manager' })
    expect(worker1(d).todayStatus).toMatchObject({ status: 'absent', verification: 'reported' })
  })

  it('attendance.override mirror: a PAST row is updated without touching todayStatus', () => {
    const d = reduceLocal(payloadFixture(), 'attendance.override', { id: 'a-yday', to: 'absent', reason: 'Correction', by: 'Site Manager' })
    const yday = worker1(d).attendances.find((a) => a.date === yesterdayEAT()) as unknown as Record<string, unknown>
    expect(yday).toMatchObject({ status: 'absent', version: 8 })
    expect(worker1(d).todayStatus).toMatchObject({ status: 'present', wage: 800 })
    expect(d.summary.wagesToday).toBe(800)
  })

  it('attendance.override mirror: an unknown row id is a no-op (server answers the honest miss)', () => {
    const d = reduceLocal(payloadFixture(), 'attendance.override', { id: 'a-404', to: 'absent', reason: 'x' })
    expect(todayRow(d)).toMatchObject({ status: 'present', version: 2 })
    expect(d.summary.wagesToday).toBe(800)
  })
})

// ---------------- normalizeOutboxItem (persisted-shape migration) ----------------

describe('#183 normalizeOutboxItem — stale persisted items migrate to the current shape', () => {
  const bare = {
    id: 'q-1', type: 'task.update', payload: { id: 't-1' }, label: 'Edit task',
    createdAt: 1_700_000_000_000, projectId: 'p-1',
  } as unknown as OutboxItem

  it('a v0 item (no lifecycle fields) becomes pending with a clean slate', () => {
    expect(normalizeOutboxItem(bare)).toEqual({
      id: 'q-1', type: 'task.update', payload: { id: 't-1' }, label: 'Edit task',
      createdAt: 1_700_000_000_000, projectId: 'p-1',
      syncStatus: 'pending', retryCount: 0, authBlocked: false, autoAttempts: 0,
      // nextAttemptAt normalises to undefined (absent key)
    })
  })

  it('a live lifecycle is preserved (syncing stays syncing, retryCount kept)', () => {
    const item = { ...bare, syncStatus: 'syncing', retryCount: 2 } as OutboxItem
    const normalized = normalizeOutboxItem(item)
    expect(normalized.syncStatus).toBe('syncing')
    expect(normalized.retryCount).toBe(2)
  })

  it('#132 fields: valid schedules survive; garbage resets to the clean slate', () => {
    const keep = normalizeOutboxItem({ ...bare, autoAttempts: 2, nextAttemptAt: 123 } as OutboxItem)
    expect(keep.autoAttempts).toBe(2)
    expect(keep.nextAttemptAt).toBe(123)
    const reset = normalizeOutboxItem({ ...bare, autoAttempts: 'soon', nextAttemptAt: 'tomorrow' } as unknown as OutboxItem)
    expect(reset.autoAttempts).toBe(0)
    expect(reset.nextAttemptAt).toBeUndefined()
  })

  it('authBlocked coerces to a strict boolean', () => {
    expect(normalizeOutboxItem({ ...bare, authBlocked: 'yes' } as unknown as OutboxItem).authBlocked).toBe(false)
    expect(normalizeOutboxItem({ ...bare, authBlocked: true } as OutboxItem).authBlocked).toBe(true)
  })
})

// ---------------- THE invariant, through the real store ----------------

describe('#183 the second offline edit stamps the newer baseVersion (real store, offline dispatch)', () => {
  beforeEach(() => {
    useMjengo.setState({
      online: false,
      syncing: false,
      outbox: [],
      syncHistory: [],
      viewMode: 'owner',
      shareToken: null,
      clientRole: false,
      data: payloadFixture(),
    } as never)
  })

  it('task path: two offline task.update edits queue baseVersion 5 then 6', async () => {
    await useMjengo.getState().dispatch('task.update', { id: 't-1', progress: 40 }, 'Edit task 40%')
    await useMjengo.getState().dispatch('task.update', { id: 't-1', progress: 55 }, 'Edit task 55%')

    const outbox = useMjengo.getState().outbox
    expect(outbox).toHaveLength(2)
    expect(outbox[0].payload.baseVersion).toBe(5)
    expect(outbox[1].payload.baseVersion).toBe(6)
    // The optimistic reducer moved the local row along with the stamps.
    expect(taskOf(useMjengo.getState().data!)).toMatchObject({ progress: 55, version: 7 })
  })

  it('attendance.override path (#183 regression): two offline overrides queue baseVersion 2 then 3', async () => {
    // Before the fix, BOTH items queued WITHOUT baseVersion — the server
    // could not detect the second one was stale against its own row.
    await useMjengo.getState().dispatch('attendance.override', { id: 'a-today', to: 'half_day', reason: 'Left at noon', by: 'Site Manager' }, 'Kamau → Half day')
    await useMjengo.getState().dispatch('attendance.override', { id: 'a-today', to: 'absent', reason: 'Went home', by: 'Site Manager' }, 'Kamau → Absent')

    const outbox = useMjengo.getState().outbox
    expect(outbox).toHaveLength(2)
    expect(outbox[0].type).toBe('attendance.override')
    expect(outbox[0].payload.baseVersion).toBe(2)
    expect(outbox[1].payload.baseVersion).toBe(3)
    // The optimistic mirror moved the local row + todayStatus along too.
    expect(todayRow(useMjengo.getState().data!)).toMatchObject({ status: 'absent', version: 4 })
    expect(worker1(useMjengo.getState().data!).todayStatus).toMatchObject({ status: 'absent', wage: 0 })
  })

  it('attendance day-action path: two offline setStatus edits queue baseVersion 2 then 3', async () => {
    await useMjengo.getState().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'half_day' }, 'Kamau half day')
    await useMjengo.getState().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'absent' }, 'Kamau absent')
    const outbox = useMjengo.getState().outbox
    expect(outbox[0].payload.baseVersion).toBe(2)
    expect(outbox[1].payload.baseVersion).toBe(3)
  })
})
