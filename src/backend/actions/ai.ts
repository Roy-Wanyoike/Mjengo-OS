// AI actions (W6-1) — the user-facing surface of the modules/ai engine.
//
// `ai.drawReview` runs ONE advisory AI review of a frozen draw pack (vision
// pass over the capped evidence photos + LLM cross-check against the pack's
// milestone/invoice/budget context) and APPENDS one AiReviewNote row.
// `ai.trustDigest` (W6-2) generates ONE weekly trust digest row for a
// language (deterministic row-composed EN/SW text + the TTS voice note when
// the provider is available) and emits ONE 'digest.trust' domain event
// (the event policy lands the honest in-app notification). Dispatched from
// lib/mjengo.ts applyAction(), which auto-writes the AuditEvent (kind
// 'ai_review' / 'ai_digest') for every success — never log manually here.
//
// House rules:
//  - AI NEVER APPROVES. Notes and digests gate nothing; milestone.decide
//    and every other action are blind to AiReviewNote/TrustDigest rows
//    (grep-pinned in tests/unit/ai-draw-review.test.ts and
//    ai-trust-digest.test.ts). The approval click stays human.
//  - THE DIGEST TEXT IS NEVER MODEL-AUTHORED — every figure in it is a
//    ledger row or documented row math (tests/unit/ai-trust-digest.test.ts
//    pins it); the model only SPEAKS the composed text (speak()).
//  - THE ACTION FAILS HONESTLY OR SUCCEEDS — a failed or unavailable
//    generation THROWS (no audit row, no digest row, no fake output): flag
//    off, no project, unparseable input. A TTS failure does NOT fail the
//    action: the text row is still written with the honest audio state
//    (the text is the product, audio is the bonus).
//  - APPEND-ONLY — re-running appends a new digest/note row (latest wins,
//    the append-only trust-score history pattern); there is no update path.
//  - ROLES: contractor/admin only (the mjengo.ts gate mirrors the route
//    allowlists; clients read digests through the share link, they never
//    generate them).
//  - FLAG: the AI_ACTIONS family is registered in lib/action-flag-gate.ts
//    under the `ai` flag (default OFF) — enforced on POST /api/actions AND
//    per-item on POST /api/sync (the S1 discipline), admin bypass included.

import { runDrawReview } from '@/backend/modules/ai/draw-review'
import { buildTrustDigest } from '@/backend/modules/ai/trust-digest'
import { emit } from '@/backend/modules/events/service'

export const AI_ACTIONS = [
  'ai.drawReview', // { drawPackId? , milestoneId? } — advisory note over one frozen pack
  'ai.trustDigest', // { lang: 'en' | 'sw', sinceDays?: number } — deterministic text + TTS voice note
] as const

// ---------------- dispatcher ----------------

export async function applyAiAction(type: string, payload: any, projectId: string): Promise<any> {
  switch (type) {
    case 'ai.drawReview': {
      const p = payload ?? {}
      const drawPackId = typeof p.drawPackId === 'string' && p.drawPackId.trim() ? p.drawPackId.trim() : undefined
      const milestoneId = typeof p.milestoneId === 'string' && p.milestoneId.trim() ? p.milestoneId.trim() : undefined
      if (!drawPackId && !milestoneId) {
        throw new Error('ai.drawReview needs a drawPackId or a milestoneId — nothing to review')
      }
      const outcome = await runDrawReview({ projectId, drawPackId, milestoneId })
      if (!outcome.ok) {
        // Honest failure: no note row, no audit row, no faked analysis.
        throw new Error(outcome.error)
      }
      const { note } = outcome
      return {
        id: note.id,
        drawPackId: note.drawPackId,
        verdict: note.verdict,
        confidence: note.confidence,
        findingsCount: note.findings.length,
        ruleVersion: note.ruleVersion,
        inputsHash: note.inputsHash,
      }
    }

    case 'ai.trustDigest': {
      const p = payload ?? {}
      // Language: explicit 'en' | 'sw'; anything else fails honestly (a
      // silent default would generate a language the user never asked for).
      if (p.lang !== 'en' && p.lang !== 'sw') {
        throw new Error("ai.trustDigest needs an explicit lang of 'en' or 'sw' — nothing was generated")
      }
      const sinceDays =
        typeof p.sinceDays === 'number' && Number.isFinite(p.sinceDays) ? p.sinceDays : undefined
      const outcome = await buildTrustDigest(projectId, { lang: p.lang, sinceDays })
      if (!outcome.ok) {
        // Honest failure: no digest row, no audit row, no faked digest.
        throw new Error(outcome.error)
      }
      const { digest } = outcome
      // One 'digest.trust' domain event per successful generation (the
      // recap.daily event discipline) — the NOTIFY_POLICY lands the honest
      // in-app notification row for the client ('logged', nothing sent).
      await emit(projectId, 'digest.trust', {
        langs: [digest.lang],
        digestIds: [digest.id],
        client: digest.client,
      })
      return {
        id: digest.id,
        lang: digest.lang,
        windowStart: digest.windowStart,
        windowEnd: digest.windowEnd,
        text: digest.text,
        textHash: digest.textHash,
        audioStatus: digest.audioStatus,
        audioError: digest.audioError,
        providerId: digest.providerId,
        ruleVersion: digest.ruleVersion,
        createdAt: digest.createdAt,
      }
    }

    default:
      throw new Error(`Unknown ai action: ${type}`)
  }
}
