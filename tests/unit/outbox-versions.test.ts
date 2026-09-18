/**
 * Entity-version conflict invariants of POST /api/sync + the shared appliers
 * (issue "Outbox conflict metadata + entity versions"; #183 completed the
 * matrix).
 *
 * Task and Attendance rows carry `version`, bumped by EVERY applier that
 * mutates them (online /api/actions, USSD and offline sync flushes share
 * applyAction). An outbox item carrying the client's known `baseVersion` is
 * REJECTED 'stale-version' when the row moved on — replacing the old
 * last-write-wins convergence for versioned entities. Pinned here:
 *  · the deterministic two-client scenario: A and B both hold v3; A syncs
 *    (applies, server → v4); B's same-entity edit with baseVersion 3 is
 *    REJECTED with serverVersion 4 + keep-server suggestion and the row is
 *    NOT overwritten; B re-sends with fresh baseVersion → applies;
 *  · equal or absent baseVersion applies exactly as today (legacy clients);
 *  · the Idempotency-Key dedupe (spec §57) still short-circuits a replayed
 *    item BEFORE any version logic (regression guard — no double apply);
 *  · force ('keep-mine') is the explicit human decision that still applies;
 *  · attendance day-rows (single-row actions + the bulk muster roll) version
 *    the same way;
 *  · the ONLINE mutation path (applyAction — what /api/actions calls) bumps
 *    the version too, so both paths move the row's version forward.
 *
 * #183 — the completed matrix:
 *  · EVERY versioned task type (update/assign/block/unblock/complete/verify)
 *    runs the full two-client ladder × {stale, fresh, absent, force}
 *    (task.verify's applier actor is pinned via the wallet/session mock —
 *    the route session and the applier actor stay consistent);
 *  · attendance.exception + attendance.override (row-id keyed) stale/fresh/
 *    absent/force — override additionally pins the append-only overrideLog;
 *  · §41 semantic pre-checks: attendance status-disagreement → human-decides
 *    readable reason (force applies); task.complete vs done/blocked server
 *    rows → human-decides; milestone.decide → server-wins, and force:true
 *    STILL refuses (money rows are append-only — the only remediation is a
 *    new correcting action); exact replay of an already-recorded decision is
 *    a silent ok;
 *  · a source pin extracts the route's VERSIONED_*_TYPES sets from sync.ts
 *    and asserts this file's coverage lists include every member — a future
 *    versioned type without a matrix row fails loudly here.
 *
 * @/backend/lib/db is swapped for an in-memory stub; route-kit's route() is
 * a pass-through with a fixed contractor session (guard/rate-limit/body are
 * pinned by their own test files); mjengo's payload loaders are stubbed to
 * keep the refresh out of scope while applyAction stays REAL.
 */
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// task.verify's applier resolves the session actor through wallet/session's
// currentActor (next/headers — outside a request scope in node it resolves
// { role: null } and the applier refuses). The route-kit mock below hands the
// ROUTE a contractor session; this mock keeps the APPLIER's actor consistent
// with it (wallet-role-gates.test.ts idiom).
vi.mock('@/backend/modules/wallet/session', () => ({
  currentActor: vi.fn(async () => ({ role: 'contractor', name: 'Foreman' })),
}))

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    seq: 0,
    projects: new Map<string, Row>(),
    phases: new Map<string, Row>(),
    tasks: new Map<string, Row>(),
    workers: new Map<string, Row>(),
    attendance: new Map<string, Row>(),
    milestones: new Map<string, Row>(),
    idempotency: new Map<string, Row>(),
    auditEvents: [] as Row[],
    reset() {
      state.projects.clear()
      state.phases.clear()
      state.tasks.clear()
      state.workers.clear()
      state.attendance.clear()
      state.milestones.clear()
      state.idempotency.clear()
      state.auditEvents = []
      state.seq = 0
    },
  }

  /** Just enough of Prisma's where for the sync path + appliers (equality, relation filter, in/notIn/gt). */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'phase') {
        const phase = state.phases.get(row.phaseId as string)
        if (!phase || !matches(phase, cond as Row)) return false
        continue
      }
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(row[key])) return false
          continue
        }
        if ('notIn' in c) {
          if ((c.notIn as unknown[]).includes(row[key])) return false
          continue
        }
        if ('gt' in c) {
          if (!((row[key] as number) > (c.gt as number))) return false
          continue
        }
        continue
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  const firstOf = (table: Map<string, Row>, where: Row) =>
    [...table.values()].find((r) => matches(r, where)) ?? null

  const applyVersion = (row: Row, data: Row) => {
    const v = (data as { version?: number | { increment?: number } }).version
    if (typeof v === 'number') row.version = v
    else if (v && typeof v === 'object' && typeof v.increment === 'number') row.version = (row.version as number) + v.increment
  }

  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: Row }) { return state.projects.get(String(where.id)) ?? null },
      async findFirst() { return [...state.projects.values()][0] ?? null },
      async findMany() { return [...state.projects.values()].map((p) => ({ ...p })) },
    },
    phase: {
      async findMany() { return [...state.phases.values()].map((p) => ({ ...p, tasks: [] })) },
    },
    task: {
      async findUnique({ where, include }: { where: Row; include?: Row }) {
        const row = state.tasks.get(String(where.id))
        if (!row) return null
        const phase = state.phases.get(row.phaseId as string) ?? null
        return { ...row, phase: include?.phase ? phase : undefined }
      },
      async findFirst({ where }: { where: Row }) { return firstOf(state.tasks, where) },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = state.tasks.get(String(where.id))
        if (!row) throw new Error(`stub: task ${String(where.id)} not found`)
        Object.assign(row, data)
        return { ...row }
      },
    },
    worker: {
      async findUnique({ where }: { where: Row }) { return state.workers.get(String(where.id)) ?? null },
      async findMany({ where }: { where: Row }) {
        return [...state.workers.values()].filter((r) => matches(r, where)).map((r) => ({ ...r }))
      },
    },
    attendance: {
      async findUnique({ where }: { where: Row }) { return state.attendance.get(String(where.id)) ?? null },
      async findFirst({ where, include }: { where: Row; include?: Row }) {
        const row = firstOf(state.attendance, where)
        if (!row) return null
        // The route's semantic pre-check includes { worker: { select: { name } } }.
        if (include?.worker) {
          const worker = state.workers.get(row.workerId as string) ?? null
          return { ...row, worker: include.worker.select ? { name: worker?.name } : worker }
        }
        return row
      },
      async findMany({ where }: { where: Row }) {
        return [...state.attendance.values()].filter((r) => matches(r, where)).map((r) => ({ ...r }))
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = state.attendance.get(String(where.id))
        if (!row) throw new Error(`stub: attendance ${String(where.id)} not found`)
        Object.assign(row, data)
        return { ...row }
      },
      async updateMany({ where, data }: { where: Row; data: Row }) {
        const rows = [...state.attendance.values()].filter((r) => matches(r, where))
        for (const row of rows) {
          applyVersion(row, data)
          Object.assign(row, { ...data, version: row.version })
        }
        return { count: rows.length }
      },
    },
    milestone: {
      // §41 financial pre-check read (milestone.decide) — the money appliers
      // are never reached in these tests (the pre-check decides).
      async findFirst({ where }: { where: Row }) { return firstOf(state.milestones, where) },
    },
    idempotencyRecord: {
      async findUnique({ where }: { where: Row }) { return state.idempotency.get(String(where.key)) ?? null },
      async create({ data }: { data: Row }) {
        const row = { id: `idem_${++state.seq}`, ...data }
        state.idempotency.set(String(row.key), row)
        return { ...row }
      },
    },
    auditEvent: {
      async create({ data }: { data: Row }) {
        const row = { id: `audit_${++state.seq}`, ...data }
        state.auditEvents.push(row)
        return { ...row }
      },
      async findMany() { return state.auditEvents.map((a) => ({ ...a })) },
    },
    notification: { async findMany() { return [] } },
  }
  return { db }
})

