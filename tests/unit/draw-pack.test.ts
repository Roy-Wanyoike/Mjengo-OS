/**
 * W4-1 — Diaspora Evidence Draw Packs: immutable, hash-stamped proof bundles
 * frozen at milestone release and served through the revocable share link.
 *
 * Pinned here (one block per acceptance criterion):
 *   · ONE PACK PER RELEASE — approve writes exactly one DrawPack; the status
 *     ladder makes a re-decide impossible (second decide throws, zero new
 *     rows, zero new money); the service ALSO short-circuits on an existing
 *     pack, so no caller can ever mint a second one.
 *   · STABLE HASH — buildDrawPackContent is pure and deterministic; identical
 *     inputs produce identical content + identical SHA-256, key insertion
 *     order is irrelevant (canonical JSON), and the hash stored on the row
 *     round-trips: sha256(pack.content) === pack.contentHash after a DB read.
 *   · IMMUTABLE — the db stub deliberately exposes NO update/delete method
 *     for drawPack (the contract under test) + a source walk over src/ pins
 *     that no file calls drawPack.update/delete/upsert; the model carries no
 *     @updatedAt and the migration is additive-only.
 *   · SHARE SERVING — GET /api/share?token&drawPack serves the pack + the
 *     printable view data through the EXISTING token gate: revoked/regen
 *     token → the standard 404 'Invalid or expired link' BEFORE any pack
 *     lookup; valid token + foreign/unknown pack id → 404 (indistinguishable);
 *     valid token + own pack → 200 pack JSON.
 *   · RATE LIMIT — pack fetches count in the route's existing share.get
 *     30/min bucket: the 31st fetch in a frozen window → 429 + Retry-After.
 *   · HONEST SCORE — the pack cites MjengoScore only when the latest row had
 *     a computed score; no row or null-score row → explicit null (the i18n
 *     "not computed" copy is pinned below).
 *   · PROJECTION, NEVER MONEY — createDrawPackForRelease alone writes ZERO
 *     ledger transactions/entries, ZERO Transaction rows and touches no
 *     wallet; the release itself (approve path) posts exactly ONE ledger txn
 *     + ONE legacy Transaction; a failed pack write never fails the release
 *     (money already moved) and is audited as draw_pack create_failed.
 *   · AUDIT — every pack creation writes a kind 'draw_pack' audit event
 *     (entity-scoped to the DrawPack row, meta carries the contentHash).
 *   · SURFACE WIRING — money-tab links released milestones to their packs
 *     through the payload's drawPacks slice; the viewer fetches through
 *     /api/share?token&drawPack; en/sw carry every drawPack.* key.
 *
 * Mocks (mjengo-score / sync-flag-gate idioms): '@/backend/lib/db' (in-memory
 * stub with just enough Prisma: equality + gte/lte/in wheres, array orderBy,
 * $transaction = identity, nested ledger entries.create). applyAction,
 * releaseMilestoneAtomic, ledger posting, wallet session, the drawpack
 * module, route-kit and rate-limit all run REAL — the whole release path is
 * the code under test. No feature flags are involved (the release ladder is
 * documented to survive the wallet flag).
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    seq: 0,
    projects: new Map<string, Row>(),
    phases: new Map<string, Row>(),
    milestones: new Map<string, Row>(),
    variations: new Map<string, Row>(),
    attendances: new Map<string, Row>(),
    mjengoScores: new Map<string, Row>(),
    sitePhotos: new Map<string, Row>(),
    escrowWallets: new Map<string, Row>(),
    drawPacks: new Map<string, Row>(),
    ledgerAccounts: new Map<string, Row>(),
    ledgerTxns: [] as Row[],
    ledgerEntries: [] as Row[],
    transactions: new Map<string, Row>(),
    auditEvents: [] as Row[],
    notifications: [] as Row[],
    /** Mutation counters — the "projection, never money" assertions. */
    createCounts: {
      drawPack: 0, auditEvent: 0, notification: 0,
      ledgerTxn: 0, ledgerEntry: 0, ledgerAccount: 0, transaction: 0,
    },
    escrowUpdates: 0,
    /** Flip to simulate a pack write failure (release must still stand). */
    failDrawPackCreate: false,
    _id(prefix: string) {
      return `${prefix}_${++state.seq}`
    },
    reset() {
      state.seq = 0
      state.failDrawPackCreate = false
      for (const m of Object.values(state)) {
        if (m instanceof Map) m.clear()
      }
      state.ledgerTxns.length = 0
      state.ledgerEntries.length = 0
      state.auditEvents.length = 0
      state.notifications.length = 0
      state.createCounts = {
        drawPack: 0, auditEvent: 0, notification: 0,
        ledgerTxn: 0, ledgerEntry: 0, ledgerAccount: 0, transaction: 0,
      }
      state.escrowUpdates = 0
    },
  }

  /** Just enough of Prisma's where: equality, { gte }, { lte }, { in }, { not }. */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>
        if ('gte' in c && String(row[key]) < String(c.gte)) return false
        if ('lte' in c && String(row[key]) > String(c.lte)) return false
        if ('in' in c && !(c.in as unknown[]).includes(row[key])) return false
        if ('not' in c && row[key] === (c.not as unknown)) return false
        continue
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  /** orderBy as a single object OR an array (deterministic multi-key sort). */
  function sorted(rows: Row[], orderBy?: Row | Row[]): Row[] {
    if (!orderBy) return rows
    const keys = Array.isArray(orderBy) ? orderBy : [orderBy]
    return [...rows].sort((a, b) => {
      for (const o of keys) {
        const [[field, dir]] = Object.entries(o)
        const av = a[field], bv = b[field]
        const cmp =
          av instanceof Date || bv instanceof Date
            ? new Date(av as string).getTime() - new Date(bv as string).getTime()
            : String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
      }
      return 0
    })
  }

  const scoped = (map: Map<string, Row>, where: Row): Row[] =>
    [...map.values()].filter((r) => matches(r, where))

  /** Prisma select: project each row to the requested keys (order preserved). */
  const project = (rows: Row[], select?: Row): Row[] =>
    select ? rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : rows

  /** update data with { decrement } / { increment } atomics. */
  function applyUpdate(row: Row, data: Row): void {
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && ('decrement' in v || 'increment' in v)) {
        const c = v as { decrement?: number; increment?: number }
        row[k] = Number(row[k] ?? 0) - Number(c.decrement ?? 0) + Number(c.increment ?? 0)
      } else {
        row[k] = v
      }
    }
  }

  const cloneTxn = (r: Row): Row => ({
    ...r,
    entries: Array.isArray(r.entries) ? (r.entries as Row[]).map((e) => ({ ...e })) : [],
  })

  const db = {
    __state: state,
    // The real release path runs inside db.$transaction — identity passthrough
    // (single-threaded stub, every method is on the same object).
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),

    project: {
      async findUnique({ where }: { where: Row }) {
        if (where.id !== undefined) {
          const r = state.projects.get(String(where.id))
          return r ? { ...r } : null
        }
        if (where.shareToken !== undefined) {
          for (const r of state.projects.values()) {
            if (r.shareToken === where.shareToken) return { ...r }
          }
        }
        return null
      },
    },
    phase: {
      async findFirst({ where }: { where: Row }) {
        const rows = scoped(state.phases, where)
        return rows[0] ? { ...rows[0] } : null
      },
    },
    milestone: {
      async findFirst({ where }: { where: Row }) {
        const rows = scoped(state.milestones, where)
        return rows[0] ? { ...rows[0] } : null
      },
      async findMany({ where, orderBy }: { where: Row; orderBy?: Row | Row[] }) {
        return sorted(scoped(state.milestones, where), orderBy).map((m) => ({ ...m }))
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = state.milestones.get(String(where.id))
        if (!row) throw new Error('Record not found')
        applyUpdate(row, data)
        return { ...row }
      },
    },
    variationOrder: {
      async findMany({ where, orderBy }: { where: Row; orderBy?: Row | Row[] }) {
        return sorted(scoped(state.variations, where), orderBy).map((v) => ({ ...v }))
      },
    },
    attendance: {
      async findMany({ where }: { where: Row }) {
        return scoped(state.attendances, where).map((a) => ({ ...a }))
      },
    },
    mjengoScore: {
      async findFirst({ where, orderBy }: { where: Row; orderBy?: Row }) {
        const rows = sorted(scoped(state.mjengoScores, where), orderBy)
        return rows[0] ? { ...rows[0] } : null
      },
    },
    sitePhoto: {
      async findMany({ where, select }: { where: Row; select?: Row }) {
        return project(scoped(state.sitePhotos, where), select).map((p) => ({ ...p }))
      },
    },
    escrowWallet: {
      async findUnique({ where }: { where: Row }) {
        const r = state.escrowWallets.get(String(where.projectId))
        return r ? { ...r } : null
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = state.escrowWallets.get(String(where.projectId))
        if (!row) throw new Error('Record not found')
        state.escrowUpdates++
        applyUpdate(row, data)
        return { ...row }
      },
    },
    // Append-only by construction: create/findUnique/findFirst/findMany ONLY.
    // There is deliberately NO update/delete method — the immutability
    // contract under test (mirrors the MjengoScore stub idiom).
    drawPack: {
      async create({ data }: { data: Row }) {
        if (state.failDrawPackCreate) throw new Error('simulated draw pack write failure')
        const row: Row = {
          id: `dp_${++state.seq}`,
          currency: 'KES',
          evidencePhotoIds: '[]',
          variationsOpen: '[]',
          schemaVersion: 1,
          ...data,
        }
        if (!row.createdAt) row.createdAt = new Date()
        state.drawPacks.set(String(row.id), row)
        state.createCounts.drawPack++
        return { ...row }
      },
      async findUnique({ where }: { where: Row }) {
        let row: Row | undefined
        if (where.milestoneId !== undefined) {
          for (const r of state.drawPacks.values()) {
            if (r.milestoneId === where.milestoneId) { row = r; break }
          }
        } else if (where.id !== undefined) {
          row = state.drawPacks.get(String(where.id))
        }
        return row ? { ...row } : null
      },
      async findFirst({ where }: { where: Row }) {
        const rows = scoped(state.drawPacks, where)
        return rows[0] ? { ...rows[0] } : null
      },
      async findMany({ where, orderBy, select }: { where: Row; orderBy?: Row; select?: Row }) {
        return project(sorted(scoped(state.drawPacks, where), orderBy), select).map((p) => ({ ...p }))
      },
    },
    ledgerAccount: {
      async findUnique({ where }: { where: Row }) {
        const r = state.ledgerAccounts.get(String(where.code))
        return r ? { ...r } : null
      },
      async create({ data }: { data: Row }) {
        const row = { id: `la_${++state.seq}`, ...data }
        state.ledgerAccounts.set(String(row.code), row)
        state.createCounts.ledgerAccount++
        return { ...row }
      },
    },
    ledgerTransaction: {
      async findUnique({ where }: { where: Row }) {
        let row: Row | undefined
        if (where.idempotencyKey !== undefined) {
          row = state.ledgerTxns.find((t) => t.idempotencyKey === where.idempotencyKey)
        } else if (where.id !== undefined) {
          row = state.ledgerTxns.find((t) => t.id === where.id)
        }
        return row ? cloneTxn(row) : null
      },
      // Nested entries.create + include:{entries:true} — the real posting shape.
      async create({ data }: { data: Row }) {
        const nested = (data.entries as { create: Row[] } | undefined)?.create ?? []
        const { entries, ...rest } = data
        void entries
        const row: Row = { id: `lt_${++state.seq}`, status: 'posted', reversalOfId: null, reversalRef: null, ...rest }
        const entryRows = nested.map((e) => ({ id: `le_${++state.seq}`, txnId: row.id, ...e }))
        row.entries = entryRows
        state.ledgerTxns.push(row)
        state.ledgerEntries.push(...entryRows)
        state.createCounts.ledgerTxn++
        state.createCounts.ledgerEntry += entryRows.length
        return cloneTxn(row)
      },
    },
    transaction: {
      async findFirst({ where }: { where: Row }) {
        const rows = scoped(state.transactions, where)
        return rows[0] ? { ...rows[0] } : null
      },
      async create({ data }: { data: Row }) {
        const row = { id: `txn_${++state.seq}`, ...data }
        state.transactions.set(String(row.id), row)
        state.createCounts.transaction++
        return { ...row }
      },
    },
    auditEvent: {
      async create({ data }: { data: Row }) {
        const row = { id: `audit_${++state.seq}`, ...data }
        state.auditEvents.push(row)
        state.createCounts.auditEvent++
        return { ...row }
      },
    },
    notification: {
      async create({ data }: { data: Row }) {
        const row = { id: `notif_${++state.seq}`, ...data }
        state.notifications.push(row)
        state.createCounts.notification++
        return { ...row }
      },
    },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { GET as shareGet } from '@/app/api/share/route'
