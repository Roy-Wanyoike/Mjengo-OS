/**
 * AI provider seam invariants (src/backend/modules/ai/{types,provider}.ts).
 *
 * The Wave-6 foundation: resolveAiProvider(flags) is the notify-style
 * getter — flag OFF (or absent) → null (fail-closed: the SDK is never
 * contacted, every surface shows the honest "AI features are off" state);
 * flag ON → a ZaiProvider wrapping z-ai-web-dev-sdk (BACKEND ONLY). The
 * suite swaps the SDK for vi.fn()s — the REAL SDK (and its .z-ai-config
 * file / network) is never touched — then pins:
 *  · resolution: flag off / key absent → null; flag on → ZaiProvider
 *    (id 'zai'); a full FlagMap-shaped object drops straight in;
 *  · the SDK instance is a lazy module singleton — create() once per
 *    process, and a FAILED create() is never cached (the next call
 *    retries: config-file added later is picked up without a restart);
 *    a failed create() answers null — "AI unavailable", never a throw;
 *  · success: chat/vision/transcribe return { ok: true, text } with the
 *    request shapes forwarded intact (chat roles+content + thinking
 *    disabled; vision model glm-5v-turbo + text/image_url content items,
 *    https URLs passed through; transcribe strips the data: prefix and
 *    sends file_base64);
 *  · SDK throws → { ok: false, error }, NEVER thrown into the caller, and
 *    the error leaks NOTHING (HTTP status three digits only — the SDK's
 *    messages embed the endpoint URL and the provider's error body);
 *  · empty model answers (blank content / blank ASR text) → honest
 *    { ok: false } — never a faked empty analysis;
 *  · input-validation bugs (empty messages/prompt/images/audio, an
 *    http(s) URL where base64 is required) → { ok: false } WITHOUT the
 *    SDK being contacted;
 *  · the 20s cap: a call that never settles fails honestly after 20s
 *    (fake timers — the SDK's own fetch has no timeout).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The SDK, swapped for vi.fn()s — NO network, NO config file in this suite
// (the same mock idiom as flags-gating.test.ts's z-ai-web-dev-sdk mock).
const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  chatCreate: vi.fn(),
  visionCreate: vi.fn(),
  asrCreate: vi.fn(),
  ttsCreate: vi.fn(),
}))

vi.mock('z-ai-web-dev-sdk', () => ({
  default: { create: sdk.create },
}))

import { resetAiSdkCache, resolveAiProvider, ZaiProvider, chunkTextForTts, parseWavBuffer, buildWavBuffer } from '@/backend/modules/ai/provider'
import type { AiProvider } from '@/backend/modules/ai/types'

/** The fake instance create() resolves to (the surface the provider uses). */
const fakeInstance = () => ({
  chat: { completions: { create: sdk.chatCreate, createVision: sdk.visionCreate } },
  audio: { asr: { create: sdk.asrCreate }, tts: { create: sdk.ttsCreate } },
})

const CHAT_OK = { choices: [{ message: { content: '  the model answer  ' } }] }
const VISION_OK = { choices: [{ message: { content: 'walling at 68 percent' } }] }
const ASR_OK = { text: '  amelewa bags ishirini ya cement  ' }

/** A tiny valid PCM WAV (44-byte header + `bytes` of payload). */
function fakeWav(bytes: number, opts?: { sampleRate?: number; channels?: number; bits?: number }): Buffer {
  const sampleRate = opts?.sampleRate ?? 8000
  const channels = opts?.channels ?? 1
  const bits = opts?.bits ?? 16
  const data = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i++) data[i] = i % 251 // non-zero, deterministic
  return buildWavBuffer({ audioFormat: 1, channels, sampleRate, bitsPerSample: bits }, data)
}

/** Wrap WAV bytes in the raw fetch Response the TTS API documents. */
const wavResponse = (buf: Buffer) => new Response(buf, { headers: { 'content-type': 'audio/wav' } })

