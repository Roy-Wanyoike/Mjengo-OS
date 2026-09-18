import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { enforceAiRoutePolicy } from '@/backend/lib/rate-limit'
import { safeErrorMessage } from '@/backend/lib/guard'
import {
  extractDocument,
  listDocuments,
  reviewDocument,
} from '@/backend/modules/documents/service'
import { isReviewDecision, isReviewStatus, type DocumentExtraction } from '@/backend/modules/documents/types'
import { log, withRequestLogging } from '@/backend/lib/log'

// Document intelligence API (MjengoOS backend wave B3, Doc A §60).
//
// POST { attachmentId, ocrTextHint? }  → run extraction (image → VLM seam;
//   PDF → SERVER-SIDE text-layer extraction, lib/pdf-text.ts — issue #42 —
//   so no client hint is required; a caller-supplied ocrTextHint still
//   takes precedence, and a PDF with no usable text layer / an encrypted
//   PDF returns the same honest 400 error shape as before, never a faked
//   extraction). Response: { ok, simulated:false, model, confidence,
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
// GET ?projectId=<id>&reviewStatus=pending|approved|rejected (issue #153) →
//   the REVIEW QUEUE the panel renders: document-mode attachments for one
//   project with their extraction drafts (parsed extractedJson) and review
//   state. projectId is REQUIRED — no default-project guessing on a queue a
//   human decides from. This is the read that finally gives the whole route
//   family its consumer surface (the Copilot "Documents" panel) and the
//   service's listDocuments its caller.
//
// All verbs share the W1-SEC /api/ai/* gate (mirrors analyze-photo):
// session → role allowlist [contractor, admin, supervisor] → 10 req/min/user
// (GET: 30/min — one queue read per review round-trip, not a model call)
// → strict body shape (unknown/mistyped fields → 400; GET has no body).

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** Parse the stored extractedJson column into the draft object — never throws
 * (a corrupt/legacy value renders as "no draft", it cannot 500 the queue). */
function parseExtractionDraft(raw: unknown): DocumentExtraction | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as DocumentExtraction) : null
  } catch {
    return null
  }
}

export const GET = (req: NextRequest): Promise<NextResponse> =>
  withRequestLogging(req, 'api/ai/extract-document', async () => {
  // Same shared gate as POST/PUT: session → role allowlist → rate limit.
  // The mutation-safety step passes GETs untouched by design, and a GET has
  // no body, so the gate's body-shape check sees {} (fields: [] → any body
  // field would 400; the query params below are validated separately).
  const gate = await enforceAiRoutePolicy(req, {
    bucket: 'ai:document-queue',
    fields: [],
    // Read-side: roomier than the 10/min model-call default — the panel
    // reads the queue once per mount and once per review round-trip.
    limit: 30,
  })
  if (!gate.ok) return gate.response

  try {
    const sp = req.nextUrl.searchParams
    const projectId = sp.get('projectId')?.trim()
    if (!projectId) {
      return NextResponse.json(
        { error: 'projectId is required — the review queue is always project-scoped (no default-project guessing)' },
        { status: 400 },
      )
    }
    const reviewStatus = sp.get('reviewStatus')?.trim() || undefined
    if (reviewStatus !== undefined && !isReviewStatus(reviewStatus)) {
      return NextResponse.json(
        { error: `reviewStatus must be one of: pending, approved, rejected (got ${JSON.stringify(reviewStatus)})` },
        { status: 400 },
      )
    }
    const exists = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
    if (!exists) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const rows = await listDocuments({ projectId, ...(reviewStatus ? { reviewStatus } : {}) })
    return NextResponse.json({
      ok: true,
      documents: rows.map((row) => {
        const { extractedJson, ...rest } = row as Record<string, unknown> & { extractedJson?: string | null }
        return { ...rest, extraction: parseExtractionDraft(extractedJson) }
      }),
    })
  } catch (e) {
    log.error('api/ai/extract-document GET', 'Request failed', { error: e })
    return NextResponse.json(
      { ok: false, error: safeErrorMessage(e, 'Could not load the document review queue') },
      { status: 500 },
    )
  }
})

export const POST = (req: NextRequest): Promise<NextResponse> =>
  withRequestLogging(req, 'api/ai/extract-document', async () => {
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
    log.error('api/ai/extract-document', 'Request failed', { error: e })
    // Same redaction as voice-log (W-AUDIT #5 family — no raw SDK errors).
    return NextResponse.json(
      { ok: false, error: safeErrorMessage(e, 'Document extraction failed') },
      { status: 500 },
    )
  }
})

export const PUT = (req: NextRequest): Promise<NextResponse> =>
  withRequestLogging(req, 'api/ai/extract-document', async () => {
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
    log.error('api/ai/extract-document PUT', 'Request failed', { error: e })
    // Same redaction as voice-log (W-AUDIT #5 family — no raw SDK errors).
    return NextResponse.json(
      { ok: false, error: safeErrorMessage(e, 'Document review failed') },
      { status: 500 },
    )
  }
})
