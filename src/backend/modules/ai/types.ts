// AI module — types for the provider seam (src/backend/modules/ai).
//
// THE PHILOSOPHY (read this before building a Wave-6 feature on the seam):
//   AI describes and flags; it NEVER approves. The ledger never lies; AI
//   output is advisory only, never an authority. Every Wave-6 feature (AI
//   draw review, site assistant, voice reports) codes against THIS seam so
//   those rules live in exactly one place:
//
//   · FLAG-GATED: the `ai` feature flag (src/backend/modules/intel/flags.ts,
//     default OFF — task 8-f) is the single switch for the whole AI surface.
//     resolveAiProvider(flags) returns null when the flag is not on; every
//     caller then renders its honest "AI features are off" state. There are
//     NO env vars for this module on purpose (the SDK self-configures — see
//     the provider.ts header).
//   · FAIL-CLOSED: a null provider or a null result means "unavailable" —
//     never an error thrown into a caller, never a faked analysis. A feature
//     that cannot reach AI says so; it does not invent output.
//   · NEVER THROWS: AiProvider methods return results. An internal failure
//     comes back as { ok: false, error } where error is LEAK-FREE and
//     operator-readable — error class or HTTP status only, never stack
//     traces, never credential fragments, never provider URLs (the same
//     discipline as the notify ChannelProvider seam).
//   · ADVISORY ONLY: { ok: true, text } is TEXT a model produced — an
//     observation, suggestion or flag for a HUMAN to read and decide on.
//     It is never a decision, never an approval, never money movement.
//     Features that persist AI output must label it as AI-derived and keep
//     the human decision path explicit (the ledger never lies in either
//     direction: no AI row ever pretends to be a verified fact).
//   · ANALYSIS + ONE NARROW RENDERING EXCEPTION (W6-2 amendment, logged in
//     the worklog): chat (text completion), vision (image analysis) and
//     transcribe (speech-to-text) are describe-the-evidence capabilities;
//     speak (text-to-speech) is the single deliberate addition — it renders
//     TEXT THE CALLER ALREADY HOLDS as audio. speak() invents nothing: the
//     input is always deterministic, row-composed text (the W6-2 trust
//     digest); feeding model output back in as fact stays forbidden, and
//     image generation still has no home on this seam — creating content is
//     a different trust conversation than analyzing it, and reading
//     platform-authored text aloud is rendering, not authorship.
//
// The AiTextResult contract (three honest states, never a throw):
//   { ok: true, text }   — the model answered; text is trimmed and non-empty.
//   { ok: false, error } — an attempt WAS made and failed honestly (SDK
//                          error, timeout, empty response, invalid input).
//   null                 — the provider itself is unavailable (the SDK could
//                          not even be instantiated); callers treat null as
//                          the honest "AI unavailable" state, distinct from
//                          a failed attempt. resolveAiProvider returning null
//                          (flag off) is the same honest state one level up.

/**
 * One message in a chat conversation — roles map 1:1 onto the SDK's
 * ChatMessage; content is plain text (callers build prompts; this seam
 * never parses responses — parsing belongs to the feature, and a parse
 * failure is the feature's honest error, never the provider's).
 */
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** The honest outcome of one AI analysis attempt — never thrown, always returned. */
export type AiTextResult = { ok: true; text: string } | { ok: false; error: string }

/**
 * The honest outcome of one speech-rendering attempt (W6-2) — the same
 * three-state discipline as AiTextResult, never a throw:
 *   { ok: true; audioBase64; mimeType } — the exact caller-held text rendered
 *       as audio bytes, base64-encoded (the caller wraps it in a data: URL or
 *       serves it with the honest content type). ONE concatenated container,
 *       not a per-chunk array: the provider chunks internally at sentence
 *       boundaries (the API caps a request at 1024 chars) and merges the PCM
 *       payloads into a single WAV, so a caller plays exactly one object and
 *       a missing sentence is impossible by construction (any chunk failure
 *       fails the whole call honestly — partial audio would misrepresent the
 *       record it reads).
 *   { ok: false, error }                — an attempt WAS made and failed
 *       honestly (SDK error, timeout, non-audio response, unparseable WAV).
 *   null                                — the provider itself is unavailable.
 */
export type AiAudioResult =
  | { ok: true; audioBase64: string; mimeType: 'audio/wav' | 'audio/mpeg' }
  | { ok: false; error: string }

/**
 * The AI provider seam — the interface every Wave-6 AI feature codes
 * against (the ChannelProvider pattern of notify, applied to analysis).
 * One implementation exists today (ZaiProvider, provider.ts — wraps
 * z-ai-web-dev-sdk, BACKEND ONLY); a future provider implements this
 * interface and gets resolved in provider.ts — no feature changes.
 */
export interface AiProvider {
  readonly id: string
  readonly label: string
  /**
   * Text completion over a message list (system prompt + turns).
   * Empty/blank input is a caller bug and fails honestly ({ ok: false })
   * without contacting the SDK.
   */
  chat(messages: AiChatMessage[]): Promise<AiTextResult | null>
  /**
   * Image analysis: one prompt over one or more photos, each a data: URL
   * (data:image/jpeg;base64,…) or an https: URL. The images are passed
   * through to the vision API as-is; no images (or a blank prompt) fails
   * honestly without contacting the SDK. ADVISORY OUTPUT ONLY — a vision
   * result describes what a photo shows; it never approves a draw.
   */
  vision(prompt: string, imageDataUrls: string[]): Promise<AiTextResult | null>
  /**
   * Speech-to-text: audio as a data: URL (data:audio/…;base64,…) or bare
   * base64. The data: prefix is stripped before the SDK call (its ASR API
   * wants the raw payload). An http(s) URL is rejected honestly — this
   * seam takes bytes the caller already holds, not remote fetches.
   */
  transcribe(audioDataUrl: string): Promise<AiTextResult | null>
  /**
   * Text-to-speech (W6-2, the one rendering exception documented in the
   * module header): renders text the CALLER ALREADY HOLDS as audio. The
   * input is deterministic platform-composed text (the trust digest) —
   * never model output, never a prompt the model answers. Blank text or a
   * speed outside the 0.5–2.0 API range fails honestly without contacting
   * the SDK. Chunks at sentence boundaries under the 1024-char API cap and
   * concatenates the PCM payloads into ONE WAV (see AiAudioResult).
   */
  speak(text: string, opts?: { voice?: string; speed?: number }): Promise<AiAudioResult | null>
}