beforeEach(() => {
  sdk.create.mockReset()
  sdk.chatCreate.mockReset()
  sdk.visionCreate.mockReset()
  sdk.asrCreate.mockReset()
  sdk.ttsCreate.mockReset()
  sdk.create.mockResolvedValue(fakeInstance())
  sdk.chatCreate.mockResolvedValue(CHAT_OK)
  sdk.visionCreate.mockResolvedValue(VISION_OK)
  sdk.asrCreate.mockResolvedValue(ASR_OK)
  sdk.ttsCreate.mockImplementation(async () => wavResponse(fakeWav(320))) // a FRESH Response per call (a body is single-use)
  resetAiSdkCache() // drop the module singleton between tests
})

afterEach(() => {
  vi.useRealTimers()
})

/** Flag-gated resolution, following the notify provider-resolution idiom. */
describe('resolveAiProvider — flag resolution is fail-closed', () => {
  it('flag OFF → null (the honest "AI features are off" state, no provider)', () => {
    expect(resolveAiProvider({ ai: false })).toBeNull()
  })

  it('flag key ABSENT → null (default-off: a missing key fails closed)', () => {
    expect(resolveAiProvider({})).toBeNull()
    expect(resolveAiProvider({ wallet: true, marketplace: false })).toBeNull()
  })

  it('flag ON → the ZaiProvider (id/label for surfacing which AI answered)', () => {
    const provider = resolveAiProvider({ ai: true })
    expect(provider).toBeInstanceOf(ZaiProvider)
    expect(provider?.id).toBe('zai')
    expect(provider?.label).toBeTruthy()
  })

  it('a full FlagMap-shaped object (the getFlags() call shape) drops straight in', () => {
    // The Wave-6 integration shape: resolveAiProvider(await getFlags()).
    const flags = {
      ai_progress: true, ai_voice: true, wallet: true,
      marketplace: true, land_verification: true, ai: true,
    }
    expect(resolveAiProvider(flags)).toBeInstanceOf(ZaiProvider)
    const flagsOff = { ...flags, ai: false }
    expect(resolveAiProvider(flagsOff)).toBeNull()
  })
})

/** The lazy singleton — created once, failures never cached. */
describe('the SDK instance is a lazy singleton (created once, failures retried)', () => {
  it('two calls share ONE create() — the config file is read once per process', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    await provider.chat([{ role: 'user', content: 'first' }])
    await provider.chat([{ role: 'user', content: 'second' }])
    // A SECOND provider instance (fresh resolution) still shares the cache.
    const again = resolveAiProvider({ ai: true }) as AiProvider
    await again.transcribe('data:audio/webm;base64,QUJD')
    expect(sdk.create).toHaveBeenCalledTimes(1)
  })

  it('a failed create() (no/invalid .z-ai-config) → null, never a throw', async () => {
    sdk.create.mockRejectedValueOnce(new Error('Configuration file not found or invalid. Please create .z-ai-config in your project, home directory, or /etc.'))
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.chat([{ role: 'user', content: 'hello' }])
    expect(res).toBeNull() // "AI unavailable" — distinct from a failed attempt
    expect(sdk.chatCreate).not.toHaveBeenCalled()
  })

  it('a failed create() is NOT cached — the next call retries and succeeds', async () => {
    sdk.create.mockRejectedValueOnce(new Error('Configuration file not found or invalid.'))
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    expect(await provider.chat([{ role: 'user', content: 'hello' }])).toBeNull()
    // The operator drops the config file in — no restart needed.
    const res = await provider.chat([{ role: 'user', content: 'hello again' }])
    expect(res).toEqual({ ok: true, text: 'the model answer' })
    expect(sdk.create).toHaveBeenCalledTimes(2)
  })
})

