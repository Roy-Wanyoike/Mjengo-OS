import ZAI from 'z-ai-web-dev-sdk'
import type { AiAudioResult, AiChatMessage, AiProvider, AiTextResult } from './types'

// AI module — the ZaiProvider implementation + flag resolution (provider.ts).
//
// The one AiProvider implementation behind the seam types.ts documents.
// It wraps z-ai-web-dev-sdk — the same SDK the existing /api/ai routes use
// (src/backend/lib/ai.ts, voice-log) — lifted into the honest-seam rules so
// Wave-6 features never call the SDK directly:
//
//   · BACKEND ONLY: z-ai-web-dev-sdk is imported here and nowhere client-
//     side, ever. It reads a config file holding an API key and puts that
//     key in an Authorization header — none of that may reach a browser
//     bundle. (The SDK is ESM-only and fs-based; a client import would fail
//     to even bundle.)
//   · NO ENV VARS (honest): the SDK self-configures — ZAI.create() reads a
//     .z-ai-config JSON file ({ baseUrl, apiKey }) from the process cwd,
//     the home directory, or /etc. That is why .env.example gains NO AI
//     entries: there is nothing to set on the app env. When no config file
//     exists, create() rejects — resolveAiProvider still returns the
//     provider (the flag is on), but every call answers null: the honest
//     "AI unavailable" state. Nothing is faked, no secret is echoed.
//   · SINGLETON: the SDK instance is created ONCE per process on first use
//     and cached module-level (ZAI.create() re-reads the config file every
//     call — worth avoiding per request). A FAILED create() is never
//     cached: the next call retries, so an operator dropping the config in
//     later is picked up without a restart.
//   · 20s CAP on every SDK call: the SDK's own fetch has NO timeout, so each
//     call is raced against a timer — a stuck model API can never hang a route
//     handler. (Raised from the AT-provider's 8s: multi-photo vision requests
//     carry ~1–2 MB of base64 and measured 6–8s alone in production testing —
//     8s made real reviews borderline-fail. The abandoned SDK request still
//     finishes in the background and is discarded.)
//   · NEVER THROWS, LEAK-FREE ERRORS: every failure mode comes back as
//     { ok: false, error }. SDK failures embed the request URL, the API
//     error body and stack traces in messages — NONE of that reaches a
//     result. error carries the HTTP status (three digits, extracted with
//     a strict regex) when the SDK surfaced one, else the error CLASS name
//     only (same hygiene as notify/channels.ts).
//   · SPEAK (W6-2, the one rendering exception the types.ts header
//     documents): text-to-speech over zai.audio.tts.create. The SDK
//     returns the RAW fetch Response — this provider owns arrayBuffer(),
//     the non-audio content-type check, RIFF/WAVE parsing, sentence
//     chunking under the API's 1024-char request cap (packed to 1000) and
//     the PCM merge into ONE WAV. The input text is always CALLER-HELD
//     deterministic prose (the trust digest); the model never authors
//     what is spoken. WAV (not mp3): merging linear PCM is byte-mechanical
//     with no re-encoding, so the concatenation is honest by construction.
//   · RESOLUTION (the notify getSmsProvider pattern, flag-flavored):
//     resolveAiProvider(flags) is synchronous and cheap — it constructs a
//     fresh ZaiProvider when flags.ai === true and returns null otherwise.
//     `flags` is structural ({ ai?: boolean }): a FlagMap from
//     getFlags() (intel/flags.ts) drops straight in, and tests pass plain
//     literals — no intel import, no import cycle. The `ai` flag is
//     DEFAULT OFF (an admin turns the AI surface on deliberately); a
//     missing key fails closed exactly like a false one.

/** Hard cap on any single SDK call — 20s, then the attempt fails honestly. */
const AI_CALL_TIMEOUT_MS = 20_000

/** Vision model — the same one the existing photo-analysis path uses (lib/ai.ts). */
const VISION_MODEL = 'glm-5v-turbo'

/**
 * TTS (W6-2) — the default voice for speak(). 'kazi' is the SDK's
 * clear/standard voice (its skill docs list it alongside 'tongtong', 'jam',
 * 'xiaochen'); a digest read aloud wants plain clarity, and callers can
 * override per call through speak(text, { voice }).
 */
const DEFAULT_TTS_VOICE = 'kazi'

