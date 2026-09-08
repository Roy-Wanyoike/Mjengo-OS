import ZAI from 'z-ai-web-dev-sdk'
import type { AiChatMessage, AiProvider, AiTextResult } from './types'

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
//   · 8s CAP on every SDK call (the AT-provider discipline): the SDK's own
//     fetch has NO timeout, so each call is raced against an 8s timer — a
//     stuck model API can never hang a route handler. The abandoned SDK
//     request finishes in the background and is discarded.
//   · NEVER THROWS, LEAK-FREE ERRORS: every failure mode comes back as
//     { ok: false, error }. SDK failures embed the request URL, the API
//     error body and stack traces in messages — NONE of that reaches a
//     result. error carries the HTTP status (three digits, extracted with
//     a strict regex) when the SDK surfaced one, else the error CLASS name
//     only (same hygiene as notify/channels.ts).
//   · RESOLUTION (the notify getSmsProvider pattern, flag-flavored):
//     resolveAiProvider(flags) is synchronous and cheap — it constructs a
//     fresh ZaiProvider when flags.ai === true and returns null otherwise.
//     `flags` is structural ({ ai?: boolean }): a FlagMap from
//     getFlags() (intel/flags.ts) drops straight in, and tests pass plain
//     literals — no intel import, no import cycle. The `ai` flag is
//     DEFAULT OFF (an admin turns the AI surface on deliberately); a
//     missing key fails closed exactly like a false one.

/** Hard cap on any single SDK call — 8s, then the attempt fails honestly. */
const AI_CALL_TIMEOUT_MS = 8_000

/** Vision model — the same one the existing photo-analysis path uses (lib/ai.ts). */
const VISION_MODEL = 'glm-5v-turbo'

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

  /**
   * THE honesty core — the one path every method shares:
   *   1. resolve the SDK singleton; a failed create() (no/invalid config)
   *      returns null — the provider is UNAVAILABLE, not "failed";
   *   2. race the SDK call against the 8s cap — timeout fails honestly;
   *   3. an empty model answer fails honestly (never fake an analysis);
   *   4. ANY throw is caught and mapped to a leak-free { ok: false, error };
   *   5. the timer always clears (no dangling handle holds the process).
   */
  private async attempt(label: string, run: (zai: ZAI) => Promise<string>): Promise<AiTextResult | null> {
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
      if (!raced) {
        return { ok: false, error: `${label} returned an empty response` }
      }
      return { ok: true, text: raced }
    } catch (err) {
      // Never throw into the caller; error CLASS / HTTP status only.
      return { ok: false, error: `${label} failed (${describeError(err)})` }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
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
