/**
 * W6-3 — the Evidence Authenticity Screen (src/backend/modules/ai/
 * authenticity.ts + the draw-pack post-freeze hook + the route).
 *
 * The whole fraud story of the feature, pinned (one block per AC):
 *   · THE DEMO AC — the same photo attached to milestone A's evidence and
 *     milestone B's evidence: screening at B's draw-pack freeze writes
 *     EXACTLY ONE 'duplicate' AiInsight whose detail names BOTH milestones
 *     and the Hamming distance ("this photo paid for the foundation AND the
 *     slab").
 *   · SINGLE-SWITCH GATING — flag OFF → the screen is a NO-OP: zero SDK
 *     calls (sdk.create never runs), zero PhotoHash rows, zero AiInsight
 *     rows, zero audit rows; the route answers the uniform 403 for
 *     non-admins; the tab section is hidden (source pin).
 *   · PROVIDER NULL (flag on, no .z-ai-config) → the deterministic hash half
 *     runs honestly (PhotoHash rows, no SDK contact) and the vision half is
 *     honestly skipped — zero vision rows, the skip reason recorded.
 *   · PROVIDER FAILURE → no fake insights: a failed/empty/unparseable vision
 *     attempt writes NOTHING, the pack and the release still succeed.
 *   · NEVER-FAILS HOOK — a screen that throws (hash write fails, insight
 *     write fails, or the planted module-level throw) NEVER fails the pack
 *     creation: the pack row + its detail come back, the failure is audited
 *     as 'ai_screen' failed, and money paths are untouched.
 *   · IDEMPOTENT BACKFILL — a second screen run cache-hits every PhotoHash
 *     row (nothing recomputed) and never double-writes an insight per
 *     (target, kind, matched-photo) window.
 *   · APPEND-ONLY + NO DECISION WRITES — no update/delete/upsert path for
 *     either model anywhere in src/ (grep), the db stub exposes only
 *     create/find for both, and no Wave-6 code path writes the
 *     decidedBy/decision/decidedAt columns (grep over the write sites).
 *   · NON-INFLUENCE — AiInsight/PhotoHash appear only in the ai module and
 *     its route; the mutating modules (money/mjengo/actions/jobs) stay
 *     insight-blind (grep-level, the mjengo-score allowlist pattern).
 *   · VISION DISCIPLINE — phase mismatch + render tells land as labeled
 *     rows with confidence; the cap holds; bytes resolve through the
 *     storage driver read seam (fake driver, the storage-document-read
 *     idiom); the prompt carries the milestone/phase context.
 *
 * Mocks (ai-provider / flags-gating / draw-pack idioms): '@/backend/lib/db'
 * is an in-memory stub; 'z-ai-web-dev-sdk' is vi.fn()s (the REAL SDK and its
 * .z-ai-config are NEVER touched); the storage driver is injected through
 * the module's own setStorageDriverForTests seam. The drawpack service, the
 * screen, the flags module, the audit logger and the provider seam run REAL
 * — the whole freeze path is the code under test. sharp runs on tiny
 * generated PNG buffers (in-test, no fixtures on disk).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

// ---------------------------------------------------------------- SDK mock

// The SDK, swapped for vi.fn()s — NO network, NO config file in this suite.
const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  chatCreate: vi.fn(),
  visionCreate: vi.fn(),
  asrCreate: vi.fn(),
}))

vi.mock('z-ai-web-dev-sdk', () => ({
  default: { create: sdk.create },
}))

// ---------------------------------------------------------------- db stub

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    seq: 0,
    projects: new Map<string, Row>(),
    phases: new Map<string, Row>(),
    milestones: new Map<string, Row>(),
    sitePhotos: new Map<string, Row>(),
    drawPacks: new Map<string, Row>(),
    variationOrders: new Map<string, Row>(),
    attendances: new Map<string, Row>(),
    mjengoScores: new Map<string, Row>(),
    photoHashes: new Map<string, Row>(),
    aiInsights: new Map<string, Row>(),
    auditEvents: [] as Row[],
    /** featureFlag rows — `ai` starts OFF (FLAG_DEFAULTS, task 8-f). */
    flagRows: [
      { key: 'ai_progress', enabled: true, description: 'AI progress' },
      { key: 'ai_voice', enabled: true, description: 'AI voice' },
      { key: 'wallet', enabled: true, description: 'Wallet' },
      { key: 'marketplace', enabled: true, description: 'Marketplace' },
      { key: 'land_verification', enabled: true, description: 'Land' },
      { key: 'ai', enabled: false, description: 'AI features' },
    ] as Array<Row>,
    /** Mutation counters + planted failures (the never-fails pins). */
    createCounts: { photoHash: 0, aiInsight: 0, drawPack: 0, auditEvent: 0 } as Record<string, number>,
    failPhotoHashCreate: false,
    failAiInsightCreate: false,
    failSitePhotoFind: false,
    failFlagRead: false,
    _id(prefix: string) {
      return `${prefix}_${++state.seq}`
    },
    reset() {
      state.seq = 0
      for (const m of [state.projects, state.phases, state.milestones, state.sitePhotos, state.drawPacks, state.variationOrders, state.attendances, state.mjengoScores, state.photoHashes, state.aiInsights]) {
        m.clear()
      }
      state.auditEvents.length = 0
      state.createCounts = { photoHash: 0, aiInsight: 0, drawPack: 0, auditEvent: 0 }
      state.failPhotoHashCreate = false
      state.failAiInsightCreate = false
      state.failSitePhotoFind = false
      state.failFlagRead = false
      const aiRow = state.flagRows.find((r) => r.key === 'ai')
      if (aiRow) aiRow.enabled = false
    },
  }

  /** Just enough Prisma where: equality, { in }. */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>
        if ('in' in c && !(c.in as unknown[]).includes(row[key])) return false
        continue
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  /** orderBy single object OR array; take. */
  function list(map: Map<string, Row>, opts: { where?: Row; orderBy?: Row | Row[]; take?: number } = {}): Row[] {
    let rows = [...map.values()].filter((r) => matches(r, opts.where ?? {}))
    const ob = opts.orderBy
    if (ob) {
      const keys = Array.isArray(ob) ? ob : [ob]
      rows = rows.sort((a, b) => {
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
    if (opts.take !== undefined) rows = rows.slice(0, opts.take)
    return rows.map((r) => ({ ...r }))
  }

  const db = {
    __state: state,
    project: {
      async findUnique({ where, select }: { where: Row; select?: Row }) {
        const r = where.id !== undefined ? state.projects.get(String(where.id)) : null
        if (!r) return null
        if (select) return Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))
        return { ...r }
      },
      async findFirst() {
        const first = [...state.projects.values()][0]
        return first ? { ...first } : null
      },
    },
    phase: {
      async findMany(opts: { where?: Row; orderBy?: Row | Row[] }) {
        return list(state.phases, opts)
      },
    },
    milestone: {
      async findUnique({ where }: { where: Row }) {
        const r = state.milestones.get(String(where.id ?? where.milestoneId))
        return r ? { ...r } : null
      },
    },
    sitePhoto: {
      async findMany(opts: { where?: Row; orderBy?: Row | Row[]; take?: number }) {
        if (state.failSitePhotoFind) throw new Error('planted sitePhoto failure')
        return list(state.sitePhotos, opts)
      },
    },
    drawPack: {
      async findUnique({ where }: { where: Row }) {
        const r = where.milestoneId !== undefined
          ? [...state.drawPacks.values()].find((p) => p.milestoneId === where.milestoneId)
          : where.id !== undefined ? state.drawPacks.get(String(where.id)) : null
        return r ? { ...r } : null
      },
      async findMany(opts: { where?: Row; orderBy?: Row | Row[] }) {
        return list(state.drawPacks, opts)
      },
      async create({ data }: { data: Row }) {
        const row = { id: state._id('pack'), ...data, createdAt: new Date() }
        state.drawPacks.set(row.id, row)
        state.createCounts.drawPack++
        return { ...row }
      },
    },
    variationOrder: {
      async findMany(opts: { where?: Row; orderBy?: Row | Row[] }) {
        return list(state.variationOrders, opts)
      },
    },
    attendance: {
      async findMany(opts: { where?: Row }) {
        return list(state.attendances, opts)
      },
    },
    mjengoScore: {
      async findFirst(_opts: { where?: Row; orderBy?: Row | Row[] }) {
        return null // honest: no score computed at release (drawpack allows null)
      },
    },
    photoHash: {
      async findMany(opts: { where?: Row }) {
        return list(state.photoHashes, opts)
      },
      async create({ data }: { data: Row }) {
        if (state.failPhotoHashCreate) throw new Error('planted photoHash.create failure')
        const row = { id: state._id('ph'), ...data, computedAt: new Date() }
        state.photoHashes.set(String(row.photoId), row)
        state.createCounts.photoHash++
        return { ...row }
      },
    },
    aiInsight: {
      async findMany(opts: { where?: Row; orderBy?: Row | Row[] }) {
        return list(state.aiInsights, opts)
      },
      async create({ data }: { data: Row }) {
        if (state.failAiInsightCreate) throw new Error('planted aiInsight.create failure')
        const row = { id: state._id('ins'), ...data, createdAt: new Date() }
        state.aiInsights.set(row.id, row)
        state.createCounts.aiInsight++
        return { ...row }
      },
    },
    featureFlag: {
      async upsert({ where, create }: { where: { key: string }; create: Row }) {
        if (!state.flagRows.find((r) => r.key === where.key)) state.flagRows.push({ ...create })
        const row = state.flagRows.find((r) => r.key === where.key)
        return row ? { ...row } : { ...create }
      },
      async findMany({ where }: { where?: { key?: { in?: string[] } } }) {
        if (state.failFlagRead) throw new Error('planted flag-table read failure')
        const keys = where?.key?.in
        return state.flagRows.filter((r) => !keys || keys.includes(String(r.key))).map((r) => ({ ...r }))
      },
      async update() { return null },
    },
    auditEvent: {
      async create({ data }: { data: Row }) {
        state.auditEvents.push({ id: state._id('evt'), ...data })
        state.createCounts.auditEvent++
        return { ...data }
      },
    },
  }
  return { db }
})