import { applyAction } from '@/backend/lib/mjengo'
import {
  buildDrawPackContent,
  canonicalJson,
  hashDrawPackContent,
  createDrawPackForRelease,
  getDrawPackForShare,
  loadDrawPacks,
  DRAW_PACK_SCHEMA_VERSION,
} from '@/backend/modules/drawpack/service'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    seq: number
    projects: Map<string, Record<string, unknown>>
    phases: Map<string, Record<string, unknown>>
    milestones: Map<string, Record<string, unknown>>
    variations: Map<string, Record<string, unknown>>
    attendances: Map<string, Record<string, unknown>>
    mjengoScores: Map<string, Record<string, unknown>>
    sitePhotos: Map<string, Record<string, unknown>>
    escrowWallets: Map<string, Record<string, unknown>>
    drawPacks: Map<string, Record<string, unknown>>
    ledgerAccounts: Map<string, Record<string, unknown>>
    ledgerTxns: Array<Record<string, unknown>>
    ledgerEntries: Array<Record<string, unknown>>
    transactions: Map<string, Record<string, unknown>>
    auditEvents: Array<Record<string, unknown>>
    notifications: Array<Record<string, unknown>>
    createCounts: {
      drawPack: number; auditEvent: number; notification: number
      ledgerTxn: number; ledgerEntry: number; ledgerAccount: number; transaction: number
    }
    escrowUpdates: number
    failDrawPackCreate: boolean
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

