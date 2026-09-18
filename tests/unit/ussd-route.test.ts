/**
 * POST/GET /api/ussd — the *384# Muster line (issues #105 BE-4 + #106 BE-9).
 *
 * Mirrors tests/unit/whatsapp-route.test.ts 1:1 (the sibling gateway seam):
 * same idioms, same db stub shape, applyAction stays REAL — the route
 * dispatches through the exact production path, and the audit rows prove the
 * worker actor + §43 request context. rate-limit (buckets AND the new
 * phone-keyed PIN lockout tracker) and audit stay real too. Fake timers
 * freeze the clock so the EAT "today" of the attendance appliers, the
 * token-bucket math and the 15-minute lockout window are all deterministic
 * (vi.advanceTimersByTime serves the lock without sleeping).
 *
 * Pinned here per the acceptance criteria:
 *   · BODY CAP (BE-4, issue #105): declared Content-Length beyond 64 KB is
 *     refused BEFORE the read; an actually-oversized body (> 64 KB of real
 *     bytes) is refused after the read; a lying small header over a big body
 *     is caught by the post-read count; a body AT the cap flows into the
 *     parser (honest menu/invalid-code reply, not a size error);
 *   · HMAC (USSD_WEBHOOK_SECRET): secret set + unsigned/mismatched
 *     X-Signature → 401 (timing-safe compare); correct hex HMAC of the RAW
 *     body → 200; unset → the open demo posture, now an EXPLICIT opt-in
 *     (issue #156: the fixtures set WEBHOOK_OPEN_POSTURE=1);
 *   · FAIL-CLOSED POSTURE (SEC-4 + issue #156): an unset secret refuses
 *     POST with 503 in EVERY runtime unless WEBHOOK_OPEN_POSTURE=1 opts
 *     into the open demo posture OUTSIDE production. Pinned: production +
 *     unset → 503 (the opt-in is IGNORED there); non-prod + unset + no
 *     opt-in → 503 before any processing (zero writes, zero audits, zero
 *     rate-limit consumption); non-prod + opt-in → open posture; secret
 *     set → the HMAC gate answers, never the 503 gate;
 *   · PIN THROTTLE: 20/min/phone and 40 PIN-attempts/min per client IP,
 *     429 + Retry-After. The per-IP key is trust-aware (issue #156): the
 *     fixtures run TRUST_PROXY=1 (distinct XFF values = distinct
 *     principals, keeping the per-test uniqueIp() bucket isolation
 *     honest), and a dedicated test pins the UNSET posture — rotating XFF
 *     values share the one anon bucket and cannot refresh it;
 *   · PIN LOCKOUT (BE-9, issue #106; REKEYED by issue #176/SEC-9): 5 wrong
 *     PINs per CLIENT-IP principal within 15 min → a 15-minute lock (the
 *     reply names the wait; correct PINs refused too, before any write);
 *     rotating phone numbers from one IP can no longer refresh the budget
 *     (AC1), and a correct PIN does not clear it either (the phone-tail
 *     refresh vehicle is closed). Kiosk-PIN attempts additionally carry a
 *     PER-WORKER lock (AC2): wrong PINs from a worker's own line accumulate
 *     on that worker regardless of phone/IP, a locked worker is refused from
 *     ANY phone, and a correct KIOSK pin clears the worker's own count
 *     (a phone-tail pin never clears anything);
 *   · PHONE-TAIL FALLBACK POLICY (BE-9 + issue #156): resolves ONLY in the
 *     explicitly opted-in open posture (secret unset +
 *     WEBHOOK_OPEN_POSTURE=1). Secret set → kiosk PIN only (the
 *     shared-secret posture, even with the opt-in env set); no opt-in →
 *     the route fails closed before any PIN resolution. Off by default.
 *   · every USSD text reply carries the sim footer.
 *
 * @/backend/lib/db is swapped for an in-memory stub (whatsapp-route.test
 * idioms — worker.findMany also honors `take` for the kiosk-PIN and
 * line-attribution lookups).
 */
