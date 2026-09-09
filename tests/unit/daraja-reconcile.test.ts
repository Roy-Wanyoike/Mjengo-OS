/**
 * Daraja pending-intent reconciliation sweep (issue #34)
 * (src/backend/modules/wallet/daraja-reconcile.ts + its registration in
 * src/backend/modules/jobs/handlers.ts + the seed in wallet/service.ts).
 *
 * No network: global fetch stubbed (vi.stubGlobal), the wallet module's
 * Prisma client swapped for an in-memory stub (mpesa-daraja.test.ts pattern
 * — extended with idempotencyRecord.findMany and the jobRecord table) so
 * the REAL ledger posting core and the REAL jobs drainer both run; notify
 * is mocked at its module boundary. Env is saved/scrubbed per test and
 * restored after. Timing is controlled by seeding intent rows with
 * backdated createdAt values (no fake timers — the sweep reads the clock
 * once per run). Pins:
 *  · a probe-eligible pending intent settles EXACTLY like the callback:
 *    one balanced ledger post through the real core, PR paid, durable
 *    daraja.callback:<id> written, notify sent, stkpushquery called;
 *  · dedupe backstop in both directions — sweep settles then a late real
 *    callback is an honest duplicate (no double post), and a callback that
 *    settled first makes the sweep a pure no-op (no query at all);
 *  · unmapped / known-failed query results NEVER post money and NEVER
 *    write the durable callback record (a later success callback can
 *    still credit) — the intent stays pending and the chain continues;
 *  · too-young intents are not probed but keep the chain alive; intents
 *    past max-age drop out of the window (stays pending, no invented
 *    failure); no intent rows → honest no-op, no follow-up;
 *  · the seed: payPaymentRequest's pending path records the intent AND
 *    enqueues a delayed wallet.reconcile row (one at a time);
 *  · the drainer integration: isJobType accepts it, JOB_HANDLERS runs it,
 *    and a queued row is drained to done with the sweep result JSON —
 *    the /api/jobs/run scheduler cycle picks the sweep up as-is;
 *  · env tuning: invalid values warn + fall back; fractional minutes work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub — mpesa-daraja.test.ts pattern, extended with
// idempotencyRecord.findMany (startsWith + createdAt gte + orderBy) and a
// jobRecord table (create / findFirst / findMany / update with increment).
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
      orderBy,
    }: {
      where?: { key?: { startsWith?: string }; createdAt?: { gte?: Date } }
      orderBy?: { createdAt?: 'asc' | 'desc' }
    } = {}) {
      let rows = [...state.idempotency.values()]
      if (where?.key?.startsWith) rows = rows.filter((r) => String(r.key).startsWith(where.key!.startsWith as string))
      if (where?.createdAt?.gte) rows = rows.filter((r) => (r.createdAt as Date) >= (where.createdAt!.gte as Date))
      rows.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
      if (orderBy?.createdAt === 'desc') rows.reverse()
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
  processDarajaStkCallback,
  resetDarajaCallbackStateForTests,
  type DarajaIntentPayload,
} from '@/backend/modules/wallet/daraja-callback'
import {
  DARAJA_RECONCILE_JOB_TYPE,
  darajaReconcileTuningFromEnv,
  runDarajaReconcile,
  scheduleDarajaReconcile,
  seedDarajaReconcileSweep,
} from '@/backend/modules/wallet/daraja-reconcile'
import { payPaymentRequest } from '@/backend/modules/wallet/service'
import { enqueue, isJobType, runDueJobs } from '@/backend/modules/jobs/service'
import { JOB_HANDLERS } from '@/backend/modules/jobs/handlers'

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

function setDarajaEnv(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    DARAJA_ENV: 'sandbox',
    DARAJA_CONSUMER_KEY: 'test-consumer-key',
    DARAJA_CONSUMER_SECRET: 'test-consumer-secret',
    DARAJA_SHORTCODE: '174379',
    DARAJA_PASSKEY: 'test-passkey',
    DARAJA_CALLBACK_BASE: 'https://cb.example',
    DARAJA_WEBHOOK_SECRET: 'test-webhook-secret',
    ...overrides,
  }
  for (const [k, v] of Object.entries(base)) if (v !== '') process.env[k] = v
}

const CHECKOUT = 'ws_CO_SWEEP_0001'
const PR_ID = 'pr_sweep_1'
const fetchMock = vi.fn()

/** Query-api response factory (ResultCode as string like Daraja sends). */
function queryResponse(resultCode: string, desc = 'The service request is processed successfully.') {
  return new Response(
    JSON.stringify({ ResponseCode: '0', CheckoutRequestID: CHECKOUT, ResultCode: resultCode, ResultDesc: desc }),
    { status: 200 },
  )
}