// ---------------- fixtures ----------------

const P1 = 'p-1'
const P2 = 'p-2'
const REQ = new Date('2026-02-01T09:00:00Z')
const DEC = new Date('2026-02-05T15:00:00Z')
// The action path stamps decidedAt = new Date() (real clock) — action fixtures
// place attendance rows RELATIVE to today so the window math is deterministic
// at any run time (dayEAT mirrors the service's dayStr).
const dayEAT = (d: Date) => new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10)
const dayOffset = (k: number) => dayEAT(new Date(Date.now() + k * 86_400_000))
const TODAY = dayOffset(0)

function seedProject(id = P1, shareToken = 'tok-1', client = 'Amina (Client)') {
  state.projects.set(id, {
    id, name: id === P1 ? 'Nyumba Yangu' : 'Kiambu Road Duplex', client,
    clientType: 'diaspora', location: 'Karen', budget: 4_500_000, status: 'active',
    shareToken, startDate: new Date('2026-01-05T09:00:00Z'), targetDate: new Date('2026-08-01T09:00:00Z'),
    createdAt: new Date('2026-01-05T09:00:00Z'), updatedAt: new Date('2026-01-05T09:00:00Z'),
  })
}

function seedReleaseRequested(id = 'm1', evidence = '["ph-1","ph-2"]', amount = 800_000) {
  state.milestones.set(id, {
    id, projectId: P1, phaseId: 'ph-1', name: 'Foundation complete', amount,
    status: 'release_requested', evidencePhotoIds: evidence,
    requestedAt: new Date(Date.now() - 3 * 86_400_000), decidedAt: null, decidedBy: null,
    decisionNote: null, releasedAt: null, createdAt: new Date('2026-01-10T09:00:00Z'),
  })
}

