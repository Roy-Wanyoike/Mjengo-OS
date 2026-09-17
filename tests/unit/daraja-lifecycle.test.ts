/**
 * M-Pesa Daraja STK payment lifecycle — ONE CONTINUOUS STORY (issue #211).
 *
 * Unlike mpesa-daraja.test.ts / daraja-reconcile.test.ts (fresh state per
 * test, one transition each), this suite deliberately shares ONE in-memory
 * state object across the whole file and runs ordered phases that build on
 * each other — the sequence semantics (a crash/miss at one step must be
 * covered by the NEXT step, never by invented money) can only be pinned by
 * walking the machine end-to-end:
 *
 *   1. initiate (pending)         → intent row + delayed sweep seed, no money
 *   2. early sweep                → intent too young, the seed is the chain
 *   3. probe #1, query "still processing" (500.001.1001) → unverified, stays
 *   4. the DELAYED sweep job drains via the jobs runner, query success →
 *      exactly ONE balanced ledger post, PR paid, one Transaction row, one
 *      durable dedupe record, one notification
 *   5. Safaricom's late REAL callback → honest duplicate, nothing changes
 *   6. a later sweep → settled-earlier no-op, zero HTTP
 *   7. crash variant: durable record lost after the commit → re-drive is an
 *      honest already-paid skip (no second post)
 *   8. NEW request, initiate TIMES OUT → honest throw + unresolved-initiation
 *      row recorded AT initiation (issue #211) — no intent row can exist
 *   9. the customer's late verified-success callback for that checkout →
 *      ALERTED (console.warn + payment.orphaned notification correlated with
 *      the phase-8 row), still ZERO money posted (fail-closed unchanged)
 *   10. the sweep structurally cannot address the orphan checkout — only an
 *      operator can settle it (documented residual risk)
 *
 * No network (vi.stubGlobal('fetch') reading mutable mode variables), no
 * fake timers (intent ages are seeded by backdating createdAt — the
 * existing pattern), notify mocked at its module boundary.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub — the daraja-reconcile.test.ts extended pattern
// (idempotencyRecord.findMany for the orphan alert's unresolved-row scan;
// full jobRecord so the REAL jobs drainer runs the delayed sweep).
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    accounts: new Map<string, Record<string, unknown>>(),
    txns: new Map<string, Record<string, unknown>>(),
    entries: new Map<string, Record<string, unknown>>(),
    paymentRequests: new Map<string, Record<string, unknown>>(),
    transactions: new Map<string, Record<string, unknown>>(),
    idempotency: new Map<string, Record<string, unknown>>(),
    jobs: new Map<string, Record<string, unknown>>(),
    reset() {
      state.accounts.clear(); state.txns.clear(); state.entries.clear()
      state.paymentRequests.clear(); state.transactions.clear()
      state.idempotency.clear(); state.jobs.clear(); state.seq = 0
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const entriesForAccount = (accountId: string) =>
    [...state.entries.values()].filter((e) => e.accountId === accountId)

  const ledgerAccount = {
    async findUnique({ where }: { where: { code?: string; id?: string } }) {
      let a: Record<string, unknown> | undefined
      if (where.id) a = state.accounts.get(where.id)
      else if (where.code) a = [...state.accounts.values()].find((x) => x.code === where.code)
      return a ? { ...a, entries: entriesForAccount(a.id as string) } : null
    },
    async create({ data }: { data: Record<string, unknown> }) {
      const a: Record<string, unknown> = { id: nid('acct'), ...data }
      state.accounts.set(a.id as string, a)
      return a
    },
  }
  const ledgerTransaction = {
    async findUnique({ where }: { where: { id?: string; idempotencyKey?: string } }) {
      let t: Record<string, unknown> | undefined
      if (where.id) t = state.txns.get(where.id)
      else if (where.idempotencyKey) t = [...state.txns.values()].find((x) => x.idempotencyKey === where.idempotencyKey)
      return t ? { ...t, entries: [...state.entries.values()].filter((e) => e.transactionId === t.id) } : null
    },
    async create({ data }: { data: Record<string, unknown> & { entries?: { create: Record<string, unknown>[] } } }) {
      const { entries, ...rest } = data
      const t: Record<string, unknown> = { id: nid('txn'), status: 'posted', reversalRef: null, ...rest }
      const created = (entries?.create ?? []).map((l) => {
        const e: Record<string, unknown> = { id: nid('entry'), transactionId: t.id, ...l }
        state.entries.set(e.id as string, e)
        return { ...e, account: state.accounts.get(e.accountId as string) ?? null }
      })
      state.txns.set(t.id as string, t)
      return { ...t, entries: created }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const t = state.txns.get(where.id)
      if (!t) throw new Error(`stub: txn ${where.id} not found`)
      Object.assign(t, data)
      return { ...t }
    },
  }
  const paymentRequest = {
    async findUnique({ where }: { where: { id: string } }) {
      const r = state.paymentRequests.get(where.id)
      return r ? { ...r } : null
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      const rows = [...state.paymentRequests.values()]
      const or = where.OR as { id?: string; requestCode?: string }[] | undefined
      if (or) return rows.find((r) => or.some((c) => (c.id ? c.id === r.id : c.requestCode === r.requestCode))) ?? null
      return rows.find((r) => (!where.id || r.id === where.id) && (!where.projectId || r.projectId === where.projectId) && (!where.status || r.status === where.status)) ?? null
    },
    async create({ data }: { data: Record<string, unknown> }) {
      const r: Record<string, unknown> = { id: nid('pr'), status: 'pending', ...data }
      state.paymentRequests.set(r.id as string, r)
      return { ...r }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const r = state.paymentRequests.get(where.id)
      if (!r) throw new Error(`stub: paymentRequest ${where.id} not found`)
      Object.assign(r, data)
      return { ...r }
    },
  }
  const transaction = {
    async findFirst({ where }: { where: { ledgerTxnId?: string; projectId?: string; id?: string } }) {
      return (
        [...state.transactions.values()].find(
          (t) =>
            (!where.ledgerTxnId || t.ledgerTxnId === where.ledgerTxnId) &&
            (!where.projectId || t.projectId === where.projectId) &&
            (!where.id || t.id === where.id),
        ) ?? null
      )
    },
    async create({ data }: { data: Record<string, unknown> }) {
      const t: Record<string, unknown> = { id: nid('tx'), ...data }
      state.transactions.set(t.id as string, t)
      return { ...t }
    },
  }
  const idempotencyRecord = {
    async findUnique({ where }: { where: { key: string } }) {
      const r = state.idempotency.get(where.key)
      return r ? { ...r } : null
    },
    async findMany({
      where,
    }: { where?: { key?: { startsWith?: string } } } = {}) {
      let rows = [...state.idempotency.values()]
      if (where?.key?.startsWith) rows = rows.filter((r) => String(r.key).startsWith(where.key!.startsWith as string))
      return rows.map((r) => ({ ...r }))
    },
    async create({ data }: { data: { key: string } & Record<string, unknown> }) {
      if (state.idempotency.has(data.key)) {
        throw new Error(`stub: unique constraint failed on IdempotencyRecord.key=${data.key}`)
      }
      const r: Record<string, unknown> = { id: nid('idem'), createdAt: new Date(), ...data }
      state.idempotency.set(data.key, r)
      return { ...r }
    },
  }
  // Full jobRecord (daraja-reconcile.test.ts shape) so runDueJobs really runs.
  const jobRecord = {
    async create({ data }: { data: Record<string, unknown> }) {
      const j: Record<string, unknown> = {
        id: nid('job'), type: 'unknown', projectId: null, status: 'queued',
        payload: '{}', result: null, attempts: 0, lastError: null,
        runAt: new Date(), startedAt: null, finishedAt: null,
        createdAt: new Date(), maxAttempts: 3, lastAttemptAt: null,
        ...data,
      }
      state.jobs.set(j.id as string, j)
      return { ...j }
    },
    async findFirst({ where }: { where: { type?: string; status?: { in: string[] } } }) {
      return (
        [...state.jobs.values()].find(
          (j) =>
            (!where.type || j.type === where.type) &&
            (!where.status || where.status.in.includes(j.status as string)),
        ) ?? null
      )
    },
    async findMany({
      where,
      orderBy,
      take,
    }: {
      where?: { status?: { in: string[] }; runAt?: { lte?: Date } }
      orderBy?: { runAt?: 'asc' | 'desc' }
      take?: number
    } = {}) {
      let rows = [...state.jobs.values()]
      if (where?.status?.in) rows = rows.filter((j) => where.status!.in!.includes(j.status as string))
      if (where?.runAt?.lte) rows = rows.filter((j) => (j.runAt as Date) <= (where.runAt!.lte as Date))
      rows.sort((a, b) => (a.runAt as Date).getTime() - (b.runAt as Date).getTime())
      if (orderBy?.runAt === 'desc') rows.reverse()
      if (take) rows = rows.slice(0, take)
      return rows.map((r) => ({ ...r }))
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const j = state.jobs.get(where.id)
      if (!j) throw new Error(`stub: jobRecord ${where.id} not found`)
      const applied = { ...data }
      if (
        applied.attempts !== undefined &&
        typeof applied.attempts === 'object' &&
        applied.attempts !== null &&
        'increment' in (applied.attempts as Record<string, unknown>)
      ) {
        applied.attempts = (j.attempts as number) + (applied.attempts as { increment: number }).increment
      }
      Object.assign(j, applied)
      return { ...j }
    },
  }
  const db = {
    ledgerAccount, ledgerTransaction, paymentRequest, transaction, idempotencyRecord, jobRecord,
    async $transaction(fn: (tx: typeof db) => unknown) {
      return fn(db)
    },
    __state: state,
  }
  return { db }
})

vi.mock('@/backend/modules/notify/service', () => ({ notify: vi.fn() }))

import { db } from '@/backend/lib/db'
import { notify } from '@/backend/modules/notify/service'
import { resetDarajaProviderCacheForTests } from '@/backend/modules/wallet/daraja'
import {
  DARAJA_CALLBACK_KEY_PREFIX,
  DARAJA_INTENT_KEY_PREFIX,
  DARAJA_UNRESOLVED_KEY_PREFIX,
  processDarajaStkCallback,
  resetDarajaCallbackStateForTests,
} from '@/backend/modules/wallet/daraja-callback'
import { DARAJA_RECONCILE_JOB_TYPE, runDarajaReconcile } from '@/backend/modules/wallet/daraja-reconcile'
import { payPaymentRequest } from '@/backend/modules/wallet/service'
import { runDueJobs } from '@/backend/modules/jobs/service'

const state = (db as unknown as {
  __state: {
    accounts: Map<string, Record<string, unknown>>
    txns: Map<string, Record<string, unknown>>
    entries: Map<string, Record<string, unknown>>
    paymentRequests: Map<string, Record<string, unknown>>
    transactions: Map<string, Record<string, unknown>>
    idempotency: Map<string, Record<string, unknown>>
    jobs: Map<string, Record<string, unknown>>
    reset: () => void
  }
}).__state

// ---------------------------------------------------------------- fixtures

const ENV_KEYS = [
  'DARAJA_ENV', 'DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_SHORTCODE',
  'DARAJA_PASSKEY', 'DARAJA_CALLBACK_BASE', 'DARAJA_WEBHOOK_SECRET',
  'DARAJA_RECONCILE_AFTER_MIN', 'DARAJA_RECONCILE_INTERVAL_MIN', 'DARAJA_RECONCILE_MAX_AGE_MIN',
]
const savedEnv: Record<string, string | undefined> = {}

const PR1_ID = 'pr_life_1'
const PR2_ID = 'pr_life_2'
const CHECKOUT_A = 'ws_CO_LIFE_0001'
const ORPHAN_CHECKOUT = 'ws_CO_LATE_9001'

/** Mutable rail behaviour — the phases flip these to walk the state machine. */
let stkPushMode: 'ok' | 'timeout' = 'ok'
let queryMode: 'success' | 'processing' = 'success'