function stubFetch(query: () => Response = () => queryResponse('0')) {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url: string })?.url ?? input)
    if (url.includes('/oauth/')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: '3599' }), { status: 200 })
    }
    if (url.includes('/mpesa/stkpushquery/')) return query()
    if (url.includes('/mpesa/stkpush/v1/processrequest')) return STK_PUSH_OK()
    throw new Error(`test: unexpected fetch ${url}`)
  })
}

const STK_PUSH_OK = () =>
  new Response(
    JSON.stringify({
      MerchantRequestID: '29115-34620561-1',
      CheckoutRequestID: CHECKOUT,
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing',
    }),
    { status: 200 },
  )

function seedPaymentRequest(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: PR_ID, requestCode: 'PR-2026-000042', projectId: 'proj-1',
    description: 'Sweep fixture payment', amount: 1500,
    payee: '254708374149', method: 'mpesa', status: 'approved',
    paidAt: null, paidTxnId: null,
    ...overrides,
  }
  state.paymentRequests.set(String(row.id), row)
  return row
}

function seedIntent(
  overrides: Partial<DarajaIntentPayload> & { createdAt?: Date; checkout?: string } = {},
) {
  const checkout = overrides.checkout ?? CHECKOUT
  const { createdAt, checkout: _c, ...rest } = overrides
  const intent: DarajaIntentPayload = {
    kind: 'payment.request',
    paymentRequestId: PR_ID,
    requestCode: 'PR-2026-000042',
    projectId: 'proj-1',
    amount: 1500,
    payee: '254708374149',
    method: 'mpesa',
    reference: 'PR-2026-000042',
    providerRef: checkout,
    initiatedBy: 'Finance Fox',
    initiatedByRole: 'finance',
    ...rest,
  }
  const key = `${DARAJA_INTENT_KEY_PREFIX}${checkout}`
  state.idempotency.set(key, {
    id: `idem_${checkout}`, key, scope: 'payment.provider_intent',
    projectId: intent.projectId, responseBody: JSON.stringify(intent),
    createdAt: createdAt ?? new Date(Date.now() - 3 * 60_000), // probe-eligible by default
  })
  return intent
}

/** Ledger postings joined back to account codes, for balance assertions. */
function postedLines() {
  return [...state.entries.values()].map((e) => ({
    side: e.side,
    amount: e.amount,
    code: state.accounts.get(e.accountId as string)?.code,
  }))
}