function seedWorld() {
  seedProject()
  seedProject(P2, 'tok-2', 'David (Client)')
  state.phases.set('ph-1', { id: 'ph-1', projectId: P1, name: 'Site Prep & Foundation', order: 1, budget: 900_000, status: 'in_progress', createdAt: REQ })
  state.escrowWallets.set(P1, { id: 'ew-1', projectId: P1, balance: 1_500_000, ledgerAccountId: null, createdAt: REQ, updatedAt: REQ })
  seedReleaseRequested()
  // evidence photos on project 1 + one on the foreign project
  state.sitePhotos.set('ph-1', { id: 'ph-1', projectId: P1, phaseId: 'ph-1', url: '/uploads/foundation-1.jpg', caption: 'Foundation rebar', createdAt: REQ })
  state.sitePhotos.set('ph-2', { id: 'ph-2', projectId: P1, phaseId: 'ph-1', url: '/uploads/foundation-2.jpg', caption: 'Formwork ready', createdAt: REQ })
  state.sitePhotos.set('ph-9', { id: 'ph-9', projectId: P2, phaseId: null, url: '/uploads/foreign.jpg', caption: 'Other project', createdAt: REQ })
  // variations: 2 submitted (frozen into the pack), 1 approved (excluded)
  state.variations.set('v1', { id: 'v1', projectId: P1, phaseId: 'ph-1', title: 'Black cotton soil', description: 'deeper foundation', budgetImpact: 180_000, status: 'submitted', submittedBy: 'Site Manager', createdAt: new Date('2026-01-28T09:00:00Z') })
  state.variations.set('v2', { id: 'v2', projectId: P1, phaseId: 'ph-1', title: 'Approved extra', description: 'already decided', budgetImpact: 50_000, status: 'approved', submittedBy: 'Site Manager', createdAt: new Date('2026-01-29T09:00:00Z') })
  state.variations.set('v3', { id: 'v3', projectId: P1, phaseId: null, title: 'Granite upgrade', description: 'counter upgrade', budgetImpact: 95_000, status: 'submitted', submittedBy: 'Site Manager', createdAt: new Date('2026-01-30T09:00:00Z') })
  // attendance relative to TODAY (the action's window is request→now)
  const att = (id: string, k: number, status: string, verification: string) => {
    state.attendances.set(id, { id, workerId: `w-${id}`, projectId: P1, date: dayOffset(k), status, method: 'geofence', wage: 500, paid: true, verification, createdAt: REQ })
  }
  att('a-out1', -4, 'present', 'verified') // before the request day → OUT
  att('a-in1', -2, 'present', 'verified') // IN
  att('a-in2', -1, 'half_day', 'reported') // IN
  att('a-in3', 0, 'present', 'verified') // IN (decision day)
  att('a-in4', 0, 'absent', 'verified') // IN (decision day, absent)
  att('a-out2', 1, 'present', 'verified') // after the decision day → OUT
  // a computed MjengoScore row (latest wins)
  state.mjengoScores.set('ms-1', { id: 'ms-1', projectId: P1, score: 90, confidence: 'high', components: '[]', notes: null, ruleVersion: '1', computedAt: new Date('2026-02-04T10:00:00Z') })
}

/** The pure builder input matching seedWorld's frozen facts (fixed dates). */
function pureInput() {
  return {
    milestoneId: 'm1',
    milestoneName: 'Foundation complete',
    amount: 800_000,
    ledgerRef: 'LX-2026-000001-424',
    ledgerTxnId: 'lt_1',
    evidencePhotoIds: ['ph-1', 'ph-2'],
    variations: [
      { id: 'v1', title: 'Black cotton soil', budgetImpact: 180_000, status: 'submitted', createdAt: new Date('2026-01-28T09:00:00Z') },
      { id: 'v2', title: 'Approved extra', budgetImpact: 50_000, status: 'approved', createdAt: new Date('2026-01-29T09:00:00Z') },
      { id: 'v3', title: 'Granite upgrade', budgetImpact: 95_000, status: 'submitted', createdAt: new Date('2026-01-30T09:00:00Z') },
    ],
    attendanceRows: [
      { date: '2026-01-31', status: 'present', verification: 'verified' }, // out
      { date: '2026-02-02', status: 'present', verification: 'verified' }, // in
      { date: '2026-02-03', status: 'half_day', verification: 'reported' }, // in
      { date: '2026-02-06', status: 'present', verification: 'verified' }, // out
    ],
    requestedAt: REQ,
    decidedAt: DEC,
    mjengoScore: { score: 90, confidence: 'high', ruleVersion: '1', computedAt: new Date('2026-02-04T10:00:00Z') },
  }
}

beforeEach(() => {
  state.reset()
  seedWorld()
})

// ================================================================ pure builder

describe('DrawPack content builder — determinism + canonical hash', () => {
  it('identical inputs build identical content and identical hash (twice, deep)', () => {
    const a = buildDrawPackContent(pureInput())
    const b = buildDrawPackContent(pureInput())
    expect(a).toEqual(b)
    expect(hashDrawPackContent(a)).toBe(hashDrawPackContent(b))
    expect(a.v).toBe(DRAW_PACK_SCHEMA_VERSION)
  })

  it('the hash is a 64-char lowercase hex SHA-256', () => {
    const h = hashDrawPackContent(buildDrawPackContent(pureInput()))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).toBe(sha256(canonicalJson(buildDrawPackContent(pureInput()))))
  })

  it('canonical JSON is key-order independent (insertion order cannot drift the hash)', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 2 }))
    expect(canonicalJson({ b: 2, a: 1 })).not.toBe(canonicalJson({ a: 2, b: 1 }))
  })

  it('one changed input field → a different hash (amount, evidence, variations, score)', () => {
    const base = () => buildDrawPackContent(pureInput())
    const h = hashDrawPackContent(base())
    const bump = (mutate: (c: ReturnType<typeof base>) => void) => {
      const c = base()
      mutate(c)
      return hashDrawPackContent(c)
    }
    expect(bump((c) => { c.amount = 801_000 })).not.toBe(h)
    expect(bump((c) => { c.evidencePhotoIds = ['ph-1'] })).not.toBe(h)
    expect(bump((c) => { c.variationsOpen = [] })).not.toBe(h)
    expect(bump((c) => { c.mjengoScore = null })).not.toBe(h)
    expect(bump((c) => { c.ledgerRef = 'LX-2026-000002-999' })).not.toBe(h)
  })

  it('frozen fields: only submitted variations ride along, deterministically ordered', () => {
    const c = buildDrawPackContent(pureInput())
    expect(c.variationsOpen.map((v) => v.id)).toEqual(['v1', 'v3'])
    expect(c.variationsOpen[0]).toMatchObject({ title: 'Black cotton soil', budgetImpact: 180_000 })
  })

  it('attendance window counts only rows inside request→decide (inclusive, string dates)', () => {
    const c = buildDrawPackContent(pureInput())
    expect(c.attendance).toEqual({
      windowStart: '2026-02-01',
      windowEnd: '2026-02-05',
      rows: 2,
      present: 1,
      halfDay: 1,
      absent: 0,
      excused: 0,
      verified: 1,
    })
  })

  it('a milestone without requestedAt falls back honestly to a one-day (decision-day) window', () => {
    const input = pureInput()
    input.requestedAt = null
    input.attendanceRows = [
      { date: '2026-02-04', status: 'present', verification: 'verified' }, // day before → out
      { date: '2026-02-05', status: 'present', verification: 'reported' }, // decision day → in
    ]
    const c = buildDrawPackContent(input)
    expect(c.attendance.windowStart).toBe('2026-02-05')
    expect(c.attendance.rows).toBe(1)
    expect(c.attendance.verified).toBe(0)
  })

  it('HONEST SCORE: no row → null; null-score row → null; computed row → frozen snapshot', () => {
    const none = pureInput()
    none.mjengoScore = null
    expect(buildDrawPackContent(none).mjengoScore).toBeNull()

    const young = pureInput()
    young.mjengoScore = { score: null, confidence: 'low', ruleVersion: '1', computedAt: new Date('2026-02-04T10:00:00Z') }
    expect(buildDrawPackContent(young).mjengoScore).toBeNull()

    const computed = buildDrawPackContent(pureInput()).mjengoScore
    expect(computed).toEqual({
      score: 90,
      confidence: 'high',
      ruleVersion: '1',
      computedAt: '2026-02-04T10:00:00.000Z',
    })
  })
})