// ------------------------------------------- authenticity module escape hatch

// The drawpack belt-and-braces catch: the hook can be made to THROW at the
// module boundary (a future programming error) while every other test still
// runs the real screen. importOriginal keeps the rest of the module intact.
const planted = vi.hoisted(() => ({ throwOnHook: false }))
vi.mock('@/backend/modules/ai/authenticity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/modules/ai/authenticity')>()
  return {
    ...actual,
    runPostFreezeAuthenticityScreen: async (...args: Parameters<typeof actual.runPostFreezeAuthenticityScreen>) => {
      if (planted.throwOnHook) throw new Error('planted hook throw — belt and braces')
      return actual.runPostFreezeAuthenticityScreen(...args)
    },
  }
})

// ---------------------------------------------------------------- guard mock

// Controllable session for the route tests (enforceAiRoutePolicy +
// requireFlagOn read it through the mocked guard — the flags-gating idiom).
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))
vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
  const getSessionFromReq = vi.fn(async () => h.session)
  return {
    getSessionFromReq,
    unauthorized: () => NextResponse.json({ error: 'Sign in required' }, { status: 401 }),
    forbidden: (role?: string) =>
      NextResponse.json({ error: role ? `Not permitted for role "${role}"` : 'Not permitted' }, { status: 403 }),
    safeErrorMessage: (e: unknown, fallback: string) =>
      e instanceof Error && !e.message.includes('\n') ? e.message : fallback,
    FINANCE_ROLES: ['finance', 'admin'],
    PAYMENT_ROLES: ['finance', 'admin', 'client'],
    KNOWN_ROLES: ['contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs'],
    OWNER_ROLES: ['contractor', 'admin', 'supervisor', 'procurement', 'qs', 'finance'],
  }
})

// ---------------------------------------------------------------- imports

import { db } from '@/backend/lib/db'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'
import { resetAiSdkCache } from '@/backend/modules/ai/provider'
import { setStorageDriverForTests } from '@/backend/lib/storage'
import type { StorageAdapter } from '@/backend/lib/storage'
import {
  VISION_PHOTOS_CAP,
  constrainPhaseName,
  loadAuthenticityInsights,
  parseVisionVerdict,
  redactModelFigures,
  runAuthenticityScreen,
} from '@/backend/modules/ai/authenticity'
import { createDrawPackForRelease } from '@/backend/modules/drawpack/service'
import { GET, POST } from '@/app/api/ai/authenticity-screen/route'

/** The db stub's in-memory state, reached through the __state test seam. */
interface StubState {
  seq: number
  projects: Map<string, Record<string, unknown>>
  phases: Map<string, Record<string, unknown>>
  milestones: Map<string, Record<string, unknown>>
  sitePhotos: Map<string, Record<string, unknown>>
  drawPacks: Map<string, Record<string, unknown>>
  photoHashes: Map<string, Record<string, unknown>>
  aiInsights: Map<string, Record<string, unknown>>
  auditEvents: Array<Record<string, unknown>>
  flagRows: Array<{ key: string; enabled: boolean }>
  createCounts: Record<string, number>
  failPhotoHashCreate: boolean
  failAiInsightCreate: boolean
  failSitePhotoFind: boolean
  failFlagRead: boolean
  reset(): void
  _id(prefix: string): string
}

const state = { __state: (db as unknown as { __state: StubState }).__state }

// ---------------------------------------------------------------- fixtures