import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    projects: new Map<string, Row>(),
    workers: new Map<string, Row>(),
    attendance: new Map<string, Row>(),
    audits: [] as Row[],
    /** Every mutating call (attendance create|update). */
    writes: 0,
    reset() {
      state.projects.clear()
      state.workers.clear()
      state.attendance.clear()
      state.audits = []
      state.writes = 0
      seed()
    },
  }

  function seed() {
    state.projects.set('p-1', {
      id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', location: 'Karen',
    })
    // w-1 carries a stored kiosk PIN; w-2 resolves ONLY via the phone-tail
    // demo fallback (pin: null); w-3 is inactive (active:false filter).
    // w-4/w-5/w-6 (issue #176) are dedicated kiosk-PIN workers for the
    // per-worker lockout pins — each lockout test owns its own worker, so the
    // (module-persistent, fake-clock) worker-keyed trackers never bleed a
    // lock state between tests: w-4 = the lock/refusal pins, w-5 = the
    // kiosk-clear pin, w-6 = the tail-never-clears pin.
    state.workers.set('w-1', {
      id: 'w-1', projectId: 'p-1', name: 'Kamau Mwangi', role: 'Fundi wa Mawe',
      phone: '0722111222', pin: '1234', dailyRate: 150000n, active: true,
    })
    state.workers.set('w-2', {
      id: 'w-2', projectId: 'p-1', name: 'Achieng Odhiambo', role: 'Foreman',
      phone: '0733444555', pin: null, dailyRate: 120000n, active: true,
    })
    state.workers.set('w-3', {
      id: 'w-3', projectId: 'p-1', name: 'Mgonjwa Fundi', role: 'Labourer',
      phone: '0799888777', pin: null, dailyRate: 80000n, active: false,
    })
    state.workers.set('w-4', {
      id: 'w-4', projectId: 'p-1', name: 'Baraka Test', role: 'Fundi wa Chuma',
      phone: '0755111333', pin: '9119', dailyRate: 90000n, active: true,
    })
    state.workers.set('w-5', {
      id: 'w-5', projectId: 'p-1', name: 'Neema Test', role: 'Msaidizi',
      phone: '0755222444', pin: '9229', dailyRate: 85000n, active: true,
    })
    state.workers.set('w-6', {
      id: 'w-6', projectId: 'p-1', name: 'Juma Test', role: 'Fundi wa Mabati',
      phone: '0755333666', pin: '9339', dailyRate: 88000n, active: true,
    })
  }
  state.reset()

  /** Just enough of Prisma's where for this surface (equality + { not }). */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Row
        if ('not' in c) {
          if (row[key] === c.not) return false
          continue
        }
        continue // unused object filters on this surface
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  const pick = (row: Row, select?: Row): Row => {
    if (!select) return { ...row }
    const out: Row = {}
    for (const k of Object.keys(select)) out[k] = row[k]
    return out
  }

  const sortBy = (rows: Row[], orderBy?: Row): Row[] => {
    if (!orderBy) return rows
    const [[key, dir] = []] = Object.entries(orderBy)
    if (!key) return rows
    const sorted = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])))
    return dir === 'desc' ? sorted.reverse() : sorted
  }

  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: Row }) { return state.projects.get(String(where.id)) ?? null },
      async findFirst() { return [...state.projects.values()][0] ?? null },
    },
    worker: {
      // supports the route's kiosk-PIN lookup ({active, pin}, take: 1) and
      // the active-worker scan for the phone-tail fallback.
      async findMany({ where, orderBy, select, take }: { where?: Row; orderBy?: Row; select?: Row; take?: number }) {
        const rows = sortBy([...state.workers.values()].filter((r) => matches(r, where)), orderBy)
          .map((r) => pick(r, select))
        return take !== undefined ? rows.slice(0, take) : rows
      },
      async findUnique({ where }: { where: Row }) { return state.workers.get(String(where.id)) ?? null },
    },
    attendance: {
      async findFirst({ where }: { where: Row }) {
        return [...state.attendance.values()].find((r) => matches(r, where)) ?? null
      },
      async create({ data }: { data: Row }) {
        state.writes++
        const row = { id: `att-${state.attendance.size + 1}`, version: 1, ...data }
        state.attendance.set(String(row.id), row)
        return { ...row }
      },
      async update({ where, data }: { where: Row; data: Row }) {
        state.writes++
        const row = state.attendance.get(String(where.id))
        if (!row) throw new Error(`stub: attendance ${String(where.id)} not found`)
        Object.assign(row, data)
        return { ...row }
      },
      async aggregate({ where }: { where: Row }) {
        const rows = [...state.attendance.values()].filter((r) => matches(r, where))
        const wage = rows.reduce((s, r) => s + ((r.wage as bigint) ?? 0n), 0n)
        return { _sum: { wage } }
      },
      async count({ where }: { where: Row }) {
        return [...state.attendance.values()].filter((r) => matches(r, where)).length
      },
    },
    auditEvent: {
      async create({ data }: { data: Row }) {
        state.audits.push({ ...data })
        return { ...data }
      },
    },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { GET as ussdGet, POST as ussdPost } from '@/app/api/ussd/route'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    projects: Map<string, Record<string, unknown>>
    workers: Map<string, Record<string, unknown>>
    attendance: Map<string, Record<string, unknown>>
    audits: Array<Record<string, unknown>>
    writes: number
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

const T0 = new Date('2026-02-14T10:00:00Z') // 13:00 EAT — today is 2026-02-14
const TODAY = '2026-02-14'
const KAMAU = '0722111222' // kiosk PIN 1234
const ACHIENG = '0733444555' // no kiosk PIN — phone-tail 4555 only
const FOOTER = '— MjengoOS sim'
const WRONG_PIN = '0000' // matches no kiosk PIN and no active phone-tail

/** Unique per-request client IP by default so token buckets never bleed between tests. */
let ipSeq = 0
function uniqueIp(): string {
  ipSeq += 1
  return `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`
}

/** Unique per-test phone numbers keep per-phone rate buckets isolated. */
let phoneSeq = 0
function uniquePhone(): string {
  phoneSeq += 1
  return `0711${String(2000000 + phoneSeq).slice(1)}` // 0711200001, 0711200002, …
}

/** Unique-per-test FIXED client IPs for the ip-keyed PIN lockout pins — each
 * test owns its own principal so the (module-persistent) tracker store never
 * bleeds lock state across tests (the per-request uniqueIp() default would
 * give every request a fresh principal and never accumulate). */
let lockIpSeq = 0
function uniqueLockIp(): string {
  lockIpSeq += 1
  return `10.176.${Math.floor(lockIpSeq / 250)}.${(lockIpSeq % 250) + 1}`
}

function ussdReq(
  phoneNumber: string,
  text: string,
  opts: { ip?: string; headers?: Record<string, string>; raw?: string } = {},
): NextRequest {
  return new NextRequest('http://localhost/api/ussd', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': opts.ip ?? uniqueIp(),
      ...(opts.headers ?? {}),
    },
    body: opts.raw ?? JSON.stringify({ sessionId: 'sess-1', phoneNumber, text }),
  })
}

/** One seeded unpaid attendance day-row for a worker (balance fixtures). */
function seedAttendance(workerId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const row = {
    id: `att-${workerId}`, workerId, projectId: 'p-1', date: TODAY,
    status: 'present', wage: 75000n, checkIn: new Date('2026-02-14T07:00:00Z'), checkOut: null,
    method: 'app', verification: 'verified', recordedBy: 'App', paid: false,
    version: 1, overrideLog: '[]', evidence: null, exceptionReason: null, exceptionNote: null,
    ...over,
  }
  state.attendance.set(String(row.id), row)
  return row
}

