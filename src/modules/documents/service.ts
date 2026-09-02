// Document intelligence service (MjengoOS backend wave B3, Doc A §60/§53).
//
// Pipeline: upload (validated bytes → public/docs/<server-generated name> +
// Attachment row with category/mime/size/title/expiresAt provenance) →
// extract (image scan → VLM via the lib/ai.ts seam; PDF → honest limitation,
// no OCR library exists in this sandbox, structured only when the caller
// supplies ocrTextHint) → human review (approve/reject + AuditEvent).
//
// HONEST DESIGN RULES (spec §60 "Never silently overwrite official records"):
//   - extractDocument writes ONLY to the Attachment row's own extraction
//     fields (ocrText, extractedJson, extractionConfidence, extractionModel).
//     No BOQ / material request / invoice / ledger row is ever created or
//     mutated here. Extraction is a DRAFT that consuming flows must gate on
//     reviewStatus === 'approved'.
//   - A successful re-extraction resets reviewStatus to 'pending' (the data
//     changed, so a prior approval no longer describes what is stored).
//   - PDFs: this environment has no PDF text-extraction library and faking
//     one would poison records — the route returns an explicit error telling
//     the user to upload a scan/photo of the document or provide ocrTextHint
//     (client-side text-layer extraction, wired for the future).
//
// File security (§53): the on-disk file name is ALWAYS server-generated
// (user-controlled fileName only lands in the DB as a display string, after
// sanitizeFileName); the declared mime must match the decoded bytes' magic
// number (sniffDocumentMime); size caps are enforced pre-write; the bucket
// is the app's own public/docs tree (no external object storage in this
// deployment — a signed-URL object store is the documented production seam).

import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { llm, extractJson, visionMessage } from '@/lib/ai'
import { logAudit } from '@/lib/audit'
import {
  isDocumentCategory,
  sanitizeFileName,
  MIME_EXT,
  type DocumentCategory,
  type DocumentExtraction,
  type DocumentMimeType,
  type ExtractResult,
  type ReviewDecision,
} from './types'

// ---------------------------------------------------------------- file helpers

/**
 * §53 file-type validation: read the magic number, not the extension the
 * client claims. Returns the sniffed type — 'image/png', 'image/jpeg',
 * 'application/pdf' — or null when the bytes match none of them.
 */
export function sniffDocumentMime(buf: Buffer): DocumentMimeType | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf'
  }
  return null
}

/** Absolute path for a public/docs storageKey (traversal stripped, defense in depth). */
function docsPath(storageKey: string): string {
  const safe = storageKey.replace(/^\/+/, '').replace(/\.\./g, '')
  return path.join(process.cwd(), 'public', 'docs', path.basename(safe))
}

// ---------------------------------------------------------------- save (upload)

export interface SaveDocumentInput {
  /** User-supplied name — sanitized here again (defense in depth). */
  fileName: string
  mimeType: DocumentMimeType
  category: DocumentCategory
  bytes: Buffer
  title?: string
  projectId?: string
  entityType?: string
  entityId?: string
  expiresAt?: Date
  uploadedBy: { name: string; role: string; email: string }
}

export interface SavedDocument {
  id: string
  fileName: string
  storageKey: string
  category: DocumentCategory
  reviewStatus: string
}

/**
 * Persist a validated document: server-generated file name under
 * public/docs/ (mkdir on demand — the directory is runtime state, not a
 * committed tree), then the Attachment row with §60 provenance metadata.
 * Audit event lands on the project when one is linked (AuditEvent.projectId
 * is non-nullable — unlinked uploads have no audit row; their provenance
 * lives on the Attachment row itself).
 */
export async function saveDocument(input: SaveDocumentInput): Promise<SavedDocument> {
  const cleanName = sanitizeFileName(input.fileName)
  const dir = path.join(process.cwd(), 'public', 'docs')
  await mkdir(dir, { recursive: true }) // created on demand, never committed
  const diskName = `doc-${Date.now()}-${randomBytes(3).toString('hex')}.${MIME_EXT[input.mimeType]}`
  await writeFile(path.join(dir, diskName), input.bytes)

  const category = isDocumentCategory(input.category) ? input.category : 'other'
  const attachment = await db.attachment.create({
    data: {
      entityType: input.entityType?.slice(0, 60) || 'document',
      entityId: input.entityId?.slice(0, 60) || 'unattached',
      fileName: cleanName,
      storageKey: `/docs/${diskName}`,
      kind: `${category}_doc`,
      uploadedBy: input.uploadedBy.email,
      projectId: input.projectId ?? null,
      // §60 metadata / provenance
      category,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      title: input.title?.slice(0, 200) ?? null,
      expiresAt: input.expiresAt ?? null,
      reviewStatus: 'pending',
    },
  })

  if (input.projectId) {
    await logAudit(
      input.projectId,
      'document',
      { name: input.uploadedBy.name, role: input.uploadedBy.role },
      `Document uploaded: ${category} "${cleanName}" (${(input.bytes.length / 1024).toFixed(0)} KB)`,
      { attachmentId: attachment.id, category, mimeType: input.mimeType, sizeBytes: input.bytes.length },
      { entity: 'Attachment', entityId: attachment.id },
    )
  }

  return {
    id: attachment.id,
    fileName: attachment.fileName,
    storageKey: attachment.storageKey,
    category: attachment.category as DocumentCategory,
    reviewStatus: attachment.reviewStatus,
  }
}