vi.mock('@/backend/lib/route-kit', () => ({
  // Pass-through: parse the JSON body, hand the handler a fixed contractor
  // session (the guard + rate-limit contracts are pinned elsewhere).
  route: (
    _opts: unknown,
    handler: (req: Request, session: unknown, body: unknown, ctx?: unknown) => Promise<Response>,
  ) =>
    async (req: Request, ctx?: unknown): Promise<Response> => {
      let body: unknown
      try { body = await req.json() } catch { body = undefined }
      return handler(req, { user: { id: 'u-1', email: 'sync@test.dev', name: 'Foreman', role: 'contractor', projectId: null } }, body, ctx)
    },
  genericError: () => async () => new Response(JSON.stringify({ error: 'Sync failed' }), { status: 500 }),
}))

vi.mock('@/backend/lib/mjengo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/lib/mjengo')>()
  return {
    ...actual,
    // The payload refresh (slice loaders) is out of scope — applyAction stays REAL.
    getProjectPayload: async () => null,
    getProjectsList: async () => [],
  }
})

import { db } from '@/backend/lib/db'
import { POST } from '@/app/api/sync/route'
import { applyAction } from '@/backend/lib/mjengo'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    projects: Map<string, Record<string, unknown>>
    phases: Map<string, Record<string, unknown>>
    tasks: Map<string, Record<string, unknown>>
    workers: Map<string, Record<string, unknown>>
    attendance: Map<string, Record<string, unknown>>
    milestones: Map<string, Record<string, unknown>>
    idempotency: Map<string, Record<string, unknown>>
    auditEvents: Record<string, unknown>[]
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

/** EAT "today" — must match the appliers' todayStr()/route's todayEAT(). */
const todayEAT = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)

interface Queued {
  id: string
  type: string
  payload: Record<string, unknown>
  projectId: string
  force?: boolean
}

function syncReq(actions: Queued[]): NextRequest {
  return new NextRequest('http://localhost/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actions }),
  })
}

async function flush(actions: Queued[]): Promise<Record<string, any>> {
  const res = await POST(syncReq(actions), undefined)
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, any>
}

