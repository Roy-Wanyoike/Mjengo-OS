/**
 * Route-level wiring of the voice-log PII scrubber (task 8-b).
 *
 * Pins the two layers where a transcript crosses the system boundary —
 * BOTH must be scrubbed before anything downstream sees them:
 *  · src/app/api/ai/voice-log/route.ts — the ASR boundary: the response body
 *    carries the masked transcript, and the raw number appears NOWHERE in
 *    the JSON (not in notes/supplier/items either);
 *  · src/backend/lib/ai.ts parseDeliveryTranscript — the shared parse seam
 *    (this is what also covers /api/ai/parse-text): the LLM prompt itself
 *    only ever contains the masked transcript, so the raw number never
 *    leaves the process, and structured parsing still works (quantities,
 *    catalog matches and suppliers survive scrubbing).
 *
 * The route itself performs no transcript db write — the persistence site is
 * the delivery.create action the copilot UI dispatches with the response's
 * transcript as rawTranscript (src/frontend/mjengo/copilot-tab.tsx). The
 * last describe pins that full chain honestly: the route response's
 * (scrubbed) transcript, fed through the REAL applyAction('delivery.create')
 * applier with the REAL audit/ledger writes against an in-memory db stub,
 * lands in db.delivery as the masked string. The applier is delivery-file
 * owned (agent 8-a) and is imported read-only here.
 *
 * Mocks: z-ai-web-dev-sdk (ASR + chat completions), @/backend/lib/db
 * (in-memory stub, notify-channels.test.ts pattern), @/backend/lib/guard
 * (fixed contractor session; everything else stays real — the AI route
 * policy contract is pinned in rate-limit.test.ts).
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { asrCreate, chatCreate } = vi.hoisted(() => ({
  asrCreate: vi.fn(),
  chatCreate: vi.fn(),
}))

vi.mock('z-ai-web-dev-sdk', () => ({
  default: {
    create: vi.fn(async () => ({
      audio: { asr: { create: asrCreate } },
      chat: { completions: { create: chatCreate } },
    })),
  },
}))

vi.mock('@/backend/lib/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/lib/guard')>()
  return {
    ...actual,
    getSessionFromReq: vi.fn(async () => ({
      user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null },
    })),
  }
})

vi.mock('@/backend/lib/db', () => {
  const now = new Date('2026-01-15T09:00:00Z')
  const project = {
    id: 'p-1', name: 'Riverside Villas', location: 'Karen', budget: 5_000_000,
    client: 'Mama Njeri', startDate: now, createdAt: now,
  }
  const material = { id: 'mat-1', name: 'cement', unit: 'bag', unitPrice: 750 }
  const state = {
    deliveries: [] as Record<string, unknown>[],
    transactions: [] as Record<string, unknown>[],
    auditEvents: [] as Record<string, unknown>[],
    reset() {
      state.deliveries.length = 0
      state.transactions.length = 0
      state.auditEvents.length = 0
    },
  }
  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: { id: string } }) {
        return where?.id === 'p-1' ? { ...project } : null
      },
      async findFirst() { return { ...project } },
      async findMany() { return [{ ...project }] },
    },
    phase: { async findMany() { return [] } },
    worker: { async findMany() { return [] } },
    material: {
      async findMany() { return [{ ...material }] },
      async findUnique({ where }: { where: { id: string } }) {
        return where?.id === 'mat-1' ? { ...material } : null
      },
    },
    delivery: {
      async findMany() { return state.deliveries.map((d) => ({ ...d })) },
      async create({ data }: { data: Record<string, unknown> }) {
        const row = { id: `del_${state.deliveries.length + 1}`, ...data }
        state.deliveries.push(row)
        return { ...row }
      },
    },
    consumption: { async findMany() { return [] } },
    transaction: {
      async findMany() { return state.transactions.map((t) => ({ ...t })) },
      async create({ data }: { data: Record<string, unknown> }) {
        const row = { id: `txn_${state.transactions.length + 1}`, ...data }
        state.transactions.push(row)
        return { ...row }
      },
    },
    attendance: { async findMany() { return [] } },
    alert: { async findMany() { return [] } },
    auditEvent: {
      async create({ data }: { data: Record<string, unknown> }) {
        const row = { id: `audit_${state.auditEvents.length + 1}`, ...data }
        state.auditEvents.push(row)
        return { ...row }
      },
    },
    // 9-a (flag gating): /api/ai/voice-log now reads the ai_voice flag at the
    // route level (requireFlagOn → FeatureFlag table). Empty rows = every
    // flag defaults ON, so the PII assertions below exercise the normal
    // (ungated) voice-log path exactly as before.
    featureFlag: {
      async upsert() {},
      async findMany() { return [] },
    },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { POST as voiceLogPost } from '@/app/api/ai/voice-log/route'
import { buildProjectDigest, parseDeliveryTranscript } from '@/backend/lib/ai'
import { applyAction } from '@/backend/lib/mjengo'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    deliveries: Record<string, unknown>[]
    transactions: Record<string, unknown>[]
    auditEvents: Record<string, unknown>[]
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

/** A realistic Swahili/English mixed delivery note with a spoken phone number. */
const ASR_TEXT =
  'Habari, nimepokea bags 80 za cement kutoka Karioke Hardware. ' +
  'Simu yake ni 0712 345 678 kwa malipo. Jumla KES 45000.'