/** chat() — text completion over a message list. */
describe('chat()', () => {
  it('success → { ok: true, text } (trimmed), messages forwarded with thinking disabled', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.chat([
      { role: 'system', content: 'You are a site assistant.' },
      { role: 'user', content: 'Summarize today.' },
    ])
    expect(res).toEqual({ ok: true, text: 'the model answer' })
    expect(sdk.chatCreate).toHaveBeenCalledWith({
      messages: [
        { role: 'system', content: 'You are a site assistant.' },
        { role: 'user', content: 'Summarize today.' },
      ],
      thinking: { type: 'disabled' },
    })
  })

  it('SDK throws with an HTTP status → { ok: false } carrying the status ONLY (leak-free)', async () => {
    sdk.chatCreate.mockRejectedValueOnce(
      new Error('API request failed with status 503: {"error":"upstream overloaded","key":"sk-live-123456"}'),
    )
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.chat([{ role: 'user', content: 'hello' }])
    expect(res?.ok).toBe(false)
    if (!res?.ok) {
      expect(res.error).toContain('HTTP 503')
      // The SDK's message embeds the provider error body — none of it leaks.
      expect(res.error).not.toContain('sk-live-123456')
      expect(res.error).not.toContain('upstream overloaded')
    }
  })

  it('SDK throws a network error → { ok: false } with the error class only, no URL leak', async () => {
    sdk.chatCreate.mockRejectedValueOnce(new TypeError('fetch failed https://api.internal.example/v1/chat'))
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.chat([{ role: 'user', content: 'hello' }])
    expect(res).toEqual({ ok: false, error: 'AI chat failed (TypeError)' })
  })

  it('empty model content → honest { ok: false }, never a faked empty analysis', async () => {
    sdk.chatCreate.mockResolvedValueOnce({ choices: [{ message: { content: '   ' } }] })
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.chat([{ role: 'user', content: 'hello' }])
    expect(res?.ok).toBe(false)
    expect((res as { error?: string })?.error).toContain('empty response')
  })

  it('odd completion shape (no choices) → honest { ok: false }, never a throw', async () => {
    sdk.chatCreate.mockResolvedValueOnce({ unexpected: true })
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.chat([{ role: 'user', content: 'hello' }])
    expect(res?.ok).toBe(false)
  })

  it('empty messages / blank content → { ok: false } without contacting the SDK', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    expect((await provider.chat([]))?.ok).toBe(false)
    expect((await provider.chat([{ role: 'user', content: '   ' }]))?.ok).toBe(false)
    expect(sdk.chatCreate).not.toHaveBeenCalled()
  })

  it('a call that never settles fails honestly after the 20s cap (the SDK fetch has no timeout)', async () => {
    vi.useFakeTimers()
    sdk.chatCreate.mockReturnValueOnce(new Promise(() => {})) // never settles
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const pending = provider.chat([{ role: 'user', content: 'hello' }])
    await vi.advanceTimersByTimeAsync(20_000)
    const res = await pending
    expect(res).toEqual({ ok: false, error: 'AI chat timed out after 20s' })
  })
})

/** vision() — image analysis over one prompt + photo URLs. */
describe('vision()', () => {
  it('success → { ok: true, text }; text + image_url items in order, https URLs passed through', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.vision('What stage is this walling?', [
      'data:image/jpeg;base64,/9j/4AAQ',
      'https://photos.example/day-47.jpg',
    ])
    expect(res).toEqual({ ok: true, text: 'walling at 68 percent' })
    expect(sdk.visionCreate).toHaveBeenCalledTimes(1)
    const body = sdk.visionCreate.mock.calls[0][0] as {
      model: string
      messages: Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>
      thinking: { type: string }
    }
    expect(body.model).toBe('glm-5v-turbo')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'What stage is this walling?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
      { type: 'image_url', image_url: { url: 'https://photos.example/day-47.jpg' } },
    ])
  })

  it('no images (or all-blank) → { ok: false } without contacting the SDK', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    expect((await provider.vision('describe', []))?.ok).toBe(false)
    expect((await provider.vision('describe', ['  ']))?.ok).toBe(false)
    expect(sdk.visionCreate).not.toHaveBeenCalled()
  })

  it('blank prompt → { ok: false } without contacting the SDK', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    expect((await provider.vision('   ', ['data:image/jpeg;base64,AAA']))?.ok).toBe(false)
    expect(sdk.visionCreate).not.toHaveBeenCalled()
  })

  it('SDK throws → { ok: false, error }, never thrown into the caller, leak-free', async () => {
    sdk.visionCreate.mockRejectedValueOnce(new Error('API request failed with status 429: rate limited for key sk-999'))
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.vision('describe', ['data:image/jpeg;base64,AAA'])
    expect(res?.ok).toBe(false)
    if (!res?.ok) {
      expect(res.error).toContain('HTTP 429')
      expect(res.error).not.toContain('sk-999')
    }
  })

  it('empty model content → honest { ok: false }', async () => {
    sdk.visionCreate.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] })
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    expect((await provider.vision('describe', ['data:image/jpeg;base64,AAA']))?.ok).toBe(false)
  })

  it('a call that never settles fails honestly after the 20s cap', async () => {
    vi.useFakeTimers()
    sdk.visionCreate.mockReturnValueOnce(new Promise(() => {}))
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const pending = provider.vision('describe', ['data:image/jpeg;base64,AAA'])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await pending).toEqual({ ok: false, error: 'AI vision timed out after 20s' })
  })
})