const taskRow = () => state.tasks.get('task-1') as Record<string, unknown>
const attRow = () => state.attendance.get('att-1') as Record<string, unknown>

beforeEach(() => {
  state.reset()
  state.projects.set('proj-1', { id: 'proj-1', name: 'Test Build', client: 'Client', createdAt: new Date('2026-01-01') })
  state.phases.set('phase-1', { id: 'phase-1', projectId: 'proj-1', name: 'Foundations', order: 1, budget: 10_000_000n, status: 'in_progress', progressManual: null })
  state.tasks.set('task-1', {
    id: 'task-1', phaseId: 'phase-1', title: 'Pour slab', status: 'in_progress', progress: 30,
    priority: 'normal', assignedToId: null, blockedById: null, blockedReason: null,
    verifiedAt: null, verifiedByName: null, dueDate: null, createdAt: new Date(), updatedAt: new Date(),
    version: 3,
  })
  state.workers.set('worker-1', { id: 'worker-1', projectId: 'proj-1', name: 'Kamau', role: 'Fundi', phone: '+254700000001', dailyRate: 80_000n, active: true })
  state.attendance.set('att-1', {
    id: 'att-1', workerId: 'worker-1', projectId: 'proj-1', date: todayEAT(),
    checkIn: new Date(), checkOut: null, status: 'present', method: 'app', wage: 80_000n, paid: false,
    verification: 'reported', evidence: null, exceptionReason: null, exceptionNote: null,
    overrideLog: null, recordedBy: null, version: 2,
  })
})

describe('online mutation path (applyAction — what /api/actions and /api/sync share) bumps the entity version', () => {
  it('task.update via applyAction bumps Task.version and writes the change', async () => {
    await applyAction('task.update', { id: 'task-1', progress: 50 }, 'proj-1')
    expect(taskRow().progress).toBe(50)
    expect(taskRow().version).toBe(4)
  })

  it('attendance.setStatus via applyAction bumps the existing day-row version', async () => {
    await applyAction('attendance.setStatus', { workerId: 'worker-1', status: 'half_day' }, 'proj-1')
    expect(attRow().status).toBe('half_day')
    expect(attRow().version).toBe(3)
  })
})

describe('POST /api/sync — deterministic two-client task conflict (A and B both hold v3)', () => {
  it('client A syncs first: applies, server version moves 3 → 4', async () => {
    const json = await flush([{ id: 'a-1', type: 'task.update', payload: { id: 'task-1', progress: 50, baseVersion: 3 }, projectId: 'proj-1' }])
    expect(json.ok).toBe(true)
    expect(json.results[0]).toMatchObject({ id: 'a-1', ok: true })
    expect(json.synced).toBe(1)
    expect(taskRow()).toMatchObject({ progress: 50, version: 4 })
  })

  it('client B then syncs the same entity with baseVersion 3 → REJECTED stale-version, entity NOT overwritten', async () => {
    await flush([{ id: 'a-1', type: 'task.update', payload: { id: 'task-1', progress: 50, baseVersion: 3 }, projectId: 'proj-1' }])

    const json = await flush([{ id: 'b-1', type: 'task.update', payload: { id: 'task-1', progress: 80, baseVersion: 3 }, projectId: 'proj-1' }])
    expect(json.ok).toBe(true)
    expect(json.conflicts).toBe(1)
    expect(json.results[0]).toEqual({
      id: 'b-1', ok: false, conflict: true, status: 'REJECTED', reason: 'stale-version',
      rule: 'human-decides', serverVersion: 4, baseVersion: 3, suggestion: 'keep-server',
    })
    // B's edit was refused — the server row still holds A's write, version unmoved.
    expect(taskRow()).toMatchObject({ progress: 50, version: 4 })
    // No idempotency record for a REJECTED item → B can re-send once re-based.
    expect(state.idempotency.get('sync:proj-1:b-1')).toBeUndefined()
  })

  it('B re-syncs with a fresh baseVersion 4 → applies, version moves on', async () => {
    await flush([{ id: 'a-1', type: 'task.update', payload: { id: 'task-1', progress: 50, baseVersion: 3 }, projectId: 'proj-1' }])
    await flush([{ id: 'b-1', type: 'task.update', payload: { id: 'task-1', progress: 80, baseVersion: 3 }, projectId: 'proj-1' }])

    const json = await flush([{ id: 'b-2', type: 'task.update', payload: { id: 'task-1', progress: 80, baseVersion: 4 }, projectId: 'proj-1' }])
    expect(json.results[0]).toMatchObject({ id: 'b-2', ok: true })
    expect(taskRow()).toMatchObject({ progress: 80, version: 5 })
  })

  it('idempotent replay of A\'s item still dedupes (spec §57) — no double apply, no version bump', async () => {
    await flush([{ id: 'a-1', type: 'task.update', payload: { id: 'task-1', progress: 50, baseVersion: 3 }, projectId: 'proj-1' }])
    await flush([{ id: 'b-2', type: 'task.update', payload: { id: 'task-1', progress: 80, baseVersion: 4 }, projectId: 'proj-1' }])
    expect(state.idempotency.get('sync:proj-1:a-1')).toBeDefined()

    // A's queue re-flushes the same item (double tap / retry after timeout).
    const json = await flush([{ id: 'a-1', type: 'task.update', payload: { id: 'task-1', progress: 50, baseVersion: 3 }, projectId: 'proj-1' }])
    expect(json.results[0]).toMatchObject({ id: 'a-1', ok: true })
    expect(taskRow()).toMatchObject({ progress: 80, version: 5 }) // B's write untouched by the replay
    expect(state.auditEvents.filter((e) => String(e.kind) === 'task')).toHaveLength(2) // one apply per unique item
  })

  it('absent baseVersion applies as today (legacy last-write-wins for clients that never stamp one)', async () => {
    await flush([{ id: 'a-1', type: 'task.update', payload: { id: 'task-1', progress: 50, baseVersion: 3 }, projectId: 'proj-1' }])

    const json = await flush([{ id: 'legacy-1', type: 'task.update', payload: { id: 'task-1', progress: 65 }, projectId: 'proj-1' }])
    expect(json.results[0]).toMatchObject({ id: 'legacy-1', ok: true })
    expect(taskRow()).toMatchObject({ progress: 65, version: 5 })
  })

  it('equal baseVersion applies (the client is current — the normal case)', async () => {
    await flush([{ id: 'a-1', type: 'task.update', payload: { id: 'task-1', progress: 50, baseVersion: 3 }, projectId: 'proj-1' }])

    const json = await flush([{ id: 'c-1', type: 'task.update', payload: { id: 'task-1', progress: 60, baseVersion: 4 }, projectId: 'proj-1' }])
    expect(json.results[0]).toMatchObject({ id: 'c-1', ok: true })
    expect(taskRow()).toMatchObject({ progress: 60, version: 5 })
  })

  it('force (keep-mine) is the explicit human decision that still applies a stale edit (§41 rule 2)', async () => {
    await flush([{ id: 'a-1', type: 'task.update', payload: { id: 'task-1', progress: 50, baseVersion: 3 }, projectId: 'proj-1' }])

    const json = await flush([{ id: 'b-1', type: 'task.update', payload: { id: 'task-1', progress: 80, baseVersion: 3 }, projectId: 'proj-1', force: true }])
    expect(json.results[0]).toMatchObject({ id: 'b-1', ok: true })
    expect(taskRow()).toMatchObject({ progress: 80, version: 5 })
  })
})