// The route-test fixture posture (issue #156): vitest runs NODE_ENV=test,
// and since #156 an unset secret fails closed in EVERY runtime unless the
// open posture is explicitly opted into. These fixtures set exactly what a
// dev/demo deployment would: WEBHOOK_OPEN_POSTURE=1 (the open
// gateway-trust posture under test — without it every test below would
// rightly get the 503) and TRUST_PROXY=1 (the one topology where distinct
// x-forwarded-for values are distinct throttle principals — keeps the
// per-test uniqueIp() bucket isolation honest). The TRUST_PROXY-unset
// collapse has its own dedicated tests below.
beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  vi.clearAllMocks()
  process.env.NEXTAUTH_SECRET = 'unit-test-secret'
  delete process.env.USSD_WEBHOOK_SECRET
  process.env.WEBHOOK_OPEN_POSTURE = '1'
  process.env.TRUST_PROXY = '1'
  state.reset()
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.USSD_WEBHOOK_SECRET
  delete process.env.WEBHOOK_OPEN_POSTURE
  delete process.env.TRUST_PROXY
  delete process.env.NEXTAUTH_SECRET
})

// ------------------------------------------------------------------- grammar

describe('POST /api/ussd — menu grammar (real applyAction path)', () => {
  it('*384# → the main menu text, footered', async () => {
    const res = await ussdPost(ussdReq(KAMAU, '*384#'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const reply = await res.text()
    expect(reply).toContain('MjengoOS Muster')
    expect(reply).toContain('1 Attendance')
    expect(reply.endsWith(FOOTER)).toBe(true)
    expect(state.writes).toBe(0)
  })

  it('attendance present via KIOSK pin → attendance.checkin with ussd evidence, worker as actor', async () => {
    const res = await ussdPost(ussdReq(KAMAU, '*384#*1*1234*1'))
    expect(res.status).toBe(200)
    const reply = await res.text()
    expect(reply).toContain('Attendance recorded.')
    expect(reply).toContain('Kamau Mwangi — PRESENT. Asante!')
    expect(reply.endsWith(FOOTER)).toBe(true)

    expect(state.attendance.size).toBe(1)
    const row = [...state.attendance.values()][0]
    expect(row.workerId).toBe('w-1')
    expect(row.status).toBe('present')
    expect(row.method).toBe('ussd')
    expect(row.verification).toBe('verified')
    expect(JSON.parse(String(row.evidence))).toEqual(['ussd', 'device'])

    // The ledger says the WORKER acted, from the USSD channel (§43 ctx too).
    expect(state.audits.length).toBe(1)
    expect(state.audits[0].actor).toBe('Kamau Mwangi')
    expect(state.audits[0].role).toBe('ussd')
    expect(JSON.parse(String(state.audits[0].meta)).type).toBe('attendance.checkin')
  })

  it('attendance absent via kiosk pin → attendance.record, a reported statement', async () => {
    const res = await ussdPost(ussdReq(KAMAU, '*384#*1*1234*2'))
    const reply = await res.text()
    expect(reply).toContain('Kamau Mwangi — ABSENT. Asante!')
    const row = [...state.attendance.values()][0]
    expect(row.status).toBe('absent')
    expect(row.wage).toBe(0n)
    expect(row.verification).toBe('reported')
    expect(row.recordedBy).toBe('USSD *384#')
  })

  it('balance via kiosk pin → unpaid wage reply (read-only, zero rows)', async () => {
    seedAttendance('w-1', { wage: 150000n })
    seedAttendance('w-1', { id: 'att-w-1-b', wage: 75000n, status: 'half_day' })
    const res = await ussdPost(ussdReq(KAMAU, '*384#*2*1234'))
    const reply = await res.text()
    expect(reply).toContain('Kamau Mwangi')
    expect(reply).toContain('KSh 2,250 (2 day(s))')
    expect(reply.endsWith(FOOTER)).toBe(true)
    expect(state.writes).toBe(0)
    expect(state.audits).toEqual([])
  })

  it('help → usage text; unknown selection → menu; non-serviceCode text → invalid code', async () => {
    const help = await (await ussdPost(ussdReq(KAMAU, '*384#*3'))).text()
    expect(help).toContain('1*PIN*1 present')
    const unknown = await (await ussdPost(ussdReq(KAMAU, '*384#*9'))).text()
    expect(unknown).toContain('MjengoOS Muster')
    const wrongCode = await (await ussdPost(ussdReq(KAMAU, '*111#'))).text()
    expect(wrongCode).toContain('Invalid code')
    expect(state.writes).toBe(0)
  })

  it('body validation: invalid JSON → 400; missing phoneNumber/text → 400', async () => {
    const bad = await ussdPost(ussdReq(KAMAU, '*384#', { raw: '{not json' }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'Invalid JSON body' })

    const noPhone = await ussdPost(ussdReq('', '*384#', { raw: JSON.stringify({ text: '*384#' }) }))
    expect(noPhone.status).toBe(400)
    expect(await noPhone.json()).toMatchObject({ error: expect.stringContaining('phoneNumber required') })

    const noText = await ussdPost(ussdReq(KAMAU, '', { raw: JSON.stringify({ phoneNumber: KAMAU }) }))
    expect(noText.status).toBe(400)
    expect(await noText.json()).toMatchObject({ error: expect.stringContaining('text required') })
  })
})

// --------------------------------------------------------------- body cap

describe('POST body cap — 64 KB raw (BE-4, issue #105)', () => {
  it('a declared Content-Length beyond 64 KB is refused before the body is read', async () => {
    const res = await ussdPost(ussdReq(KAMAU, '*384#', {
      raw: 'x',
      headers: { 'content-length': String(64 * 1024 + 1) },
    }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('64 KB') })
    expect(state.writes).toBe(0)
  })

  it('an actually-oversized body (> 64 KB of real bytes) is refused after the read', async () => {
    const big = JSON.stringify({ phoneNumber: KAMAU, text: `*384#${'a'.repeat(70_000)}` })
    const res = await ussdPost(ussdReq(KAMAU, '*384#', { raw: big }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('64 KB') })
    expect(state.writes).toBe(0)
  })

  it('a LYING small Content-Length over a big body is caught by the post-read count', async () => {
    const big = JSON.stringify({ phoneNumber: KAMAU, text: `*384#${'a'.repeat(70_000)}` })
    const res = await ussdPost(ussdReq(KAMAU, '*384#', {
      raw: big,
      headers: { 'content-length': '10' }, // the lie: claims 10 bytes, ships 70 KB
    }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('64 KB') })
  })

  it('a body AT the cap passes into the parser (honest route reply, no size error)', async () => {
    // ~63 KB of valid JSON — under the cap, so the route parses it and the
    // parser answers honestly (text does not start with the service code).
    const text = `*999#${'a'.repeat(63 * 1024)}`
    const raw = JSON.stringify({ sessionId: 'sess-1', phoneNumber: KAMAU, text })
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(60 * 1024)
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    const res = await ussdPost(ussdReq(KAMAU, text, { raw }))
    expect(res.status).toBe(200) // parsed and answered, never a 400 size error
    const reply = await res.text()
    expect(reply).toContain('Invalid code')
    expect(reply.endsWith(FOOTER)).toBe(true)
    expect(state.writes).toBe(0)
  })

  it('oversized body is refused even when it would otherwise fail HMAC first (cap runs before the signature)', async () => {
    process.env.USSD_WEBHOOK_SECRET = 'ussd-unit-secret'
    const big = JSON.stringify({ phoneNumber: KAMAU, text: `*384#${'a'.repeat(70_000)}` })
    const res = await ussdPost(ussdReq(KAMAU, '*384#', { raw: big }))
    expect(res.status).toBe(400) // size error, NOT the 401 signature error
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('64 KB') })
  })
})