/** Two deterministic tiny PNG scenes (distinct dHashes — see the hash suite). */
async function scenePng(variant: 'a' | 'b'): Promise<Buffer> {
  const pixel = (x: number, y: number): [number, number, number] => {
    if (variant === 'a') {
      const v = (x * 61 + y * 17) % 256
      return [v, v, v]
    }
    const v = x < 9 ? 220 : 40
    return [v, v, v]
  }
  const w = 18
  const hgt = 16
  const data = Buffer.alloc(w * hgt * 3)
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y)
      const i = (y * w + x) * 3
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
    }
  }
  return sharp(data, { raw: { width: w, height: hgt, channels: 3 } }).png().toBuffer()
}

/** The fake storage driver + its byte store (url → bytes). */
const bytesByUrl = new Map<string, Buffer>()
const fakeDriver: StorageAdapter = {
  id: 'local-disk',
  canPresign: false,
  put: async () => {},
  publicUrl: (key: string) => `/photos/${key}`,
  keyFor: (url: string) => (url.startsWith('/photos/') ? url.slice('/photos/'.length) : null),
  read: async (key: string) => {
    const bytes = bytesByUrl.get(`/photos/${key}`)
    return bytes ? { bytes, contentType: 'image/png', sizeBytes: bytes.length } : null
  },
}

const VISION_JSON_OK = JSON.stringify({
  phaseShown: 'Walling',
  matchesClaim: false,
  confidence: 'medium',
  renderTells: [],
  observation: 'Walls to lintel level.',
})
const VISION_JSON_MATCH = JSON.stringify({
  phaseShown: 'Foundation',
  matchesClaim: true,
  confidence: 'high',
  renderTells: [],
  observation: 'Footings and stub columns.',
})

let sceneA: Buffer
let sceneB: Buffer

/** Seed one project + phase + photo; returns the photo row. */
function seedPhoto(id: string, scene: 'a' | 'b', createdAt: Date): Record<string, unknown> {
  const url = `/photos/${id}.png`
  bytesByUrl.set(url, scene === 'a' ? sceneA : sceneB)
  const row = { id, projectId: 'p-1', url, caption: `photo ${id}`, phaseId: 'ph-1', createdAt }
  state.__state.sitePhotos.set(id, row)
  return row
}

/** The fake SDK instance create() resolves to. */
const fakeInstance = () => ({
  chat: { completions: { create: sdk.chatCreate, createVision: sdk.visionCreate } },
  audio: { asr: { create: sdk.asrCreate } },
})

function setAiFlag(enabled: boolean) {
  const row = state.__state.flagRows.find((r) => r.key === 'ai')
  if (row) row.enabled = enabled
  invalidateFlagCache()
}

/** Freeze a pack for a milestone through the REAL service (hook included). */
async function freezePack(input: {
  milestoneId: string
  milestoneName: string
  evidencePhotoIds: string[]
}): Promise<ReturnType<typeof createDrawPackForRelease>> {
  return createDrawPackForRelease('p-1', {
    milestoneId: input.milestoneId,
    milestoneName: input.milestoneName,
    amount: 100_000,
    evidencePhotoIds: input.evidencePhotoIds,
    requestedAt: new Date('2026-09-01T10:00:00Z'),
    decidedAt: new Date(),
    ledgerRef: 'LX-000001',
    ledgerTxnId: 'lt-1',
    decider: { name: 'Mama Njeri', role: 'client' },
  })
}

function insights(): Array<Record<string, unknown>> {
  return [...state.__state.aiInsights.values()]
}
function photoHashes(): Array<Record<string, unknown>> {
  return [...state.__state.photoHashes.values()]
}
function auditOf(type: string): Array<Record<string, unknown>> {
  return state.__state.auditEvents.filter((e) => {
    try {
      const meta = typeof e.meta === 'string' ? JSON.parse(e.meta) : (e.meta ?? {})
      return meta?.type === type
    } catch {
      return false
    }
  })
}

beforeEach(async () => {
  state.__state.reset()
  bytesByUrl.clear()
  planted.throwOnHook = false
  h.session = null
  sdk.create.mockReset()
  sdk.chatCreate.mockReset()
  sdk.visionCreate.mockReset()
  sdk.asrCreate.mockReset()
  sdk.create.mockResolvedValue(fakeInstance())
  sdk.visionCreate.mockResolvedValue({ choices: [{ message: { content: VISION_JSON_MATCH } }] })
  resetAiSdkCache()
  invalidateFlagCache()
  setStorageDriverForTests(fakeDriver)
  sceneA = await scenePng('a')
  sceneB = await scenePng('b')

  state.__state.projects.set('p-1', {
    id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', location: 'Karen',
    shareToken: 'tok-1', startDate: new Date('2026-01-05T09:00:00Z'),
  })
  state.__state.phases.set('ph-1', { id: 'ph-1', projectId: 'p-1', name: 'Foundation', order: 1 })
  state.__state.phases.set('ph-2', { id: 'ph-2', projectId: 'p-1', name: 'Walling', order: 2 })
  state.__state.milestones.set('m-1', {
    id: 'm-1', projectId: 'p-1', phaseId: 'ph-1', name: 'Foundation complete',
    amount: 100_000, status: 'released', evidencePhotoIds: '[]',
  })
  state.__state.milestones.set('m-2', {
    id: 'm-2', projectId: 'p-1', phaseId: 'ph-2', name: 'Slab cast',
    amount: 200_000, status: 'released', evidencePhotoIds: '[]',
  })
})

// ================================================== the single-switch gate

describe('gating — one `ai` switch for the whole screen', () => {
  it('flag OFF → the screen is a NO-OP: no rows, no audit, sdk.create never called', async () => {
    setAiFlag(false)
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    const outcome = await runAuthenticityScreen({ projectId: 'p-1' })
    expect(outcome).toMatchObject({ ok: true, ran: false, reason: 'flag_off' })
    expect(photoHashes()).toHaveLength(0)
    expect(insights()).toHaveLength(0)
    expect(state.__state.auditEvents).toHaveLength(0)
    expect(sdk.create).not.toHaveBeenCalled()
    expect(sdk.visionCreate).not.toHaveBeenCalled()
  })

  it('flag OFF → the post-freeze hook no-ops silently (pack still created, no screen rows)', async () => {
    setAiFlag(false)
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    const pack = await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    expect(pack).not.toBeNull()
    expect(photoHashes()).toHaveLength(0)
    expect(insights()).toHaveLength(0)
    expect(sdk.create).not.toHaveBeenCalled()
    // Only the pack's own audit event — no ai_screen row.
    expect(auditOf('ai_screen.run')).toHaveLength(0)
  })

  it('flag ON, no photos → honest no-op with reason no_photos', async () => {
    setAiFlag(true)
    const outcome = await runAuthenticityScreen({ projectId: 'p-1' })
    expect(outcome).toMatchObject({ ok: true, ran: false, reason: 'no_photos' })
  })

  it('flag key ABSENT fails closed (a fresh install with no flag rows)', async () => {
    state.__state.flagRows.length = 0
    invalidateFlagCache()
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    const outcome = await runAuthenticityScreen({ projectId: 'p-1' })
    expect(outcome).toMatchObject({ ok: true, ran: false, reason: 'flag_off' })
    expect(photoHashes()).toHaveLength(0)
  })

  it('an UNREADABLE flag table fails closed — the screen no-ops SILENTLY (no failure audit, no rows)', async () => {
    state.__state.failFlagRead = true
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    const outcome = await runAuthenticityScreen({ projectId: 'p-1' })
    expect(outcome).toMatchObject({ ok: true, ran: false, reason: 'flag_off' })
    expect(photoHashes()).toHaveLength(0)
    expect(insights()).toHaveLength(0)
    // A switch you cannot read is OFF — not a screen failure: no 'ai_screen'
    // failed audit row, no console error spam on every pack freeze.
    expect(auditOf('ai_screen.failed')).toHaveLength(0)
    expect(auditOf('ai_screen.run')).toHaveLength(0)
    expect(sdk.create).not.toHaveBeenCalled()
    // The same fail-closed state through the freeze hook: the pack stands and
    // the hook stays silent (the legacy draw-pack stub has no featureFlag
    // delegate at all — this is that environment, made explicit).
    const pack = await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    expect(pack).not.toBeNull()
    expect(state.__state.drawPacks.size).toBe(1)
    expect(auditOf('ai_screen.failed')).toHaveLength(0)
    expect(photoHashes()).toHaveLength(0)
  })
})