describe('POST /api/sync — attendance day-rows version the same way', () => {
  it('single-row action: stale baseVersion → REJECTED with the server version, row untouched', async () => {
    const json = await flush([{ id: 'b-1', type: 'attendance.setStatus', payload: { workerId: 'worker-1', status: 'absent', baseVersion: 1 }, projectId: 'proj-1' }])
    expect(json.conflicts).toBe(1)
    expect(json.results[0]).toMatchObject({
      id: 'b-1', ok: false, conflict: true, status: 'REJECTED', reason: 'stale-version',
      serverVersion: 2, baseVersion: 1, suggestion: 'keep-server',
    })
    expect(attRow()).toMatchObject({ status: 'present', version: 2 })
  })

  it('single-row action: fresh baseVersion applies and bumps (check-out on the current row)', async () => {
    const json = await flush([{ id: 'b-2', type: 'attendance.checkin', payload: { workerId: 'worker-1', toggle: 'out', baseVersion: 2 }, projectId: 'proj-1' }])
    expect(json.results[0]).toMatchObject({ id: 'b-2', ok: true })
    expect(attRow()).toMatchObject({ status: 'present', version: 3 })
    expect(attRow().checkOut).not.toBeNull()
  })

  it('single-row action: fresh baseVersion + force applies a status correction (the §41 human decision path)', async () => {
    const json = await flush([{ id: 'b-3', type: 'attendance.setStatus', payload: { workerId: 'worker-1', status: 'absent', baseVersion: 2 }, projectId: 'proj-1', force: true }])
    expect(json.results[0]).toMatchObject({ id: 'b-3', ok: true })
    expect(attRow()).toMatchObject({ status: 'absent', version: 3, wage: 0n })
  })

  it('bulk muster roll: a per-record stale baseVersion rejects the item', async () => {
    const records = JSON.stringify([{ workerId: 'worker-1', status: 'absent', baseVersion: 1 }])
    const json = await flush([{ id: 'r-1', type: 'attendance.record', payload: { records, verification: 'reported' }, projectId: 'proj-1' }])
    expect(json.results[0]).toMatchObject({
      id: 'r-1', ok: false, conflict: true, status: 'REJECTED', reason: 'stale-version', serverVersion: 2,
    })
    expect(attRow()).toMatchObject({ status: 'present', version: 2 })
  })

  it('bulk muster roll: same-status records with fresh baseVersion apply as a NO-OP — row untouched, version unmoved', async () => {
    // The applier deliberately never downgrades an existing row to a re-saved
    // same-status muster (evidence protection) — so no bump either.
    const records = JSON.stringify([{ workerId: 'worker-1', status: 'present', baseVersion: 2 }])
    const json = await flush([{ id: 'r-2', type: 'attendance.record', payload: { records, verification: 'reported' }, projectId: 'proj-1' }])
    expect(json.results[0]).toMatchObject({ id: 'r-2', ok: true })
    expect(attRow()).toMatchObject({ status: 'present', version: 2 })
  })

  it('bulk muster roll: fresh per-record baseVersion + force applies the correction and bumps the row', async () => {
    const records = JSON.stringify([{ workerId: 'worker-1', status: 'absent', baseVersion: 2 }])
    const json = await flush([{ id: 'r-3', type: 'attendance.record', payload: { records, verification: 'reported' }, projectId: 'proj-1', force: true }])
    expect(json.results[0]).toMatchObject({ id: 'r-3', ok: true })
    expect(attRow()).toMatchObject({ status: 'absent', version: 3 })
  })
})