// ================================================================ service (db stub)

describe('createDrawPackForRelease — one immutable pack, projection only', () => {
  const releaseInput = () => ({
    milestoneId: 'm1',
    milestoneName: 'Foundation complete',
    amount: 800_000,
    evidencePhotoIds: ['ph-1', 'ph-2'],
    requestedAt: new Date(Date.now() - 3 * 86_400_000),
    decidedAt: new Date(),
    ledgerRef: 'LX-2026-000001-424',
    ledgerTxnId: 'lt_1',
    decider: { name: 'Amina (Client)', role: 'client' },
  })

  it('freezes every documented field on ONE row', async () => {
    const pack = await createDrawPackForRelease(P1, releaseInput())
    expect(pack).not.toBeNull()
    expect(state.drawPacks.size).toBe(1)
    expect(pack).toMatchObject({
      milestoneId: 'm1',
      projectId: P1,
      milestoneName: 'Foundation complete',
      amount: 800_000,
      currency: 'KES',
      ledgerRef: 'LX-2026-000001-424',
      ledgerTxnId: 'lt_1',
      evidencePhotoIds: ['ph-1', 'ph-2'],
      schemaVersion: DRAW_PACK_SCHEMA_VERSION,
    })
    expect(pack!.variationsOpen.map((v) => v.id)).toEqual(['v1', 'v3'])
    // window relative to the seeded attendance rows
    expect(pack!.attendance.rows).toBe(4)
    expect(pack!.attendance.present).toBe(2)
    expect(pack!.attendance.halfDay).toBe(1)
    expect(pack!.attendance.absent).toBe(1)
    expect(pack!.attendance.verified).toBe(3)
    expect(pack!.mjengoScore).toMatchObject({ score: 90, confidence: 'high' })
    expect(pack!.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('calling it again for the same milestone returns the EXISTING pack — never a second row', async () => {
    const first = await createDrawPackForRelease(P1, releaseInput())
    const second = await createDrawPackForRelease(P1, releaseInput())
    expect(second).not.toBeNull()
    expect(second!.id).toBe(first!.id)
    expect(state.drawPacks.size).toBe(1)
    expect(state.createCounts.drawPack).toBe(1)
  })

  it('hash round-trips through the store: sha256(pack.content) === pack.contentHash after a DB read', async () => {
    await createDrawPackForRelease(P1, releaseInput())
    const packId = [...state.drawPacks.keys()][0]
    const found = await getDrawPackForShare(P1, packId)
    expect(found).not.toBeNull()
    expect(sha256(found!.pack.content)).toBe(found!.pack.contentHash)
    // and the canonical content parses back to the frozen snapshot
    const parsed = JSON.parse(found!.pack.content)
    expect(parsed.milestoneId).toBe('m1')
    expect(parsed.evidencePhotoIds).toEqual(['ph-1', 'ph-2'])
  })

  it('PROJECTION, NEVER MONEY: pack creation writes zero ledger rows, zero Transactions, zero wallet updates', async () => {
    await createDrawPackForRelease(P1, releaseInput())
    expect(state.createCounts.ledgerTxn).toBe(0)
    expect(state.createCounts.ledgerEntry).toBe(0)
    expect(state.createCounts.ledgerAccount).toBe(0)
    expect(state.createCounts.transaction).toBe(0)
    expect(state.escrowUpdates).toBe(0)
    expect(state.ledgerTxns).toEqual([])
    expect(state.transactions.size).toBe(0)
  })

  it('writes the draw_pack audit event, entity-scoped, with the contentHash in meta', async () => {
    const pack = await createDrawPackForRelease(P1, releaseInput())
    const events = state.auditEvents.filter((e) => e.kind === 'draw_pack')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actor: 'Amina (Client)', role: 'client', entity: 'DrawPack', entityId: pack!.id })
    expect(String(events[0].summary)).toContain('Evidence draw pack frozen')
    expect(String(events[0].summary)).toContain('LX-2026-000001-424')
    const meta = JSON.parse(String(events[0].meta))
    expect(meta).toMatchObject({ type: 'draw_pack.create', milestoneId: 'm1', drawPackId: pack!.id, contentHash: pack!.contentHash })
  })

  it('a failing pack write returns null, logs loudly, and audits create_failed — it never throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      state.failDrawPackCreate = true
      const pack = await createDrawPackForRelease(P1, releaseInput())
      expect(pack).toBeNull()
      expect(errSpy).toHaveBeenCalled()
      const failed = state.auditEvents.filter((e) => e.kind === 'draw_pack')
      expect(failed).toHaveLength(1)
      expect(String(failed[0].summary)).toContain('FAILED')
      const meta = JSON.parse(String(failed[0].meta))
      expect(meta.type).toBe('draw_pack.create_failed')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('the db stub documents the contract: NO update/delete method exists on drawPack', () => {
    const dp = db.drawPack as Record<string, unknown>
    for (const forbidden of ['update', 'updateMany', 'delete', 'deleteMany', 'upsert', 'createMany']) {
      expect(dp[forbidden], `db.drawPack.${forbidden} must not exist — packs are immutable`).toBeUndefined()
    }
  })
})

// ================================================================ the money.ts hook (real release)

describe('milestone.decide → approve hooks exactly one pack (real applyAction + real release)', () => {
  it('approve: releases atomically AND freezes one pack; result carries drawPackId', async () => {
    const result = await applyAction('milestone.decide', { id: 'm1', decision: 'approve', by: 'Amina (Client)' }, P1)
    // the release itself
    expect(result.balance).toBe(700_000)
    expect(result.ledgerRef).toMatch(/^LX-/)
    // the pack
    expect(result.drawPackId).toBeTruthy()
    expect(state.drawPacks.size).toBe(1)
    const pack = [...state.drawPacks.values()][0]
    expect(pack.ledgerRef).toBe(result.ledgerRef)
    expect(pack.ledgerTxnId).toBe(state.ledgerTxns[0].id)
    expect(String(pack.evidencePhotoIds)).toBe('["ph-1","ph-2"]')
    // exactly ONE money movement for the release, and the pack added none
    expect(state.createCounts.ledgerTxn).toBe(1)
    expect(state.createCounts.ledgerEntry).toBe(2)
    expect(state.createCounts.transaction).toBe(1)
    expect(state.escrowUpdates).toBe(1)
    // milestone flipped by the release transaction
    expect(state.milestones.get('m1')!.status).toBe('released')
    // BOTH audit rows: the action's own milestone event + the pack's draw_pack event
    expect(state.auditEvents.filter((e) => e.kind === 'milestone')).toHaveLength(1)
    expect(state.auditEvents.filter((e) => e.kind === 'draw_pack')).toHaveLength(1)
  })

  it('the pack hash served over share round-trips (sha256(content) === contentHash)', async () => {
    const result = await applyAction('milestone.decide', { id: 'm1', decision: 'approve' }, P1)
    const found = await getDrawPackForShare(P1, String(result.drawPackId))
    expect(found).not.toBeNull()
    expect(sha256(found!.pack.content)).toBe(found!.pack.contentHash)
  })

  it('RE-DECIDE IS IMPOSSIBLE: second approve throws the ladder error — no second pack, no second money', async () => {
    await applyAction('milestone.decide', { id: 'm1', decision: 'approve' }, P1)
    await expect(
      applyAction('milestone.decide', { id: 'm1', decision: 'approve' }, P1),
    ).rejects.toThrow('Milestone is not awaiting a client decision')
    await expect(
      applyAction('milestone.decide', { id: 'm1', decision: 'reject' }, P1),
    ).rejects.toThrow('Milestone is not awaiting a client decision')
    expect(state.drawPacks.size).toBe(1)
    expect(state.createCounts.ledgerTxn).toBe(1)
    expect(state.createCounts.transaction).toBe(1)
  })

  it('reject moves no money and freezes NO pack', async () => {
    const result = await applyAction('milestone.decide', { id: 'm1', decision: 'reject', note: 'rework first' }, P1)
    expect(result.drawPackId).toBeUndefined()
    expect(state.drawPacks.size).toBe(0)
    expect(state.createCounts.ledgerTxn).toBe(0)
    expect(state.createCounts.transaction).toBe(0)
    expect(state.milestones.get('m1')!.status).toBe('rejected')
    expect(state.auditEvents.filter((e) => e.kind === 'draw_pack')).toHaveLength(0)
  })

  it('a failing pack write NEVER fails the release (money already moved) — audited as create_failed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      state.failDrawPackCreate = true
      const result = await applyAction('milestone.decide', { id: 'm1', decision: 'approve' }, P1)
      // the release stands
      expect(result.balance).toBe(700_000)
      expect(result.drawPackId).toBeNull()
      expect(state.createCounts.ledgerTxn).toBe(1)
      expect(state.milestones.get('m1')!.status).toBe('released')
      // the failure is on the record
      expect(state.auditEvents.filter((e) => e.kind === 'draw_pack').map((e) => JSON.parse(String(e.meta)).type)).toEqual(['draw_pack.create_failed'])
    } finally {
      errSpy.mockRestore()
    }
  })
})