// ------------------------------------------------------------------ signature

describe('X-Signature — HMAC shared-secret verification (USSD_WEBHOOK_SECRET)', () => {
  const SECRET = 'ussd-unit-secret'
  const rawBody = JSON.stringify({ sessionId: 'sess-1', phoneNumber: KAMAU, text: '*384#*3' })
  const goodSig = createHmac('sha256', SECRET).update(rawBody).digest('hex')

  beforeEach(() => {
    process.env.USSD_WEBHOOK_SECRET = SECRET
  })

  it('secret set + unsigned POST → 401 with the honest missing-header message', async () => {
    const res = await ussdPost(ussdReq(KAMAU, '*384#*3', { raw: rawBody }))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('Missing X-Signature header'),
    })
    expect(state.writes).toBe(0)
  })

  it('secret set + MISMATCHED signature → 401, nothing written', async () => {
    const res = await ussdPost(ussdReq(KAMAU, '*384#*3', {
      raw: rawBody,
      headers: { 'x-signature': createHmac('sha256', 'wrong-secret').update(rawBody).digest('hex') },
    }))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'Invalid X-Signature' })
    expect(state.writes).toBe(0)
    expect(state.audits).toEqual([])
  })

  it('secret set + correct hex HMAC of the RAW body → 200 (footer reply)', async () => {
    const res = await ussdPost(ussdReq(KAMAU, '*384#*3', {
      raw: rawBody,
      headers: { 'x-signature': goodSig },
    }))
    expect(res.status).toBe(200)
    expect((await res.text()).endsWith(FOOTER)).toBe(true)
  })

  it('UNSET secret + WEBHOOK_OPEN_POSTURE=1 (the fixture opt-in) → open demo posture: plain POST goes through', async () => {
    delete process.env.USSD_WEBHOOK_SECRET
    const res = await ussdPost(ussdReq(KAMAU, '*384#*3'))
    expect(res.status).toBe(200)
    expect((await res.text()).endsWith(FOOTER)).toBe(true)
    expect(process.env.WEBHOOK_OPEN_POSTURE).toBe('1') // the explicit opt-in, not an accident
  })
})

// ------------------------------------------- production fail-closed (SEC-4)

