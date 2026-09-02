// Document intelligence (MjengoOS backend wave B3, Doc A §60 + §53).
//
// Contracts shared by the module's service, /api/upload (document mode) and
// /api/ai/extract-document. The whole flow is DRAFT-ONLY by design:
// extraction fills Attachment.ocrText / extractedJson / extractionConfidence
// and nothing else — no BOQ, material request, invoice or ledger row is ever
// written from an extraction. reviewStatus (pending|approved|rejected) is the
// human gate (spec: "AI assists, humans decide"); consuming code must check
// it before trusting extractedJson.

// ------------------------------------------------------------------ categories

/** Attachment.category allowlist (mirrors the schema comment, §60 doc kinds). */
export const DOCUMENT_CATEGORIES = [
  'contract', 'drawing', 'permit', 'receipt', 'boq', 'invoice', 'quote', 'other',
] as const
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number]

export function isDocumentCategory(v: unknown): v is DocumentCategory {
  return typeof v === 'string' && (DOCUMENT_CATEGORIES as readonly string[]).includes(v)
}

// ------------------------------------------------------------------ mime / size

/**
 * Document-mode upload types (§53 file security): PDF documents plus photo
 * scans of documents. Anything else (SVG/EXE/rebranded extensions) is a 400
 * BEFORE any byte hits disk. The mime must ALSO agree with the decoded bytes'
 * magic number (see sniffDocumentMime in service.ts).
 */
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number]

export function isDocumentMimeType(v: unknown): v is DocumentMimeType {
  return typeof v === 'string' && (DOCUMENT_MIME_TYPES as readonly string[]).includes(v)
}

/** Extension per allowed mime (server-generated file names use this — the
 * user-supplied fileName never becomes part of a disk path). */
export const MIME_EXT: Record<DocumentMimeType, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

/** 8 MB decoded cap for document uploads (§53 size limits). */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

/** 120-char cap for stored file names (display only — not a path). */
export const MAX_FILENAME_CHARS = 120

// ------------------------------------------------------------------ sanitization

/**
 * §53: file names are attacker-controlled display strings, never paths.
 * Strip directory components and traversal runs, control characters and
 * leading/trailing dots+spaces; cap at MAX_FILENAME_CHARS while PRESERVING
 * the extension. Always non-empty ('document' fallback). The on-disk name is
 * server-generated separately, so this value only ever lands in the DB row.
 */
export function sanitizeFileName(raw: string): string {
  // 1. Keep only the final path segment — kills '../../etc/passwd' style input.
  let name = raw.split(/[/\\]/).pop() ?? ''
  // 2. Collapse any surviving dot-runs ('..' -> '.') — no traversal tokens.
  name = name.replace(/\.{2,}/g, '.')
  // 3. Control characters out.
  name = name.replace(/[\u0000-\u001f\u007f]/g, '')
  // 4. Trim whitespace and edge dots.
  name = name.trim().replace(/^[\s.]+/, '').replace(/[\s.]+$/, '')
  // 5. Length cap, extension-preserving.
  if (name.length > MAX_FILENAME_CHARS) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot) : ''
    const base = dot > 0 ? name.slice(0, dot) : name
    name = base.slice(0, Math.max(1, MAX_FILENAME_CHARS - ext.length)) + ext
  }
  if (!name || name === '.') name = 'document'
  return name
}

// ------------------------------------------------------------------ extraction

/** One priced line item as extracted from a document (all fields best-effort). */
export interface ExtractedLine {
  description: string
  qty: number | null
  unitPrice: number | null
  total: number | null
}

/**
 * Normalized extraction payload persisted to Attachment.extractedJson
 * (§60: structured info + confidence + source provenance).
 */
export interface DocumentExtraction {
  docType: string
  supplier: string | null
  total: number | null
  currency: string | null
  lines: ExtractedLine[]
  notes: string | null
}

/** Result contract for extractDocument — honest errors, never silent fakes. */
export type ExtractResult =
  | {
      ok: true
      simulated: false
      model: string
      confidence: number | null
      extraction: DocumentExtraction
      attachmentId: string
    }
  | { ok: false; error: string }

/** Review decisions (Attachment.reviewStatus). */
export const REVIEW_DECISIONS = ['approved', 'rejected'] as const
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number]

export function isReviewDecision(v: unknown): v is ReviewDecision {
  return typeof v === 'string' && (REVIEW_DECISIONS as readonly string[]).includes(v)
}