const SCRUBBED_TEXT =
  'Habari, nimepokea bags 80 za cement kutoka Karioke Hardware. ' +
  'Simu yake ni 07\u2022\u2022\u2022\u2022\u2022\u202278 kwa malipo. Jumla KES 45000.'
const RAW_NUMBER = '0712 345 678'
const MASK = '07\u2022\u2022\u2022\u2022\u2022\u202278'

/** The fixed LLM answer for the parse call (items survive scrubbing). */
const LLM_JSON = JSON.stringify({
  supplier: 'Karioke Hardware',
  language: 'sw',
  items: [{ name: 'cement', quantity: '80', unit: 'bag' }],
  notes: null,
  confidence: 0.9,
})

function voiceReq(): NextRequest {
  return new NextRequest('http://localhost/api/ai/voice-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64: 'aGVsbG8=', projectId: 'p-1' }),
  })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  state.reset()
  chatCreate.mockReset()
  chatCreate.mockResolvedValue({ choices: [{ message: { content: LLM_JSON } }] })
})

describe('POST /api/ai/voice-log — the ASR boundary is scrubbed', () => {
  it('response transcript is masked; the raw number appears nowhere in the body', async () => {
    asrCreate.mockResolvedValue({ text: ASR_TEXT })
    const res = await voiceLogPost(voiceReq())
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.transcript).toBe(SCRUBBED_TEXT)
    expect(JSON.stringify(body)).not.toContain(RAW_NUMBER)
    expect(JSON.stringify(body)).not.toContain('0712345678')
  })

  it('the LLM parse prompt only ever sees the scrubbed transcript (raw PII never leaves the process)', async () => {
    asrCreate.mockResolvedValue({ text: ASR_TEXT })
    await voiceLogPost(voiceReq())
    expect(chatCreate).toHaveBeenCalledTimes(1)
    const prompt = String(chatCreate.mock.calls[0][0].messages[1].content)
    expect(prompt).toContain(MASK)
    expect(prompt).toContain('"""')
    expect(prompt).not.toContain(RAW_NUMBER)
    expect(prompt).not.toContain('0712345678')
  })

  it('structured parsing is unaffected: items, quantities and catalog matches survive', async () => {
    asrCreate.mockResolvedValue({ text: ASR_TEXT })
    const body = await bodyOf(await voiceLogPost(voiceReq()))
    const items = body.items as Array<Record<string, unknown>>
    expect(items).toHaveLength(1)
    expect(items[0].quantity).toBe(80)
    expect(items[0].materialId).toBe('mat-1')
    expect(items[0].matched).toBe(true)
    expect(body.supplier).toBe('Karioke Hardware')
  })

  it('phone-free transcripts round-trip verbatim (no false masking in the flow)', async () => {
    const clean = 'Habari, nimepokea bags 80 za cement kutoka Karioke Hardware, 07:30 asubuhi, KES 45000.'
    asrCreate.mockResolvedValue({ text: clean })
    const body = await bodyOf(await voiceLogPost(voiceReq()))
    expect(body.transcript).toBe(clean)
  })

  it('the empty-ASR path still returns the honest 400', async () => {
    asrCreate.mockResolvedValue({ text: '' })
    const res = await voiceLogPost(voiceReq())
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Could not hear any speech in that voice note' })
  })

  it('multiple numbers in one voice note: every mask lands once (double scrub at route + seam is a no-op)', async () => {
    asrCreate.mockResolvedValue({ text: 'Piga 0712345678 ama +254 722 345 678 kuhusu cement.' })
    const body = await bodyOf(await voiceLogPost(voiceReq()))
    expect(body.transcript).toBe('Piga 07\u2022\u2022\u2022\u2022\u2022\u202278 ama +2547\u2022\u2022\u2022\u2022\u2022\u202278 kuhusu cement.')
  })
})