describe('production fail-closed — unset secret → 503, no processing (SEC-4)', () => {
  const rawBody = JSON.stringify({ sessionId: 'sess-1', phoneNumber: KAMAU, text: '*384#*3' })
  const goodSig = createHmac('sha256', 'ussd-unit-secret').update(rawBody).digest('hex')

  /** Run one assertion block with NODE_ENV=production; ALWAYS restored. */
  async function asProduction<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      return await fn()
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  }

  it('NODE_ENV=production + UNSET secret → 503 JSON configuration error, zero processing', async () => {
    await asProduction(async () => {
      const res = await ussdPost(ussdReq(KAMAU, '*384#*3'))
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining('USSD_WEBHOOK_SECRET is not configured'),
      })
      expect(state.writes).toBe(0)
      expect(state.audits).toEqual([])
    })
    expect(process.env.NODE_ENV).not.toBe('production') // restored for the file
  })

  it('production IGNORES the opt-in: WEBHOOK_OPEN_POSTURE=1 + unset secret → STILL 503 (issue #156)', async () => {
    // The beforeEach fixture already sets WEBHOOK_OPEN_POSTURE=1 — production
    // must not read it. (Set it explicitly anyway so the intent is visible.)
    process.env.WEBHOOK_OPEN_POSTURE = '1'
    await asProduction(async () => {
      const res = await ussdPost(ussdReq(KAMAU, '*384#*3'))
      expect(res.status).toBe(503)
      expect(state.writes).toBe(0)
      expect(state.audits).toEqual([])
    })
  })

  it('production refuses BEFORE the grammar: an attendance attempt writes nothing', async () => {
    await asProduction(async () => {
      const res = await ussdPost(ussdReq(KAMAU, '*384#*1*1234*1'))
      expect(res.status).toBe(503)
      expect(state.attendance.size).toBe(0)
      expect(state.writes).toBe(0)
      expect(state.audits).toEqual([])
    })
  })

  it('production + secret SET + correct HMAC → 200 — a configured route never sees the 503 gate', async () => {
    process.env.USSD_WEBHOOK_SECRET = 'ussd-unit-secret'
    await asProduction(async () => {
      const res = await ussdPost(ussdReq(KAMAU, '*384#*3', {
        raw: rawBody,
        headers: { 'x-signature': goodSig },
      }))
      expect(res.status).toBe(200)
      expect((await res.text()).endsWith(FOOTER)).toBe(true)
    })
  })

  it('production + secret SET + unsigned → 401 (the HMAC gate answers, not the 503 gate)', async () => {
    process.env.USSD_WEBHOOK_SECRET = 'ussd-unit-secret'
    await asProduction(async () => {
      const res = await ussdPost(ussdReq(KAMAU, '*384#*3', { raw: rawBody }))
      expect(res.status).toBe(401)
      expect(state.writes).toBe(0)
    })
  })
})

// ------------------------------------------- open-posture opt-in (issue #156)

describe('open-posture opt-in — WEBHOOK_OPEN_POSTURE gates unauthenticated writes (issue #156)', () => {
  it('non-production + unset secret + NO opt-in → 503 (the new fail-closed default), zero processing', async () => {
    delete process.env.WEBHOOK_OPEN_POSTURE
    const res = await ussdPost(ussdReq(KAMAU, '*384#*3'))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('USSD_WEBHOOK_SECRET is not configured')
    expect(body.error).toContain('WEBHOOK_OPEN_POSTURE') // the honest remedy is named
    expect(state.writes).toBe(0)
    expect(state.audits).toEqual([])
  })

  it('a runtime with NO NODE_ENV at all (bare container) + no opt-in → 503 too', async () => {
    delete process.env.WEBHOOK_OPEN_POSTURE
    const prev = process.env.NODE_ENV
    delete process.env.NODE_ENV // `docker run` of the image without NODE_ENV
    try {
      const res = await ussdPost(ussdReq(KAMAU, '*384#*1*1234*1'))
      expect(res.status).toBe(503)
      expect(state.attendance.size).toBe(0)
      expect(state.writes).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  })

  it('opt-in set to 0/false/blank is NOT an opt-in → 503', async () => {
    for (const v of ['', '0', 'false']) {
      process.env.WEBHOOK_OPEN_POSTURE = v
      const res = await ussdPost(ussdReq(KAMAU, '*384#*3'))
      expect(res.status, `WEBHOOK_OPEN_POSTURE="${v}"`).toBe(503)
    }
    expect(state.writes).toBe(0)
  })

  it('non-production + unset secret + WEBHOOK_OPEN_POSTURE=1 → 200 (the explicit open demo posture)', async () => {
    process.env.WEBHOOK_OPEN_POSTURE = '1' // the beforeEach default, restated
    const res = await ussdPost(ussdReq(KAMAU, '*384#*3'))
    expect(res.status).toBe(200)
    expect((await res.text()).endsWith(FOOTER)).toBe(true)
  })

  it('non-production + secret SET → the HMAC gate answers regardless of the opt-in (503 never shadows it)', async () => {
    process.env.USSD_WEBHOOK_SECRET = 'ussd-unit-secret'
    delete process.env.WEBHOOK_OPEN_POSTURE
    const rawBody = JSON.stringify({ sessionId: 'sess-1', phoneNumber: KAMAU, text: '*384#*3' })
    const unsigned = await ussdPost(ussdReq(KAMAU, '*384#*3', { raw: rawBody }))
    expect(unsigned.status).toBe(401)
    const signed = await ussdPost(ussdReq(KAMAU, '*384#*3', {
      raw: rawBody,
      headers: { 'x-signature': createHmac('sha256', 'ussd-unit-secret').update(rawBody).digest('hex') },
    }))
    expect(signed.status).toBe(200)
  })
})

// --------------------------------------------------------------- rate limits

describe('rate limits — 20/min/phone + 40 PIN-attempts/min/IP (fake-timer determinism)', () => {
  it('the 21st request from ONE phone within the window → 429 + Retry-After', async () => {
    // fixed IP: the bucket key is (bucket, principal) and the principal is
    // the client IP here — a rotating IP would mint a fresh bucket per request.
    const ip = '10.7.0.9'
    for (let i = 0; i < 20; i++) {
      const res = await ussdPost(ussdReq(KAMAU, '*384#', { ip })) // menu requests, no PIN
      expect(res.status, `request ${i + 1} should pass`).toBe(200)
    }
    const blocked = await ussdPost(ussdReq(KAMAU, '*384#', { ip }))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(await blocked.json()).toMatchObject({ error: 'Too many requests' })
  })

  it('the 41st PIN attempt from ONE client IP (rotating phones) → 429 — the lockout is the effective wrong-PIN bound, the bucket the outer cap (issue #176)', async () => {
    const ip = '10.7.0.3'
    for (let i = 0; i < 40; i++) {
      const phone = `0711${String(3000000 + i).slice(1)}` // unique per request
      const res = await ussdPost(ussdReq(phone, `*384#*2*${WRONG_PIN}`, { ip }))
      expect(res.status, `request ${i + 1} should pass (text either way)`).toBe(200)
      if (i < 4) {
        // first 4 wrong PINs: the ip principal's budget is not exhausted
        expect(await res.text()).toContain('PIN not recognised')
      } else {
        // from the 5th on, the ip-keyed LOCKOUT answers (rotating phones
        // could not refresh the budget) — still 200 text, never a row written
        expect(await res.text()).toContain('Too many wrong PINs')
      }
    }
    const blocked = await ussdPost(ussdReq('0713999999', `*384#*2*${WRONG_PIN}`, { ip }))
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: 'Too many requests' })
    expect(state.writes).toBe(0) // 40 wrong-PIN replies — never a single row
  })

  it('issue #156 + #176: TRUST_PROXY UNSET → rotating x-forwarded-for refreshes NEITHER the per-IP PIN bucket NOR the anon lockout budget', async () => {
    // The old first-XFF semantics let a scripted client mint a fresh PIN
    // bucket per request by rotating the forgeable header. Now (TRUST_PROXY
    // unset — direct exposure) the header is ignored: every request shares
    // the ONE anon bucket AND the ONE anon lockout budget, so the 40/min cap
    // and the 5-wrong-PINs/15-min lock actually bind.
    delete process.env.TRUST_PROXY
    try {
      for (let i = 0; i < 40; i++) {
        const phone = `0712${String(4000000 + i).slice(1)}` // unique per request
        const spoofedXff = `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}` // ROTATING "IP"
        const res = await ussdPost(ussdReq(phone, `*384#*2*${WRONG_PIN}`, { ip: spoofedXff }))
        expect(res.status, `request ${i + 1} should pass despite rotation`).toBe(200)
        if (i >= 4) {
          // the 5th wrong PIN under rotation already tripped the ANON
          // lockout principal — no header rotation mints a fresh budget
          expect(await res.text()).toContain('Too many wrong PINs')
        }
      }
      // a brand-new spoofed "IP" is still the same anon principal → blocked
      const blocked = await ussdPost(ussdReq('0713999999', `*384#*2*${WRONG_PIN}`, { ip: '203.0.113.99' }))
      expect(blocked.status).toBe(429)
      expect(await blocked.json()).toMatchObject({ error: 'Too many requests' })
      expect(state.writes).toBe(0)
    } finally {
      process.env.TRUST_PROXY = '1' // restore the fixture posture
    }
  })

  it('PIN-less requests do NOT consume the per-IP PIN bucket (menu from one IP passes 41 times)', async () => {
    const ip = '10.7.0.4'
    for (let i = 0; i < 41; i++) {
      const res = await ussdPost(ussdReq(uniquePhone(), '*384#', { ip }))
      expect(res.status, `menu request ${i + 1} should pass`).toBe(200)
    }
  })
})

