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
//   · ANALYSIS ONLY: chat (text completion), vision (image analysis) and
//     transcribe (speech-to-text) are describe-the-evidence capabilities.
//     Image generation and text-to-speech are deliberately NOT on this seam
//     — creating content is a different trust conversation than analyzing
//     it, and this foundation stays on the analysis side.
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
}