/** transcribe() — speech-to-text from a data: URL or bare base64. */
describe('transcribe()', () => {
  it('data: URL → { ok: true, text } with the prefix STRIPPED (file_base64 payload only)', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.transcribe('data:audio/webm;base64,QUJDREVG')
    expect(res).toEqual({ ok: true, text: 'amelewa bags ishirini ya cement' })
    expect(sdk.asrCreate).toHaveBeenCalledWith({ file_base64: 'QUJDREVG' })
  })

  it('bare base64 passes through as-is', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    await provider.transcribe('QUJDREVG')
    expect(sdk.asrCreate).toHaveBeenCalledWith({ file_base64: 'QUJDREVG' })
  })

  it('blank ASR text → honest { ok: false } — never a faked empty transcript', async () => {
    sdk.asrCreate.mockResolvedValueOnce({ text: '   ' })
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.transcribe('data:audio/webm;base64,QUJD')
    expect(res?.ok).toBe(false)
  })

  it('SDK throws → { ok: false, error }, never thrown, leak-free (status only)', async () => {
    sdk.asrCreate.mockRejectedValueOnce(new Error('API request failed with status 500: audio too large for key sk-1'))
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.transcribe('data:audio/webm;base64,QUJD')
    expect(res?.ok).toBe(false)
    if (!res?.ok) {
      expect(res.error).toContain('HTTP 500')
      expect(res.error).not.toContain('sk-1')
    }
  })

  it('empty audio → { ok: false } without contacting the SDK', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    expect((await provider.transcribe(''))?.ok).toBe(false)
    expect((await provider.transcribe('    '))?.ok).toBe(false)
    expect(sdk.asrCreate).not.toHaveBeenCalled()
  })

  it('an http(s) URL is rejected honestly — the seam takes bytes, not remote fetches', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.transcribe('https://bucket.example/note.webm')
    expect(res?.ok).toBe(false)
    if (!res?.ok) expect(res.error).toContain('not a URL')
    expect(sdk.asrCreate).not.toHaveBeenCalled()
  })

  it('a data: URL without base64 (or without a payload) → { ok: false }, SDK untouched', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    expect((await provider.transcribe('data:audio/webm,QUJD'))?.ok).toBe(false)
    expect((await provider.transcribe('data:audio/webm;base64,'))?.ok).toBe(false)
    expect(sdk.asrCreate).not.toHaveBeenCalled()
  })

  it('a call that never settles fails honestly after the 20s cap', async () => {
    vi.useFakeTimers()
    sdk.asrCreate.mockReturnValueOnce(new Promise(() => {}))
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const pending = provider.transcribe('data:audio/webm;base64,QUJD')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await pending).toEqual({ ok: false, error: 'AI transcription timed out after 20s' })
  })
})