// ================================================================ share GET serving

describe('GET /api/share?token&drawPack — packs ride the EXISTING token gate', () => {
  let packId: string

  beforeEach(async () => {
    await applyAction('milestone.decide', { id: 'm1', decision: 'approve' }, P1)
    packId = String([...state.drawPacks.keys()][0])
  })

  const req = (query: string, ip = '198.51.100.7') =>
    new NextRequest(`http://localhost/api/share${query}`, { headers: { 'x-forwarded-for': ip } })

  it('valid token → 200 pack JSON + printable view data + project identity', async () => {
    const res = await shareGet(req(`?token=tok-1&drawPack=${packId}`, '198.51.100.1'), undefined)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.ok).toBe(true)
    expect(body.pack.milestoneId).toBe('m1')
    expect(body.pack.milestoneName).toBe('Foundation complete')
    expect(body.pack.amount).toBe(800_000)
    expect(body.pack.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256(body.pack.content)).toBe(body.pack.contentHash)
    expect(body.project).toMatchObject({ name: 'Nyumba Yangu', client: 'Amina (Client)', location: 'Karen' })
    // view data: the pack's evidence photo rows (id/url/caption)
    expect(body.photos).toHaveLength(2)
    expect(body.photos.map((p: { id: string }) => p.id).sort()).toEqual(['ph-1', 'ph-2'])
    expect(body.photos[0].url).toContain('/uploads/')
  })

  it('the response carries the honest MjengoScore snapshot (and null copy when absent)', async () => {
    const res = await shareGet(req(`?token=tok-1&drawPack=${packId}`, '198.51.100.2'), undefined)
    const body = (await res.json()) as Record<string, any>
    expect(body.pack.mjengoScore).toMatchObject({ score: 90, confidence: 'high' })

    // no score computed at all → explicit null (the "not computed" copy is pinned in i18n)
    seedReleaseRequested('m2', '["ph-1"]', 100_000)
    state.drawPacks.clear()
    state.mjengoScores.clear()
    await applyAction('milestone.decide', { id: 'm2', decision: 'approve' }, P1)
    const nullPackId = String([...state.drawPacks.keys()][0])
    const res2 = await shareGet(req(`?token=tok-1&drawPack=${nullPackId}`, '198.51.100.3'), undefined)
    const body2 = (await res2.json()) as Record<string, any>
    expect(body2.pack.mjengoScore).toBeNull()
  })

  it('pack of a DIFFERENT project → 404, indistinguishable from unknown', async () => {
    // a pack that exists but belongs to p-2
    state.drawPacks.set('dp-foreign', {
      ...[...state.drawPacks.values()][0],
      id: 'dp-foreign',
      projectId: P2,
      milestoneId: 'm-foreign',
    })
    const foreign = await shareGet(req('?token=tok-1&drawPack=dp-foreign', '198.51.100.4'), undefined)
    expect(foreign.status).toBe(404)
    expect((await foreign.json()).error).toBe('Draw pack not found')

    const unknown = await shareGet(req('?token=tok-1&drawPack=dp-nope', '198.51.100.5'), undefined)
    expect(unknown.status).toBe(404)
    expect((await unknown.json()).error).toBe('Draw pack not found')
  })

  it('REVOKED/REGENERATED token → the standard share 404 BEFORE any pack lookup', async () => {
    // regenerate = the project row now carries a different token
    state.projects.get(P1)!.shareToken = 'tok-regenerated'
    const res = await shareGet(req(`?token=tok-1&drawPack=${packId}`, '198.51.100.6'), undefined)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Invalid or expired link')
  })

  it('missing token → 400 (the existing GET contract, unchanged)', async () => {
    const res = await shareGet(req(`?drawPack=${packId}`, '198.51.100.8'), undefined)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Share token required')
  })

  it('pack fetches count in the existing share.get 30/min bucket — the 31st → 429 + Retry-After', async () => {
    vi.useFakeTimers()
    try {
      const ip = '203.0.113.77'
      let res: Awaited<ReturnType<typeof shareGet>>
      for (let i = 0; i < 30; i++) {
        res = await shareGet(req(`?token=tok-1&drawPack=${packId}`, ip), undefined)
        expect(res.status, `request ${i + 1} of 30 must pass`).toBe(200)
      }
      res = await shareGet(req(`?token=tok-1&drawPack=${packId}`, ip), undefined)
      expect(res.status).toBe(429)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toBe('Too many requests')
      expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ================================================================ payload + surface wiring (source-level)

describe('payload + money-tab wiring (grep-level contract)', () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

  it('getProjectPayload loads the drawPacks link slice (loadDrawPacks in the Promise.all)', () => {
    const src = read('src/backend/lib/mjengo.ts')
    expect(src).toContain('loadDrawPacks(project.id)')
    expect(src).toMatch(/drawPacks:\s*DrawPackLink\[\]/)
    expect(src).toMatch(/drawPacks,\s*\n\s*}/)
  })

  it('money-tab links released milestones to their packs and mounts the viewer', () => {
    const src = read('src/frontend/mjengo/money-tab.tsx')
    expect(src).toContain("m.status === 'released' && packFor(m.id)")
    expect(src).toContain('DrawPackViewer')
    expect(src).toContain("t('drawPack.view')")
    expect(src).toContain("t('drawPack.aria', { milestone: m.name })")
    expect(src).toContain('#draw-pack-print-root') // print isolation
  })

  it('the viewer fetches through the share token gate, never a new auth surface', () => {
    const src = read('src/frontend/mjengo/draw-pack-viewer.tsx')
    expect(src).toContain('/api/share?token=')
    expect(src).toMatch(/encodeURIComponent\(shareToken\)\}&drawPack=/)
  })

  it('loadDrawPacks returns link rows only (no bundle bytes on the live payload)', async () => {
    await applyAction('milestone.decide', { id: 'm1', decision: 'approve' }, P1)
    const rows = await loadDrawPacks(P1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: expect.any(String),
      milestoneId: 'm1',
      milestoneName: 'Foundation complete',
      amount: 800_000,
      ledgerRef: expect.stringMatching(/^LX-/),
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      createdAt: expect.any(String),
    })
    expect(Object.keys(rows[0]).sort()).toEqual(['amount', 'contentHash', 'createdAt', 'id', 'ledgerRef', 'milestoneId', 'milestoneName'])
  })
})

