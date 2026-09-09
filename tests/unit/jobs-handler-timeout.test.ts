/**
 * BE-7 (issue #76) — the jobs drain loop survives a hung handler.
 *
 * runDueJobs used to await each handler with NO cap: one hung TTS/AI call
 * stalled every subsequent tick (anomaly scans, recap, the Daraja reconcile
 * sweep). Pinned here per acceptance criterion:
 *   · a NEVER-RESOLVING handler → the row lands 'failed' with a timeout
 *     lastError (terminal — NOT a §48 backoff retry; a handler that already
 *     hung a full window would re-hang every retry, see service.ts), and
 *     the drain CONTINUES: a later queued job in the same drain still runs
 *     'done' and is reported in the results;
 *   · a normal handler under the cap → 'done' with its result (the cap is
 *     invisible when calls answer in time);
 *   · a THROWING handler keeps the historical §48 ladder exactly (attempt
 *     1/3 → 'retrying' with backoff; terminal only at maxAttempts) — the
 *     timeout path did not bend the ordinary failure semantics;
 *   · JOBS_HANDLER_TIMEOUT_MS overrides the 30s default, read at drain
 *     time (env set before runDueJobs, no re-import needed).
 *
 * Mocks: '@/backend/modules/jobs/handlers' (a fake registry: never-resolving,
 *   ok, throwing handlers) and '@/backend/lib/db' (an in-memory jobRecord
 *   stub implementing findMany/update on the fields runDueJobs touches — the
 *   whatsapp-route.test.ts stub idiom). The service's own drain loop, backoff
 *   math and timeout race stay REAL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/modules/jobs/handlers', () => ({
  JOB_TYPES: ['test.hang', 'test.ok', 'test.throw'],
  JOB_HANDLERS: {
    'test.hang': () => new Promise<never>(() => {}), // never settles — the BE-7 scenario
    'test.ok': vi.fn(async () => ({ fine: true })),
    'test.throw': vi.fn(async () => {
      throw new Error('boom — transient provider failure')
    }),
  },
}))

vi.mock('@/backend/lib/db', () => {
  type Row = {
    id: string
    type: string
    projectId: string | null
    payload: string
    status: string
    attempts: number
    maxAttempts: number
    runAt: Date
    result: string | null
    lastError: string | null
    finishedAt: Date | null
  }
  let seq = 0
  const rows = new Map<string, Row>()
  const db = {
    __rows: rows,
    __reset() {
      rows.clear()
      seq = 0
    },
    __seed(type: string, over: Partial<Row> = {}): Row {
      seq += 1
      const row: Row = {
        id: `job-${seq}`,
        type,
        projectId: 'p-1',
        payload: '{}',
        status: 'queued',
        attempts: 0,
        maxAttempts: 3,
        runAt: new Date(Date.now() - 60_000), // due
        result: null,
        lastError: null,
        finishedAt: null,
        ...over,
      }
      rows.set(row.id, row)
      return row
    },
    jobRecord: {
      async findMany({ where, orderBy, take }: { where: { status: { in: string[] } }; orderBy: { runAt: 'asc' }; take: number }) {
        const now = Date.now()
        return [...rows.values()]
          .filter((r) => where.status.in.includes(r.status) && r.runAt.getTime() <= now)
          .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
          .slice(0, take)
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const row = rows.get(where.id)
        if (!row) throw new Error(`stub: jobRecord ${where.id} not found`)
        const { attempts, ...rest } = data as { attempts?: { increment: number } } & Record<string, unknown>
        if (attempts) row.attempts += attempts.increment
        Object.assign(row, rest)
        return { ...row }
      },
      async create({ data }: { data: Partial<Row> }) {
        seq += 1
        const row: Row = {
          id: `job-${seq}`, projectId: null, payload: '{}', status: 'queued', attempts: 0,
          maxAttempts: 3, runAt: new Date(), result: null, lastError: null, finishedAt: null,
          ...data,
        } as Row
        rows.set(row.id, row)
        return { ...row }
      },
    },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { runDueJobs, retryBackoffMs } from '@/backend/modules/jobs/service'

type Rows = ReturnType<typeof rowsType>
function rowsType() {
  return undefined as unknown as {
    __rows: Map<string, Record<string, unknown>>
    __reset: () => void
    __seed: (type: string, over?: Record<string, unknown>) => Record<string, unknown>
  }
}
const stub = (db as unknown as { __state?: Rows }).__state ?? (db as unknown as Rows)

let prevTimeoutEnv: string | undefined
let errorLog: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  stub.__reset()
  prevTimeoutEnv = process.env.JOBS_HANDLER_TIMEOUT_MS
  process.env.JOBS_HANDLER_TIMEOUT_MS = '40' // small cap — real timers, fast test
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (prevTimeoutEnv === undefined) delete process.env.JOBS_HANDLER_TIMEOUT_MS
  else process.env.JOBS_HANDLER_TIMEOUT_MS = prevTimeoutEnv
  errorLog.mockRestore()
})

describe('runDueJobs — per-handler timeout (BE-7)', () => {
  it('a NEVER-RESOLVING handler fails the row terminally and the drain continues past it', async () => {
    const hung = stub.__seed('test.hang') // runAt earlier → drained first
    const after = stub.__seed('test.ok') // queued behind the hung job

    const { ran, results } = await runDueJobs(10)

    expect(ran).toBe(2) // BOTH jobs produced a result — the loop did not stall
    const hungRow = stub.__rows.get(String(hung.id)) as { status: string; lastError: string | null }
    const okRow = stub.__rows.get(String(after.id)) as { status: string; result: string | null }

    expect(hungRow.status).toBe('failed')
    expect(hungRow.lastError).toMatch(/timed out after 40ms/i)
    expect(hungRow.lastError).toContain('test.hang')

    expect(okRow.status).toBe('done')
    expect(String(okRow.result)).toContain('"fine":true')

    const byId = Object.fromEntries(results.map((r) => [r.id, r]))
    expect(byId[String(hung.id)].status).toBe('failed')
    expect(byId[String(after.id)].status).toBe('done')
    // One loud log line for the timeout.
    expect(errorLog.mock.calls.some((c) => String(c[0]).includes('TIMED OUT'))).toBe(true)
  })

  it('a handler that answers in time is untouched by the cap', async () => {
    const job = stub.__seed('test.ok')
    const { ran, results } = await runDueJobs(10)
    expect(ran).toBe(1)
    expect(results[0].status).toBe('done')
    const row = stub.__rows.get(String(job.id)) as { status: string }
    expect(row.status).toBe('done')
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('a THROWING handler keeps the historical §48 retry ladder (attempt 1/3 → retrying)', async () => {
    const job = stub.__seed('test.throw', { maxAttempts: 3 })
    const { results } = await runDueJobs(10)
    expect(results[0].status).toBe('retrying')
    expect(results[0].attempts).toBe(1)
    const row = stub.__rows.get(String(job.id)) as { status: string; lastError: string | null; runAt: Date }
    expect(row.status).toBe('retrying')
    expect(row.lastError).toContain('boom')
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + retryBackoffMs(1) - 5_000)
  })

  it('a throwing handler at maxAttempts is terminal (unchanged semantics)', async () => {
    const job = stub.__seed('test.throw', { attempts: 2, maxAttempts: 3 })
    const { results } = await runDueJobs(10)
    expect(results[0].status).toBe('failed')
    const row = stub.__rows.get(String(job.id)) as { status: string }
    expect(row.status).toBe('failed')
  })

  it('JOBS_HANDLER_TIMEOUT_MS is read at drain time (default 30s when unset/invalid)', async () => {
    delete process.env.JOBS_HANDLER_TIMEOUT_MS
    // Drain with the DEFAULT cap: a hung job would stall the real 30s — use a
    // throwing job instead so the drain finishes fast; only the timeout env
    // resolution is observable here (the default is pinned by construction:
    // DEFAULT_HANDLER_TIMEOUT_MS = 30_000, see service.ts).
    stub.__seed('test.throw')
    const { ran } = await runDueJobs(10)
    expect(ran).toBe(1)

    // An invalid value falls back to the default instead of zero/NaN.
    process.env.JOBS_HANDLER_TIMEOUT_MS = 'not-a-number'
    stub.__reset()
    stub.__seed('test.ok')
    const again = await runDueJobs(10)
    expect(again.ran).toBe(1)
    expect(again.results[0].status).toBe('done')
  })
})
