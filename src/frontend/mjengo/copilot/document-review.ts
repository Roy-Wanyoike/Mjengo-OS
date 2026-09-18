// Document-intelligence review client (issue #153 — the /api/ai/extract-document
// consumer surface).
//
// This module owns the panel's fetch contract against the route family, kept
// pure and DOM-free so the request shapes and error surfacing are unit-testable
// at the module boundary (tests/unit/document-review-client.test.ts — the
// frontend-robustness.test.ts convention):
//
//   · GET  /api/ai/extract-document?projectId&reviewStatus=pending → the queue
//   · POST /api/ai/extract-document { attachmentId }                  → run the
//     extraction (image → VLM; PDF → server-side text layer — no ocrTextHint
//     is ever sent from this surface)
//   · PUT  /api/ai/extract-document { attachmentId, decision }        → the
//     human review gate
//
// Contract decisions pinned deliberately:
//   · The PUT never sends `reviewer` — the route stamps the signed-in session
//     identity (auditable by design); the UI makes no free-text claim.
//   · Every function returns a discriminated result. `error` carries the
//     server's honest `{ error }` text when one came back; `null` means a
//     network-level failure (the caller substitutes localized generic copy).
//   · The queue response's `extraction` is the route-parsed extractedJson
//     draft (never the raw 200 KB ocrText — the queue does not render it).

import type { DocumentExtraction } from '@/backend/modules/documents/types'

/** One queued document row — the GET response's documents[] item. */
export interface ReviewQueueDocument {
  id: string
  fileName: string
  title: string | null
  category: string | null
  mimeType: string | null
  sizeBytes: number | null
  storageKey: string
  reviewStatus: string
  reviewedBy: string | null
  reviewedAt: string | null
  extractionConfidence: number | null
  extractionModel: string | null
  uploadedBy: string
  createdAt: string
  /** The parsed extraction draft, or null when none was run yet. */
  extraction: DocumentExtraction | null
}

/** Queue read: the pending documents, or the honest error. */
export type QueueResult =
  | { ok: true; documents: ReviewQueueDocument[] }
  | { ok: false; error: string | null }

/**
 * Fetch the document review queue for one project. `reviewStatus` defaults to
 * 'pending' (the panel's queue); the route validates the value against its
 * pending|approved|rejected allowlist.
 */
export async function fetchDocumentQueue(
  projectId: string,
  reviewStatus: 'pending' | 'approved' | 'rejected' = 'pending',
): Promise<QueueResult> {
  try {
    const params = new URLSearchParams({ projectId, reviewStatus })
    const res = await fetch(`/api/ai/extract-document?${params.toString()}`, { cache: 'no-store' })
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; documents?: ReviewQueueDocument[]; error?: string }
      | null
    if (res.ok && json?.ok && Array.isArray(json.documents)) {
      return { ok: true, documents: json.documents }
    }
    return { ok: false, error: typeof json?.error === 'string' ? json.error : null }
  } catch {
    return { ok: false, error: null }
  }
}

/** Extraction run: the fresh draft, or the honest error (never a fake). */
export type ExtractOutcome =
  | {
      ok: true
      attachmentId: string
      model: string
      confidence: number | null
      extraction: DocumentExtraction
      reviewStatus: string
    }
  | { ok: false; error: string | null }

/**
 * Run extraction on a stored document (POST). No ocrTextHint is sent — the
 * server reads the stored bytes (image → VLM seam; PDF → server-side text
 * layer, honest failure on a scan). Re-extraction resets reviewStatus to
 * 'pending' because the content changed.
 */
export async function extractDocumentDraft(attachmentId: string): Promise<ExtractOutcome> {
  try {
    const res = await fetch('/api/ai/extract-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachmentId }),
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (res.ok && json?.ok) {
      return {
        ok: true,
        attachmentId: String(json.attachmentId),
        model: String(json.model ?? ''),
        confidence: typeof json.confidence === 'number' ? json.confidence : null,
        extraction: (json.extraction ?? null) as DocumentExtraction,
        reviewStatus: String(json.reviewStatus ?? 'pending'),
      }
    }
    return { ok: false, error: typeof json?.error === 'string' ? json.error : null }
  } catch {
    return { ok: false, error: null }
  }
}

/** Review gate outcome: the stamped verdict, or the honest error. */
export type ReviewOutcome =
  | {
      ok: true
      attachmentId: string
      reviewStatus: string
      reviewedBy: string
      reviewedAt: string
    }
  | { ok: false; error: string | null }

/**
 * The human review gate (PUT). `decision` is 'approved' | 'rejected' — the
 * route stamps the signed-in session as the reviewer (auditable); this client
 * deliberately sends NO `reviewer` field, so a free-text identity claim can
 * never originate from the UI.
 */
export async function reviewDocumentDraft(
  attachmentId: string,
  decision: 'approved' | 'rejected',
): Promise<ReviewOutcome> {
  try {
    const res = await fetch('/api/ai/extract-document', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachmentId, decision }),
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (res.ok && json?.ok) {
      return {
        ok: true,
        attachmentId: String(json.attachmentId),
        reviewStatus: String(json.reviewStatus),
        reviewedBy: String(json.reviewedBy ?? ''),
        reviewedAt: String(json.reviewedAt ?? ''),
      }
    }
    return { ok: false, error: typeof json?.error === 'string' ? json.error : null }
  } catch {
    return { ok: false, error: null }
  }
}