// ---------------------------------------------------------------- PIN lockout

describe('per-PIN failure lockout — 5 wrong PINs per client-IP principal → 15-minute lock (BE-9 + issue #176)', () => {
  it('4 wrong PINs from ONE ip do NOT lock; each gets the honest "PIN not recognised" reply', async () => {
    const ip = uniqueLockIp()
    for (let i = 0; i < 4; i++) {
      const res = await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip }))
      expect(res.status).toBe(200)
      const reply = await res.text()
      expect(reply).toContain('PIN not recognised')
      expect(reply).not.toContain('locked')
    }
    expect(state.writes).toBe(0)
  })

  it('the 5th wrong PIN from one ip trips the lock — the reply names the wait (15 minutes)', async () => {
    const ip = uniqueLockIp()
    for (let i = 0; i < 4; i++) await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip }))
    const fifth = await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip }))
    expect(fifth.status).toBe(200) // a gateway always gets text back
    const reply = await fifth.text()
    expect(reply).toContain('Too many wrong PINs')
    expect(reply).toContain('locked for 15 more minute')
    expect(reply.endsWith(FOOTER)).toBe(true)
    expect(state.writes).toBe(0)
  })

  it('issue #176 AC1 — ROTATING PHONE NUMBERS from one ip cannot refresh the failure budget', async () => {
    const ip = uniqueLockIp()
    // five wrong PINs, each from a DIFFERENT (freshly rotated) phone — one
    // shared ip-keyed budget: the 5th strike trips exactly as if the phone
    // had never changed.
    for (let i = 0; i < 4; i++) {
      const res = await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip }))
      expect(await res.text()).toContain('PIN not recognised')
    }
    const fifth = await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip }))
    expect(await fifth.text()).toContain('Too many wrong PINs')
    // …and a SIXTH rotated phone from the same ip is refused the same way.
    const sixth = await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip }))
    expect(await sixth.text()).toContain('Too many wrong PINs')
    expect(state.writes).toBe(0)
  })

  it('the lock follows the ip principal, not the phone: a fresh phone from the same ip is refused; another ip keeps working', async () => {
    const lockedIp = uniqueLockIp()
    for (let i = 0; i < 5; i++) await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip: lockedIp }))
    // Same ip, brand-new phone (the OLD per-phone semantics would have let
    // this through — that was the bug): still locked.
    const sameIp = await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip: lockedIp }))
    expect(await sameIp.text()).toContain('Too many wrong PINs')
    // A different ip: its own budget — honest miss reply, no lock.
    const otherIp = await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip: uniqueLockIp() }))
    expect(await otherIp.text()).toContain('PIN not recognised')
    // And a correct PIN from that other ip still records attendance.
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*1*1234*1', { ip: uniqueLockIp() }))
    expect(await res.text()).toContain('Attendance recorded.')
    expect(state.attendance.size).toBe(1)
  })

  it('the CORRECT PIN during the lock is still refused — zero rows written', async () => {
    const ip = uniqueLockIp()
    for (let i = 0; i < 5; i++) await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip }))
    // The correct kiosk PIN from the locked principal — still refused.
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*1*1234*1', { ip }))
    expect(res.status).toBe(200)
    const reply = await res.text()
    expect(reply).toContain('Too many wrong PINs')
    expect(reply).toContain('locked for 15 more minute')
    expect(state.attendance.size).toBe(0) // refusal happened BEFORE any DB work
    expect(state.audits).toEqual([])
    expect(state.writes).toBe(0)
  })

  it('after the 15-minute window the same correct PIN works again (lock served, clean slate)', async () => {
    const ip = uniqueLockIp()
    for (let i = 0; i < 5; i++) await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip }))
    vi.advanceTimersByTime(15 * 60 * 1000 + 1_000) // serve the lock
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*1*1234*1', { ip }))
    expect(res.status).toBe(200)
    const reply = await res.text()
    expect(reply).toContain('Attendance recorded.')
    expect(reply).toContain('Kamau Mwangi — PRESENT. Asante!')
    expect(state.attendance.size).toBe(1)
  })

  it('issue #176: a correct PIN does NOT reset the ip-keyed budget (the phone-tail refresh exploit is closed)', async () => {
    const ip = uniqueLockIp()
    for (let i = 0; i < 4; i++) await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip }))
    // A correct kiosk-PIN balance lookup from the same ip works (the worker
    // key is cleared, the request itself is legitimate)…
    const ok = await ussdPost(ussdReq(uniquePhone(), '*384#*2*1234', { ip }))
    expect(await ok.text()).toContain('Kamau Mwangi')
    // …but it does NOT wipe the ip principal's budget: the very next wrong
    // PIN is the 5th strike and trips the lock. (Under the pre-#176 phone
    // keying, alternating correct phone-tail PINs and wrong guesses kept the
    // count reset forever — that refresh vehicle is gone.)
    const next = await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`, { ip }))
    expect(await next.text()).toContain('Too many wrong PINs')
  })

  it('issue #176 AC2 — PER-WORKER lock: 5 wrong kiosk PINs from the worker\'s own line lock the worker identity — the CORRECT kiosk PIN is then refused from ANY phone', async () => {
    // Five wrong kiosk-PIN guesses from Baraka's own line (each request from
    // a different ip, so only the WORKER key accumulates — exactly the
    // per-worker budget): the 5th trips the worker lock.
    for (let i = 0; i < 4; i++) {
      const res = await ussdPost(ussdReq('0755111333', `*384#*2*${WRONG_PIN}`)) // uniqueIp() default
      expect(await res.text()).toContain('PIN not recognised')
    }
    const fifth = await ussdPost(ussdReq('0755111333', `*384#*2*${WRONG_PIN}`))
    expect(await fifth.text()).toContain('Too many wrong PINs')
    // Now the CORRECT kiosk PIN for that worker — from a FRESH phone and a
    // FRESH ip (nothing else is locked): the worker identity itself is
    // locked, so the resolution is refused regardless of which phone sent it.
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*1*9119*1'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Too many wrong PINs')
    expect(state.attendance.size).toBe(0) // refused before any write
    expect(state.writes).toBe(0)
  })

  it('a locked worker does not block other workers (the per-worker lock is surgical, not a line/global lock)', async () => {
    // Lock Baraka's identity from his own line (fresh ips per request).
    for (let i = 0; i < 5; i++) await ussdPost(ussdReq('0755111333', `*384#*2*${WRONG_PIN}`))
    // Kamau's kiosk PIN from an unrelated line still records attendance.
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*1*1234*1', { ip: uniqueLockIp() }))
    expect(await res.text()).toContain('Attendance recorded.')
    expect(state.attendance.size).toBe(1)
  })

  it('a correct KIOSK pin clears the WORKER\'s own count (consecutive semantics, keyed on the worker identity)', async () => {
    // Neema's line: 4 wrong kiosk-PIN guesses (fresh ips — only the worker
    // key accumulates)…
    for (let i = 0; i < 4; i++) {
      const res = await ussdPost(ussdReq('0755222444', `*384#*2*${WRONG_PIN}`))
      expect(await res.text()).toContain('PIN not recognised')
    }
    // …then the correct kiosk PIN from her own line: resolves, and clears
    // HER worker count (the identity that proved itself restarts).
    const ok = await ussdPost(ussdReq('0755222444', '*384#*2*9229'))
    expect(await ok.text()).toContain('Neema Test')
    // …so four MORE wrong guesses from her line stay under the limit…
    for (let i = 0; i < 4; i++) {
      const res = await ussdPost(ussdReq('0755222444', `*384#*2*${WRONG_PIN}`))
      expect(await res.text()).toContain('PIN not recognised')
    }
    // …and the 5th wrong AFTER the clear is what trips it.
    const fifth = await ussdPost(ussdReq('0755222444', `*384#*2*${WRONG_PIN}`))
    expect(await fifth.text()).toContain('Too many wrong PINs')
  })

  it('a correct PHONE-TAIL pin never clears anything (the 10^4 demo identity is not kiosk knowledge)', async () => {
    // Juma's line: 4 wrong kiosk-PIN guesses (worker key at 4)…
    for (let i = 0; i < 4; i++) {
      await ussdPost(ussdReq('0755333666', `*384#*2*${WRONG_PIN}`))
    }
    // …then his phone-tail PIN (3666) resolves in the open posture — the
    // balance reply comes back, but the worker count is NOT cleared…
    const tail = await ussdPost(ussdReq('0755333666', '*384#*2*3666'))
    expect(await tail.text()).toContain('Juma Test')
    // …so the very next wrong kiosk guess is the 5th strike: locked.
    const next = await ussdPost(ussdReq('0755333666', `*384#*2*${WRONG_PIN}`))
    expect(await next.text()).toContain('Too many wrong PINs')
  })

  it('the attendance branch records failures on the ip key too (wrong PIN → not recognised → counted)', async () => {
    const ip = uniqueLockIp()
    for (let i = 0; i < 5; i++) await ussdPost(ussdReq(uniquePhone(), `*384#*1*${WRONG_PIN}*1`, { ip }))
    // Attendance attempts tripped the lock exactly like balance attempts.
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*1*1234*1', { ip }))
    expect(await res.text()).toContain('Too many wrong PINs')
    expect(state.attendance.size).toBe(0)
  })
})