const fetchMock = vi.fn()
const STK_PUSH_OK = () =>
  new Response(
    JSON.stringify({
      MerchantRequestID: '29115-34620561-1',
      CheckoutRequestID: CHECKOUT_A,
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing',
    }),
    { status: 200 },
  )
const QUERY_OK = () =>
  new Response(
    JSON.stringify({
      ResponseCode: '0',
      CheckoutRequestID: CHECKOUT_A,
      ResultCode: '0',
      ResultDesc: 'The service request is processed successfully.',
    }),
    { status: 200 },
  )
const QUERY_PROCESSING = () =>
  new Response(
    JSON.stringify({ errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' }),
    { status: 500 },
  )

fetchMock.mockImplementation(async (input: unknown) => {
  const url = typeof input === 'string' ? input : String((input as { url: string })?.url ?? input)
  if (url.includes('/oauth/')) {
    return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: '3599' }), { status: 200 })
  }
  if (url.includes('/mpesa/stkpush/v1/processrequest')) {
    if (stkPushMode === 'timeout') return Promise.reject(new DOMException('The operation was aborted', 'TimeoutError'))
    return STK_PUSH_OK()
  }
  if (url.includes('/mpesa/stkpushquery/')) {
    return queryMode === 'processing' ? QUERY_PROCESSING() : QUERY_OK()
  }
  throw new Error(`test: unexpected fetch ${url}`)
})