function sweepJobRows() {
  return [...state.jobs.values()].filter((j) => j.type === DARAJA_RECONCILE_JOB_TYPE)
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  state.reset()
  resetDarajaCallbackStateForTests()
  resetDarajaProviderCacheForTests()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.clearAllMocks()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------- the sweep

describe('runDarajaReconcile — settles pending intents like the callback', () => {
  beforeEach(() => {
    setDarajaEnv()
    stubFetch()
    seedPaymentRequest()
    seedIntent()
  })

  it('probe-eligible intent → ONE balanced ledger post via the real core, PR paid, durable record, notify, followUp ends', async () => {
    const result = await runDarajaReconcile()
    expect(result.scanned).toBe(1)
    expect(result.probed).toBe(1)
    expect(result.credited).toBe(1)
    expect(result.followUpAt).toBeNull()
    // the money: exactly the callback's balanced double-entry
    expect(state.txns.size).toBe(1)
    const lines = postedLines()
    expect(lines).toHaveLength(2)
    expect(lines).toContainEqual({ side: 'debit', amount: 1500, code: 'EXPENSE:proj-1' })
    expect(lines).toContainEqual({ side: 'credit', amount: 1500, code: 'CASH_MPESA' })
    expect(state.paymentRequests.get(PR_ID)?.status).toBe('paid')
    expect(state.transactions.size).toBe(1) // legacy Transaction row linked
    // the durable dedupe record — same key family the callback writes
    expect(state.idempotency.has(`${DARAJA_CALLBACK_KEY_PREFIX}${CHECKOUT}`)).toBe(true)
    // the query API was actually called, with the CheckoutRequestID
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/mpesa/stkpushquery/'))).toHaveLength(1)
    const queryCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/mpesa/stkpushquery/'))
    expect(JSON.parse((queryCall![1] as { body: string }).body).CheckoutRequestID).toBe(CHECKOUT)
    expect(notify).toHaveBeenCalledTimes(1)
    // the money trail says HOW the settlement was triggered (honest label)
    const notifyArgs = (notify as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(notifyArgs[2])).toContain('reconciliation sweep')
    expect(String(notifyArgs[2])).toContain('verified')
    const txnNote = String([...state.transactions.values()][0].note)
    expect(txnNote).toContain('reconciliation sweep')
    expect(txnNote).toContain(CHECKOUT)
  })

  it('too-young intent is not probed, but the chain schedules a follow-up sweep', async () => {
    seedIntent({ createdAt: new Date(Date.now() - 30_000) })
    const result = await runDarajaReconcile()
    expect(result.scanned).toBe(1)
    expect(result.probed).toBe(0)
    expect(result.tooYoung).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.txns.size).toBe(0)
    expect(state.paymentRequests.get(PR_ID)?.status).toBe('approved')
    expect(result.followUpAt).not.toBeNull()
    const rows = sweepJobRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('queued')
    expect((rows[0].runAt as Date).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000) // default interval 5
  })

  it('unmapped query ResultCode → stays pending: no post, NO durable record, chain continues', async () => {
    stubFetch(() => queryResponse('9999', 'Unmapped something'))
    const result = await runDarajaReconcile()
    expect(result.probed).toBe(1)
    expect(result.unverified).toBe(1)
    expect(result.credited).toBe(0)
    expect(state.txns.size).toBe(0)
    expect(state.paymentRequests.get(PR_ID)?.status).toBe('approved')
    expect(state.idempotency.has(`${DARAJA_CALLBACK_KEY_PREFIX}${CHECKOUT}`)).toBe(false)
    expect(result.followUpAt).not.toBeNull()
  })

  it('known-failed query (1032 user-cancelled) → no post, no durable record (a later success callback can still credit)', async () => {
    stubFetch(() => queryResponse('1032', 'Request cancelled by user'))
    const result = await runDarajaReconcile()
    expect(result.unverified).toBe(1)
    expect(state.txns.size).toBe(0)
    expect(state.idempotency.has(`${DARAJA_CALLBACK_KEY_PREFIX}${CHECKOUT}`)).toBe(false)
    expect(state.paymentRequests.get(PR_ID)?.status).toBe('approved')
    // and indeed a later genuine success callback can still credit it
    stubFetch()
    const outcome = await processDarajaStkCallback({
      Body: { stkCallback: { CheckoutRequestID: CHECKOUT, ResultCode: 0, ResultDesc: 'late success' } },
    })
    expect(outcome.action).toBe('credited')
    expect(state.txns.size).toBe(1)
  })

  it('no intent rows at all → honest no-op, no fetch, no follow-up', async () => {
    state.idempotency.clear()
    const result = await runDarajaReconcile()
    expect(result.scanned).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.followUpAt).toBeNull()
    expect(sweepJobRows()).toHaveLength(0)
    expect(result.note).toContain('nothing to do')
  })

  it('intent past max-age drops out of the window: not probed, chain ends, stays pending (no invented failure)', async () => {
    seedIntent({ createdAt: new Date(Date.now() - 90 * 60_000) }) // default maxAge = 60
    const result = await runDarajaReconcile()
    expect(result.scanned).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.followUpAt).toBeNull()
    expect(sweepJobRows()).toHaveLength(0)
    expect(state.txns.size).toBe(0)
    expect(state.paymentRequests.get(PR_ID)?.status).toBe('approved')
    expect(state.idempotency.has(`${DARAJA_INTENT_KEY_PREFIX}${CHECKOUT}`)).toBe(true) // still pending
  })

  it('request already paid via another path → honest closed no-op, no second post', async () => {
    seedPaymentRequest({ status: 'paid', paidAt: new Date(), paidTxnId: 'tx_old' })
    const result = await runDarajaReconcile()
    expect(result.probed).toBe(1)
    expect(result.ignored).toBe(1)
    expect(result.credited).toBe(0)
    expect(state.txns.size).toBe(0) // no new posting
    expect(state.idempotency.has(`${DARAJA_CALLBACK_KEY_PREFIX}${CHECKOUT}`)).toBe(false)
    expect(result.followUpAt).not.toBeNull() // bounded probing until max-age
  })

  it('probe budget: 26 unsettled probe-eligible intents → 25 probed this run, follow-up scheduled for the rest', async () => {
    state.idempotency.clear()
    for (let i = 0; i < 26; i++) {
      const prId = `pr_budget_${i}`
      seedPaymentRequest({ id: prId, requestCode: `PR-2026-B${i}` })
      seedIntent({ checkout: `ws_CO_BUDGET_${String(i).padStart(4, '0')}`, paymentRequestId: prId, requestCode: `PR-2026-B${i}` })
    }
    const result = await runDarajaReconcile()
    expect(result.scanned).toBe(26)
    expect(result.probed).toBe(25)
    expect(result.tooYoung).toBe(1) // the over-budget one is left for the follow-up
    expect(result.credited).toBe(25)
    expect(state.txns.size).toBe(25)
    expect(result.followUpAt).not.toBeNull()
    expect(sweepJobRows()).toHaveLength(1)
  })
})