/** speak() — text-to-speech of caller-held deterministic text (W6-2). */
describe('speak()', () => {
  it('success → { ok: true, audioBase64, mimeType } that round-trips to a parseable WAV', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.speak('Habari. This week your money built the ring beam.')
    expect(res?.ok).toBe(true)
    if (res?.ok) {
      expect(res.mimeType).toBe('audio/wav')
      const buf = Buffer.from(res.audioBase64, 'base64')
      expect(buf.length).toBeGreaterThan(44)
      const wav = parseWavBuffer(buf)
      expect(wav).not.toBeNull()
      expect(wav?.data.length).toBe(320)
      expect(wav?.audioFormat).toBe(1)
    }
  })

  it('forwards the documented request shape (input, voice, speed, wav, stream:false); opts override voice/speed', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    await provider.speak('One short sentence.', { voice: 'tongtong', speed: 1.5 })
    expect(sdk.ttsCreate).toHaveBeenCalledWith({
      input: 'One short sentence.',
      voice: 'tongtong',
      speed: 1.5,
      response_format: 'wav',
      stream: false,
    })
  })

  it('defaults: the clear/standard voice, speed 1.0', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    await provider.speak('Default voice and speed.')
    const body = sdk.ttsCreate.mock.calls[0][0] as { voice: string; speed: number }
    expect(body.voice).toBe('kazi')
    expect(body.speed).toBe(1.0)
  })

  it('empty / whitespace text → { ok: false } without contacting the SDK', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    expect((await provider.speak(''))?.ok).toBe(false)
    expect((await provider.speak('   '))?.ok).toBe(false)
    expect(sdk.ttsCreate).not.toHaveBeenCalled()
  })

  it('speed outside the 0.5–2.0 API range → { ok: false } without contacting the SDK', async () => {
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    expect((await provider.speak('hello', { speed: 4 }))?.ok).toBe(false)
    expect((await provider.speak('hello', { speed: 0.1 }))?.ok).toBe(false)
    expect((await provider.speak('hello', { speed: Number.NaN }))?.ok).toBe(false)
    expect(sdk.ttsCreate).not.toHaveBeenCalled()
  })

  it('text longer than the 1024-char request cap is CHUNKED at sentence boundaries — one SDK call per chunk, every input ≤1000, nothing dropped', async () => {
    const sentence = 'Mjengo score imepanda kwa tano kwa sababu ya ushahidi mpya. ' // ~60 chars
    const longText = sentence.repeat(30).trim() // ~1800 chars → 2 chunks
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.speak(longText)
    expect(res?.ok).toBe(true)
    expect(sdk.ttsCreate.mock.calls.length).toBeGreaterThanOrEqual(2)
    const inputs = sdk.ttsCreate.mock.calls.map((c) => (c[0] as { input: string }).input)
    for (const input of inputs) expect(input.length).toBeLessThanOrEqual(1_000)
    // No sentence dropped: the chunks re-glue to the source text (mod whitespace).
    expect(inputs.join(' ').replace(/\s+/g, ' ').trim()).toBe(longText.replace(/\s+/g, ' ').trim())
  })

  it('multi-chunk audio is MERGED into ONE WAV: one header, PCM payloads concatenated', async () => {
    const a = fakeWav(100)
    const b = fakeWav(60)
    sdk.ttsCreate
      .mockImplementationOnce(async () => wavResponse(a))
      .mockImplementationOnce(async () => wavResponse(b))
    const sentence = 'Sentence one here. '
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.speak(sentence.repeat(80).trim()) // ~1500 chars → 2+ chunks
    expect(sdk.ttsCreate.mock.calls.length).toBeGreaterThanOrEqual(2)
    if (!res?.ok) throw new Error('expected ok')
    const merged = parseWavBuffer(Buffer.from(res.audioBase64, 'base64'))
    expect(merged).not.toBeNull()
    expect(merged?.data.length).toBe(160) // 100 + 60 — both payloads present
  })

  it('ANY chunk failure fails the WHOLE call — partial audio is never returned (a missing sentence would misrepresent the text)', async () => {
    sdk.ttsCreate
      .mockImplementationOnce(async () => wavResponse(fakeWav(100)))
      .mockRejectedValueOnce(new Error('API request failed with status 503: overloaded for key sk-tts-77'))
    const sentence = 'Sentence one here. '
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.speak(sentence.repeat(80).trim())
    expect(res?.ok).toBe(false)
    if (!res?.ok) {
      expect(res.error).toContain('HTTP 503')
      expect(res.error).not.toContain('sk-tts-77') // leak-free
    }
  })

  it('a non-audio content-type response → { ok: false } leak-free, never fake audio', async () => {
    sdk.ttsCreate.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'quota exceeded', key: 'sk-9' }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.speak('hello')
    expect(res?.ok).toBe(false)
    if (!res?.ok) expect(res.error).not.toContain('quota exceeded')
  })

  it('audio-declared but non-WAV bytes → { ok: false } (RIFF magic is verified, not trusted)', async () => {
    sdk.ttsCreate.mockResolvedValueOnce(
      new Response(Buffer.from('not a wav at all, just bytes'), {
        headers: { 'content-type': 'audio/wav' },
      }),
    )
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    expect((await provider.speak('hello'))?.ok).toBe(false)
  })

  it('chunks with INCONSISTENT PCM formats are refused, not stitched', async () => {
    sdk.ttsCreate
      .mockImplementationOnce(async () => wavResponse(fakeWav(100, { sampleRate: 8000 })))
      .mockImplementationOnce(async () => wavResponse(fakeWav(100, { sampleRate: 16000 })))
    const sentence = 'Sentence one here. '
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const res = await provider.speak(sentence.repeat(80).trim())
    expect(res?.ok).toBe(false)
    if (!res?.ok) expect(res.error).toContain('inconsistent audio formats')
  })

  it('a failed create() (no .z-ai-config) → null — "AI unavailable", never a throw', async () => {
    sdk.create.mockRejectedValueOnce(new Error('Configuration file not found or invalid.'))
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    expect(await provider.speak('hello')).toBeNull()
    expect(sdk.ttsCreate).not.toHaveBeenCalled()
  })

  it('a call that never settles fails honestly after the 20s cap (per chunk)', async () => {
    vi.useFakeTimers()
    sdk.ttsCreate.mockReturnValueOnce(new Promise(() => {}))
    const provider = resolveAiProvider({ ai: true }) as AiProvider
    const pending = provider.speak('hello')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await pending).toEqual({ ok: false, error: 'AI speech timed out after 20s' })
  })
})