function seedPr(id: string, overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id,
    requestCode: `PR-2026-${id === PR1_ID ? '000101' : '000102'}`,
    projectId: 'proj-1',
    description: 'Lifecycle fixture payment',
    amount: id === PR1_ID ? 150000n : 220000n,
    payee: '254708374149',
    method: 'mpesa',
    status: 'approved',
    relatedEntityType: null,
    relatedEntityId: null,
    paidAt: null,
    paidTxnId: null,
    ...overrides,
  }
  state.paymentRequests.set(id, row)
  return row
}

function callbackBody(checkout: string, amount: number, receipt: string) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: checkout,
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: amount },
            { Name: 'MpesaReceiptNumber', Value: receipt },
            { Name: 'PhoneNumber', Value: 254708374149 },
          ],
        },
      },
    },
  }
}

function postedLines() {
  return [...state.entries.values()].map((e) => ({
    side: e.side,
    amount: e.amount,
    code: state.accounts.get(e.accountId as string)?.code,
  }))
}
function sweepJobs() {
  return [...state.jobs.values()].filter((j) => j.type === DARAJA_RECONCILE_JOB_TYPE)
}
function backdateIntent(checkout: string, minutes: number) {
  const row = state.idempotency.get(`${DARAJA_INTENT_KEY_PREFIX}${checkout}`)
  if (row) row.createdAt = new Date(Date.now() - minutes * 60_000)
}