// ---------------------------------------------------------------------------
// #183 — the FULL versioned task-type matrix. Every task type the server
// versions runs the deterministic two-client ladder × all four arms:
// stale (baseVersion left behind) → REJECTED; fresh (equal) → applies +
// bumps; absent (legacy client) → applies; force ('keep-mine') → applies.
// A source pin at the bottom of this file asserts the table itself covers
// every member of the route's VERSIONED_TASK_TYPES — a future versioned
// type without a row here fails loudly.
// ---------------------------------------------------------------------------

interface TaskMatrixRow {
  type: string
  /** Client A's first-mover action — moves the row so B's stamp is stale. */
  firstMover: { type: string; payload: Record<string, unknown> }
  /** Client B's payload under test (the runner adds baseVersion). */
  payload: Record<string, unknown>
  /** Row state after the first mover — what a stale B must NOT clobber. */
  assertStaleUntouched: (row: Record<string, unknown>) => void
  /** Row state after B applied (fresh / absent / force). */
  assertApplied: (row: Record<string, unknown>) => void
}

const TASK_MATRIX: TaskMatrixRow[] = [
  {
    type: 'task.update',
    firstMover: { type: 'task.update', payload: { progress: 40 } },
    payload: { progress: 55 },
    assertStaleUntouched: (row) => expect(row.progress).toBe(40),
    assertApplied: (row) => expect(row.progress).toBe(55),
  },
  {
    type: 'task.assign',
    firstMover: { type: 'task.update', payload: { progress: 40 } },
    payload: { assignedToId: 'worker-1' },
    assertStaleUntouched: (row) => expect(row.assignedToId).toBeNull(),
    assertApplied: (row) => expect(row.assignedToId).toBe('worker-1'),
  },
  {
    type: 'task.block',
    firstMover: { type: 'task.update', payload: { progress: 40 } },
    payload: { reason: 'No cement delivery' },
    assertStaleUntouched: (row) => { expect(row.status).toBe('in_progress'); expect(row.blockedReason).toBeNull() },
    assertApplied: (row) => { expect(row.status).toBe('blocked'); expect(row.blockedReason).toBe('No cement delivery') },
  },
  {
    type: 'task.unblock',
    // A blocks the task (v3 → v4, blocked) so B's unblock has a real state to restore.
    firstMover: { type: 'task.block', payload: { reason: 'Steel delayed' } },
    payload: {},
    assertStaleUntouched: (row) => { expect(row.status).toBe('blocked'); expect(row.blockedReason).toBe('Steel delayed') },
    assertApplied: (row) => { expect(row.status).toBe('in_progress'); expect(row.blockedReason).toBeNull() },
  },
  {
    type: 'task.complete',
    firstMover: { type: 'task.update', payload: { progress: 40 } },
    payload: {},
    assertStaleUntouched: (row) => expect(row.status).toBe('in_progress'),
    assertApplied: (row) => { expect(row.status).toBe('done'); expect(row.progress).toBe(100) },
  },
  {
    type: 'task.verify',
    // A completes the task (v3 → v4, done) — only completed work can verify.
    firstMover: { type: 'task.update', payload: { progress: 100 } },
    payload: {},
    assertStaleUntouched: (row) => expect(row.verifiedAt).toBeNull(),
    assertApplied: (row) => { expect(row.verifiedAt).not.toBeNull(); expect(row.verifiedByName).toBe('Foreman') },
  },
]