// ================================================== the demo AC

describe('THE DEMO AC — the same photo paid for two milestones', () => {
  beforeEach(() => {
    setAiFlag(true)
  })

  it('same photo id in milestone A and milestone B → exactly ONE duplicate insight naming both milestones + the Hamming distance', async () => {
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    // First release: the foundation pack freezes + screens the photo.
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    expect(insights()).toHaveLength(0) // no prior packs — nothing to match
    expect(photoHashes()).toHaveLength(1)

    // Second release: the SAME photo id is milestone B's evidence.
    await freezePack({ milestoneId: 'm-2', milestoneName: 'Slab cast', evidencePhotoIds: ['photo-1'] })

    const rows = insights()
    expect(rows).toHaveLength(1) // EXACTLY one
    const row = rows[0]
    expect(row.kind).toBe('duplicate')
    expect(row.source).toBe('dhash')
    expect(row.severity).toBe('critical')
    expect(row.targetType).toBe('site_photo')
    expect(row.targetId).toBe('photo-1')
    expect(row.confidence).toBeNull() // rules carry no confidence
    const detail = JSON.parse(String(row.detail))
    expect(detail.match).toBe('cross_pack')
    expect(detail.matchedMilestoneName).toBe('Foundation complete')
    expect(detail.milestoneName).toBe('Slab cast')
    expect(detail.matchedPackId).toBe(String([...state.__state.drawPacks.values()][0].id))
    expect(detail.hammingDistance).toBe(0)
    expect(detail.threshold).toBe(6)
  })

  it('same BYTES re-uploaded as a NEW photo id in pack B → one cross-pack duplicate with distance 0', async () => {
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    // A "fresh" upload that is actually the same file.
    seedPhoto('photo-2', 'a', new Date('2026-08-20T09:00:00Z'))
    await freezePack({ milestoneId: 'm-2', milestoneName: 'Slab cast', evidencePhotoIds: ['photo-2'] })

    const rows = insights()
    expect(rows).toHaveLength(1)
    const detail = JSON.parse(String(rows[0].detail))
    expect(rows[0].kind).toBe('duplicate')
    expect(detail.match).toBe('cross_pack')
    // The NEWER submission is the target; the older photo is the match.
    expect(rows[0].targetId).toBe('photo-2')
    expect(detail.matchedPhotoId).toBe('photo-1')
    expect(detail.matchedMilestoneName).toBe('Foundation complete')
    expect(detail.hammingDistance).toBe(0)
  })

  it('DISTINCT photos in two packs → no duplicate row', async () => {
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    seedPhoto('photo-2', 'b', new Date('2026-08-20T09:00:00Z'))
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    await freezePack({ milestoneId: 'm-2', milestoneName: 'Slab cast', evidencePhotoIds: ['photo-2'] })
    const dups = insights().filter((r) => r.kind === 'duplicate')
    expect(dups).toHaveLength(0)
  })

  it('two different photo ids with the SAME image inside ONE pack → one within_pack duplicate (warning)', async () => {
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    seedPhoto('photo-2', 'a', new Date('2026-08-02T09:00:00Z'))
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1', 'photo-2'] })
    const dups = insights().filter((r) => r.kind === 'duplicate')
    expect(dups).toHaveLength(1)
    expect(dups[0].severity).toBe('warning')
    expect(JSON.parse(String(dups[0].detail)).match).toBe('within_pack')
  })

  it('a pack photo matching an EARLIER UNPAID photo (project history) → one project_history duplicate', async () => {
    // photo-1 exists in the project (uploaded, never paid on); photo-2 is the
    // same image and IS the pack's evidence. The pair surfaces on the
    // ON-DEMAND run (which backfills hashes for the whole photo history —
    // the freeze hook only screens the pack's own set).
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    seedPhoto('photo-2', 'a', new Date('2026-08-02T09:00:00Z'))
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-2'] })
    expect(insights().filter((r) => r.kind === 'duplicate')).toHaveLength(0)
    await runAuthenticityScreen({ projectId: 'p-1' }) // the backfill run
    const dups = insights().filter((r) => r.kind === 'duplicate')
    expect(dups).toHaveLength(1)
    const detail = JSON.parse(String(dups[0].detail))
    expect(detail.match).toBe('project_history')
    expect(detail.matchedPhotoId).toBe('photo-1')
    expect(dups[0].targetId).toBe('photo-2') // the newer submission carries the flag
  })
})

// ================================================== provider null / failure

describe('provider null (flag on, no .z-ai-config) — deterministic half runs, vision honestly skipped', () => {
  beforeEach(() => {
    setAiFlag(true)
  })

  it('sdk.create rejects → PhotoHash rows still written, zero vision rows, honest skip note', async () => {
    sdk.create.mockRejectedValue(new Error('Configuration file not found or invalid.'))
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    const outcome = await runAuthenticityScreen({ projectId: 'p-1' })
    expect(outcome).toMatchObject({ ok: true, ran: true, hashed: 1 })
    if (outcome.ok && outcome.ran) {
      expect(outcome.vision.provider).toBe('unavailable')
      expect(outcome.vision.insights).toBe(0)
      expect(outcome.vision.skipped).toContain('unavailable')
    }
    expect(photoHashes()).toHaveLength(1)
    expect(insights().filter((r) => r.source === 'vision')).toHaveLength(0)
    expect(sdk.visionCreate).not.toHaveBeenCalled()
    // The screen still ran end-to-end (its audit row exists, honest note).
    expect(auditOf('ai_screen.run')).toHaveLength(1)
  })

  it('provider null via the freeze hook → the pack still freezes and the hash row stands', async () => {
    sdk.create.mockRejectedValue(new Error('Configuration file not found or invalid.'))
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    const pack = await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    expect(pack).not.toBeNull()
    expect(photoHashes()).toHaveLength(1)
    expect(insights()).toHaveLength(0)
  })
})

