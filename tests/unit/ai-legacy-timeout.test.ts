/**
 * BE-4 (issue #76) — the legacy AI seam (src/backend/lib/ai.ts) gets the
 * modules/ai/provider.ts discipline, applied LOCALLY (provider.ts untouched):
 *
 *   · llm() / visionMessage() / transcribeAudio() (the voice-log ASR path)
 *     each race their SDK call against a 20s cap — the SDK's own fetch has NO
 *     timeout, so a hung model/ASR API used to hold analyze-photo, recap,
 *     voice-log open until the route's maxDuration (120s). Pinned here: a
 *     NEVER-SETTLING SDK call rejects with a clean "<label> timed out after
 *     20s" error — a TIMEOUT, never a hang (fake timers, same idiom as
 *     ai-provider.test.ts's 20s-cap cases).
 *   · the SDK instance is a module-level singleton: create() once per process
 *     even when llm + vision + asr run in the same process; a FAILED create()
 *     is never cached — the next call retries (config dropped in later is
 *     picked up, no restart).
 *   · success paths are untouched: request shapes forwarded intact (roles +
 *     thinking disabled, glm-5v-turbo vision, file_base64 for ASR), jsonMode
 *     extraction still works, transcript trimmed.
 *   · the voice-log ROUTE (the direct-ASR caller this fixes) answers 500 with
 *     the timeout error — it no longer imports the SDK at all; ASR goes
 *     through the capped lib/ai.ts seam.
 *
 * The SDK is swapped for vi.fn()s — NO network, NO config file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// The SDK, swapped for vi.fn()s (the ai-provider.test.ts mock idiom).
const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  chatCreate: vi.fn(),
  visionCreate: vi.fn(),
  asrCreate: vi.fn(),
}))

vi.mock('z-ai-web-dev-sdk', () => ({
  default: { create: sdk.create },
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
  return {
    db: {
      project: {
        async findUnique({ where }: { where: { id: string } }) {
          return where?.id === 'p-1' ? { ...project } : null
        },
        async findFirst() { return { ...project } },
        async findMany() { return [{ ...project }] },
      },
      // Empty flag rows = every flag default ON (ai_voice true) — the route
      // proceeds to the ASR call this suite exercises.
      featureFlag: { async upsert() {}, async findMany() { return [] } },
      phase: { async findMany() { return [] } },
      worker: { async findMany() { return [] } },
      material: { async findMany() { return [] } },
      delivery: { async findMany() { return [] } },
      consumption: { async findMany() { return [] } },
      transaction: { async findMany() { return [] } },
      attendance: { async findMany() { return [] } },
      alert: { async findMany() { return [] } },
    },
  }
})

import { llm, visionMessage, transcribeAudio, resetLegacyAiSdkCache } from '@/backend/lib/ai'
import { POST as voiceLogPost } from '@/app/api/ai/voice-log/route'

/** The fake instance create() resolves to (the surface the seam uses). */
const fakeInstance = () => ({
  chat: { completions: { create: sdk.chatCreate, createVision: sdk.visionCreate } },
  audio: { asr: { create: sdk.asrCreate } },
})

const CHAT_OK = { choices: [{ message: { content: '  model says hatari  ' } }] }
const VISION_OK = { choices: [{ message: { content: 'walling at 68 percent' } }] }
const ASR_OK = { text: '  amelewa bags ishirini ya cement  ' }

beforeEach(() => {
  sdk.create.mockReset()
  sdk.chatCreate.mockReset()
  sdk.visionCreate.mockReset()
  sdk.asrCreate.mockReset()
  sdk.create.mockResolvedValue(fakeInstance())
  sdk.chatCreate.mockResolvedValue(CHAT_OK)
  sdk.visionCreate.mockResolvedValue(VISION_OK)
  sdk.asrCreate.mockResolvedValue(ASR_OK)
  resetLegacyAiSdkCache() // drop the module singleton between tests
})

afterEach(() => {
  vi.useRealTimers()
})

