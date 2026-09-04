/**
 * Entity-version conflict invariants of POST /api/sync + the shared appliers
 * (issue "Outbox conflict metadata + entity versions").
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
 * @/backend/lib/db is swapped for an in-memory stub; route-kit's route() is
 * a pass-through with a fixed contractor session (guard/rate-limit/body are
 * pinned by their own test files); mjengo's payload loaders are stubbed to
 * keep the refresh out of scope while applyAction stays REAL.
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    seq: 0,
    projects: new Map<string, Row>(),
    phases: new Map<string, Row>(),
    tasks: new Map<string, Row>(),
    workers: new Map<string, Row>(),
    attendance: new Map<string, Row>(),
    idempotency: new Map<string, Row>(),
    auditEvents: [] as Row[],
    reset() {
      state.projects.clear()
      state.phases.clear()
      state.tasks.clear()
      state.workers.clear()
      state.attendance.clear()
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
  state.phases.set('phase-1', { id: 'phase-1', projectId: 'proj-1', name: 'Foundations', order: 1, budget: 100_000, status: 'in_progress', progressManual: null })
  state.tasks.set('task-1', {
    id: 'task-1', phaseId: 'phase-1', title: 'Pour slab', status: 'in_progress', progress: 30,
    priority: 'normal', assignedToId: null, blockedById: null, blockedReason: null,
    verifiedAt: null, verifiedByName: null, dueDate: null, createdAt: new Date(), updatedAt: new Date(),
    version: 3,
  })
  state.workers.set('worker-1', { id: 'worker-1', projectId: 'proj-1', name: 'Kamau', role: 'Fundi', phone: '+254700000001', dailyRate: 800, active: true })
  state.attendance.set('att-1', {
    id: 'att-1', workerId: 'worker-1', projectId: 'proj-1', date: todayEAT(),
    checkIn: new Date(), checkOut: null, status: 'present', method: 'app', wage: 800, paid: false,
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
    expect(attRow()).toMatchObject({ status: 'absent', version: 3, wage: 0 })
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