describe('provider failure — no fake insights, leak-free', () => {
  beforeEach(() => {
    setAiFlag(true)
  })

  it('vision SDK throws (HTTP 429 with a key fragment) → zero vision rows, no leak into any row or audit', async () => {
    sdk.visionCreate.mockRejectedValue(new Error('API request failed with status 429: rate limited for key sk-live-999'))
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    const outcome = await runAuthenticityScreen({ projectId: 'p-1' })
    if (outcome.ok && outcome.ran) {
      expect(outcome.vision.insights).toBe(0)
      expect(outcome.vision.skipped).toContain('failed')
    }
    expect(insights()).toHaveLength(0)
    // Leak-free: the provider error never reaches rows or audit events.
    const everything = JSON.stringify([...insights(), ...state.__state.auditEvents])
    expect(everything).not.toContain('sk-live-999')
    expect(everything).not.toContain('429')
  })

  it('vision returns an unparseable answer → honest skip, zero rows', async () => {
    sdk.visionCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'I cannot say, sorry.' } }] })
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    const outcome = await runAuthenticityScreen({ projectId: 'p-1' })
    if (outcome.ok && outcome.ran) expect(outcome.vision.insights).toBe(0)
    expect(insights()).toHaveLength(0)
  })

  it('vision returns an empty model answer → honest skip, zero rows', async () => {
    sdk.visionCreate.mockResolvedValueOnce({ choices: [{ message: { content: '   ' } }] })
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    await runAuthenticityScreen({ projectId: 'p-1' })
    expect(insights()).toHaveLength(0)
  })

  it('vision verdict says the phase MATCHES → no insight row', async () => {
    sdk.visionCreate.mockResolvedValueOnce({ choices: [{ message: { content: VISION_JSON_MATCH } }] })
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    await runAuthenticityScreen({ projectId: 'p-1' })
    expect(insights().filter((r) => r.source === 'vision')).toHaveLength(0)
  })
})

// ================================================== pure sanitize rules

describe('pure parse/sanitize rules — the ledger decides numbers, rows decide phase names', () => {
  it('redactModelFigures strips every digit run (the W6-1 draw-review twin)', () => {
    expect(redactModelFigures('KSh 650,000 for 12 courses of 450mm stone')).toBe('KSh # for # courses of #mm stone')
    expect(redactModelFigures('no numbers here')).toBe('no numbers here')
    expect(redactModelFigures('photo taken 2024-01-05 at 09:00')).toBe('photo taken #-#-# at #:#')
    expect(redactModelFigures('')).toBe('')
  })

  it('parseVisionVerdict redacts model figures in the observation + render tells at parse time', () => {
    const v = parseVisionVerdict(JSON.stringify({
      phaseShown: 'Foundation', matchesClaim: true, confidence: 'low',
      renderTells: ['rendering app v2.5 UI chrome visible'],
      observation: 'Screed of 40mm over 200 sqm, cost KSh 650,000',
    }))
    expect(v).not.toBeNull()
    expect(v!.observation).not.toMatch(/\d/)
    expect(v!.observation).toContain('KSh #')
    expect(v!.renderTells).toHaveLength(1)
    expect(v!.renderTells[0]).not.toMatch(/\d/)
  })

  it('constrainPhaseName: the project\u2019s own vocabulary only; hallucinations become unknown', () => {
    expect(constrainPhaseName('walling', ['Foundation', 'Walling'])).toBe('Walling')
    expect(constrainPhaseName('  Foundation ', ['Foundation', 'Walling'])).toBe('Foundation')
    expect(constrainPhaseName('Swimming pool deck', ['Foundation', 'Walling'])).toBe('unknown')
    expect(constrainPhaseName('unknown', ['Foundation'])).toBe('unknown')
    expect(constrainPhaseName('', ['Foundation'])).toBe('unknown')
    expect(constrainPhaseName('Foundation', [])).toBe('unknown')
  })
})

// ================================================== vision findings