describe('POST /api/sync — full versioned TASK-type matrix (#183: assign/block/unblock/complete/verify)', () => {
  for (const c of TASK_MATRIX) {
    describe(`${c.type}`, () => {
      // Client A applies its edit (v3 → v4) — the shared ladder prefix.
      async function firstMoverApplies() {
        const json = await flush([{
          id: 'a-1', type: c.firstMover.type,
          payload: { id: 'task-1', ...c.firstMover.payload, baseVersion: 3 }, projectId: 'proj-1',
        }])
        expect(json.results[0]).toMatchObject({ id: 'a-1', ok: true })
        expect(taskRow().version).toBe(4)
      }

      it('stale baseVersion → REJECTED stale-version, A\'s write stands, no idempotency row for B', async () => {
        await firstMoverApplies()

        const json = await flush([{ id: 'b-1', type: c.type, payload: { id: 'task-1', ...c.payload, baseVersion: 3 }, projectId: 'proj-1' }])
        expect(json.conflicts).toBe(1)
        expect(json.results[0]).toEqual({
          id: 'b-1', ok: false, conflict: true, status: 'REJECTED', reason: 'stale-version',
          rule: 'human-decides', serverVersion: 4, baseVersion: 3, suggestion: 'keep-server',
        })
        c.assertStaleUntouched(taskRow())
        expect(taskRow().version).toBe(4) // B's refusal never moves the row
        expect(state.idempotency.get('sync:proj-1:b-1')).toBeUndefined()
      })

      it('fresh baseVersion (re-based onto A\'s write) → applies, version moves on', async () => {
        await firstMoverApplies()

        const json = await flush([{ id: 'b-2', type: c.type, payload: { id: 'task-1', ...c.payload, baseVersion: 4 }, projectId: 'proj-1' }])
        expect(json.results[0]).toMatchObject({ id: 'b-2', ok: true })
        c.assertApplied(taskRow())
        expect(taskRow().version).toBe(5)
      })

      it('absent baseVersion applies as today (legacy last-write-wins for clients that never stamp one)', async () => {
        await firstMoverApplies()

        const json = await flush([{ id: 'b-3', type: c.type, payload: { id: 'task-1', ...c.payload }, projectId: 'proj-1' }])
        expect(json.results[0]).toMatchObject({ id: 'b-3', ok: true })
        c.assertApplied(taskRow())
        expect(taskRow().version).toBe(5)
      })

      it('force (keep-mine) is the explicit human decision that still applies a stale edit', async () => {
        await firstMoverApplies()

        const json = await flush([{ id: 'b-4', type: c.type, payload: { id: 'task-1', ...c.payload, baseVersion: 3 }, projectId: 'proj-1', force: true }])
        expect(json.results[0]).toMatchObject({ id: 'b-4', ok: true })
        c.assertApplied(taskRow())
        expect(taskRow().version).toBe(5)
      })
    })
  }
})

// ---------------------------------------------------------------------------
// #183 — attendance.exception (workerId, date keyed) + attendance.override
// (attendance ROW id keyed). The override arm is the server half of the
// issue's client bug: the client never stamped it, so detectStaleVersion
// returned null and a stale override applied silently.
// ---------------------------------------------------------------------------

describe('POST /api/sync — attendance.exception (#183: previously untested)', () => {
  it('stale baseVersion → REJECTED with the server version, row untouched', async () => {
    const json = await flush([{
      id: 'x-1', type: 'attendance.exception',
      payload: { workerId: 'worker-1', reason: 'forgot', baseVersion: 1 }, projectId: 'proj-1',
    }])
    expect(json.conflicts).toBe(1)
    expect(json.results[0]).toEqual({
      id: 'x-1', ok: false, conflict: true, status: 'REJECTED', reason: 'stale-version',
      rule: 'human-decides', serverVersion: 2, baseVersion: 1, suggestion: 'keep-server',
    })
    expect(attRow()).toMatchObject({ status: 'present', verification: 'reported', version: 2 })
    expect(attRow().exceptionReason).toBeNull()
    expect(state.idempotency.get('sync:proj-1:x-1')).toBeUndefined()
  })

  it('fresh baseVersion applies: verification exception + reason + version bump (status/wage untouched)', async () => {
    const json = await flush([{
      id: 'x-2', type: 'attendance.exception',
      payload: { workerId: 'worker-1', reason: 'forgot', note: 'phone at the charging kiosk', baseVersion: 2 },
      projectId: 'proj-1',
    }])
    expect(json.results[0]).toMatchObject({ id: 'x-2', ok: true })
    expect(attRow()).toMatchObject({
      status: 'present', wage: 80_000n, verification: 'exception',
      exceptionReason: 'forgot', exceptionNote: 'phone at the charging kiosk', version: 3,
    })
  })

  it('force on a stale exception is the human decision and applies (§41 rule 2)', async () => {
    const json = await flush([{
      id: 'x-3', type: 'attendance.exception',
      payload: { workerId: 'worker-1', reason: 'network', baseVersion: 1 }, projectId: 'proj-1', force: true,
    }])
    expect(json.results[0]).toMatchObject({ id: 'x-3', ok: true })
    expect(attRow()).toMatchObject({ verification: 'exception', exceptionReason: 'network', version: 3 })
  })
})