/** llm() — text + JSON chat completions through the capped seam. */
describe('llm() — the 20s cap (BE-4)', () => {
  it('success → content (legacy passthrough, verbatim), request shape forwarded intact', async () => {
    const out = await llm('you are the site parser', 'bags 20 za cement')
    // NOTE: legacy llm() returns the model content VERBATIM (unlike the
    // provider seam, which trims) — unchanged on purpose: only the timeout
    // cap was added (BE-4), not a behavior change.
    expect(out).toBe('  model says hatari  ')
    expect(sdk.chatCreate).toHaveBeenCalledWith({
      messages: [
        { role: 'assistant', content: 'you are the site parser' },
        { role: 'user', content: 'bags 20 za cement' },
      ],
      thinking: { type: 'disabled' },
    })
  })

  it('jsonMode → the fenced JSON is still extracted', async () => {
    sdk.chatCreate.mockResolvedValue({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] })
    await expect(llm('sys', 'user', true)).resolves.toEqual({ ok: true })
  })

  it('a call that never settles REJECTS with a timeout error — not a hang', async () => {
    vi.useFakeTimers()
    sdk.chatCreate.mockReturnValueOnce(new Promise(() => {})) // never settles
    // Attach the rejection handler BEFORE advancing the clock, so the
    // rejection is never even momentarily unhandled.
    const assertion = expect(llm('sys', 'user')).rejects.toThrow('AI chat timed out after 20s')
    await vi.advanceTimersByTimeAsync(20_000)
    await assertion
  })
})

/** visionMessage() — photo analysis through the capped seam. */
describe('visionMessage() — the 20s cap (BE-4)', () => {
  it('success → content, glm-5v-turbo + data: URL forwarded intact', async () => {
    const out = await visionMessage('describe', 'QUJD', 'image/png')
    expect(out).toBe('walling at 68 percent')
    expect(sdk.visionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'glm-5v-turbo',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
            ],
          },
        ],
        thinking: { type: 'disabled' },
      }),
    )
  })

  it('a call that never settles REJECTS with a timeout error — not a hang', async () => {
    vi.useFakeTimers()
    sdk.visionCreate.mockReturnValueOnce(new Promise(() => {}))
    const assertion = expect(visionMessage('describe', 'QUJD')).rejects.toThrow('AI vision timed out after 20s')
    await vi.advanceTimersByTimeAsync(20_000)
    await assertion
  })
})

/** transcribeAudio() — the voice-log ASR path, now capped like the rest. */
describe('transcribeAudio() — the 20s cap (BE-4)', () => {
  it('success → trimmed transcript, file_base64 forwarded intact', async () => {
    const out = await transcribeAudio('QUJD')
    expect(out).toBe('amelewa bags ishirini ya cement')
    expect(sdk.asrCreate).toHaveBeenCalledWith({ file_base64: 'QUJD' })
  })

  it('a model answer with no text → empty string (the caller decides)', async () => {
    sdk.asrCreate.mockResolvedValueOnce({ text: null })
    await expect(transcribeAudio('QUJD')).resolves.toBe('')
  })

  it('a call that never settles REJECTS with a timeout error — not a hang', async () => {
    vi.useFakeTimers()
    sdk.asrCreate.mockReturnValueOnce(new Promise(() => {}))
    const assertion = expect(transcribeAudio('QUJD')).rejects.toThrow('AI transcription timed out after 20s')
    await vi.advanceTimersByTimeAsync(20_000)
    await assertion
  })
})

/** The singleton — one create() per process, failures never cached. */
describe('the SDK singleton (BE-4)', () => {
  it('create() runs ONCE across chat + vision + asr in the same process', async () => {
    await llm('sys', 'user')
    await visionMessage('describe', 'QUJD')
    await transcribeAudio('QUJD')
    expect(sdk.create).toHaveBeenCalledTimes(1)
  })

  it('a FAILED create() is never cached — the next call retries and succeeds', async () => {
    sdk.create.mockRejectedValueOnce(new Error('Configuration file not found or invalid.'))
    await expect(llm('sys', 'user')).rejects.toThrow('Configuration file not found')
    sdk.create.mockResolvedValue(fakeInstance())
    await expect(llm('sys', 'user')).resolves.toBe('  model says hatari  ')
    expect(sdk.create).toHaveBeenCalledTimes(2)
  })
})

/** The route that used to call the SDK directly with no cap. */
describe('POST /api/ai/voice-log — hung ASR answers 500, not a hang (BE-4)', () => {
  it('a never-settling ASR call → 500 with the timeout error (route never imports the SDK)', async () => {
    vi.useFakeTimers()
    sdk.asrCreate.mockReturnValueOnce(new Promise(() => {})) // hung ASR
    const req = new NextRequest('http://localhost/api/ai/voice-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioBase64: 'aGVsbG8=', projectId: 'p-1' }),
    })
    const pending = voiceLogPost(req)
    await vi.advanceTimersByTimeAsync(20_000)
    const res = await pending
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('AI transcription timed out after 20s')
  })
})