/**
 * Hard per-request input cap documented by the TTS API: 1024 characters.
 * speak() chunks at 1000 to leave headroom under the cap (the chunker
 * packs whole sentences up to this length before a hard word-boundary
 * split — see chunkTextForTts).
 */
const MAX_TTS_CHUNK_CHARS = 1_000

// ── the module-level SDK singleton ───────────────────────────────────────────

/** Cached create() promise — null until first use, or after a failure (never poison the cache). */
let zaiPromise: Promise<ZAI> | null = null

/**
 * The lazy singleton: create the SDK once, cache the SUCCESS. A rejected
 * create() resets the cache and rethrows to the caller's catch — the next
 * call retries (config-file discipline documented in the module header).
 */
async function getZaiSdk(): Promise<ZAI> {
  if (!zaiPromise) {
    zaiPromise = ZAI.create().catch((err: unknown) => {
      zaiPromise = null // do not cache the failure — retry on the next call
      throw err
    })
  }
  return zaiPromise
}

/**
 * Drop the cached SDK instance so the next call re-creates it. The test
 * hook for the singleton (the flags module's invalidateFlagCache() role);
 * also correct if an operator changes the config file at runtime.
 */
export function resetAiSdkCache(): void {
  zaiPromise = null
}

// ── leak-free helpers ────────────────────────────────────────────────────────

/** Race sentinel — the 8s cap fired before the SDK answered. */
const TIMED_OUT = Symbol('zai-call-timeout')

/**
 * Pull choices[0].message.content out of an SDK completion. Defensive by
 * construction: the SDK's create() is typed Promise<any>, so an odd shape
 * is an honest EMPTY response (''), never a throw. Trimmed — the result
 * contract says text is non-empty trimmed model output.
 */
function pickContent(completion: unknown): string {
  try {
    const content = (completion as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]
      ?.message?.content
    return typeof content === 'string' ? content.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Map ANY thrown value to a leak-free error fragment. The SDK's failure
 * messages embed the endpoint URL, the provider's error body and stack
 * traces — none of that ever reaches a result. What survives: the HTTP
 * status (three digits, strictly regexed) when the SDK surfaced one, else
 * the error CLASS name only. Same hygiene as notify/channels.ts.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const status = /\bstatus (\d{3})\b/.exec(err.message)
    if (status) return `HTTP ${status[1]}`
    return err.name
  }
  return 'unknown'
}

/**
 * Accept a data: URL (data:audio/webm;base64,AAAA…) or bare base64 and
 * return the base64 payload, or null when there is nothing usable. The
 * SDK's ASR wants the RAW payload (file_base64) — the data: prefix is
 * browser metadata, not model input.
 */
function extractBase64(audioDataUrl: string): string | null {
  const s = typeof audioDataUrl === 'string' ? audioDataUrl.trim() : ''
  if (!s) return null
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',')
    if (comma === -1) return null // data: URL without a payload
    if (!s.slice(5, comma).toLowerCase().includes('base64')) return null // data: URL, not base64-encoded
    return s.slice(comma + 1).trim() || null
  }
  return s // already bare base64
}

// ── TTS helpers (W6-2) ───────────────────────────────────────────────────────

/**
 * Split text into chunks of whole sentences, each at most `maxChars` (the
 * TTS API caps ONE request at 1024 characters — the caller passes 1000 to
 * leave headroom). Sentences break on . ! ? … and newlines. A single
 * sentence longer than the cap is hard-split at word boundaries (and, in
 * the pathological no-space case, by raw length) — the text is
 * deterministic platform-composed prose, so a mid-word cut cannot corrupt
 * a figure, but the chunker still avoids it.
 */
export function chunkTextForTts(text: string, maxChars: number): string[] {
  const src = text.trim()
  if (!src) return []
  if (maxChars < 1) return [src]
  // Sentence split: keep the terminator with the sentence.
  const sentences = src.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [src]
  const chunks: string[] = []
  let current = ''
  const flush = () => {
    const t = current.trim()
    if (t) chunks.push(t)
    current = ''
  }
  for (const sentence of sentences.map((s) => (s.endsWith('\n') ? s.trim() + ' ' : s))) {
    const piece = sentence.trim()
    if (!piece) continue
    if (piece.length > maxChars) {
      // Flush what we have, then hard-split the over-long sentence at word
      // boundaries (last resort: raw length).
      flush()
      let words = piece.split(/(\s+)/) // keep separators so gluing preserves spacing
      let part = ''
      for (const w of words) {
        if ((part + w).trim().length > maxChars && part.trim()) {
          chunks.push(part.trim())
          part = w.trimStart()
        } else {
          part += w
        }
        // A single word longer than the cap (pathological) — cut it raw.
        while (part.length > maxChars) {
          chunks.push(part.slice(0, maxChars))
          part = part.slice(maxChars)
        }
      }
      if (part.trim()) chunks.push(part.trim())
      words = []
      continue
    }
    if ((current + ' ' + piece).trim().length > maxChars) flush()
    current = current ? `${current} ${piece}` : piece
  }
  flush()
  return chunks
}