describe('vision phase-consistency findings land as labeled advisory rows', () => {
  beforeEach(() => {
    setAiFlag(true)
  })

  it('a phase mismatch → one phase_mismatch row (source vision, confidence labeled, detail carries phases)', async () => {
    sdk.visionCreate.mockResolvedValueOnce({ choices: [{ message: { content: VISION_JSON_OK } }] })
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    // The milestone m-1 claims phase Foundation (ph-1).
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    const rows = insights().filter((r) => r.source === 'vision')
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.kind).toBe('phase_mismatch')
    expect(row.confidence).toBe('medium')
    expect(row.severity).toBe('warning')
    const detail = JSON.parse(String(row.detail))
    expect(detail.phaseShown).toBe('Walling')
    expect(detail.phaseClaimed).toBe('Foundation')
    expect(detail.milestoneName).toBe('Foundation complete')
  })

  it('render/AI-generation tells → one render_suspect row carrying the tells', async () => {
    sdk.visionCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        phaseShown: 'Foundation', matchesClaim: true, confidence: 'high',
        renderTells: ['UI chrome of a rendering app visible in the corner'],
        observation: 'Looks like a screenshot.',
      }) } }],
    })
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    const rows = insights().filter((r) => r.kind === 'render_suspect')
    expect(rows).toHaveLength(1)
    const detail = JSON.parse(String(rows[0].detail))
    expect(detail.tells).toEqual(['UI chrome of a rendering app visible in the corner'])
    expect(rows[0].source).toBe('vision')
  })

  it('the prompt carries the milestone + claimed-phase context and a data: image URL (the storage read seam)', async () => {
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    expect(sdk.visionCreate).toHaveBeenCalled()
    const body = sdk.visionCreate.mock.calls[0][0] as {
      model: string
      messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>
    }
    const prompt = body.messages[0].content.find((c) => c.type === 'text')?.text ?? ''
    expect(prompt).toContain('Foundation complete')
    expect(prompt).toContain('Foundation')
    expect(prompt).toContain('STRICT JSON')
    expect(prompt).toContain('Do not include numbers, quantities, amounts or dates') // the W6-1 figures discipline
    expect(body.model).toBe('glm-5v-turbo')
    const image = body.messages[0].content.find((c) => c.type === 'image_url')
    expect(image?.image_url.url).toMatch(/^data:image\/png;base64,/)
  })

  it('the vision set is capped (6 photos) while dHash covers every photo', async () => {
    for (let i = 1; i <= 8; i++) {
      seedPhoto(`photo-${i}`, i % 2 === 0 ? 'b' : 'a', new Date(`2026-08-0${i}T09:00:00Z`))
    }
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1','photo-2','photo-3','photo-4','photo-5','photo-6','photo-7','photo-8'] })
    expect(VISION_PHOTOS_CAP).toBe(6)
    expect(sdk.visionCreate).toHaveBeenCalledTimes(6)
    // All 8 photos hashed — the deterministic half is uncapped at pack size.
    expect(photoHashes()).toHaveLength(8)
  })

  it('duplicate + vision rows coexist, each labeled with its source', async () => {
    sdk.visionCreate.mockResolvedValueOnce({ choices: [{ message: { content: VISION_JSON_OK } }] })
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    seedPhoto('photo-2', 'a', new Date('2026-08-20T09:00:00Z'))
    sdk.visionCreate.mockResolvedValue({ choices: [{ message: { content: VISION_JSON_OK } }] })
    await freezePack({ milestoneId: 'm-2', milestoneName: 'Slab cast', evidencePhotoIds: ['photo-2'] })
    const rows = insights()
    expect(rows.some((r) => r.source === 'dhash' && r.kind === 'duplicate')).toBe(true)
    expect(rows.some((r) => r.source === 'vision' && r.kind === 'phase_mismatch')).toBe(true)
    // Every row carries its source label.
    for (const r of rows) expect(['dhash', 'vision']).toContain(r.source)
  })

  it('a HALLUCINATED phase name (not in the project\u2019s list) never accuses — constrained to unknown', async () => {
    sdk.visionCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        phaseShown: 'Swimming pool deck', matchesClaim: false, confidence: 'high',
        renderTells: [], observation: 'Water and tiles.',
      }) } }],
    })
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    expect(insights()).toHaveLength(0) // phaseShown outside the Phase rows → unknown → no row
  })

  it('model figures never reach a stored row (observation + tells redacted — the ledger decides numbers)', async () => {
    sdk.visionCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        phaseShown: 'Foundation', matchesClaim: true, confidence: 'medium',
        renderTells: ['rendering app v2.5 chrome in the corner, 3 duplicates'],
        observation: 'Screed of 40mm over 200 sqm, cost KSh 650,000',
      }) } }],
    })
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    const rows = insights().filter((r) => r.kind === 'render_suspect')
    expect(rows).toHaveLength(1)
    const detail = JSON.parse(String(rows[0].detail))
    // The model-authored fields carry zero digits (row ids may — they are rows).
    expect(detail.tells[0]).not.toMatch(/\d/)
    expect(detail.tell).not.toMatch(/\d/)
    expect(detail.observation).not.toMatch(/\d/)
    expect(detail.tells[0]).toContain('v# chrome')
    expect(detail.observation).toContain('KSh #')
  })

  it('a photo with NO claimed phase (on-demand run, no phase recorded) cannot phase-mismatch', async () => {
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    state.__state.sitePhotos.get('photo-1')!.phaseId = null // nothing claimed
    sdk.visionCreate.mockResolvedValueOnce({ choices: [{ message: { content: VISION_JSON_OK } }] })
    await runAuthenticityScreen({ projectId: 'p-1' })
    expect(insights().filter((r) => r.kind === 'phase_mismatch')).toHaveLength(0)
  })
})

// ================================================== the never-fails hook

describe('the never-fails hook — the pack and the release stand', () => {
  beforeEach(() => {
    setAiFlag(true)
  })

  it('a PhotoHash write failure → pack still created, failure audited as ai_screen.failed, no throw', async () => {
    state.__state.failPhotoHashCreate = true
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    const pack = await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    expect(pack).not.toBeNull() // the pack row exists and the detail returns
    expect(state.__state.drawPacks.size).toBe(1)
    const failures = auditOf('ai_screen.failed')
    expect(failures).toHaveLength(1)
    // The pack's own audit event still exists (the screen failed AFTER it).
    expect(state.__state.auditEvents.some((e) => e.kind === 'draw_pack')).toBe(true)
  })

  it('an AiInsight write failure → same: pack stands, failure audited', async () => {
    state.__state.failAiInsightCreate = true
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    seedPhoto('photo-2', 'a', new Date('2026-08-02T09:00:00Z'))
    const pack = await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1', 'photo-2'] })
    expect(pack).not.toBeNull()
    expect(auditOf('ai_screen.failed')).toHaveLength(1)
  })

  it('a screen-internal db error → runAuthenticityScreen returns { ok:false, errorClass }, never throws', async () => {
    state.__state.failSitePhotoFind = true
    const outcome = await runAuthenticityScreen({ projectId: 'p-1' })
    expect(outcome).toMatchObject({ ok: false, errorClass: 'Error' })
  })

  it('the planted MODULE-level hook throw → the belt-and-braces catch in drawpack/service.ts keeps the pack alive', async () => {
    planted.throwOnHook = true
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    const pack = await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    expect(pack).not.toBeNull()
    expect(state.__state.drawPacks.size).toBe(1)
    planted.throwOnHook = false
  })

  it('money paths untouched: zero ledger/wallet/transaction delegates exist on the stub the screen uses', () => {
    // The screen's write surface is exactly photoHash/aiInsight/auditEvent —
    // there is no ledger, wallet or transaction write anywhere in the module
    // (grep pin on the source, the projection-never-money discipline).
    const src = readFileSync(
      fileURLToPath(new URL('../../src/backend/modules/ai/authenticity.ts', import.meta.url)),
      'utf8',
    )
    for (const banned of ['ledgerTransaction', 'wallet', 'db.transaction.create', 'releaseMilestone']) {
      expect(src, `authenticity.ts must not reference ${banned}`).not.toContain(banned)
    }
  })
})

// ================================================== idempotency

describe('idempotent backfill + no double-written insights', () => {
  beforeEach(() => {
    setAiFlag(true)
  })

  it('a second screen run cache-hits every PhotoHash row (nothing recomputed)', async () => {
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    expect(photoHashes()).toHaveLength(1)
    const first = await runAuthenticityScreen({ projectId: 'p-1', photoIds: ['photo-1'] })
    if (first.ok && first.ran) {
      expect(first.hashed).toBe(0)
      expect(first.cacheHits).toBe(1)
    }
    expect(photoHashes()).toHaveLength(1) // still one row
  })

  it('re-running the second freeze scenario writes NO second duplicate insight', async () => {
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    await freezePack({ milestoneId: 'm-2', milestoneName: 'Slab cast', evidencePhotoIds: ['photo-1'] })
    expect(insights().filter((r) => r.kind === 'duplicate')).toHaveLength(1)
    // The on-demand route run over the same project: the pair is recorded.
    await runAuthenticityScreen({ projectId: 'p-1' })
    expect(insights().filter((r) => r.kind === 'duplicate')).toHaveLength(1)
  })
})

// ================================================== the route

