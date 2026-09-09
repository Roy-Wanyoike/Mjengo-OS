/**
 * M-Pesa Daraja provider + callback invariants
 * (src/backend/modules/wallet/{daraja,daraja-callback,providers,service}.ts +
 * src/app/api/webhooks/daraja/*).
 *
 * No network: global fetch is stubbed (vi.stubGlobal), the wallet module's
 * Prisma client is swapped for a tiny in-memory stub (the ledger.test.ts
 * pattern) so the REAL ledger posting core runs, and the notify service is
 * mocked at its module boundary. Env is saved/scrubbed per test and restored
 * after. Pins:
 *  · factory fail-closed: incomplete DARAJA_* env → SimulatedProvider (the
 *    historical rail); complete env → DarajaProvider for method 'mpesa' only;
 *    unknown methods never reach a real rail;
 *  · OAuth: Basic-auth GET, token cached for the TTL (second initiate within
 *    TTL does NOT re-fetch), one refresh on a 401, small expires_in (< the
 *    safety margin) expires immediately;
 *  · STK initiate: exact payload shape (Password = base64(shortcode +
 *    passkey + Timestamp), TransactionType CustomerPayBillOnline, callback
 *    URL with the derived secret segment), honest 'pending' result with the
 *    CheckoutRequestID as providerRef, fail-closed before any HTTP for
 *    non-phone payees, leak-free failure details;
 *  · verifyPayment: ResultCode 0 → succeeded, 1032/1037 → failed, unmapped
 *    codes and Daraja's "still processing" 500.001.1001 → pending (never
 *    succeeded without confirmation);
 *  · refund: reversal creds unset → honest failed, no HTTP; set → the
 *    sandbox-shaped reversal request, honest 'pending' (async result);
 *  · payPaymentRequest with a pending initiation: intent row recorded,
 *    PaymentRequest stays approved, NO ledger post, honest throw;
 *  · callback: dedupe (in-memory + durable IdempotencyRecord) and the
 *    ledger idempotency key — a duplicate can never double-post; ResultCode
 *    != 0 → no post; unverified (query says failed) → no post; no intent →
 *    no post, honest 200; wrong secret path segment → 404.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub: ledger tables (posting core), paymentRequest,
// transaction + idempotencyRecord (wallet flows) + jobRecord (the pending
// path's wallet.reconcile seed). __state exposes the tables.
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
      state.accounts.clear()
      state.txns.clear()
      state.entries.clear()
      state.paymentRequests.clear()
      state.transactions.clear()
      state.idempotency.clear()
      state.jobs.clear()
      state.seq = 0
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const entriesFor = (txnId: string) =>
    [...state.entries.values()]
      .filter((e) => e.transactionId === txnId)
      .map((e) => ({ ...e, account: state.accounts.get(e.accountId as string) ?? null }))
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
      else if (where.idempotencyKey) {
        t = [...state.txns.values()].find((x) => x.idempotencyKey === where.idempotencyKey)
      }
      return t ? { ...t, entries: entriesFor(t.id as string) } : null
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
      return { ...t, entries: entriesFor(where.id) }
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
      if (or) {
        return (
          rows.find((r) =>
            or.some((c) => (c.id ? c.id === r.id : c.requestCode ? c.requestCode === r.requestCode : false)),
          ) ?? null
        )
      }
      return (
        rows.find(
          (r) =>
            (!where.id || r.id === where.id) &&
            (!where.projectId || r.projectId === where.projectId) &&
            (!where.status || r.status === where.status),
        ) ?? null
      )
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
    async create({ data }: { data: { key: string } & Record<string, unknown> }) {
      if (state.idempotency.has(data.key)) {
        throw new Error(`stub: unique constraint failed on IdempotencyRecord.key=${data.key}`)
      }
      const r: Record<string, unknown> = { id: nid('idem'), createdAt: new Date(), ...data }
      state.idempotency.set(data.key, r)
      return { ...r }
    },
  }
  // jobRecord (minimal): the pending-initiation path seeds a delayed
  // wallet.reconcile sweep row (issue #34) — the stub records it so the
  // existing intent pin can also assert the seed.
  const jobRecord = {
    async create({ data }: { data: Record<string, unknown> }) {
      const j: Record<string, unknown> = { id: nid('job'), status: 'queued', ...data }
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
  }
  const db = {
    ledgerAccount,
    ledgerTransaction,
    paymentRequest,
    transaction,
    idempotencyRecord,
    jobRecord,
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
import { getProvider, SimulatedProvider, EscrowWalletProvider } from '@/backend/modules/wallet/providers'
import {
  darajaConfigFromEnv,
  darajaPassword,
  darajaWebhookSegment,
  getDarajaProvider,
  DarajaProvider,
  msisdnFromPayee,
  resetDarajaProviderCacheForTests,
} from '@/backend/modules/wallet/daraja'
import {
  DARAJA_CALLBACK_KEY_PREFIX,
  DARAJA_INTENT_KEY_PREFIX,
  processDarajaStkCallback,
  recordDarajaIntent,
  resetDarajaCallbackStateForTests,
  type DarajaIntentPayload,
} from '@/backend/modules/wallet/daraja-callback'
import { payPaymentRequest } from '@/backend/modules/wallet/service'
import { POST as secretPathPost } from '@/app/api/webhooks/daraja/[secret]/route'
import { GET as docsGet, POST as fixedPathPost } from '@/app/api/webhooks/daraja/route'

const state = (db as unknown as { __state: ReturnType<typeof getState> }).__state
function getState() {
  return undefined as unknown as {
    accounts: Map<string, Record<string, unknown>>
    txns: Map<string, Record<string, unknown>>
    entries: Map<string, Record<string, unknown>>
    paymentRequests: Map<string, Record<string, unknown>>
    transactions: Map<string, Record<string, unknown>>
    idempotency: Map<string, Record<string, unknown>>
    jobs: Map<string, Record<string, unknown>>
    reset: () => void
  }
}

// ---------------------------------------------------------------- fixtures

const ENV = {
  DARAJA_ENV: 'sandbox',
  DARAJA_CONSUMER_KEY: 'test-consumer-key',
  DARAJA_CONSUMER_SECRET: 'test-consumer-secret',
  DARAJA_SHORTCODE: '174379',
  DARAJA_PASSKEY: 'test-passkey',
  DARAJA_CALLBACK_BASE: 'https://cb.example',
  DARAJA_WEBHOOK_SECRET: 'test-webhook-secret',
  DARAJA_INITIATOR_NAME: '',
  DARAJA_SECURITY_CREDENTIAL: '',
}
const ENV_KEYS = Object.keys(ENV)
const savedEnv: Record<string, string | undefined> = {}

const SHORTCODE = ENV.DARAJA_SHORTCODE
const PASSKEY = ENV.DARAJA_PASSKEY
const SEGMENT = darajaWebhookSegment(ENV.DARAJA_WEBHOOK_SECRET)
const CALLBACK_URL = `https://cb.example/api/webhooks/daraja/${SEGMENT}`
const CHECKOUT = 'ws_CO_TEST_0001'

const fetchMock = vi.fn()

function oauthBody(token: string, expiresIn: string) {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200 })
}
const STK_OK = () =>
  new Response(
    JSON.stringify({
      MerchantRequestID: '29115-34620561-1',
      CheckoutRequestID: CHECKOUT,
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing',
      CustomerMessage: 'Success. Request accepted for processing',
    }),
    { status: 200 },
  )
const QUERY_OK = () =>
  new Response(
    JSON.stringify({
      ResponseCode: '0',
      MerchantRequestID: '29115-34620561-1',
      CheckoutRequestID: CHECKOUT,
      ResultCode: '0',
      ResultDesc: 'The service request is processed successfully.',
    }),
    { status: 200 },
  )
const REVERSAL_OK = () =>
  new Response(
    JSON.stringify({
      ConversationID: 'AG_237648729_24628971',
      OriginatorConversationID: '1934-691871-1',
      ResponseCode: '0',
      ResponseDescription: 'Accept the service request successfully',
    }),
    { status: 200 },
  )

/** Route fetch by URL substring; defaults serve a full happy-path flow. */
function stubFetch(
  routes: { match: string; respond: (n: number) => Response }[] = [
    { match: '/oauth/', respond: () => oauthBody('tok-1', '3599') },
    { match: '/mpesa/stkpush/v1/processrequest', respond: () => STK_OK() },
    { match: '/mpesa/stkpushquery/', respond: () => QUERY_OK() },
    { match: '/mpesa/reversal/', respond: () => REVERSAL_OK() },
  ],
) {
  const counts = new Map<string, number>()
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url: string })?.url ?? input)
    for (const r of routes) {
      if (url.includes(r.match)) {
        counts.set(r.match, (counts.get(r.match) ?? 0) + 1)
        return r.respond(counts.get(r.match) as number)
      }
    }
    throw new Error(`test: unexpected fetch ${url}`)
  })
}
const callsTo = (match: string) => fetchMock.mock.calls.filter(([u]) => String(u).includes(match))
const bodyOfCall = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>