describe('POST /api/sync — attendance.override (#183: previously untested + the row-id keying)', () => {
  it('stale baseVersion → REJECTED (row-id keyed), row untouched — this is the arm the client never stamped', async () => {
    const json = await flush([{
      id: 'o-1', type: 'attendance.override',
      payload: { id: 'att-1', to: 'absent', reason: 'Went home sick', by: 'Site Manager', baseVersion: 1 },
      projectId: 'proj-1',
    }])
    expect(json.conflicts).toBe(1)
    expect(json.results[0]).toEqual({
      id: 'o-1', ok: false, conflict: true, status: 'REJECTED', reason: 'stale-version',
      rule: 'human-decides', serverVersion: 2, baseVersion: 1, suggestion: 'keep-server',
    })
    expect(attRow()).toMatchObject({ status: 'present', wage: 80_000n, version: 2 })
    expect(attRow().overrideLog).toBeNull()
  })

  it('an override WITHOUT baseVersion applies (legacy path) — exactly why the client not stamping it was a silent last-write-wins bug', async () => {
    const json = await flush([{
      id: 'o-2', type: 'attendance.override',
      payload: { id: 'att-1', to: 'absent', reason: 'Went home sick', by: 'Site Manager' },
      projectId: 'proj-1',
    }])
    expect(json.results[0]).toMatchObject({ id: 'o-2', ok: true })
    expect(attRow()).toMatchObject({ status: 'absent', version: 3 })
  })

  it('fresh baseVersion applies: status + wage change, append-only overrideLog entry, version bump', async () => {
    const json = await flush([{
      id: 'o-3', type: 'attendance.override',
      payload: { id: 'att-1', to: 'half_day', reason: 'Left at noon', by: 'Site Manager', baseVersion: 2 },
      projectId: 'proj-1',
    }])
    expect(json.results[0]).toMatchObject({ id: 'o-3', ok: true })
    expect(attRow()).toMatchObject({ status: 'half_day', wage: 40_000n, version: 3 })
    // History is append-only, never truncated: the entry records both sides + who.
    const log = JSON.parse(String(attRow().overrideLog)) as Array<Record<string, unknown>>
    expect(log).toEqual([
      expect.objectContaining({ by: 'Site Manager', from: 'present', to: 'half_day', reason: 'Left at noon' }),
    ])
  })

  it('force on a stale override applies (§41 human-decides — the field row is theirs to decide)', async () => {
    const json = await flush([{
      id: 'o-4', type: 'attendance.override',
      payload: { id: 'att-1', to: 'excused', reason: 'Family emergency', by: 'Site Manager', baseVersion: 1 },
      projectId: 'proj-1', force: true,
    }])
    expect(json.results[0]).toMatchObject({ id: 'o-4', ok: true })
    expect(attRow()).toMatchObject({ status: 'excused', wage: 0n, version: 3 })
  })
})

// ---------------------------------------------------------------------------
// #183 — §41 SEMANTIC conflict pre-checks (detectConflict). These run
// read-only BEFORE applyAction, independent of baseVersion: field rows get a
// human decision (keep-server suggested, keep-mine offered via force);
// FINANCIAL rows are server-wins — and force does NOT override them.
// ---------------------------------------------------------------------------