// --------------------------------------------------- phone-tail fallback policy

describe('phone-tail PIN fallback — gated behind the explicit open posture (BE-9 + issue #156)', () => {
  it('OFF BY DEFAULT: no opt-in → the route fails closed (503) before any PIN resolution — the 10^4 keyspace identity is closed', async () => {
    delete process.env.WEBHOOK_OPEN_POSTURE
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*2*4555')) // Achieng's phone-tail
    expect(res.status).toBe(503)
    expect(state.writes).toBe(0)
    expect(state.audits).toEqual([])
  })

  it('ON in the explicit open posture: secret unset + WEBHOOK_OPEN_POSTURE=1 → last-4 resolves the worker', async () => {
    delete process.env.USSD_WEBHOOK_SECRET
    // WEBHOOK_OPEN_POSTURE=1 is the beforeEach fixture — the only state where
    // the demo fallback legitimately resolves.
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*2*4555')) // Achieng's phone-tail
    expect(res.status).toBe(200)
    const reply = await res.text()
    expect(reply).toContain('Achieng Odhiambo')
    expect(reply).toContain('Unpaid balance')
    expect(state.writes).toBe(0)
  })

  it('secret SET → the phone-tail fallback is DROPPED: last-4 no longer resolves', async () => {
    process.env.USSD_WEBHOOK_SECRET = 'ussd-unit-secret'
    const rawBody = JSON.stringify({ phoneNumber: uniquePhone(), text: '*384#*2*4555' })
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*2*4555', {
      raw: rawBody,
      headers: { 'x-signature': createHmac('sha256', 'ussd-unit-secret').update(rawBody).digest('hex') },
    }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('PIN not recognised') // kiosk PIN only now
    expect(state.writes).toBe(0)
    expect(state.audits).toEqual([])
  })

  it('secret SET + WEBHOOK_OPEN_POSTURE=1 → the fallback is STILL dropped (the shared-secret posture wins over the opt-in)', async () => {
    process.env.USSD_WEBHOOK_SECRET = 'ussd-unit-secret'
    // WEBHOOK_OPEN_POSTURE=1 is the fixture — the opt-in must not leak the
    // 10^4 last-4 identity into the shared-secret posture.
    const rawBody = JSON.stringify({ phoneNumber: uniquePhone(), text: '*384#*2*4555' })
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*2*4555', {
      raw: rawBody,
      headers: { 'x-signature': createHmac('sha256', 'ussd-unit-secret').update(rawBody).digest('hex') },
    }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('PIN not recognised')
    expect(state.writes).toBe(0)
  })

  it('secret SET → the stored KIOSK PIN still resolves (shared-secret posture works)', async () => {
    process.env.USSD_WEBHOOK_SECRET = 'ussd-unit-secret'
    const rawBody = JSON.stringify({ phoneNumber: uniquePhone(), text: '*384#*1*1234*1' })
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*1*1234*1', {
      raw: rawBody,
      headers: { 'x-signature': createHmac('sha256', 'ussd-unit-secret').update(rawBody).digest('hex') },
    }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Attendance recorded.')
    expect(state.attendance.size).toBe(1)
  })

  it('no opt-in + secret unset → the KIOSK PIN path is closed too (the whole route is 503 — kiosk PIN is the default only once a posture is chosen)', async () => {
    delete process.env.WEBHOOK_OPEN_POSTURE
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*1*1234*1'))
    expect(res.status).toBe(503)
    expect(state.attendance.size).toBe(0)
  })
})