function setDarajaEnv(overrides: Record<string, string> = {}) {
  for (const k of ENV_KEYS) process.env[k] = ENV[k as keyof typeof ENV] as string
  Object.assign(process.env, overrides)
  for (const k of ENV_KEYS) if (process.env[k] === '') delete process.env[k]
}

const INITIATION = {
  amount: 1500,
  currency: 'KES',
  method: 'mpesa' as const,
  payee: '254708374149',
  reference: 'PR-2026-000001',
  description: 'Cement delivery payment',
}

// payment request + intent fixtures for the callback flow
const PR_ID = 'pr_1'
function seedPaymentRequest(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: PR_ID,
    requestCode: 'PR-2026-000001',
    projectId: 'proj-1',
    requestedByRole: 'contractor',
    requestedByName: 'Site Manager',
    description: 'Cement delivery payment',
    amount: 1500,
    payee: '254708374149',
    method: 'mpesa',
    status: 'approved',
    relatedEntityType: null,
    relatedEntityId: null,
    decidedBy: 'Client Claude',
    decidedAt: new Date(),
    decisionNote: null,
    paidAt: null,
    paidTxnId: null,
    ...overrides,
  }
  state.paymentRequests.set(PR_ID, row)
  return row
}
const INTENT: DarajaIntentPayload = {
  kind: 'payment.request',
  paymentRequestId: PR_ID,
  requestCode: 'PR-2026-000001',
  projectId: 'proj-1',
  amount: 1500,
  payee: '254708374149',
  method: 'mpesa',
  reference: 'PR-2026-000001',
  providerRef: CHECKOUT,
  initiatedBy: 'Finance Fox',
  initiatedByRole: 'finance',
}
function seedIntent(intent: DarajaIntentPayload = INTENT) {
  state.idempotency.set(`${DARAJA_INTENT_KEY_PREFIX}${intent.providerRef}`, {
    id: `idem_${intent.providerRef}`,
    key: `${DARAJA_INTENT_KEY_PREFIX}${intent.providerRef}`,
    scope: 'payment.provider_intent',
    projectId: intent.projectId,
    responseBody: JSON.stringify(intent),
    createdAt: new Date(),
  })
}
function callbackBody(overrides: Record<string, unknown> = {}, resultCode: number = 0) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: CHECKOUT,
        ResultCode: resultCode,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 1500 },
            { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
            { Name: 'PhoneNumber', Value: 254708374149 },
          ],
        },
        ...overrides,
      },
    },
  }
}

