// AI actions (W6-1) — the user-facing surface of the modules/ai engine.
//
// `ai.drawReview` runs ONE advisory AI review of a frozen draw pack (vision
// pass over the capped evidence photos + LLM cross-check against the pack's
// milestone/invoice/budget context) and APPENDS one AiReviewNote row.
// Dispatched from lib/mjengo.ts applyAction(), which auto-writes the
// AuditEvent (kind 'ai_review') for every success — never log manually here.
//
// House rules:
//  - AI NEVER APPROVES. The note gates nothing; milestone.decide and every
//    other action are blind to AiReviewNote rows (grep-pinned in
//    tests/unit/ai-draw-review.test.ts). The approval click stays human.
//  - THE ACTION FAILS HONESTLY OR SUCCEEDS — a failed or unavailable review
//    THROWS (no audit row, no note row, no faked analysis): flag off, no
//    pack, provider unavailable, provider error, unparseable output. The
//    thrown message is operator-readable and leak-free.
//  - APPEND-ONLY — re-running appends a new note (latest wins, the
//    append-only trust-score history pattern); there is no update path.
//  - ROLES: contractor/admin only (the mjengo.ts gate mirrors the route
//    allowlists; clients read notes through the share link, they never run
//    reviews).
//  - FLAG: the AI_ACTIONS family is registered in lib/action-flag-gate.ts
//    under the `ai` flag (default OFF) — enforced on POST /api/actions AND
//    per-item on POST /api/sync (the S1 discipline), admin bypass included.

import { runDrawReview } from '@/backend/modules/ai/draw-review'

export const AI_ACTIONS = [
  'ai.drawReview', // { drawPackId? , milestoneId? } — advisory note over one frozen pack
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

    default:
      throw new Error(`Unknown ai action: ${type}`)
  }
}