/** One parsed PCM WAV — the minimal shape the concatenator needs. */
interface WavFormat {
  audioFormat: number // 1 = PCM (the only form this provider merges)
  channels: number
  sampleRate: number
  bitsPerSample: number
  data: Buffer // the PCM payload
}

/**
 * Parse a RIFF/WAVE buffer into its PCM payload + format, or null when it
 * is not a WAV we can honestly merge (missing RIFF/WAVE magic, no fmt/data
 * chunk, or non-PCM audio format). Defensive by construction: the TTS API
 * documents wav output, but a proxy/gateway could hand back anything — a
 * non-audio body is an honest failure, never a throw, never fake audio.
 */
export function parseWavBuffer(buf: Buffer): WavFormat | null {
  try {
    if (!buf || buf.length < 12) return null
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
    let offset = 12
    let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null
    let data: Buffer | null = null
    while (offset + 8 <= buf.length) {
      const chunkId = buf.toString('ascii', offset, offset + 4)
      const chunkSize = buf.readUInt32LE(offset + 4)
      const body = buf.subarray(offset + 8, offset + 8 + chunkSize)
      if (chunkId === 'fmt ' && chunkSize >= 16) {
        fmt = {
          audioFormat: body.readUInt16LE(0),
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          bitsPerSample: body.readUInt16LE(14),
        }
      } else if (chunkId === 'data') {
        data = Buffer.from(body)
      }
      // RIFF chunks are word-aligned: walk the declared size, padded to even.
      offset += 8 + chunkSize + (chunkSize % 2)
    }
    if (!fmt || !data) return null
    if (fmt.audioFormat !== 1) return null // only linear PCM merges mechanically
    if (data.length === 0) return null
    return { ...fmt, data }
  } catch {
    return null
  }
}

/**
 * Build ONE canonical 44-byte-header PCM WAV from a format + concatenated
 * payload (the inverse of parseWavBuffer — used by speak() to hand the
 * caller a single playable object).
 */