describe('POST /api/sync — §41 semantic conflicts (#183: previously untested)', () => {
  it('attendance status-disagreement → human-decides with the readable both-sides reason', async () => {
    const json = await flush([{
      id: 's-1', type: 'attendance.setStatus',
      payload: { workerId: 'worker-1', status: 'absent' }, projectId: 'proj-1',
    }])
    expect(json.conflicts).toBe(1)
    expect(json.results[0]).toMatchObject({ id: 's-1', ok: false, conflict: true, rule: 'human-decides' })
    expect(json.results[0].reason).toContain('already recorded today as present for Kamau')
    expect(json.results[0].reason).toContain('your offline edit records absent')
    // Read-only pre-check: the row was not touched, no idempotency record.
    expect(attRow()).toMatchObject({ status: 'present', version: 2 })
    expect(state.idempotency.get('sync:proj-1:s-1')).toBeUndefined()
  })

  it('the human decided: force re-sends the attendance disagreement and it applies', async () => {
    const json = await flush([{
      id: 's-2', type: 'attendance.setStatus',
      payload: { workerId: 'worker-1', status: 'absent' }, projectId: 'proj-1', force: true,
    }])
    expect(json.results[0]).toMatchObject({ id: 's-2', ok: true })
    expect(attRow()).toMatchObject({ status: 'absent', wage: 0n, version: 3 })
  })

  it('task.complete vs a server row already done (and verified) → human-decides readable reason', async () => {
    state.tasks.set('task-1', {
      ...state.tasks.get('task-1')!,
      status: 'done', progress: 100, verifiedAt: new Date(), verifiedByName: 'Amina (QS)',
    })
    const json = await flush([{ id: 's-3', type: 'task.complete', payload: { id: 'task-1' }, projectId: 'proj-1' }])
    expect(json.conflicts).toBe(1)
    expect(json.results[0]).toMatchObject({ id: 's-3', ok: false, conflict: true, rule: 'human-decides' })
    expect(json.results[0].reason).toContain('already marked done on the server')
    expect(json.results[0].reason).toContain('verified by Amina (QS)')
    expect(taskRow().version).toBe(3) // read-only pre-check — the row never moved
  })

  it('task.complete vs a server row now blocked → human-decides readable reason carrying the block reason', async () => {
    state.tasks.set('task-1', {
      ...state.tasks.get('task-1')!,
      status: 'blocked', blockedReason: 'Waiting on steel',
    })
    const json = await flush([{ id: 's-4', type: 'task.complete', payload: { id: 'task-1' }, projectId: 'proj-1' }])
    expect(json.conflicts).toBe(1)
    expect(json.results[0]).toMatchObject({ id: 's-4', ok: false, conflict: true, rule: 'human-decides' })
    expect(json.results[0].reason).toContain('now blocked on the server')
    expect(json.results[0].reason).toContain('Waiting on steel')
    expect(taskRow().version).toBe(3)
  })

  it('milestone.decide on an already-released milestone → server-wins (the ledger row stands)', async () => {
    state.milestones.set('ms-1', {
      id: 'ms-1', projectId: 'proj-1', name: 'Roof payment', status: 'released', decidedBy: 'Mama Njeri',
    })
    const json = await flush([{ id: 's-5', type: 'milestone.decide', payload: { id: 'ms-1', decision: 'reject' }, projectId: 'proj-1' }])
    expect(json.conflicts).toBe(1)
    expect(json.results[0]).toMatchObject({ id: 's-5', ok: false, conflict: true, rule: 'server-wins' })
    expect(json.results[0].reason).toContain('server wins')
    expect(json.results[0].reason).toContain('"Roof payment" was already released by Mama Njeri')
    expect(json.results[0].reason).toContain('your queued decision "reject" differs')
    // Money rows are never re-applied by a conflicting flush.
    expect(state.milestones.get('ms-1')).toMatchObject({ status: 'released' })
    expect(state.idempotency.get('sync:proj-1:s-5')).toBeUndefined()
  })

  it('server-wins IGNORES force: a forced milestone.decide STILL refuses (money is append-only — remediate with a correcting action)', async () => {
    state.milestones.set('ms-1', {
      id: 'ms-1', projectId: 'proj-1', name: 'Roof payment', status: 'released', decidedBy: 'Mama Njeri',
    })
    const json = await flush([{
      id: 's-6', type: 'milestone.decide',
      payload: { id: 'ms-1', decision: 'reject' }, projectId: 'proj-1', force: true,
    }])
    expect(json.conflicts).toBe(1)
    expect(json.results[0]).toMatchObject({ id: 's-6', ok: false, conflict: true, rule: 'server-wins' })
    expect(state.milestones.get('ms-1')).toMatchObject({ status: 'released' })
  })

  it('an exact replay of the already-recorded decision is a silent ok (§41 rule 3 — the ledger holds exactly this)', async () => {
    state.milestones.set('ms-1', {
      id: 'ms-1', projectId: 'proj-1', name: 'Roof payment', status: 'released', decidedBy: 'Mama Njeri',
    })
    const json = await flush([{ id: 's-7', type: 'milestone.decide', payload: { id: 'ms-1', decision: 'approve' }, projectId: 'proj-1' }])
    expect(json.results[0]).toMatchObject({ id: 's-7', ok: true })
    expect(json.synced).toBe(1)
    expect(json.conflicts).toBe(0)
    expect(state.milestones.get('ms-1')).toMatchObject({ status: 'released' })
  })
})

// ---------------------------------------------------------------------------
// #183 — source pin: this file's matrix must cover EVERY type the route
// actually versions. The sets are extracted from sync.ts (not duplicated by
// hand), so adding a versioned type server-side without a matrix row — or
// without the client stamping it — fails loudly at the next test run.
// ---------------------------------------------------------------------------

describe('#183 matrix completeness (source pin on the route\'s versioned sets)', () => {
  const syncSrc = readFileSync(fileURLToPath(new URL('../../src/backend/api/sync.ts', import.meta.url)), 'utf8')

  const setOf = (name: string): string[] => {
    const body = syncSrc.match(new RegExp(`const ${name} = new Set<string>\\(\\[([^\\]]+)\\]`))?.[1] ?? ''
    return body.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  }

  it('every VERSIONED_TASK_TYPES member has a two-client matrix row above', () => {
    const serverTaskTypes = setOf('VERSIONED_TASK_TYPES')
    expect(serverTaskTypes.length).toBeGreaterThanOrEqual(6)
    const matrixTypes = TASK_MATRIX.map((c) => c.type)
    for (const type of serverTaskTypes) {
      expect(matrixTypes, `#183: server versions "${type}" but the task matrix has no row`).toContain(type)
    }
  })

  it('every VERSIONED_ATTENDANCE_TYPES member is exercised somewhere in this file', () => {
    const serverAttendanceTypes = setOf('VERSIONED_ATTENDANCE_TYPES')
    expect(serverAttendanceTypes.length).toBeGreaterThanOrEqual(5)
    // Types exercised across this file's describes (stale + fresh arms each).
    const covered = [
      'attendance.setStatus', // two-client describe + §41 semantic describe
      'attendance.checkin', // attendance day-row describe
      'attendance.record', // bulk muster describe
      'attendance.exception', // #183 describe above
      'attendance.override', // #183 describe above
    ]
    for (const type of serverAttendanceTypes) {
      expect(covered, `#183: server versions "${type}" but no test flushes it`).toContain(type)
    }
  })
})