describe('parseDeliveryTranscript — the shared parse seam (covers /api/ai/parse-text)', () => {
  it('returns a scrubbed transcript and feeds the LLM the scrubbed text', async () => {
    const digest = await buildProjectDigest('p-1')
    const parsed = await parseDeliveryTranscript(ASR_TEXT, digest)
    expect(parsed.transcript).toBe(SCRUBBED_TEXT)
    expect(chatCreate).toHaveBeenCalledTimes(1)
    const prompt = String(chatCreate.mock.calls[0][0].messages[1].content)
    expect(prompt).toContain(MASK)
    expect(prompt).not.toContain(RAW_NUMBER)
  })

  it('items still parse and match the catalog (scrubbing does not break extraction)', async () => {
    const digest = await buildProjectDigest('p-1')
    const parsed = await parseDeliveryTranscript(ASR_TEXT, digest)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0].quantity).toBe(80)
    expect(parsed.items[0].materialId).toBe('mat-1')
    expect(parsed.supplier).toBe('Karioke Hardware')
  })
})

describe('the persistence chain — db write receives the scrubbed transcript', () => {
  it('route response transcript → delivery.create rawTranscript lands masked in the delivery row', async () => {
    asrCreate.mockResolvedValue({ text: ASR_TEXT })
    // 1. The boundary: what the route hands the client (and the client then
    //    persists via delivery.create — see copilot-tab.tsx confirmLog).
    const body = await bodyOf(await voiceLogPost(voiceReq()))
    expect(body.transcript).toBe(SCRUBBED_TEXT)

    // 2. The persistence site, through the REAL applier (audit + ledger
    //    included) exactly as the UI dispatches it.
    await applyAction(
      'delivery.create',
      {
        materialId: 'mat-1',
        quantity: 80,
        unitCost: 750,
        supplier: String(body.supplier),
        source: 'voice',
        rawTranscript: body.transcript,
      },
      'p-1',
    )

    expect(state.deliveries).toHaveLength(1)
    expect(state.deliveries[0].rawTranscript).toBe(SCRUBBED_TEXT)
    expect(JSON.stringify(state.deliveries)).not.toContain(RAW_NUMBER)
    expect(JSON.stringify(state.deliveries)).not.toContain('0712345678')
    // the applier really ran: ledger row + audit row written alongside
    expect(state.transactions).toHaveLength(1)
    expect(state.auditEvents).toHaveLength(1)
  })
})
