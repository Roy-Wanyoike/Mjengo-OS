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
 *     body → 200; unset → documented open demo posture;
 *   · PIN THROTTLE: 20/min/phone and 40 PIN-attempts/min per client IP,
 *     429 + Retry-After;
 *   · PIN LOCKOUT (BE-9, issue #106): 5 wrong PINs for one phone → the line
 *     is locked 15 minutes (the reply names the wait); the correct PIN
 *     during the lock is STILL refused and writes nothing; after the window
 *     the same PIN works again; the lock is keyed per phone; a correct PIN
 *     resets the count (consecutive-failure semantics);
 *   · PHONE-TAIL FALLBACK POLICY: USSD_WEBHOOK_SECRET set → last-4-of-phone
 *     no longer resolves (kiosk PIN only — the shared-secret posture);
 *     unset → the documented demo fallback keeps working;
 *   · every USSD text reply carries the sim footer.
 *
 * @/backend/lib/db is swapped for an in-memory stub (whatsapp-route.test
 * idioms — worker.findMany also honors `take` for the kiosk-PIN lookup).
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
    state.workers.set('w-1', {
      id: 'w-1', projectId: 'p-1', name: 'Kamau Mwangi', role: 'Fundi wa Mawe',
      phone: '0722111222', pin: '1234', dailyRate: 1500, active: true,
    })
    state.workers.set('w-2', {
      id: 'w-2', projectId: 'p-1', name: 'Achieng Odhiambo', role: 'Foreman',
      phone: '0733444555', pin: null, dailyRate: 1200, active: true,
    })
    state.workers.set('w-3', {
      id: 'w-3', projectId: 'p-1', name: 'Mgonjwa Fundi', role: 'Labourer',
      phone: '0799888777', pin: null, dailyRate: 800, active: false,
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
        const wage = rows.reduce((s, r) => s + (Number(r.wage) || 0), 0)
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

/** Unique per-test phone numbers keep the phone-keyed PIN lockout isolated. */
let phoneSeq = 0
function uniquePhone(): string {
  phoneSeq += 1
  return `0711${String(2000000 + phoneSeq).slice(1)}` // 0711200001, 0711200002, …
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
    status: 'present', wage: 750, checkIn: new Date('2026-02-14T07:00:00Z'), checkOut: null,
    method: 'app', verification: 'verified', recordedBy: 'App', paid: false,
    version: 1, overrideLog: '[]', evidence: null, exceptionReason: null, exceptionNote: null,
    ...over,
  }
  state.attendance.set(String(row.id), row)
  return row
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  vi.clearAllMocks()
  process.env.NEXTAUTH_SECRET = 'unit-test-secret'
  delete process.env.USSD_WEBHOOK_SECRET
  state.reset()
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.USSD_WEBHOOK_SECRET
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
    expect(row.wage).toBe(0)
    expect(row.verification).toBe('reported')
    expect(row.recordedBy).toBe('USSD *384#')
  })

  it('balance via kiosk pin → unpaid wage reply (read-only, zero rows)', async () => {
    seedAttendance('w-1', { wage: 1500 })
    seedAttendance('w-1', { id: 'att-w-1-b', wage: 750, status: 'half_day' })
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

  it('UNSET secret → documented open demo posture: plain POST goes through', async () => {
    delete process.env.USSD_WEBHOOK_SECRET
    const res = await ussdPost(ussdReq(KAMAU, '*384#*3'))
    expect(res.status).toBe(200)
    expect((await res.text()).endsWith(FOOTER)).toBe(true)
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

  it('the 41st PIN attempt from ONE client IP (rotating phones) → 429 — the IP bucket throttles', async () => {
    const ip = '10.7.0.3'
    for (let i = 0; i < 40; i++) {
      const phone = `0711${String(3000000 + i).slice(1)}` // unique per request
      const res = await ussdPost(ussdReq(phone, `*384#*2*${WRONG_PIN}`, { ip }))
      expect(res.status, `request ${i + 1} should pass`).toBe(200) // honest "PIN not recognised"
    }
    const blocked = await ussdPost(ussdReq('0713999999', `*384#*2*${WRONG_PIN}`, { ip }))
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: 'Too many requests' })
    expect(state.writes).toBe(0) // 40 wrong-PIN replies — never a single row
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

describe('per-PIN failure lockout — 5 wrong PINs → 15-minute line lock (BE-9, issue #106)', () => {
  it('4 wrong PINs do NOT lock; each gets the honest "PIN not recognised" reply', async () => {
    const phone = uniquePhone()
    for (let i = 0; i < 4; i++) {
      const res = await ussdPost(ussdReq(phone, `*384#*2*${WRONG_PIN}`))
      expect(res.status).toBe(200)
      const reply = await res.text()
      expect(reply).toContain('PIN not recognised')
      expect(reply).not.toContain('locked')
    }
    expect(state.writes).toBe(0)
  })

  it('the 5th wrong PIN trips the lock — the reply names the wait (15 minutes)', async () => {
    const phone = uniquePhone()
    for (let i = 0; i < 4; i++) await ussdPost(ussdReq(phone, `*384#*2*${WRONG_PIN}`))
    const fifth = await ussdPost(ussdReq(phone, `*384#*2*${WRONG_PIN}`))
    expect(fifth.status).toBe(200) // a gateway always gets text back
    const reply = await fifth.text()
    expect(reply).toContain('Too many wrong PINs')
    expect(reply).toContain('locked for 15 more minute')
    expect(reply.endsWith(FOOTER)).toBe(true)
    expect(state.writes).toBe(0)
  })

  it('the lock is keyed PER PHONE: another line keeps working while one is locked', async () => {
    const locked = uniquePhone()
    for (let i = 0; i < 5; i++) await ussdPost(ussdReq(locked, `*384#*2*${WRONG_PIN}`))
    // A different phone: same wrong PIN, fresh tracker — honest reply, no lock.
    const other = await ussdPost(ussdReq(uniquePhone(), `*384#*2*${WRONG_PIN}`))
    expect(other.status).toBe(200)
    expect(await other.text()).toContain('PIN not recognised')
    // And a correct PIN from the OTHER phone still records attendance.
    const res = await ussdPost(ussdReq(uniquePhone(), '*384#*1*1234*1'))
    expect(await res.text()).toContain('Attendance recorded.')
    expect(state.attendance.size).toBe(1)
  })

  it('the CORRECT PIN during the lock is still refused — zero rows written', async () => {
    const phone = uniquePhone()
    for (let i = 0; i < 5; i++) await ussdPost(ussdReq(phone, `*384#*2*${WRONG_PIN}`))
    // Now the line's OWN worker keys the correct kiosk PIN — still locked.
    const res = await ussdPost(ussdReq(phone, '*384#*1*1234*1'))
    expect(res.status).toBe(200)
    const reply = await res.text()
    expect(reply).toContain('Too many wrong PINs')
    expect(reply).toContain('locked for 15 more minute')
    expect(state.attendance.size).toBe(0) // refusal happened BEFORE any DB work
    expect(state.audits).toEqual([])
    expect(state.writes).toBe(0)
  })

  it('after the 15-minute window the same correct PIN works again (lock served, clean slate)', async () => {
    const phone = uniquePhone()
    for (let i = 0; i < 5; i++) await ussdPost(ussdReq(phone, `*384#*2*${WRONG_PIN}`))
    vi.advanceTimersByTime(15 * 60 * 1000 + 1_000) // serve the lock
    const res = await ussdPost(ussdReq(phone, '*384#*1*1234*1'))
    expect(res.status).toBe(200)
    const reply = await res.text()
    expect(reply).toContain('Attendance recorded.')
    expect(reply).toContain('Kamau Mwangi — PRESENT. Asante!')
    expect(state.attendance.size).toBe(1)
  })

  it('consecutive semantics: a CORRECT PIN between failures resets the count', async () => {
    const phone = uniquePhone()
    for (let i = 0; i < 4; i++) await ussdPost(ussdReq(phone, `*384#*2*${WRONG_PIN}`))
    // A correct balance lookup on the same line wipes the tracker…
    const ok = await ussdPost(ussdReq(phone, '*384#*2*1234'))
    expect(await ok.text()).toContain('Kamau Mwangi')
    // …so four MORE wrong PINs stay under the limit.
    for (let i = 0; i < 4; i++) {
      const res = await ussdPost(ussdReq(phone, `*384#*2*${WRONG_PIN}`))
      expect(await res.text()).toContain('PIN not recognised')
    }
    // The 5th wrong after the reset is what trips it.
    const fifth = await ussdPost(ussdReq(phone, `*384#*2*${WRONG_PIN}`))
    expect(await fifth.text()).toContain('Too many wrong PINs')
  })

  it('the attendance branch records failures too (wrong PIN → not recognised → counted)', async () => {
    const phone = uniquePhone()
    for (let i = 0; i < 5; i++) await ussdPost(ussdReq(phone, `*384#*1*${WRONG_PIN}*1`))
    // Attendance attempts tripped the lock exactly like balance attempts.
    const res = await ussdPost(ussdReq(phone, '*384#*1*1234*1'))
    expect(await res.text()).toContain('Too many wrong PINs')
    expect(state.attendance.size).toBe(0)
  })
})

// --------------------------------------------------- phone-tail fallback policy

describe('phone-tail PIN fallback — demo posture vs shared-secret posture (BE-9)', () => {
  it('UNSET secret → last-4-of-phone resolves the worker (documented demo posture)', async () => {
    delete process.env.USSD_WEBHOOK_SECRET
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
    expect(String(doc.pinResolution)).toContain('dropped when USSD_WEBHOOK_SECRET is set')
    expect(String(doc.rateLimit)).toContain('20 requests/min/phone')
    expect(String(doc.rateLimit)).toContain('40 PIN-attempts/min per client IP')
    expect(String(doc.rateLimit)).toContain('15-minute line lockout')
    expect(String(doc.bodyCap)).toContain('64 KB')
    expect(String(doc.signature)).toContain('USSD_WEBHOOK_SECRET')
    expect(String(doc.honest)).toContain('No SMS/USSD aggregator is wired')
  })
})