// ---------------------------------------------------------- dedupe backstop

describe('runDarajaReconcile — dedupe vs the real callback (both directions)', () => {
  beforeEach(() => {
    setDarajaEnv()
    stubFetch()
    seedPaymentRequest()
    seedIntent()
  })

  it('callback arrives AFTER the sweep settled → honest duplicate, no double post', async () => {
    const sweep = await runDarajaReconcile()
    expect(sweep.credited).toBe(1)
    const outcome = await processDarajaStkCallback({
      Body: { stkCallback: { CheckoutRequestID: CHECKOUT, ResultCode: 0, ResultDesc: 'late real callback' } },
    })
    expect(outcome.action).toBe('duplicate')
    expect(state.txns.size).toBe(1)
    expect([...state.entries.values()].filter((e) => e.side === 'debit')).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(1) // only the original credit notified
  })

  it('callback settles FIRST → the sweep is a pure no-op: settled-earlier, no query fetch at all', async () => {
    const outcome = await processDarajaStkCallback({
      Body: { stkCallback: { CheckoutRequestID: CHECKOUT, ResultCode: 0, ResultDesc: 'real callback' } },
    })
    expect(outcome.action).toBe('credited')
    fetchMock.mockClear()
    const result = await runDarajaReconcile()
    expect(result.scanned).toBe(1)
    expect(result.settledEarlier).toBe(1)
    expect(result.probed).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled() // settled intents cost zero HTTP
    expect(state.txns.size).toBe(1) // untouched
    expect(result.followUpAt).toBeNull()
    expect(sweepJobRows()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- scheduling

describe('sweep scheduling — seed, chain, and the jobs drainer', () => {
  beforeEach(() => {
    setDarajaEnv()
    stubFetch()
    seedPaymentRequest()
    seedIntent()
  })

  it('payPaymentRequest pending path seeds ONE delayed wallet.reconcile row (runAt ≈ now + after-min)', async () => {
    // payPaymentRequest records the intent itself — drop the beforeEach
    // fixture row so the real recordDarajaIntent create succeeds.
    state.idempotency.delete(`${DARAJA_INTENT_KEY_PREFIX}${CHECKOUT}`)
    await expect(
      payPaymentRequest('proj-1', { id: PR_ID, method: 'mpesa', paidBy: 'Finance Fox', paidByRole: 'finance' }),
    ).rejects.toThrow(/PENDING customer confirmation/i)
    const rows = sweepJobRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('queued')
    expect(rows[0].projectId).toBeNull() // cross-project sweep
    const runAt = (rows[0].runAt as Date).getTime()
    expect(runAt).toBeGreaterThan(Date.now() + 60_000) // ~2 min default (never due immediately)
    expect(runAt).toBeLessThan(Date.now() + 4 * 60_000)
    // a second seed while one is queued never stacks a second row
    const again = await seedDarajaReconcileSweep()
    expect(again).toBeNull()
    expect(sweepJobRows()).toHaveLength(1)
    // the intent row is recorded as before, no money moved
    expect(state.idempotency.has(`${DARAJA_INTENT_KEY_PREFIX}${CHECKOUT}`)).toBe(true)
    expect(state.txns.size).toBe(0)
  })

  it('registered with the drainer: isJobType accepts wallet.reconcile, JOB_HANDLERS has it', () => {
    expect(isJobType(DARAJA_RECONCILE_JOB_TYPE)).toBe(true)
    expect(typeof JOB_HANDLERS[DARAJA_RECONCILE_JOB_TYPE]).toBe('function')
  })

  it('the /api/jobs/run drain cycle executes a queued sweep row to done with the sweep result JSON', async () => {
    // enqueue exactly like POST /api/jobs/run {type: 'wallet.reconcile'} does
    const row = await enqueue(DARAJA_RECONCILE_JOB_TYPE, null, {})
    const { ran, results } = await runDueJobs(10)
    expect(ran).toBe(1)
    const first = results[0] as { id: string; type: string; status: string; result: string | null }
    expect(first.id).toBe(row.id)
    expect(first.type).toBe(DARAJA_RECONCILE_JOB_TYPE)
    expect(first.status).toBe('done')
    const resultJson = JSON.parse(first.result ?? '{}') as Record<string, unknown>
    expect(resultJson.credited).toBe(1)
    expect(resultJson.probed).toBe(1)
    // the money actually posted through the drain cycle
    expect(state.txns.size).toBe(1)
    expect(state.paymentRequests.get(PR_ID)?.status).toBe('paid')
    // the stored row is done — re-draining never re-runs it (queue semantics)
    const second = await runDueJobs(10)
    expect(second.ran).toBe(0)
    expect(state.txns.size).toBe(1)
  })

  it('a not-yet-due sweep row is not drained early (runAt respected)', async () => {
    await scheduleDarajaReconcile(new Date(Date.now() + 5 * 60_000))
    const { ran } = await runDueJobs(10)
    expect(ran).toBe(0)
    expect(state.txns.size).toBe(0)
  })
})

// ---------------------------------------------------------------- env tuning

describe('darajaReconcileTuningFromEnv — env-driven with honest defaults', () => {
  it('all unset → defaults 2 / 5 / 60 (minutes)', () => {
    const tuning = darajaReconcileTuningFromEnv({})
    expect(tuning).toEqual({ afterMin: 2, intervalMin: 5, maxAgeMin: 60 })
  })

  it('invalid values warn and fall back; fractional minutes are accepted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tuning = darajaReconcileTuningFromEnv({
      DARAJA_RECONCILE_AFTER_MIN: 'banana',
      DARAJA_RECONCILE_INTERVAL_MIN: '-4',
      DARAJA_RECONCILE_MAX_AGE_MIN: '0.5',
    })
    expect(tuning.afterMin).toBe(2)
    expect(tuning.intervalMin).toBe(5)
    expect(tuning.maxAgeMin).toBe(0.5)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0][0])).toContain('DARAJA_RECONCILE_AFTER_MIN')
    warn.mockRestore()
  })

  it('a tiny after-min makes a seconds-old intent probe-eligible', async () => {
    setDarajaEnv({ DARAJA_RECONCILE_AFTER_MIN: '0.01' }) // 0.6 s
    stubFetch()
    seedPaymentRequest()
    seedIntent({ createdAt: new Date(Date.now() - 2_000) })
    const result = await runDarajaReconcile()
    expect(result.probed).toBe(1)
    expect(result.credited).toBe(1)
  })
})