// ---------------------------------------------------------------- extraction

const EXTRACT_JSON_CONTRACT = `{
  "docType": "<invoice|quotation|boq|receipt|contract|permit|drawing|delivery note|other — your best read of what this document is>",
  "supplier": "<supplier/vendor name exactly as printed, or null>",
  "total": <grand total as a plain number, or null>,
  "currency": "<currency code as printed, e.g. KES, or null>",
  "lines": [{"description": "<line item text as printed>", "qty": <number or null>, "unitPrice": <number or null>, "total": <number or null>}],
  "notes": "<one short note about anything unreadable or uncertain, or null>",
  "confidence": <0-1, your honest confidence in this extraction>
}`

const EXTRACT_RULES = `RULES:
- Transcribe ONLY what is actually visible. Unreadable value -> null. Never guess or invent numbers.
- All numbers are plain numbers (no commas, no currency symbols).
- If the document has no priced line items, return an empty lines array.
- Confidence must reflect reality: blurry scan or missing values -> low confidence.`

function coerceNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.\-]/g, ''))
    return Number.isFinite(n) && v.trim() !== '' ? n : null
  }
  return null
}

function asText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Coerce a model response into the normalized shape (never trusts the model). */
function normalizeExtraction(parsed: unknown): { extraction: DocumentExtraction; confidence: number | null } {
  const p = (parsed ?? {}) as Record<string, unknown>
  const linesIn = Array.isArray(p.lines) ? p.lines.slice(0, 200) : []
  const lines = linesIn
    .map((l) => {
      const r = (l ?? {}) as Record<string, unknown>
      return {
        description: asText(r.description) ?? '',
        qty: coerceNumber(r.qty),
        unitPrice: coerceNumber(r.unitPrice),
        total: coerceNumber(r.total),
      }
    })
    .filter((l) => l.description !== '')
  const rawConf = coerceNumber(p.confidence)
  return {
    extraction: {
      docType: asText(p.docType) ?? 'unknown',
      supplier: asText(p.supplier),
      total: coerceNumber(p.total),
      currency: asText(p.currency),
      lines,
      notes: asText(p.notes),
    },
    confidence: rawConf === null ? null : Math.min(1, Math.max(0, rawConf)),
  }
}

export interface ExtractOptions {
  /**
   * Future seam (§60): text extracted from a PDF's text layer ELSEWHERE
   * (client-side lib, upstream OCR service). When absent, PDFs honestly
   * fail — this sandbox has no PDF text-extraction library and a faked
   * extraction would poison downstream records.
   */
  ocrTextHint?: string
}

/**
 * Extract structured data from an uploaded document image (or a PDF WITH an
 * ocrTextHint) and persist it to the Attachment row. Image path uses the
 * VLM seam (lib/ai.ts visionMessage — model 'glm-5v-turbo'); hint path uses
 * the chat-LLM seam (llm, jsonMode) — the seam does not return the chat
 * model id, so that path's provenance label is 'zai-chat-llm' (pipeline
 * label, not a model version — the VLM path records the seam's pinned model).
 *
 * Draft-only by design: writes only ocrText / extractedJson /
 * extractionConfidence / extractionModel (and resets a stale review).
 */
