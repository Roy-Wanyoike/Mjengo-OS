import { NextRequest, NextResponse } from 'next/server'
import { enforceAiRoutePolicy } from '@/backend/lib/rate-limit'
import { safeErrorMessage } from '@/backend/lib/guard'
import {
  extractDocument,
  reviewDocument,
} from '@/backend/modules/documents/service'
import { isReviewDecision } from '@/backend/modules/documents/types'

// Document intelligence API (MjengoOS backend wave B3, Doc A §60).
//
// POST { attachmentId, ocrTextHint? }  → run extraction (image → VLM seam;
//   PDF → honest error unless a client-side ocrTextHint is supplied — this
//   sandbox has no PDF text-extraction library and faking one would poison
//   records). Response: { ok, simulated:false, model, confidence,
//   extraction } — extraction is DRAFT-ONLY: it writes the Attachment row's
//   extraction fields and NEVER any official record (no BOQ / material
//   request / invoice / ledger writes). reviewStatus resets to 'pending'
//   because the content changed.
//
// PUT { attachmentId, decision:'approved'|'rejected', reviewer? } → the
//   human review gate (spec: "AI assists, humans decide"). Sets
//   reviewStatus/reviewBy/reviewedAt and logs an AuditEvent (kind
//   'document') on the linked project.
//
// Both verbs share the W1-SEC /api/ai/* gate (mirrors analyze-photo):
// session → role allowlist [contractor, admin, supervisor] → 10 req/min/user
// → strict body shape (unknown/mistyped fields → 400).

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const POST = async (req: NextRequest): Promise<NextResponse> => {
  const gate = await enforceAiRoutePolicy(req, {
    bucket: 'ai:extract-document',
    fields: [
      { name: 'attachmentId', type: 'string' },
      { name: 'ocrTextHint', type: 'string' },
    ],
  })
  if (!gate.ok) return gate.response

  try {
    const { attachmentId, ocrTextHint } = gate.body as { attachmentId?: string; ocrTextHint?: string }
    if (!attachmentId || !attachmentId.trim()) {
      return NextResponse.json({ error: 'attachmentId is required' }, { status: 400 })
    }
    if (ocrTextHint !== undefined && ocrTextHint.length > 100_000) {
      return NextResponse.json({ error: 'ocrTextHint is capped at 100,000 characters' }, { status: 400 })
    }

    const result = await extractDocument(attachmentId, ocrTextHint ? { ocrTextHint } : {})
    if (!result.ok) {
      // Attachment not found → 404; honest environment limits → 400 with the
      // exact reason (never a fake extraction).
      const status = result.error === 'Attachment not found' ? 404 : 400
      return NextResponse.json({ ok: false, error: result.error }, { status })
    }

    return NextResponse.json({
      ok: true,
      simulated: false, // honest label: this is a real model call, no fixture
      model: result.model,
      confidence: result.confidence,
      extraction: result.extraction,
      attachmentId: result.attachmentId,
      reviewStatus: 'pending', // re-extraction always re-opens review
    })
  } catch (e) {
    console.error('[api/ai/extract-document]', e)
    // Same redaction as voice-log (W-AUDIT #5 family — no raw SDK errors).
    return NextResponse.json(
      { ok: false, error: safeErrorMessage(e, 'Document extraction failed') },
      { status: 500 },
    )
  }
}

export const PUT = async (req: NextRequest): Promise<NextResponse> => {
  const gate = await enforceAiRoutePolicy(req, {
    bucket: 'ai:document-review',
    fields: [
      { name: 'attachmentId', type: 'string' },
      { name: 'decision', type: 'string' },
      { name: 'reviewer', type: 'string' },
    ],
  })
  if (!gate.ok) return gate.response

  try {
    const { attachmentId, decision, reviewer } = gate.body as {
      attachmentId?: string; decision?: string; reviewer?: string
    }
    if (!attachmentId || !attachmentId.trim()) {
      return NextResponse.json({ error: 'attachmentId is required' }, { status: 400 })
    }
    if (!isReviewDecision(decision)) {
      return NextResponse.json({ error: `decision must be "approved" or "rejected" (got ${JSON.stringify(decision)})` }, { status: 400 })
    }
    if (reviewer !== undefined && reviewer.length > 120) {
      return NextResponse.json({ error: 'reviewer is capped at 120 characters' }, { status: 400 })
    }

    // Default reviewer identity: the signed-in session (auditable), not a
    // free-text claim; explicit reviewer only overrides the display name.
    const name = reviewer?.trim() || gate.session.user.name || gate.session.user.email
    const result = await reviewDocument(attachmentId, decision, {
      name,
      role: gate.session.user.role,
    })
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 404 })
    }

    const { ok, ...rest } = result
    return NextResponse.json({ ok, ...rest, reviewedBy: name })
  } catch (e) {
    console.error('[api/ai/extract-document PUT]', e)
    // Same redaction as voice-log (W-AUDIT #5 family — no raw SDK errors).
    return NextResponse.json(
      { ok: false, error: safeErrorMessage(e, 'Document review failed') },
      { status: 500 },
    )
  }
}