// ================================================================ immutability + migration (source-level)

describe('immutability: no update path exists anywhere', () => {
  /** Recursively collect .ts/.tsx files under a directory. */
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
    }
    return out
  }

  it('NO source file calls drawPack.update/updateMany/delete/deleteMany/upsert', () => {
    const root = fileURLToPath(new URL('../../src', import.meta.url))
    const offenders: string[] = []
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8')
      if (/\bdrawPack\.(update|updateMany|delete|deleteMany|upsert|createMany)\b/.test(src)) {
        offenders.push(file.replace(`${root}/`, ''))
      }
    }
    expect(offenders, `mutation calls found: ${offenders.join(', ')}`).toEqual([])
  })

  it('the schema model is append-only: unique milestoneId, no @updatedAt, one-to-one with Milestone', () => {
    const schema = readFileSync(fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)), 'utf8')
    expect(schema).toMatch(/model DrawPack \{/)
    expect(schema).toMatch(/milestoneId\s+String\s+@unique/)
    const model = schema.slice(schema.indexOf('model DrawPack'), schema.indexOf('}', schema.indexOf('model DrawPack')))
    expect(model).not.toContain('@updatedAt')
    expect(model).not.toContain('deletedAt')
    // the one-to-one back-relation on Milestone
    expect(schema).toMatch(/drawPack\s+DrawPack\?/)
  })

  it('the migration is additive-only: one CREATE TABLE + its unique index, nothing else', () => {
    const sql = readFileSync(fileURLToPath(new URL('../../prisma/migrations/2_draw_pack/migration.sql', import.meta.url)), 'utf8')
    // Comments stripped — comment text can legitimately say the word UPDATE.
    const body = sql.replace(/--[^\n]*/g, '')
    const statements = body.split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^CREATE TABLE "DrawPack" \(/)
    expect(statements[1]).toMatch(/^CREATE UNIQUE INDEX "DrawPack_milestoneId_key"/)
    const mutations = statements.filter((s) =>
      /^(ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|CREATE (TRIGGER|VIEW))/i.test(s),
    )
    expect(mutations, `mutation statements found: ${mutations.join(' || ')}`).toEqual([])
    expect(body.match(/CREATE TABLE/g)).toHaveLength(1)
  })

  it('the SQL columns match the Prisma model fields, mjengoScore nullable', () => {
    const sql = readFileSync(fileURLToPath(new URL('../../prisma/migrations/2_draw_pack/migration.sql', import.meta.url)), 'utf8')
    for (const col of [
      'id', 'milestoneId', 'projectId', 'milestoneName', 'amount', 'currency', 'ledgerRef',
      'ledgerTxnId', 'evidencePhotoIds', 'variationsOpen', 'attendanceSummary', 'mjengoScore',
      'contentHash', 'schemaVersion', 'createdAt',
    ]) {
      expect(sql).toContain(`"${col}"`)
    }
    const scoreLine = sql.split('\n').find((l) => l.includes('"mjengoScore"'))!
    expect(scoreLine).not.toContain('NOT NULL')
  })
})