export function buildWavBuffer(fmt: Omit<WavFormat, 'data'>, data: Buffer): Buffer {
  const byteRate = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8)
  const blockAlign = fmt.channels * (fmt.bitsPerSample / 8)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM fmt chunk size
  header.writeUInt16LE(fmt.audioFormat, 20)
  header.writeUInt16LE(fmt.channels, 22)
  header.writeUInt32LE(fmt.sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(fmt.bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * Read a TTS API response (the raw fetch Response the SDK returns) into a
 * parsed WAV, or an honest failure reason: a non-audio content-type when
 * the response declares one, a failed body read, or an unparseable/not-PCM
 * body. Never throws.
 */
async function responseToWav(
  response: unknown,
): Promise<{ ok: true; wav: WavFormat } | { ok: false; reason: string }> {
  const res = response as { arrayBuffer?: unknown; headers?: { get?: (name: string) => string | null } } | null
  if (!res || typeof res.arrayBuffer !== 'function') {
    return { ok: false, reason: 'TTS response was not a readable Response' }
  }
  const contentType = typeof res.headers?.get === 'function' ? res.headers.get('content-type') ?? '' : ''
  if (contentType && !/^audio\//i.test(contentType)) {
    // The response SAYS it is not audio — believe it, never ship the body.
    return { ok: false, reason: 'TTS response content-type was not audio' }
  }
  let bytes: ArrayBuffer
  try {
    bytes = await res.arrayBuffer()
  } catch {
    return { ok: false, reason: 'TTS response body could not be read' }
  }
  const buf = Buffer.from(new Uint8Array(bytes))
  if (buf.length === 0) return { ok: false, reason: 'TTS response was empty' }
  const wav = parseWavBuffer(buf)
  if (!wav) return { ok: false, reason: 'TTS response was not a parseable PCM WAV' }
  return { ok: true, wav }
}

// ── the provider ─────────────────────────────────────────────────────────────

/**
 * The z-ai-web-dev-sdk implementation of the AiProvider seam. Every method
 * funnels through attempt() — the one execution path that owns the honesty
 * rules (singleton resolution, 8s race, leak-free errors, never-throws).
 * Constructed fresh by resolveAiProvider(); the expensive part (the SDK
 * instance) is the module-level cache above.
 */
export class ZaiProvider implements AiProvider {
  readonly id = 'zai'
  readonly label = 'Z AI (z-ai-web-dev-sdk)'

  async chat(messages: AiChatMessage[]): Promise<AiTextResult | null> {
    if (!messages.length || messages.some((m) => !m.content.trim())) {
      // Caller bug, reported honestly — the SDK is not contacted.
      return { ok: false, error: 'AI chat called with empty messages — nothing sent' }
    }
    return this.attempt('AI chat', async (zai) => {
      const completion: unknown = await zai.chat.completions.create({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        thinking: { type: 'disabled' },
      })
      return pickContent(completion)
    })
  }

  async vision(prompt: string, imageDataUrls: string[]): Promise<AiTextResult | null> {
    if (!prompt.trim()) {
      return { ok: false, error: 'AI vision called with an empty prompt — nothing sent' }
    }
    // Defensive: filter blank entries; a caller passing an empty/blank list
    // is a bug reported honestly — the vision API is not contacted.
    const images = Array.isArray(imageDataUrls) ? imageDataUrls.filter((u) => typeof u === 'string' && u.trim()) : []
    if (!images.length) {
      return { ok: false, error: 'AI vision called with no images — nothing sent' }
    }
    return this.attempt('AI vision', async (zai) => {
      const completion: unknown = await zai.chat.completions.createVision({
        model: VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              // data: URLs and https: URLs pass through as-is — the vision
              // API accepts both address forms directly.
              ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
            ],
          },
        ],
        thinking: { type: 'disabled' },
      })
      return pickContent(completion)
    })
  }

  async transcribe(audioDataUrl: string): Promise<AiTextResult | null> {
    const raw = typeof audioDataUrl === 'string' ? audioDataUrl.trim() : ''
    if (!raw) {
      return { ok: false, error: 'AI transcription called with empty audio — nothing sent' }
    }
    if (/^https?:\/\//i.test(raw)) {
      // The ASR API takes base64 bytes, not URLs — fetching remote audio is
      // the caller's job (and a policy decision this seam does not make).
      return { ok: false, error: 'AI transcription needs base64 audio, not a URL — fetch it first' }
    }
    const base64 = extractBase64(raw)
    if (!base64) {
      return { ok: false, error: 'AI transcription audio has no base64 payload — nothing sent' }
    }
    return this.attempt('AI transcription', async (zai) => {
      const asr: unknown = await zai.audio.asr.create({ file_base64: base64 })
      const text = (asr as { text?: unknown } | null)?.text
      return typeof text === 'string' ? text.trim() : ''
    })
  }

  async speak(text: string, opts?: { voice?: string; speed?: number }): Promise<AiAudioResult | null> {
    const raw = typeof text === 'string' ? text.trim() : ''
    if (!raw) {
      // Caller bug, reported honestly — the SDK is not contacted.
      return { ok: false, error: 'AI speech called with empty text — nothing sent' }
    }
    const speed = typeof opts?.speed === 'number' ? opts.speed : 1.0
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2.0) {
      return { ok: false, error: 'AI speech speed must be between 0.5 and 2.0 — nothing sent' }
    }
    const voice =
      typeof opts?.voice === 'string' && opts.voice.trim() ? opts.voice.trim() : DEFAULT_TTS_VOICE

    // ONE request per sentence-packed chunk (the API caps a request at 1024
    // characters — the chunker packs to 1000). ANY chunk failure fails the
    // whole call: partial audio would silently drop sentences out of the
    // deterministic text the caller holds, and the digest must be read whole
    // or not at all.
    const chunks = chunkTextForTts(raw, MAX_TTS_CHUNK_CHARS)
    const wavs: WavFormat[] = []
    for (const chunk of chunks) {
      const res = await this.attemptRaw('AI speech', async (zai) => {
        const response: unknown = await zai.audio.tts.create({
          input: chunk,
          voice,
          speed,
          response_format: 'wav',
          stream: false, // required for wav/mp3 — we want the full body
        })
        const wav = await responseToWav(response)
        if (!wav.ok) {
          // Honest failure surfaced as a THROW inside the attempt so it lands
          // in the same leak-free { ok: false, error } mapping below.
          throw new Error(wav.reason)
        }
        return wav.wav
      })
      if (res === null) return null // SDK unavailable — no attempt was possible
      if (!res.ok) return { ok: false, error: res.error }
      wavs.push(res.value)
    }
    if (!wavs.length) {
      return { ok: false, error: 'AI speech produced no audio chunks' }
    }
    // Merge: every chunk must carry the SAME PCM format — the API renders one
    // voice at one rate, so a mismatch is an anomaly we refuse to stitch.
    const first = wavs[0]
    const mismatched = wavs.find(
      (w) =>
        w.audioFormat !== first.audioFormat ||
        w.channels !== first.channels ||
        w.sampleRate !== first.sampleRate ||
        w.bitsPerSample !== first.bitsPerSample,
    )
    if (mismatched) {
      return { ok: false, error: 'AI speech chunks carried inconsistent audio formats — not stitched' }
    }
    const merged = buildWavBuffer(
      {
        audioFormat: first.audioFormat,
        channels: first.channels,
        sampleRate: first.sampleRate,
        bitsPerSample: first.bitsPerSample,
      },
      Buffer.concat(wavs.map((w) => w.data)),
    )
    return { ok: true, audioBase64: merged.toString('base64'), mimeType: 'audio/wav' }
  }

  /**
   * THE honesty core (generic) — the one path every method shares:
   *   1. resolve the SDK singleton; a failed create() (no/invalid config)
   *      returns null — the provider is UNAVAILABLE, not "failed";
   *   2. race the SDK call against the 8s cap — timeout fails honestly;
   *   3. an empty answer fails honestly (never fake an analysis);
   *   4. ANY throw is caught and mapped to a leak-free { ok: false, error };
   *   5. the timer always clears (no dangling handle holds the process).
   */
  private async attemptRaw<T>(
    label: string,
    run: (zai: ZAI) => Promise<T>,
    isEmpty: (value: T) => boolean = (v) => !v,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string } | null> {
    let zai: ZAI
    try {
      zai = await getZaiSdk()
    } catch {
      // SDK unusable (no/invalid .z-ai-config) — unavailable, never thrown,
      // never faked. Distinct from { ok: false }: no attempt was possible.
      return null
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const raced = await Promise.race([
        run(zai),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), AI_CALL_TIMEOUT_MS)
        }),
      ])
      if (raced === TIMED_OUT) {
        return { ok: false, error: `${label} timed out after ${AI_CALL_TIMEOUT_MS / 1000}s` }
      }
      if (isEmpty(raced)) {
        return { ok: false, error: `${label} returned an empty response` }
      }
      return { ok: true, value: raced }
    } catch (err) {
      // Never throw into the caller; error CLASS / HTTP status only.
      return { ok: false, error: `${label} failed (${describeError(err)})` }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * THE honesty core — the text-result twin of attemptRaw (chat/vision/
   * transcribe): identical discipline, mapped onto the AiTextResult shape.
   */
  private async attempt(label: string, run: (zai: ZAI) => Promise<string>): Promise<AiTextResult | null> {
    const res = await this.attemptRaw(label, run)
    if (res === null) return null
    return res.ok ? { ok: true, text: res.value } : { ok: false, error: res.error }
  }
}

// ── resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve the AI provider from the flag map — the notify-style getter,
 * flag-flavored (fail-closed):
 *   · flags.ai !== true (flag off, or the key absent — it is default OFF)
 *     → null. No provider exists: callers render the honest "AI features
 *     are off" state and the SDK is never contacted.
 *   · flags.ai === true → a ZaiProvider (cheap + synchronous; the SDK
 *     instance itself is created lazily on first call).
 *
 * `flags` is structural ({ ai?: boolean }) — the FlagMap from getFlags()
 * (src/backend/modules/intel/flags.ts) drops straight in:
 *   const provider = resolveAiProvider(await getFlags())
 */
export function resolveAiProvider(flags: Readonly<{ ai?: boolean }>): AiProvider | null {
  return flags.ai === true ? new ZaiProvider() : null
}