/** The pure TTS helpers — the chunker and the WAV parser/builder contracts. */
describe('TTS helpers (pure)', () => {
  it('chunkTextForTts: short text → ONE chunk; whole sentences never split mid-sentence', () => {
    const chunks = chunkTextForTts('One. Two. Three.', 1000)
    expect(chunks).toEqual(['One. Two. Three.'])
  })

  it('chunkTextForTts: packs sentences up to the cap; every chunk ≤ cap; nothing lost', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} here.`).join(' ')
    const chunks = chunkTextForTts(text, 120)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120)
    expect(chunks.join(' ')).toBe(text)
  })

  it('chunkTextForTts: a single over-long sentence splits at word boundaries', () => {
    const text = 'word '.repeat(60).trim() // 300 chars, one "sentence"
    const chunks = chunkTextForTts(text, 100)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100)
    expect(chunks.join(' ')).toBe(text)
  })

  it('chunkTextForTts: empty text → no chunks (the caller fails honestly upstream)', () => {
    expect(chunkTextForTts('   ', 100)).toEqual([])
  })

  it('parseWavBuffer ↔ buildWavBuffer round-trip; non-PCM and garbage → null, never a throw', () => {
    const wav = fakeWav(64, { sampleRate: 44_100, channels: 2, bits: 16 })
    const parsed = parseWavBuffer(wav)
    expect(parsed).toMatchObject({ audioFormat: 1, channels: 2, sampleRate: 44_100, bitsPerSample: 16 })
    expect(parsed?.data.length).toBe(64)
    expect(parseWavBuffer(Buffer.alloc(12))).toBeNull()
    expect(parseWavBuffer(Buffer.from('RIFF____WAVEjunkjunkjunk'))).toBeNull()
    // A WAV whose fmt declares non-PCM (audioFormat 0) is refused honestly.
    const nonPcm = buildWavBuffer({ audioFormat: 3, channels: 1, sampleRate: 8000, bitsPerSample: 16 }, Buffer.alloc(8))
    expect(parseWavBuffer(nonPcm)).toBeNull()
  })
})
