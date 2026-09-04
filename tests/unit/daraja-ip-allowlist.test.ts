/**
 * Source-IP allowlisting for the Daraja webhook (issue #35)
 * (src/backend/modules/wallet/ip-allowlist.ts + the gate in
 * src/app/api/webhooks/daraja/[secret]/route.ts).
 *
 * Pure CIDR-matching edge cases first (no env, no db): IPv4 parse strictness,
 * mask math, boundary addresses, wrong-mask misses, bare-IP = /32, /0, IPv6
 * EXACT-literal matching (and IPv6 CIDR rejection), invalid-entry
 * ignore-with-report, and the empty-allowlist fail-closed contract.
 *
 * Then the ROUTE gate, pinned with the mpesa-daraja.test.ts stub pattern
 * (in-memory db, notify mocked, global fetch stubbed, env saved/restored):
 * unset env = the current posture unchanged; set+match = pass; set+no-match
 * = 403 BEFORE the body is parsed (a malformed body under a non-matching IP
 * 403s instead of 400-ing); unresolvable IP = 403; zero-valid-entries =
 * deny-all; invalid entries ignored while valid ones still apply; TRUST_PROXY
 * flips which x-forwarded-for hop is the client.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub (mpesa-daraja.test.ts pattern) — the 403 paths never
// touch the db, the one 200 path reuses the full callback machinery.
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
      return rows.find((r) => (!where.id || r.id === where.id) && (!where.status || r.status === where.status)) ?? null
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
    async findMany() {
      return [...state.idempotency.values()].map((r) => ({ ...r }))
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
      const j: Record<string, unknown> = { id: nid('job'), ...data }
      state.jobs.set(j.id as string, j)
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
import { darajaWebhookSegment, resetDarajaProviderCacheForTests } from '@/backend/modules/wallet/daraja'
import {
  DARAJA_INTENT_KEY_PREFIX,
  resetDarajaCallbackStateForTests,
  type DarajaIntentPayload,
} from '@/backend/modules/wallet/daraja-callback'
import {
  ipAllowed,
  ipv4Mask,
  parseIpAllowlist,
  parseIpAllowlistEntry,
  parseIpv4,
} from '@/backend/modules/wallet/ip-allowlist'
import { POST as secretPathPost } from '@/app/api/webhooks/daraja/[secret]/route'

const state = (db as unknown as { __state: { txns: Map<string, Record<string, unknown>>; idempotency: Map<string, Record<string, unknown>>; paymentRequests: Map<string, Record<string, unknown>>; reset: () => void } }).__state

// ---------------------------------------------------------------- fixtures

const WEBHOOK_SECRET = 'test-webhook-secret'
const SEGMENT = darajaWebhookSegment(WEBHOOK_SECRET)
const CHECKOUT = 'ws_CO_IP_0001'
const PR_ID = 'pr_ip_1'
const fetchMock = vi.fn()

const ENV_KEYS = [
  'DARAJA_ENV', 'DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_SHORTCODE',
  'DARAJA_PASSKEY', 'DARAJA_CALLBACK_BASE', 'DARAJA_WEBHOOK_SECRET',
  'DARAJA_ALLOWED_IPS', 'TRUST_PROXY', 'MUTATION_ORIGIN_ALLOWLIST',
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
    DARAJA_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...overrides,
  }
  for (const [k, v] of Object.entries(base)) if (v !== '') process.env[k] = v
}

const QUERY_OK = () =>
  new Response(
    JSON.stringify({
      ResponseCode: '0', CheckoutRequestID: CHECKOUT,
      ResultCode: '0', ResultDesc: 'The service request is processed successfully.',
    }),
    { status: 200 },
  )

function stubFetch() {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url: string })?.url ?? input)
    if (url.includes('/oauth/')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: '3599' }), { status: 200 })
    }
    if (url.includes('/mpesa/stkpushquery/')) return QUERY_OK()
    throw new Error(`test: unexpected fetch ${url}`)
  })
}

function seedCallbackFixtures() {
  state.paymentRequests.set(PR_ID, {
    id: PR_ID, requestCode: 'PR-2026-000009', projectId: 'proj-1',
    description: 'Allowlist fixture payment', amount: 1500,
    payee: '254708374149', method: 'mpesa', status: 'approved',
    paidAt: null, paidTxnId: null,
  })
  const intent: DarajaIntentPayload = {
    kind: 'payment.request', paymentRequestId: PR_ID, requestCode: 'PR-2026-000009',
    projectId: 'proj-1', amount: 1500, payee: '254708374149', method: 'mpesa',
    reference: 'PR-2026-000009', providerRef: CHECKOUT,
    initiatedBy: 'Finance Fox', initiatedByRole: 'finance',
  }
  state.idempotency.set(`${DARAJA_INTENT_KEY_PREFIX}${CHECKOUT}`, {
    key: `${DARAJA_INTENT_KEY_PREFIX}${CHECKOUT}`, scope: 'payment.provider_intent',
    projectId: 'proj-1', responseBody: JSON.stringify(intent), createdAt: new Date(),
  })
}

function callbackBody() {
  return {
    Body: {
      stkCallback: {
        CheckoutRequestID: CHECKOUT, ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
      },
    },
  }
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

// ---------------------------------------------------------------- pure module

describe('ip-allowlist — pure IPv4/CIDR matching', () => {
  it('parses strict dotted quads and rejects malformed IPv4', () => {
    expect(parseIpv4('196.201.214.9')).not.toBeNull()
    expect(parseIpv4(' 196.201.214.9 ')).not.toBeNull() // trimmed
    expect(parseIpv4('196.201.214.9 ')).not.toBeNull()
    expect(parseIpv4('256.0.0.1')).toBeNull() // octet > 255
    expect(parseIpv4('1.2.3')).toBeNull() // too few octets
    expect(parseIpv4('1.2.3.4.5')).toBeNull() // too many
    expect(parseIpv4('a.b.c.d')).toBeNull()
    expect(parseIpv4('')).toBeNull()
    expect(parseIpv4('1.2.3.-4')).toBeNull()
  })

  it('computes netmasks for prefix lengths 0, 24, 32 and rejects 33/-1', () => {
    expect(ipv4Mask(0)).toBe(0n)
    expect(ipv4Mask(24)).toBe(0xffffff00n)
    expect(ipv4Mask(32)).toBe(0xffffffffn)
    expect(ipv4Mask(33)).toBeNull()
    expect(ipv4Mask(-1)).toBeNull()
  })

  it('normalizes host bits out of a CIDR entry (196.201.214.5/24 ≡ .0/24)', () => {
    const entry = parseIpAllowlistEntry('196.201.214.5/24')
    expect(entry?.kind).toBe('ipv4-cidr')
    if (entry?.kind === 'ipv4-cidr') {
      expect((entry.net & entry.mask) === entry.net).toBe(true)
      expect(ipAllowed('196.201.214.7', [entry])).toBe(true)
    }
  })

  it('a bare IPv4 entry is an exact /32', () => {
    const entry = parseIpAllowlistEntry('196.201.214.34')
    expect(entry?.kind).toBe('ipv4-cidr')
    expect(ipAllowed('196.201.214.34', [entry!])).toBe(true)
    expect(ipAllowed('196.201.214.35', [entry!])).toBe(false)
  })

  it('rejects malformed CIDRs: /33, non-numeric mask, trailing slash, garbage', () => {
    expect(parseIpAllowlistEntry('196.201.214.0/33')).toBeNull()
    expect(parseIpAllowlistEntry('196.201.214.0/abc')).toBeNull()
    expect(parseIpAllowlistEntry('196.201.214.0/')).toBeNull()
    expect(parseIpAllowlistEntry('196.201.214.0/024')).toBeNull() // 3-digit mask stays strict
    expect(parseIpAllowlistEntry('not-an-ip')).toBeNull()
    expect(parseIpAllowlistEntry('')).toBeNull()
    expect(parseIpAllowlistEntry('1.2.3.4/24/8')).toBeNull()
  })

  it('IPv6 entries are exact-literal (lowercased) — CIDR for IPv6 is unsupported', () => {
    const v6 = parseIpAllowlistEntry('2001:DB8::1')
    expect(v6?.kind).toBe('ipv6-exact')
    if (v6?.kind === 'ipv6-exact') {
      expect(v6.literal).toBe('2001:db8::1')
      expect(ipAllowed('2001:db8::1', [v6])).toBe(true)
      expect(ipAllowed('2001:DB8::1', [v6])).toBe(true) // request side lowercased too
      expect(ipAllowed('2001:db8::2', [v6])).toBe(false)
      expect(ipAllowed('196.201.214.1', [v6])).toBe(false) // never matches an IPv4 request
    }
    expect(parseIpAllowlistEntry('2001:db8::/32')).toBeNull() // IPv6 CIDR rejected, not mis-parsed
    expect(parseIpAllowlistEntry('a:b')).toBeNull() // single colon is not an IPv6 literal
    expect(parseIpAllowlistEntry('zz::1')).toBeNull()
  })

  it('parseIpAllowlist: comma-separated, blank = unset, invalid entries reported', () => {
    const one = parseIpAllowlist('196.201.214.0/24, 10.0.0.5 , oops')
    expect(one.entries).toHaveLength(2)
    expect(one.invalid).toEqual(['oops'])
    expect(parseIpAllowlist('')).toEqual({ entries: [], invalid: [] })
    expect(parseIpAllowlist(undefined)).toEqual({ entries: [], invalid: [] })
    expect(parseIpAllowlist('   ')).toEqual({ entries: [], invalid: [] })
    const allBad = parseIpAllowlist('nope, 1.2.3.4/99')
    expect(allBad.entries).toHaveLength(0)
    expect(allBad.invalid).toHaveLength(2)
  })

  it('ipAllowed: /24 boundaries match, adjacent network misses, /0 matches all IPv4', () => {
    const cidr = parseIpAllowlistEntry('196.201.214.0/24')!
    expect(ipAllowed('196.201.214.0', [cidr])).toBe(true) // network address
    expect(ipAllowed('196.201.214.255', [cidr])).toBe(true) // broadcast — both boundaries
    expect(ipAllowed('196.201.215.0', [cidr])).toBe(false) // wrong mask side
    expect(ipAllowed('196.201.213.255', [cidr])).toBe(false)
    const everything = parseIpAllowlistEntry('0.0.0.0/0')!
    expect(ipAllowed('196.201.214.9', [everything])).toBe(true)
    expect(ipAllowed('8.8.8.8', [everything])).toBe(true)
  })

  it('ipAllowed fails closed: empty (but active) allowlist, unresolvable or non-IP input', () => {
    expect(ipAllowed('196.201.214.9', [])).toBe(false)
    expect(ipAllowed('', [])).toBe(false)
    expect(ipAllowed(undefined, parseIpAllowlist('196.201.214.0/24').entries)).toBe(false)
    expect(ipAllowed('not-an-ip', parseIpAllowlist('196.201.214.0/24').entries)).toBe(false)
  })
})

// ---------------------------------------------------------------- route gate

describe('webhook route — DARAJA_ALLOWED_IPS gate', () => {
  function secretReq(body: string, headers: Record<string, string> = {}) {
    return new NextRequest(`http://localhost/api/webhooks/daraja/${SEGMENT}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...headers },
      body,
    })
  }
  const ctx = () => ({ params: Promise.resolve({ secret: SEGMENT }) })
  const jsonOf = async (res: { json: () => Promise<unknown> }) => (await res.json()) as Record<string, unknown>
  const post = (body: string, headers: Record<string, string> = {}) =>
    secretPathPost(secretReq(body, headers), ctx())

  beforeEach(() => {
    setDarajaEnv()
    stubFetch()
    seedCallbackFixtures()
  })

  it('env unset → the current posture: valid callback credits (no IP filtering)', async () => {
    const res = await post(JSON.stringify(callbackBody()), { 'x-forwarded-for': '203.0.113.9' })
    expect(res.status).toBe(200)
    expect((await jsonOf(res)).action).toBe('credited')
    expect(state.txns.size).toBe(1)
  })

  it('set + matching CIDR → passes and credits', async () => {
    process.env.DARAJA_ALLOWED_IPS = '196.201.214.0/24'
    const res = await post(JSON.stringify(callbackBody()), { 'x-forwarded-for': '196.201.214.100' })
    expect(res.status).toBe(200)
    expect((await jsonOf(res)).action).toBe('credited')
    expect(state.txns.size).toBe(1)
  })

  it('set + non-matching IP → 403 generic body, nothing processed (fetch, ledger untouched)', async () => {
    process.env.DARAJA_ALLOWED_IPS = '196.201.214.0/24'
    const res = await post(JSON.stringify(callbackBody()), { 'x-forwarded-for': '203.0.113.9' })
    expect(res.status).toBe(403)
    const body = await jsonOf(res)
    expect(body.error).toBe('Source IP not permitted')
    expect(Object.keys(body)).toEqual(['error']) // generic — no config echo
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.txns.size).toBe(0)
    expect(state.paymentRequests.get(PR_ID)?.status).toBe('approved')
    expect(notify).not.toHaveBeenCalled()
  })

  it('403 happens BEFORE body parsing — a malformed body under a denied IP 403s, never 400s', async () => {
    process.env.DARAJA_ALLOWED_IPS = '196.201.214.0/24'
    const res = await post('not-json{', { 'x-forwarded-for': '203.0.113.9' })
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    // same malformed body from an ALLOWED source still parses and 400s honestly
    const res2 = await post('not-json{', { 'x-forwarded-for': '196.201.214.100' })
    expect(res2.status).toBe(400)
  })

  it('set but no x-forwarded-for at all → unresolvable IP → 403 (fail closed)', async () => {
    process.env.DARAJA_ALLOWED_IPS = '196.201.214.0/24'
    const res = await post(JSON.stringify(callbackBody()))
    expect(res.status).toBe(403)
    expect(state.txns.size).toBe(0)
  })

  it('set with only invalid entries → zero valid entries → deny all (fail closed, warned)', async () => {
    process.env.DARAJA_ALLOWED_IPS = 'not-an-ip, 1.2.3.4/99'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await post(JSON.stringify(callbackBody()), { 'x-forwarded-for': '196.201.214.100' })
    expect(res.status).toBe(403)
    expect(state.txns.size).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('2 invalid entries')
    warn.mockRestore()
  })

  it('invalid entries are ignored while valid entries still apply (mixed config)', async () => {
    process.env.DARAJA_ALLOWED_IPS = '196.201.214.0/24, oops'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await post(JSON.stringify(callbackBody()), { 'x-forwarded-for': '196.201.214.100' })
    expect(res.status).toBe(200)
    expect((await jsonOf(res)).action).toBe('credited')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('bare IPv4 entry (= /32) and exact IPv6 entry both work as entries', async () => {
    process.env.DARAJA_ALLOWED_IPS = '196.201.214.34,2001:db8::1'
    const res = await post(JSON.stringify(callbackBody()), { 'x-forwarded-for': '196.201.214.34' })
    expect(res.status).toBe(200)
    // reset the credited state so the second POST re-runs the full path
    const res2 = await post(JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: 'ws_CO_OTHER', ResultCode: 0 } } }), { 'x-forwarded-for': '2001:db8::1' })
    expect(res2.status).toBe(200) // unknown checkout → honest ignored, but the IP gate PASSED
    expect((await jsonOf(res2)).action).toBe('ignored')
    const res3 = await post(JSON.stringify(callbackBody()), { 'x-forwarded-for': '2001:db8::2' })
    expect(res3.status).toBe(403)
  })

  it('TRUST_PROXY flips the trusted x-forwarded-for hop (rightmost vs first)', async () => {
    process.env.DARAJA_ALLOWED_IPS = '196.201.214.0/24'
    const chain = { 'x-forwarded-for': '203.0.113.9, 196.201.214.100' }
    // unset (default): FIRST value — spoofable left value wins → denied
    const res = await post(JSON.stringify(callbackBody()), chain)
    expect(res.status).toBe(403)
    // set: RIGHTMOST value — the trusted proxy's view of the client → allowed
    process.env.TRUST_PROXY = '1'
    const res2 = await post(JSON.stringify(callbackBody()), chain)
    expect(res2.status).toBe(200)
  })
})