export async function extractDocument(attachmentId: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const attachment = await db.attachment.findUnique({ where: { id: attachmentId } })
  if (!attachment) return { ok: false, error: 'Attachment not found' }

  const buf = await readFile(docsPath(attachment.storageKey)).catch(() => null)
  if (!buf || buf.length === 0) {
    return { ok: false, error: 'Stored file is missing or unreadable — re-upload the document' }
  }
  const mime = sniffDocumentMime(buf)
  if (!mime) {
    return { ok: false, error: 'Stored file is not a recognizable document (PDF/PNG/JPEG) — re-upload' }
  }
  if (mime !== attachment.mimeType) {
    return { ok: false, error: `Stored file bytes do not match its recorded type (${attachment.mimeType}) — re-upload` }
  }

  if (mime === 'application/pdf') {
    const hint = opts.ocrTextHint?.trim()
    if (!hint) {
      // HONEST LIMITATION — no OCR library in this sandbox. Do not fake it.
      return {
        ok: false,
        error:
          'PDF text extraction is not available in this environment — upload an image of the document, or provide ocrTextHint',
      }
    }
    const parsed = await llm(
      `You are MjengoOS's document reader for Kenyan construction paperwork (invoices, quotations, BOQs, receipts, contracts, permits).
You receive raw text extracted from a PDF (possibly noisy). Structure it.
Respond with STRICT JSON only (no markdown):
${EXTRACT_JSON_CONTRACT}
${EXTRACT_RULES}`,
      `PDF file name: ${attachment.fileName}
Extracted text:
"""${hint.slice(0, 100_000)}"""`,
      true,
    )
    const { extraction, confidence } = normalizeExtraction(parsed)
    await persistExtraction(attachmentId, hint, extraction, confidence, 'zai-chat-llm')
    return { ok: true, simulated: false, model: 'zai-chat-llm', confidence, extraction, attachmentId }
  }

  // Image scan → VLM seam.
  const prompt = `You are MjengoOS's document reader for Kenyan construction paperwork (invoices, quotations, BOQs, delivery notes, receipts, contracts, permits, drawings).
Read this scanned document image and extract its commercial content.

Respond with STRICT JSON only (no markdown):
${EXTRACT_JSON_CONTRACT}
${EXTRACT_RULES}`
  const raw = await visionMessage(prompt, buf.toString('base64'), mime)
  const parsed = extractJson(raw)
  const { extraction, confidence } = normalizeExtraction(parsed)
  await persistExtraction(attachmentId, raw, extraction, confidence, 'glm-5v-turbo')
  return { ok: true, simulated: false, model: 'glm-5v-turbo', confidence, extraction, attachmentId }
}

async function persistExtraction(
  attachmentId: string,
  ocrText: string,
  extraction: DocumentExtraction,
  confidence: number | null,
  model: string,
): Promise<void> {
  await db.attachment.update({
    where: { id: attachmentId },
    data: {
      ocrText: ocrText.slice(0, 200_000) || null,
      extractedJson: JSON.stringify(extraction),
      extractionConfidence: confidence,
      extractionModel: model,
      // New data invalidates any prior human verdict (never silently keeps
      // an 'approved' badge over changed content).
      reviewStatus: 'pending',
      reviewedBy: null,
      reviewedAt: null,
    },
  })
}

// ---------------------------------------------------------------- review

export interface ReviewResult {
  ok: true
  attachmentId: string
  reviewStatus: ReviewDecision
  reviewedBy: string
  reviewedAt: string
}

/**
 * Human review gate (§60: AI extracts, humans decide). Sets reviewStatus /
 * reviewedBy / reviewedAt and writes an AuditEvent (kind 'document') on the
 * linked project — AuditEvent.projectId is non-nullable, so an unlinked
 * document's verdict is carried by the Attachment row alone.
 */
export async function reviewDocument(
  attachmentId: string,
  decision: ReviewDecision,
  reviewer: { name: string; role: string },
): Promise<ReviewResult | { ok: false; error: string }> {
  const attachment = await db.attachment.findUnique({ where: { id: attachmentId } })
  if (!attachment) return { ok: false, error: 'Attachment not found' }

  const reviewedAt = new Date()
  const updated = await db.attachment.update({
    where: { id: attachmentId },
    data: {
      reviewStatus: decision,
      reviewedBy: reviewer.name,
      reviewedAt,
    },
  })

  if (attachment.projectId) {
    await logAudit(
      attachment.projectId,
      'document',
      { name: reviewer.name, role: reviewer.role },
      `Document review: ${decision} — ${attachment.category ?? 'document'} "${attachment.fileName}"`,
      { attachmentId, decision, previousStatus: attachment.reviewStatus },
      { entity: 'Attachment', entityId: attachmentId },
    )
  }

  return {
    ok: true,
    attachmentId,
    reviewStatus: decision,
    reviewedBy: updated.reviewedBy ?? reviewer.name,
    reviewedAt: reviewedAt.toISOString(),
  }
}

// ---------------------------------------------------------------- listing

/** List document-mode attachments (payload consumption — §60 review queue). */
export async function listDocuments(filter: {
  projectId?: string
  category?: string
  reviewStatus?: string
}): Promise<Array<Record<string, unknown>>> {
  return db.attachment.findMany({
    where: {
      entityType: 'document',
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.reviewStatus ? { reviewStatus: filter.reviewStatus } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      fileName: true,
      title: true,
      category: true,
      mimeType: true,
      sizeBytes: true,
      storageKey: true,
      projectId: true,
      entityType: true,
      entityId: true,
      expiresAt: true,
      reviewStatus: true,
      reviewedBy: true,
      reviewedAt: true,
      extractionConfidence: true,
      extractionModel: true,
      uploadedBy: true,
      createdAt: true,
    },
  })
}