describe('POST/GET /api/ai/authenticity-screen — the gate ladder', () => {
  function jsonReq(url: string, method: 'GET' | 'POST', body?: unknown): NextRequest {
    return new NextRequest(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  function sessionFor(role: string, email = `${role}@test.dev`) {
    h.session = { user: { id: `u-${role}`, email, name: role, role, projectId: null } }
  }

  it('no session → 401 (before any flag or SDK contact)', async () => {
    h.session = null
    const res = await POST(jsonReq('http://localhost/api/ai/authenticity-screen', 'POST', { projectId: 'p-1' }))
    expect(res.status).toBe(401)
    expect(sdk.create).not.toHaveBeenCalled()
  })

  it('a CLIENT role session → 403 (AI routes are site-team only)', async () => {
    sessionFor('client')
    const res = await POST(jsonReq('http://localhost/api/ai/authenticity-screen', 'POST', { projectId: 'p-1' }))
    expect(res.status).toBe(403)
  })

  it('flag OFF + contractor → the uniform 403; admin bypasses', async () => {
    setAiFlag(false)
    sessionFor('contractor')
    const denied = await POST(jsonReq('http://localhost/api/ai/authenticity-screen', 'POST', { projectId: 'p-1' }))
    expect(denied.status).toBe(403)
    expect((await denied.json() as { error: string }).error).toContain('Feature disabled by feature flag (ai)')
    expect(sdk.create).not.toHaveBeenCalled()
    // Admins bypass so they can toggle and test — the route runs the screen.
    sessionFor('admin')
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    const adminRes = await POST(jsonReq('http://localhost/api/ai/authenticity-screen', 'POST', { projectId: 'p-1' }))
    expect(adminRes.status).toBe(200)
  })

  it('flag ON + contractor + provider ok → 200 with the honest outcome + insights', async () => {
    setAiFlag(true)
    sessionFor('contractor')
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    const res = await POST(jsonReq('http://localhost/api/ai/authenticity-screen', 'POST', { projectId: 'p-1' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; outcome: { ran: boolean; hashed: number }; insights: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.outcome.ran).toBe(true)
    expect(body.outcome.hashed).toBe(1)
    expect(Array.isArray(body.insights)).toBe(true)
  })

  it('GET with flag ON → 200 rows (the tab display path, no SDK contact)', async () => {
    setAiFlag(true)
    sessionFor('contractor')
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    await runAuthenticityScreen({ projectId: 'p-1', photoIds: ['photo-1'] })
    sdk.create.mockClear()
    const res = await GET(new NextRequest('http://localhost/api/ai/authenticity-screen?projectId=p-1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; insights: Array<Record<string, unknown>> }
    expect(body.ok).toBe(true)
    expect(sdk.create).not.toHaveBeenCalled()
  })

  it('GET without projectId → 400; unknown projectId → 404', async () => {
    setAiFlag(true)
    sessionFor('contractor')
    const noParam = await GET(new NextRequest('http://localhost/api/ai/authenticity-screen'))
    expect(noParam.status).toBe(400)
    const missing = await GET(new NextRequest('http://localhost/api/ai/authenticity-screen?projectId=nope'))
    expect(missing.status).toBe(404)
  })

  it('an unknown body field → 400 (the policy allowlist)', async () => {
    setAiFlag(true)
    sessionFor('contractor')
    const res = await POST(jsonReq('http://localhost/api/ai/authenticity-screen', 'POST', { projectId: 'p-1', rogue: true }))
    expect(res.status).toBe(400)
  })

  it('11th POST in the window → 429 + Retry-After (the AI route bucket)', async () => {
    setAiFlag(true)
    sessionFor('contractor', 'burst@test.dev')
    let saw429 = false
    for (let i = 0; i < 11; i++) {
      const res = await POST(jsonReq('http://localhost/api/ai/authenticity-screen', 'POST', { projectId: 'p-1' }))
      if (res.status === 429) {
        saw429 = true
        expect(res.headers.get('retry-after')).toBeTruthy()
      }
    }
    expect(saw429).toBe(true)
  })
})

// ================================================== read path shape

describe('loadAuthenticityInsights — read-only view data', () => {
  it('returns serialized rows with parsed detail, newest first', async () => {
    setAiFlag(true)
    seedPhoto('photo-1', 'a', new Date('2026-08-01T09:00:00Z'))
    await freezePack({ milestoneId: 'm-1', milestoneName: 'Foundation complete', evidencePhotoIds: ['photo-1'] })
    seedPhoto('photo-2', 'a', new Date('2026-08-20T09:00:00Z'))
    await freezePack({ milestoneId: 'm-2', milestoneName: 'Slab cast', evidencePhotoIds: ['photo-2'] })
    const rows = await loadAuthenticityInsights('p-1')
    expect(rows.length).toBeGreaterThanOrEqual(1)
    for (const r of rows) {
      expect(typeof r.id).toBe('string')
      expect(r.detail).toBeTypeOf('object')
      expect(r.decidedBy).toBeNull() // decision fields present-but-null in Wave 6
      expect(r.decision).toBeNull()
      expect(r.decidedAt).toBeNull()
    }
  })

  it('an unknown project → empty list, no throw', async () => {
    expect(await loadAuthenticityInsights('nope')).toEqual([])
  })
})

// ================================================== append-only + non-influence (grep-level)

describe('append-only: no update/delete path exists for PhotoHash/AiInsight', () => {
  it('the db stub contract: only create/find for both models', () => {
    const stub = db as unknown as Record<string, Record<string, unknown>>
    for (const model of ['photoHash', 'aiInsight']) {
      expect(Object.keys(stub[model]).sort()).toEqual(['create', 'findMany'])
    }
  })

  it('no src file calls photoHash/aiInsight update, delete or upsert', () => {
    const root = fileURLToPath(new URL('../../src', import.meta.url))
    function walk(dir: string): string[] {
      const out: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`
        if (statSync(full).isDirectory()) out.push(...walk(full))
        else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
      }
      return out
    }
    const offenders: string[] = []
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8')
      if (/photoHash\.(update|delete|upsert)|aiInsight\.(update|delete|upsert)/.test(src)) {
        offenders.push(file.replace(`${root}/`, ''))
      }
    }
    expect(offenders).toEqual([])
  })

  it('no Wave-6 code path writes the human-decision columns (grep over the write sites)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/backend/modules/ai/authenticity.ts', import.meta.url)),
      'utf8',
    )
    // Every AiInsight.create data block in the module, extracted.
    const blocks = [...src.matchAll(/db\.aiInsight\.create\(\{([\s\S]*?)\}\)\n/g)]
    expect(blocks.length).toBeGreaterThanOrEqual(2) // duplicate + vision write sites
    for (const m of blocks) {
      expect(m[1], 'an insight write must not set decision fields').not.toMatch(/decidedBy|decidedAt|decision\s*:/)
    }
    // The migrations declare the decision columns NULLABLE (present-but-null).
    const sql = readFileSync(
      fileURLToPath(new URL('../../prisma/migrations/7_ai_insight/migration.sql', import.meta.url)),
      'utf8',
    )
    for (const col of ['"decidedBy"', '"decision"', '"decidedAt"']) {
      const line = sql.split('\n').find((l) => l.includes(col))
      expect(line, `${col} must be declared`).toBeTruthy()
      expect(line).not.toContain('NOT NULL')
    }
  })
})

describe('non-influence: insight/hash rows change no action outcomes', () => {
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

  it('PhotoHash/AiInsight appear ONLY in the ai module (the allowlist)', () => {
    const root = fileURLToPath(new URL('../../src', import.meta.url))
    // Absolute paths, the mjengo-score allowlist idiom.
    const allowlist = new Set(
      [
        'src/backend/modules/ai/authenticity.ts',
        // W6-2 trust digest: READS the insights table (findMany count, never
        // writes) for the digest's advisory AI-flags count — row math,
        // displayed, never an influence on any action.
        'src/backend/modules/ai/trust-digest.ts',
      ].map((p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))),
    )
    const offenders: string[] = []
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8')
      if (/PhotoHash|AiInsight|photoHash|aiInsight/.test(src) && !allowlist.has(file)) {
        offenders.push(file.replace(`${root}/`, ''))
      }
    }
    expect(offenders, `files outside the allowlist reference the insight models: ${offenders.join(', ')}`).toEqual([])
  })

  it('the mutating modules stay insight-blind (money/mjengo/actions/jobs)', () => {
    const modules = [
      'src/backend/actions/money.ts',
      'src/backend/lib/mjengo.ts',
      'src/backend/api/actions.ts',
      'src/backend/modules/jobs/handlers.ts',
      'src/backend/modules/wallet/service.ts',
      'src/backend/modules/intel/score.ts',
    ]
    for (const rel of modules) {
      const src = readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
      expect(src, `${rel} must not reference AiInsight/PhotoHash`).not.toMatch(/AiInsight|PhotoHash|aiInsight|photoHash/)
    }
  })
})

// ================================================== migrations + surface wiring

describe('migrations are additive-only (one CREATE TABLE each)', () => {
  const readSql = (dir: string) =>
    readFileSync(fileURLToPath(new URL(`../../prisma/migrations/${dir}/migration.sql`, import.meta.url)), 'utf8')

  it('6_photo_hash: exactly one CREATE TABLE + one unique index, no mutation statements', () => {
    const sql = readSql('6_photo_hash')
    const body = sql.replace(/--[^\n]*/g, '') // comments stripped (prose may say UPDATE)
    const statements = body.split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^CREATE TABLE "PhotoHash" \(/)
    expect(statements[1]).toMatch(/^CREATE UNIQUE INDEX "PhotoHash_photoId_key"/)
    const mutations = statements.filter((s) =>
      /^(ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|CREATE (TRIGGER|VIEW))/i.test(s),
    )
    expect(mutations, `mutation statements found: ${mutations.join(' || ')}`).toEqual([])
    expect(sql).toContain('"photoId" TEXT NOT NULL')
    expect(sql).toContain('"hashHex" TEXT NOT NULL')
    expect(sql).toContain('"packId" TEXT')
  })

  it('7_ai_insight: exactly one CREATE TABLE statement, no mutations (the FK ON DELETE CASCADE is a reference, not a touch)', () => {
    const sql = readSql('7_ai_insight')
    const body = sql.replace(/--[^\n]*/g, '')
    const statements = body.split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE TABLE "AiInsight" \(/)
    const mutations = statements.filter((s) =>
      /^(ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|CREATE (INDEX|TRIGGER|VIEW))/i.test(s),
    )
    expect(mutations, `mutation statements found: ${mutations.join(' || ')}`).toEqual([])
    expect(sql).toContain('"source" TEXT NOT NULL')
    expect(sql).toContain('"kind" TEXT NOT NULL')
    expect(sql).toContain('"detail" TEXT NOT NULL')
  })

  it('the schema declares both models append-only-shaped (no @updatedAt)', () => {
    const schema = readFileSync(fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)), 'utf8')
    expect(schema).toContain('model PhotoHash')
    expect(schema).toContain('model AiInsight')
    const photoHashBlock = schema.slice(schema.indexOf('model PhotoHash'), schema.indexOf('model AiInsight'))
    const aiInsightBlock = schema.slice(schema.indexOf('model AiInsight'))
    expect(photoHashBlock).not.toContain('@updatedAt')
    expect(aiInsightBlock).not.toContain('@updatedAt')
    expect(photoHashBlock).toContain('@unique')
  })
})

describe('frontend wiring + i18n parity (the evidence tab section)', () => {
  it('the section is flag-gated on data.intel.flags.ai and hides itself when off (source pin)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/frontend/mjengo/evidence-tab.tsx', import.meta.url)),
      'utf8',
    )
    expect(src).toContain('data.intel.flags.ai')
    expect(src).toContain('if (!aiFlag) return null')
    expect(src).toContain('auth.honesty') // the "AI describes, humans decide" band
    expect(src).toContain('/api/ai/authenticity-screen')
  })

  it('audit-tab lists the ai_screen kind', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/frontend/mjengo/audit-tab.tsx', import.meta.url)),
      'utf8',
    )
    expect(src).toContain("'ai_screen'")
  })

  it('every t("auth.…") literal in the evidence tab resolves in BOTH dictionaries', () => {
    const tabSrc = readFileSync(
      fileURLToPath(new URL('../../src/frontend/mjengo/evidence-tab.tsx', import.meta.url)),
      'utf8',
    )
    const keys = [...tabSrc.matchAll(/t\('((?:auth|badge)\.[^']+)'/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(10)
    const dicts = ['en', 'sw'].map((lang) =>
      readFileSync(fileURLToPath(new URL(`../../src/frontend/i18n/dicts/${lang}.ts`, import.meta.url)), 'utf8'),
    )
    for (const key of keys) {
      for (const dict of dicts) {
        expect(dict, `${key} missing from a dictionary`).toContain(`'${key}':`)
      }
    }
  })

  it('both dictionaries carry the W6-3 end-append block with real Kiswahili values', () => {
    for (const lang of ['en', 'sw']) {
      const dict = readFileSync(
        fileURLToPath(new URL(`../../src/frontend/i18n/dicts/${lang}.ts`, import.meta.url)),
        'utf8',
      )
      expect(dict).toContain('# W6-3: evidence authenticity')
      expect(dict).toContain("'auth.title'")
      expect(dict).toContain("'auth.honesty'")
      expect(dict).toContain("'auth.dup.crossPack'")
    }
    // The EN and SW key sets are identical (the compile-time check.ts twin).
    const en = readFileSync(fileURLToPath(new URL('../../src/frontend/i18n/dicts/en.ts', import.meta.url)), 'utf8')
    const sw = readFileSync(fileURLToPath(new URL('../../src/frontend/i18n/dicts/sw.ts', import.meta.url)), 'utf8')
    const enAuthKeys = [...en.matchAll(/'((?:auth)\.[^']+)':/g)].map((m) => m[1])
    const swAuthKeys = new Set([...sw.matchAll(/'((?:auth)\.[^']+)':/g)].map((m) => m[1]))
    for (const key of enAuthKeys) expect(swAuthKeys.has(key)).toBe(true)
    expect(swAuthKeys.size).toBe(enAuthKeys.length)
  })
})