// ------------------------------------------------------------ GET contract

describe('GET /api/ussd — the machine-readable contract', () => {
  it('documents the menu, the pin-resolution policy, the rate limits and the body cap honestly', async () => {
    const res = await ussdGet()
    expect(res.status).toBe(200)
    const doc = (await res.json()) as Record<string, unknown>
    expect(doc.ok).toBe(true)
    expect(doc.endpoint).toBe('POST /api/ussd')
    expect(String(doc.pinResolution)).toContain('kiosk PIN (Worker.pin) first')
    expect(String(doc.pinResolution)).toContain('ONLY in the explicitly opted-in open posture')
    expect(String(doc.pinResolution)).toContain('WEBHOOK_OPEN_POSTURE=1')
    expect(String(doc.rateLimit)).toContain('20 requests/min/phone')
    expect(String(doc.rateLimit)).toContain('40 PIN-attempts/min per client IP')
    expect(String(doc.rateLimit)).toContain('5 wrong PINs per client-IP principal')
    expect(String(doc.rateLimit)).toContain('15-minute lockout')
    expect(String(doc.rateLimit)).toContain('per-worker lockout')
    expect(String(doc.rateLimit)).toContain('trust-aware')
    expect(String(doc.rateLimit)).toContain('TRUST_PROXY unset')
    expect(String(doc.bodyCap)).toContain('64 KB')
    expect(String(doc.signature)).toContain('USSD_WEBHOOK_SECRET')
    expect(String(doc.signature)).toContain('WEBHOOK_OPEN_POSTURE=1')
    expect(String(doc.signature)).toContain('FAILS CLOSED in EVERY runtime')
    expect(String(doc.honest)).toContain('No SMS/USSD aggregator is wired')
  })
})