// The story runs on ONE shared state — env set once, db reset never.
beforeAll(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  process.env.DARAJA_ENV = 'sandbox'
  process.env.DARAJA_CONSUMER_KEY = 'test-consumer-key'
  process.env.DARAJA_CONSUMER_SECRET = 'test-consumer-secret'
  process.env.DARAJA_SHORTCODE = '174379'
  process.env.DARAJA_PASSKEY = 'test-passkey'
  process.env.DARAJA_CALLBACK_BASE = 'https://cb.example'
  process.env.DARAJA_WEBHOOK_SECRET = 'test-webhook-secret'
  resetDarajaProviderCacheForTests()
  resetDarajaCallbackStateForTests()
  seedPr(PR1_ID)
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

beforeEach(() => {
  vi.clearAllMocks() // per-phase notify/fetch call counts (state persists)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------- the story

describe('M-Pesa STK lifecycle — one continuous story on shared state (issue #211)', () => {
  it('1 · initiate (pending) → intent row + delayed sweep seed, ZERO money moved', async () => {
    await expect(
      payPaymentRequest('proj-1', { id: PR1_ID, method: 'mpesa', paidBy: 'Finance Fox', paidByRole: 'finance' }),
    ).rejects.toThrow(/PENDING customer confirmation/i)
    expect(state.idempotency.get(`${DARAJA_INTENT_KEY_PREFIX}${CHECKOUT_A}`)).toBeTruthy()
    expect(state.txns.size).toBe(0)
    expect(state.paymentRequests.get(PR1_ID)?.status).toBe('approved')
    expect(notify).not.toHaveBeenCalled()
    const jobs = sweepJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].status).toBe('queued')
    expect((jobs[0].runAt as Date).getTime()).toBeGreaterThan(Date.now()) // ~2 min out
  })

  it('2 · an early sweep (intent too young) probes nothing — the seeded job is the chain', async () => {
    const result = await runDarajaReconcile()
    expect(result.scanned).toBe(1)
    expect(result.tooYoung).toBe(1)
    expect(result.probed).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.txns.size).toBe(0)
    // the seed row from phase 1 already chains the next probe — no stacking
    expect(sweepJobs()).toHaveLength(1)
    expect(result.followUpAt).toBeNull() // a queued sweep already exists
  })

  it('3 · probe #1: query says still processing (500.001.1001) → unverified, intent stays, nothing posted', async () => {
    backdateIntent(CHECKOUT_A, 3) // probe-eligible now
    queryMode = 'processing'
    const result = await runDarajaReconcile()
    expect(result.probed).toBe(1)
    expect(result.unverified).toBe(1)
    expect(result.credited).toBe(0)
    expect(state.txns.size).toBe(0)
    expect(state.idempotency.has(`${DARAJA_CALLBACK_KEY_PREFIX}${CHECKOUT_A}`)).toBe(false)
    expect(state.paymentRequests.get(PR1_ID)?.status).toBe('approved')
  })

  it('4 · the DELAYED sweep job drains: query success → exactly ONE balanced post, PR paid, ONE Transaction row, ONE dedupe record, ONE notify', async () => {
    queryMode = 'success'
    const job = sweepJobs()[0]
    job.runAt = new Date(Date.now() - 1_000) // the ~2-min delay has elapsed
    const { ran } = await runDueJobs(10)
    expect(ran).toBe(1)
    expect(job.status).toBe('done')
    // the money: ONE balanced double-entry (financial invariant — nothing invented)
    expect(state.txns.size).toBe(1)
    const lines = postedLines()
    expect(lines).toHaveLength(2)
    expect(lines).toContainEqual(expect.objectContaining({ side: 'debit', amount: 150000n, code: 'EXPENSE:proj-1' }))
    expect(lines).toContainEqual(expect.objectContaining({ side: 'credit', amount: 150000n, code: 'CASH_MPESA' }))
    expect(state.paymentRequests.get(PR1_ID)?.status).toBe('paid')
    expect(state.paymentRequests.get(PR1_ID)?.paidTxnId).toBeTruthy()
    expect(state.transactions.size).toBe(1) // exactly one legacy Transaction row
    expect(state.idempotency.has(`${DARAJA_CALLBACK_KEY_PREFIX}${CHECKOUT_A}`)).toBe(true) // one dedupe record
    expect(notify).toHaveBeenCalledTimes(1) // exactly one notification
    expect(String((notify as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2])).toContain('reconciliation sweep')
  })

  it('5 · Safaricom’s late REAL callback → honest duplicate, nothing changes (no double effect)', async () => {
    const outcome = await processDarajaStkCallback(callbackBody(CHECKOUT_A, 1500, 'NLJ7RT61SV'))
    expect(outcome.action).toBe('duplicate')
    expect(state.txns.size).toBe(1)
    expect([...state.entries.values()].filter((e) => e.side === 'debit')).toHaveLength(1)
    expect(state.paymentRequests.get(PR1_ID)?.status).toBe('paid')
    expect(notify).not.toHaveBeenCalled() // only the original credit notified
  })

  it('6 · a later sweep is a pure no-op: settled-earlier, zero HTTP, ledger untouched', async () => {
    fetchMock.mockClear()
    const result = await runDarajaReconcile()
    expect(result.settledEarlier).toBe(1)
    expect(result.probed).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.txns.size).toBe(1)
  })

  it('7 · crash variant (durable record lost after the commit) → re-drive is an honest already-paid skip', async () => {
    state.idempotency.delete(`${DARAJA_CALLBACK_KEY_PREFIX}${CHECKOUT_A}`)
    resetDarajaCallbackStateForTests() // simulate a fresh process: in-memory guard gone too
    const outcome = await processDarajaStkCallback(callbackBody(CHECKOUT_A, 1500, 'NLJ7RT61SV'))
    expect(outcome.action).toBe('ignored')
    expect(outcome.detail).toContain('already paid')
    expect(state.txns.size).toBe(1) // the original post stands — nothing re-posted
    expect([...state.entries.values()].filter((e) => e.side === 'debit')).toHaveLength(1)
  })

  it('8 · NEW request, initiate TIMES OUT → honest throw + unresolved-initiation row recorded AT initiation; NO intent row can exist (issue #211)', async () => {
    seedPr(PR2_ID)
    stkPushMode = 'timeout'
    await expect(
      payPaymentRequest('proj-1', { id: PR2_ID, method: 'mpesa', paidBy: 'Finance Fox', paidByRole: 'finance' }),
    ).rejects.toThrow(/did not accept the payment.*timed out after 10s/s)
    stkPushMode = 'ok'
    // the durable-intent pattern applied to the outcome-unknown class: the
    // request, amount, payer and failure line survive for reconciliation
    const unresolved = [...state.idempotency.values()].filter((r) => String(r.key).startsWith(DARAJA_UNRESOLVED_KEY_PREFIX))
    expect(unresolved).toHaveLength(1)
    const payload = JSON.parse(String(unresolved[0].responseBody)) as Record<string, unknown>
    expect(payload.requestCode).toBe('PR-2026-000102')
    expect(payload.amount).toBe(2200)
    expect(payload.payee).toBe('254708374149')
    expect(String(payload.failureDetail)).toContain('timed out after 10s')
    // ...but NO intent row was invented (the checkout id was never learned):
    // every daraja.intent:* row still belongs to the phase-1 request only
    const intentRows = [...state.idempotency.values()].filter((r) => String(r.key).startsWith(DARAJA_INTENT_KEY_PREFIX))
    expect(intentRows.length).toBeGreaterThanOrEqual(1)
    for (const row of intentRows) {
      expect((JSON.parse(String(row.responseBody)) as { paymentRequestId: string }).paymentRequestId).toBe(PR1_ID)
    }
    expect(state.txns.size).toBe(1) // still only the phase-4 post
    expect(state.paymentRequests.get(PR2_ID)?.status).toBe('approved')
    expect(notify).not.toHaveBeenCalled()
  })

  it('9 · the customer’s late verified-success callback → ALERTED, not silently ignored — still ZERO money posted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    queryMode = 'success'
    const outcome = await processDarajaStkCallback(callbackBody(ORPHAN_CHECKOUT, 2200, 'SBK1QT6XYZ'))
    // fail-closed unchanged: no intent row → no post, request stays approved
    expect(outcome.action).toBe('ignored')
    expect(outcome.detail).toContain('No pending provider intent')
    expect(state.txns.size).toBe(1)
    expect(state.paymentRequests.get(PR2_ID)?.status).toBe('approved')
    // ...but the silence is broken on both channels, correlated with phase 8
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain(ORPHAN_CHECKOUT)
    expect(String(warn.mock.calls[0][0])).toContain('SBK1QT6XYZ')
    expect(notify).toHaveBeenCalledTimes(1)
    const args = (notify as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(args[0]).toBe('proj-1')
    expect(String(args[1])).toContain('Unmatched M-Pesa payment')
    expect(String(args[2])).toContain('PR-2026-000102')
    expect(String(args[2])).toContain(ORPHAN_CHECKOUT)
    expect((args[3] as { kind: string }).kind).toBe('payment.orphaned')
    expect((args[3] as { audienceRole: string }).audienceRole).toBe('finance')
    warn.mockRestore()
  })

  it('10 · the sweep structurally cannot address the orphan checkout — only an operator can settle it', async () => {
    const before = state.txns.size
    const result = await runDarajaReconcile()
    // no intent row for the orphan exists to scan (its checkout id was never
    // learned); the phase-1 intent may re-drive as the honest already-paid
    // skip (its durable record was lost in the phase-7 crash variant)
    expect(state.idempotency.has(`${DARAJA_INTENT_KEY_PREFIX}${ORPHAN_CHECKOUT}`)).toBe(false)
    expect(result.credited).toBe(0)
    expect(state.txns.size).toBe(before) // nothing new posted, ever
    expect(state.paymentRequests.get(PR2_ID)?.status).toBe('approved') // operator path
  })
})