/** Ledger postings joined back to account codes, for balance assertions. */
function postedLines() {
  return [...state.entries.values()].map((e) => ({
    side: e.side,
    amount: e.amount,
    code: state.accounts.get(e.accountId as string)?.code,
    memo: e.memo,
  }))
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

// ---------------------------------------------------------------- factory

describe('provider factory — env-gated, fail-closed', () => {
  it('env unset → SimulatedProvider for mpesa (the default rail, unchanged)', () => {
    const p = getProvider('mpesa')
    expect(p).toBeInstanceOf(SimulatedProvider)
    expect(p.id).toBe('mpesa')
    expect(p.integrationNote).toContain('Simulated')
  })

  it('partial env (passkey missing) → still SimulatedProvider', () => {
    setDarajaEnv({ DARAJA_PASSKEY: '' })
    expect(getDarajaProvider()).toBeNull()
    expect(getProvider('mpesa')).toBeInstanceOf(SimulatedProvider)
  })

  it('blank DARAJA_WEBHOOK_SECRET → not selectable (callback URL must be unguessable)', () => {
    setDarajaEnv({ DARAJA_WEBHOOK_SECRET: '' })
    expect(getProvider('mpesa')).toBeInstanceOf(SimulatedProvider)
  })

  it('http (not https) callback base → not selectable', () => {
    setDarajaEnv({ DARAJA_CALLBACK_BASE: 'http://cb.example' })
    expect(getDarajaProvider()).toBeNull()
  })

  it('complete env → DarajaProvider, for method mpesa only', () => {
    setDarajaEnv()
    expect(getProvider('mpesa')).toBeInstanceOf(DarajaProvider)
    expect(getProvider('bank')).toBeInstanceOf(SimulatedProvider)
    expect(getProvider('bank').id).toBe('bank')
    expect(getProvider('wallet')).toBeInstanceOf(EscrowWalletProvider)
    // unknown method → the SIMULATED mpesa rail, never the env-gated real one
    expect(getProvider('does-not-exist')).toBeInstanceOf(SimulatedProvider)
    expect(getProvider('does-not-exist').id).toBe('mpesa')
  })

  it('DARAJA_ENV=production → production base + honest production labels', async () => {
    setDarajaEnv({ DARAJA_ENV: 'production' })
    const config = darajaConfigFromEnv()
    expect(config?.baseUrl).toBe('https://api.safaricom.co.ke')
    const provider = getProvider('mpesa')
    expect(provider).toBeInstanceOf(DarajaProvider)
    expect(provider?.label).toContain('production')
    expect(provider?.integrationNote).toContain('NOT a licensed integration')
    stubFetch()
    const result = await provider?.initiatePayment(INITIATION)
    expect(result?.simulated).toBe(false) // production rail would be real money
  })

  it('sandbox config keeps honest simulated: true on results', async () => {
    setDarajaEnv()
    stubFetch()
    const result = await getDarajaProvider()?.initiatePayment(INITIATION)
    expect(result?.simulated).toBe(true)
    expect(getDarajaProvider()?.integrationNote).toContain('no real money')
  })
})

// ---------------------------------------------------------------- OAuth

describe('Daraja OAuth — token fetch, cache, one 401 refresh', () => {
  beforeEach(() => setDarajaEnv())

  it('authenticates with Basic base64(consumerKey:consumerSecret) on the generate endpoint', async () => {
    stubFetch()
    await getDarajaProvider()?.initiatePayment(INITIATION)
    const oauthCalls = callsTo('/oauth/')
    expect(oauthCalls).toHaveLength(1)
    expect(String(oauthCalls[0][0])).toContain('/oauth/v1/generate?grant_type=client_credentials')
    const expectedBasic = Buffer.from(
      `${ENV.DARAJA_CONSUMER_KEY}:${ENV.DARAJA_CONSUMER_SECRET}`,
    ).toString('base64')
    expect((oauthCalls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe(
      `Basic ${expectedBasic}`,
    )
  })

  it('second initiate within the TTL does NOT re-fetch the token', async () => {
    stubFetch()
    const provider = getDarajaProvider()
    await provider?.initiatePayment(INITIATION)
    await provider?.initiatePayment({ ...INITIATION, reference: 'PR-2026-000002' })
    expect(callsTo('/oauth/')).toHaveLength(1)
    expect(callsTo('/mpesa/stkpush/v1/processrequest')).toHaveLength(2)
  })

  it('expires_in smaller than the 60s safety margin expires immediately → token re-fetched', async () => {
    stubFetch([
      { match: '/oauth/', respond: () => oauthBody('tok-1', '30') },
      { match: '/mpesa/stkpush/v1/processrequest', respond: () => STK_OK() },
    ])
    const provider = getDarajaProvider()
    await provider?.initiatePayment(INITIATION)
    await provider?.initiatePayment(INITIATION)
    expect(callsTo('/oauth/')).toHaveLength(2)
  })

  it('401 from the API → exactly ONE token refresh, request retried once, succeeds', async () => {
    let oauthCount = 0
    stubFetch([
      { match: '/oauth/', respond: () => oauthBody(`tok-${++oauthCount}`, '3599') },
      {
        match: '/mpesa/stkpush/v1/processrequest',
        respond: (n) => (n === 1 ? new Response('', { status: 401 }) : STK_OK()),
      },
    ])
    const result = await getDarajaProvider()?.initiatePayment(INITIATION)
    expect(callsTo('/oauth/')).toHaveLength(2)
    const stkCalls = callsTo('/mpesa/stkpush/v1/processrequest')
    expect(stkCalls).toHaveLength(2)
    expect((stkCalls[1][1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok-2')
    expect(result?.status).toBe('pending')
  })

  it('OAuth failure (HTTP 500) → honest failed result, no API call, no credential leak', async () => {
    stubFetch([{ match: '/oauth/', respond: () => new Response('boom', { status: 500 }) }])
    const result = await getDarajaProvider()?.initiatePayment(INITIATION)
    expect(result?.status).toBe('failed')
    expect(result?.detail).toContain('authentication failed')
    expect(result?.detail).not.toContain(ENV.DARAJA_CONSUMER_KEY)
    expect(result?.detail).not.toContain('https://sandbox')
    expect(callsTo('/mpesa/stkpush/')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- STK push

describe('initiatePayment — STK push shape + honest pending result', () => {
  beforeEach(() => setDarajaEnv())

  it('sends the documented payload; Password = base64(shortcode + passkey + Timestamp)', async () => {
    stubFetch()
    await getDarajaProvider()?.initiatePayment(INITIATION)
    const stkCalls = callsTo('/mpesa/stkpush/v1/processrequest')
    expect(stkCalls).toHaveLength(1)
    const init = stkCalls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
    expect(init.signal).toBeTruthy() // AbortSignal.timeout — a stuck API can never hang us
    const body = bodyOfCall(stkCalls[0])
    expect(body.BusinessShortCode).toBe(SHORTCODE)
    expect(body.Timestamp).toMatch(/^\d{14}$/)
    expect(body.Password).toBe(darajaPassword({ shortcode: SHORTCODE, passkey: PASSKEY } as never, body.Timestamp as string))
    // the password is literally the base64 of shortcode+passkey+timestamp
    expect(Buffer.from(body.Password as string, 'base64').toString('utf8')).toBe(
      `${SHORTCODE}${PASSKEY}${body.Timestamp}`,
    )
    expect(body.TransactionType).toBe('CustomerPayBillOnline')
    expect(body.Amount).toBe(1500)
    expect(body.PartyA).toBe('254708374149')
    expect(body.PartyB).toBe(SHORTCODE)
    expect(body.PhoneNumber).toBe('254708374149')
    expect(body.AccountReference).toBe('PR-2026-000001')
    expect(typeof body.TransactionDesc).toBe('string')
  })

  it('CallBackURL is the public base + /api/webhooks/daraja/ + the derived secret segment', async () => {
    stubFetch()
    await getDarajaProvider()?.initiatePayment(INITIATION)
    const body = bodyOfCall(callsTo('/mpesa/stkpush/v1/processrequest')[0])
    expect(body.CallBackURL).toBe(CALLBACK_URL)
    expect(String(body.CallBackURL)).toContain(darajaWebhookSegment(ENV.DARAJA_WEBHOOK_SECRET))
    expect(String(body.CallBackURL)).not.toContain(ENV.DARAJA_WEBHOOK_SECRET)
  })

  it('accepted push → pending with the CheckoutRequestID as providerRef (STK is async)', async () => {
    stubFetch()
    const result = await getDarajaProvider()?.initiatePayment(INITIATION)
    expect(result?.status).toBe('pending')
    expect(result?.providerRef).toBe(CHECKOUT)
    expect(result?.detail).toContain('awaiting')
    expect(result?.detail.toLowerCase()).not.toContain('password')
  })

  it('normalizes 07… / 7… / 254… payees to a 254 MSISDN', async () => {
    stubFetch()
    await getDarajaProvider()?.initiatePayment({ ...INITIATION, payee: '0708374149' })
    expect(bodyOfCall(callsTo('/mpesa/stkpush/v1/processrequest')[0]).PartyA).toBe('254708374149')
    expect(msisdnFromPayee('708374149')).toBe('254708374149')
    expect(msisdnFromPayee('254708374149')).toBe('254708374149')
    expect(msisdnFromPayee('+254 708 374 149')).toBe('254708374149')
    expect(msisdnFromPayee('Jane Contractor')).toBeNull()
  })

  it('non-phone payee → honest failed BEFORE any HTTP call (no oauth fetch either)', async () => {
    stubFetch()
    const result = await getDarajaProvider()?.initiatePayment({ ...INITIATION, payee: 'Jane Contractor' })
    expect(result?.status).toBe('failed')
    expect(result?.detail).toContain('MSISDN')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fractional amount → honest failed (no silent rounding on money)', async () => {
    stubFetch()
    const result = await getDarajaProvider()?.initiatePayment({ ...INITIATION, amount: 1500.5 })
    expect(result?.status).toBe('failed')
    expect(result?.detail).toContain('whole-shilling')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ResponseCode != 0 → failed with the provider description, no success claim', async () => {
    stubFetch([
      { match: '/oauth/', respond: () => oauthBody('tok-1', '3599') },
      {
        match: '/mpesa/stkpush/v1/processrequest',
        respond: () =>
          new Response(
            JSON.stringify({ ResponseCode: '1', ResponseDescription: 'Rejected: amount above daily limit' }),
            { status: 200 },
          ),
      },
    ])
    const result = await getDarajaProvider()?.initiatePayment(INITIATION)
    expect(result?.status).toBe('failed')
    expect(result?.detail).toContain('ResponseCode 1')
  })

  it('network TypeError → failed, leak-free (error class only, no URLs/secrets)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed https://sandbox.safaricom.co.ke/secret'))
    const result = await getDarajaProvider()?.initiatePayment(INITIATION)
    expect(result?.status).toBe('failed')
    expect(result?.detail).toContain('unreachable')
    expect(result?.detail).not.toContain('safaricom')
    expect(result?.detail).not.toContain(ENV.DARAJA_CONSUMER_SECRET)
  })

  it('timeout (TimeoutError DOMException) → failed with the honest 10s line', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted', 'TimeoutError'))
    const result = await getDarajaProvider()?.initiatePayment(INITIATION)
    expect(result?.status).toBe('failed')
    expect(result?.detail).toContain('timed out after 10s')
  })
})

// ---------------------------------------------------------------- verify

describe('verifyPayment — ResultCode mappings (query API)', () => {
  beforeEach(() => setDarajaEnv())

  const queryResult = (json: unknown, status = 200) => [
    { match: '/oauth/', respond: () => oauthBody('tok-1', '3599') },
    { match: '/mpesa/stkpushquery/', respond: () => new Response(JSON.stringify(json), { status }) },
  ]

  it("ResultCode 0 → succeeded", async () => {
    stubFetch(queryResult({ ResultCode: '0', ResultDesc: 'The service request is processed successfully.' }))
    const r = await getDarajaProvider()?.verifyPayment(CHECKOUT)
    expect(r?.status).toBe('succeeded')
    expect(r?.providerRef).toBe(CHECKOUT)
    // the query request itself carries the password fields
    const body = bodyOfCall(callsTo('/mpesa/stkpushquery/')[0])
    expect(body.CheckoutRequestID).toBe(CHECKOUT)
    expect(body.BusinessShortCode).toBe(SHORTCODE)
    expect(Buffer.from(body.Password as string, 'base64').toString('utf8')).toBe(
      `${SHORTCODE}${PASSKEY}${body.Timestamp}`,
    )
  })

  it('ResultCode 1032 → failed (user cancelled)', async () => {
    stubFetch(queryResult({ ResultCode: '1032', ResultDesc: 'Request cancelled by user' }))
    const r = await getDarajaProvider()?.verifyPayment(CHECKOUT)
    expect(r?.status).toBe('failed')
    expect(r?.detail).toContain('1032')
    expect(r?.detail).toContain('cancelled')
  })

  it('ResultCode 1037 → failed (customer unreachable)', async () => {
    stubFetch(queryResult({ ResultCode: '1037', ResultDesc: 'DS timeout user cannot be reached' }))
    const r = await getDarajaProvider()?.verifyPayment(CHECKOUT)
    expect(r?.status).toBe('failed')
    expect(r?.detail).toContain('1037')
  })

  it('ResultCode 1 → failed (insufficient balance)', async () => {
    stubFetch(queryResult({ ResultCode: '1', ResultDesc: 'The balance is insufficient' }))
    const r = await getDarajaProvider()?.verifyPayment(CHECKOUT)
    expect(r?.status).toBe('failed')
  })

  it('unmapped ResultCode → pending, NEVER succeeded (fail closed on money)', async () => {
    stubFetch(queryResult({ ResultCode: '4242', ResultDesc: 'Something novel' }))
    const r = await getDarajaProvider()?.verifyPayment(CHECKOUT)
    expect(r?.status).toBe('pending')
    expect(r?.detail).toContain('4242')
  })

  it('HTTP 500 + errorCode 500.001.1001 → pending (Daraja\u2019s "still processing")', async () => {
    stubFetch(
      queryResult({ errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' }, 500),
    )
    const r = await getDarajaProvider()?.verifyPayment(CHECKOUT)
    expect(r?.status).toBe('pending')
    expect(r?.detail).toContain('processing')
  })

  it('2xx without a ResultCode → honest pending, not success', async () => {
    stubFetch(queryResult({ ResponseCode: '0', ResponseDescription: 'accepted' }))
    const r = await getDarajaProvider()?.verifyPayment(CHECKOUT)
    expect(r?.status).toBe('pending')
  })
})

// ---------------------------------------------------------------- refund

describe('refund — reversal request (separate credentials)', () => {
  beforeEach(() => setDarajaEnv())

  it('reversal creds unset → honest failed, no HTTP call, says what is missing', async () => {
    stubFetch()
    const r = await getDarajaProvider()?.refund(CHECKOUT, 1500)
    expect(r?.status).toBe('failed')
    expect(r?.detail).toContain('DARAJA_INITIATOR_NAME')
    expect(r?.detail).toContain('DARAJA_SECURITY_CREDENTIAL')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creds set → sandbox-shaped reversal POST, honest pending (async result callback)', async () => {
    setDarajaEnv({ DARAJA_INITIATOR_NAME: 'testapi496', DARAJA_SECURITY_CREDENTIAL: 'test-credential' })
    stubFetch()
    const r = await getDarajaProvider()?.refund(CHECKOUT, 1500)
    const reversal = callsTo('/mpesa/reversal/v1/request')
    expect(reversal).toHaveLength(1)
    const body = bodyOfCall(reversal[0])
    expect(body.CommandID).toBe('TransactionReversal')
    expect(body.InitiatorName).toBe('testapi496')
    expect(body.SecurityCredential).toBe('test-credential')
    expect(body.TransactionID).toBe(CHECKOUT)
    expect(body.Amount).toBe(1500)
    expect(body.RecieverIdentifierType).toBe('11') // Safaricom's own misspelling, kept verbatim
    expect(String(body.ResultURL)).toBe(CALLBACK_URL)
    expect(r?.status).toBe('pending') // honest: the reversal RESULT is an async callback
    expect(r?.detail).toContain('ResultURL')
  })
})

// --------------------------------------------- payPaymentRequest pending path

describe('payPaymentRequest with a pending provider initiation', () => {
  it('records the intent, throws honestly, posts NO money, request stays approved', async () => {
    setDarajaEnv()
    stubFetch()
    seedPaymentRequest()
    await expect(
      payPaymentRequest('proj-1', { id: PR_ID, method: 'mpesa', paidBy: 'Finance Fox', paidByRole: 'finance' }),
    ).rejects.toThrow(/PENDING customer confirmation/i)
    // intent row recorded under daraja.intent:<CheckoutRequestID>
    const intentRow = state.idempotency.get(`${DARAJA_INTENT_KEY_PREFIX}${CHECKOUT}`)
    expect(intentRow).toBeTruthy()
    const intent = JSON.parse((intentRow as { responseBody: string }).responseBody) as DarajaIntentPayload
    expect(intent.paymentRequestId).toBe(PR_ID)
    expect(intent.initiatedBy).toBe('Finance Fox')
    expect(intent.providerRef).toBe(CHECKOUT)
    // money untouched: no ledger txn, request still approved, no notification
    expect(state.txns.size).toBe(0)
    expect(state.paymentRequests.get(PR_ID)?.status).toBe('approved')
    expect(notify).not.toHaveBeenCalled()
    // issue #34: the pending path also seeds a delayed wallet.reconcile sweep
    // job (drained by the /api/jobs/run scheduler cycle) — one queued row,
    // due ~2 min out (the default DARAJA_RECONCILE_AFTER_MIN).
    const sweepRows = [...state.jobs.values()].filter((j) => j.type === 'wallet.reconcile')
    expect(sweepRows).toHaveLength(1)
    expect(sweepRows[0].status).toBe('queued')
    expect((sweepRows[0].runAt as Date).getTime()).toBeGreaterThan(Date.now())
  })
})

// ---------------------------------------------------------------- callbacks

describe('processDarajaStkCallback — dedupe, verification, completion', () => {
  beforeEach(() => {
    setDarajaEnv()
    stubFetch()
    seedPaymentRequest()
    seedIntent()
  })

  it('verified success → ONE balanced ledger post via the ledger module, request paid, notification sent', async () => {
    const outcome = await processDarajaStkCallback(callbackBody())
    expect(outcome.action).toBe('credited')
    expect(state.txns.size).toBe(1)
    const lines = postedLines()
    expect(lines).toHaveLength(2)
    expect(lines).toContainEqual({ side: 'debit', amount: 1500, code: 'EXPENSE:proj-1', memo: null })
    expect(lines).toContainEqual({ side: 'credit', amount: 1500, code: 'CASH_MPESA', memo: null })
    const pr = state.paymentRequests.get(PR_ID) as Record<string, unknown>
    expect(pr.status).toBe('paid')
    expect(pr.paidAt).toBeTruthy()
    expect(pr.paidTxnId).toBeTruthy()
    // legacy Transaction row linked to the ledger txn
    expect(state.transactions.size).toBe(1)
    expect([...state.transactions.values()][0].ledgerTxnId).toBe([...state.txns.keys()][0])
    // durable dedupe record written
    expect(state.idempotency.has(`${DARAJA_CALLBACK_KEY_PREFIX}${CHECKOUT}`)).toBe(true)
    // the query API was actually called for reconciliation
    expect(callsTo('/mpesa/stkpushquery/')).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(1)
    const notifyArgs = (notify as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(notifyArgs[0]).toBe('proj-1')
    expect(String(notifyArgs[2])).toContain('verified')
  })

  it('duplicate callback (same CheckoutRequestID) → no second post, honest duplicate', async () => {
    await processDarajaStkCallback(callbackBody())
    const outcome = await processDarajaStkCallback(callbackBody())
    expect(outcome.action).toBe('duplicate')
    expect(state.txns.size).toBe(1)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('durable record lost + request payable again → ledger idempotency key returns the ORIGINAL txn (no double post)', async () => {
    await processDarajaStkCallback(callbackBody())
    // simulate the race state: the dedupe record write failed after the
    // commit and the request is still approved from this caller's view
    state.idempotency.delete(`${DARAJA_CALLBACK_KEY_PREFIX}${CHECKOUT}`)
    resetDarajaCallbackStateForTests()
    ;(state.paymentRequests.get(PR_ID) as Record<string, unknown>).status = 'approved'
    const outcome = await processDarajaStkCallback(callbackBody())
    expect(outcome.action).toBe('credited') // idempotent replay of the same ledger txn
    expect(state.txns.size).toBe(1)
    expect([...state.entries.values()].filter((e) => e.side === 'debit').length).toBe(1)
  })

  it('ResultCode != 0 → ignored, no post, request stays approved', async () => {
    const outcome = await processDarajaStkCallback(callbackBody({}, 1032))
    expect(outcome.action).toBe('ignored')
    expect(outcome.detail).toContain('1032')
    expect(state.txns.size).toBe(0)
    expect(state.paymentRequests.get(PR_ID)?.status).toBe('approved')
    expect(fetchMock).not.toHaveBeenCalled() // no query for a failed result
  })

  it('callback says 0 but the query API says failed → unverified, no post', async () => {
    stubFetch([
      { match: '/oauth/', respond: () => oauthBody('tok-1', '3599') },
      { match: '/mpesa/stkpushquery/', respond: () => new Response(JSON.stringify({ ResultCode: '1032', ResultDesc: 'Request cancelled by user' }), { status: 200 }) },
    ])
    const outcome = await processDarajaStkCallback(callbackBody())
    expect(outcome.action).toBe('unverified')
    expect(outcome.detail).toContain('failed')
    expect(state.txns.size).toBe(0)
    expect(state.paymentRequests.get(PR_ID)?.status).toBe('approved')
  })

  it('no pending intent (unknown CheckoutRequestID) → ignored, never an invented credit', async () => {
    const outcome = await processDarajaStkCallback({
      Body: { stkCallback: { CheckoutRequestID: 'ws_CO_UNKNOWN', ResultCode: 0, ResultDesc: 'success' } },
    })
    expect(outcome.action).toBe('ignored')
    expect(outcome.detail).toContain('No pending provider intent')
    expect(state.txns.size).toBe(0)
  })

  it('already-paid request → honest skip, no second post', async () => {
    seedPaymentRequest({ status: 'paid', paidAt: new Date(), paidTxnId: 'tx_old' })
    const outcome = await processDarajaStkCallback(callbackBody())
    expect(outcome.action).toBe('ignored')
    expect(outcome.detail).toContain('already paid')
    expect(state.txns.size).toBe(0)
  })

  it('Daraja env unset → unverified (provider cannot verify), no post, no fetch', async () => {
    for (const k of ENV_KEYS) delete process.env[k]
    const outcome = await processDarajaStkCallback(callbackBody())
    expect(outcome.action).toBe('unverified')
    expect(outcome.detail).toContain('not configured')
    expect(state.txns.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('non-stkCallback body (e.g. a reversal Result) → honestly ignored', async () => {
    const outcome = await processDarajaStkCallback({ Body: { Result: { ResultCode: 0 } } })
    expect(outcome.action).toBe('ignored')
    expect(state.txns.size).toBe(0)
  })

  it('notify failing after the post never masks the credited outcome', async () => {
    ;(notify as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('notify channel exploded')
    })
    const outcome = await processDarajaStkCallback(callbackBody())
    expect(outcome.action).toBe('credited')
    expect(state.txns.size).toBe(1)
  })

  it('callback metadata amount differing from the approved amount still posts the APPROVED amount', async () => {
    const body = callbackBody()
    ;((body.Body.stkCallback as Record<string, unknown>).CallbackMetadata as { Item: { Name: string; Value: number }[] }).Item[0].Value = 999
    const outcome = await processDarajaStkCallback(body)
    expect(outcome.action).toBe('credited')
    const lines = postedLines()
    expect(lines.find((l) => l.code === 'EXPENSE:proj-1')?.amount).toBe(1500)
  })
})

// ---------------------------------------------------------------- route

describe('webhook routes', () => {
  beforeEach(() => {
    setDarajaEnv()
    stubFetch()
    seedPaymentRequest()
    seedIntent()
  })

  function secretReq(body: string, headers: Record<string, string> = {}, secret: string = SEGMENT) {
    return new NextRequest(`http://localhost/api/webhooks/daraja/${secret}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...headers },
      body,
    })
  }
  const ctx = (secret: string = SEGMENT) => ({ params: Promise.resolve({ secret }) })
  /** POST with the default secret path (ctx resolved like Next 16 does). */
  const post = (body: string, headers: Record<string, string> = {}, secret: string = SEGMENT) =>
    secretPathPost(secretReq(body, headers, secret), ctx(secret))
  const jsonOf = async (res: { json: () => Promise<unknown> }) => (await res.json()) as Record<string, unknown>

  it('wrong secret segment → 404, nothing processed (no query fetch, no ledger)', async () => {
    const res = await secretPathPost(secretReq(JSON.stringify(callbackBody()), {}, 'deadbeef'), ctx('deadbeef'))
    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.txns.size).toBe(0)
  })

  it('correct secret + verified success → 200 credited with one balanced post', async () => {
    const res = await secretPathPost(secretReq(JSON.stringify(callbackBody())), ctx())
    expect(res.status).toBe(200)
    const body = await jsonOf(res)
    expect(body.action).toBe('credited')
    expect(body.ok).toBe(true)
    expect(state.txns.size).toBe(1)
  })

  it('duplicate callback via the route → 200 duplicate, ledger untouched', async () => {
    await secretPathPost(secretReq(JSON.stringify(callbackBody())), ctx())
    const res = await secretPathPost(secretReq(JSON.stringify(callbackBody())), ctx())
    expect(res.status).toBe(200)
    expect((await jsonOf(res)).action).toBe('duplicate')
    expect(state.txns.size).toBe(1)
  })

  it('malformed JSON → 400 (honest, no processing)', async () => {
    const res = await secretPathPost(secretReq('not-json{'), ctx())
    expect(res.status).toBe(400)
    expect(state.txns.size).toBe(0)
  })

  it('MUTATION_ORIGIN_ALLOWLIST set + foreign browser Origin → 403', async () => {
    process.env.MUTATION_ORIGIN_ALLOWLIST = 'https://app.example'
    const res = await post(JSON.stringify(callbackBody()), { origin: 'http://evil.example' })
    expect(res.status).toBe(403)
    expect(state.txns.size).toBe(0)
  })

  it('no Origin header (Safaricom server-to-server) → passes the origin gate', async () => {
    process.env.MUTATION_ORIGIN_ALLOWLIST = 'https://app.example'
    const res = await post(JSON.stringify(callbackBody()))
    expect(res.status).toBe(200)
    expect((await jsonOf(res)).action).toBe('credited')
  })

  it('DARAJA_WEBHOOK_SECRET unset → every segment 404s (fail closed)', async () => {
    delete process.env.DARAJA_WEBHOOK_SECRET
    const res = await post(JSON.stringify(callbackBody()))
    expect(res.status).toBe(404)
    expect(state.txns.size).toBe(0)
  })

  it('GET on the fixed path → honest machine-readable contract', async () => {
    const res = await docsGet()
    expect(res.status).toBe(200)
    const body = await jsonOf(res)
    expect(body.ok).toBe(true)
    expect(String(body.endpoint)).toContain('/api/webhooks/daraja/{secret-path-segment}')
    expect(JSON.stringify(body.security)).toContain('reconciliation')
  })

  it('POST on the fixed (secret-less) path → honest 400, never money', async () => {
    const res = await fixedPathPost(
      new NextRequest('http://localhost/api/webhooks/daraja', { method: 'POST', body: '{}' }),
    )
    expect(res.status).toBe(400)
    expect(String((await jsonOf(res)).error)).toContain('secret path')
    expect(state.txns.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