// ================================================================ i18n

describe('en/sw dictionaries ship the drawPack keys', () => {
  const enKeys = Object.keys(enDict)
  const swKeys = Object.keys(swDict)

  it('every drawPack.* key exists in BOTH dictionaries with non-empty values', () => {
    const enPacks = enKeys.filter((k) => k.startsWith('drawPack.'))
    const swPacks = swKeys.filter((k) => k.startsWith('drawPack.'))
    expect(new Set(enPacks)).toEqual(new Set(swPacks))
    expect(enPacks.length).toBeGreaterThanOrEqual(28)
    for (const k of enPacks) {
      expect(enDict[k as keyof typeof enDict].trim().length).toBeGreaterThan(0)
      expect(swDict[k as keyof typeof swDict].trim().length).toBeGreaterThan(0)
    }
  })

  it('every t("drawPack.…") literal in the viewer + money-tab resolves in both dictionaries', () => {
    const sources = ['src/frontend/mjengo/draw-pack-viewer.tsx', 'src/frontend/mjengo/money-tab.tsx']
    const literals = new Set<string>()
    for (const rel of sources) {
      const src = readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
        if (m[1].startsWith('drawPack.')) literals.add(m[1])
      }
    }
    expect(literals.size).toBeGreaterThan(20) // the regex actually found keys
    for (const key of literals) {
      expect(enKeys, `en.ts missing "${key}"`).toContain(key)
      expect(swKeys, `sw.ts missing "${key}"`).toContain(key)
    }
  })

  it('the honest "not computed" score copy exists in both languages (AC: explicit null + copy)', () => {
    expect(enDict['drawPack.scoreNotComputed']).toContain('Not computed')
    expect(swDict['drawPack.scoreNotComputed']).toContain('Haikuhesabiwa')
  })

  it('the keys are appended at the END of each dict under the W4-1 header (merge-conflict contract)', () => {
    const enSrc = readFileSync(fileURLToPath(new URL('../../src/frontend/i18n/dicts/en.ts', import.meta.url)), 'utf8')
    const swSrc = readFileSync(fileURLToPath(new URL('../../src/frontend/i18n/dicts/sw.ts', import.meta.url)), 'utf8')
    for (const src of [enSrc, swSrc]) {
      const header = src.indexOf('# W4-1 draw packs')
      const lastKey = src.lastIndexOf("'drawPack.")
      const closing = src.indexOf('} satisfies Dict')
      expect(header).toBeGreaterThan(-1)
      expect(lastKey).toBeGreaterThan(header)
      expect(closing).toBeGreaterThan(lastKey) // the block is the last thing before the closing brace
    }
  })
})
