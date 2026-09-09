import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { route, genericError } from '@/backend/lib/route-kit'
import { OWNER_ROLES, type GuardSession } from '@/backend/lib/guard'
import { enforceRateLimit } from '@/backend/lib/rate-limit'
import { getStorageDriver } from '@/backend/lib/storage'
import { saveDocument, sniffDocumentMime, sniffImageMime } from '@/backend/modules/documents/service'
import {
  isDocumentCategory,
  isDocumentMimeType,
  MAX_DOCUMENT_BYTES,
  sanitizeFileName,
} from '@/backend/modules/documents/types'

// Upload v2 (spec §84 photo seam + Doc A §60/§53 document intelligence).
// src/app/api/upload/route.ts is the thin shim — this file completes the
// backend reorg that a prior (botched, conflict-causing) attempt started by
// deleting the whole route.
//
// TWO modes, one route:
//
// 1. LEGACY (byte-for-byte response contract): POST { dataUrl } — the
//    Copilot fresh-photo flow. Validates a data:image/* URL, decodes it,
//    enforces the 4 MB decoded cap, writes public/photos/upp-*.jpg and
//    returns { ok, url, bytes }. The URL is what /api/ai/analyze-photo and
//    the photo.apply action consume — do not change this shape.
//    W-AUDIT #4 hardening (both applied here, deliberately additive —
//    legit uploads behave identically):
//      · the raw request body is capped (12 MB) BEFORE JSON.parse and the
//        base64 decode — oversized payloads used to be fully parsed first;
//      · the declared MIME is checked against the decoded bytes' MAGIC
//        NUMBER (sniffImageMime) exactly like document mode — a renamed
//        executable wearing an image hat dies with an honest 400.
//
// 2. DOCUMENT (B3): POST { mode:'document', fileName, mimeType,
//    contentBase64, category, title?, projectId?, entityType?, entityId?,
//    expiresAt? } — BOQs, invoices, quotations, contracts, land documents,
//    drawings, receipts (§53). File security: mime allowlist
//    (PDF/PNG/JPEG) checked against the decoded bytes' MAGIC NUMBER, 8 MB
//    decoded cap, fileName sanitized (never a path — the on-disk name is
//    server-generated under public/docs/), 10 uploads/min/user. Persists an
//    Attachment row with §60 provenance (category, mimeType, sizeBytes,
//    title, expiresAt) at reviewStatus 'pending' and returns
//    { ok, attachment: { id, storageKey, category, reviewStatus } }.
//
// NOTE (task 9-b): the photo write now goes through the storage driver seam
// (src/backend/lib/storage — local-disk default, S3/R2/MinIO env-gated), so
// a multi-instance deployment can point uploads at object storage. The
// local-disk driver's behavior is byte-identical to the old direct fs write;
// the frozen-build caveat below still applies to THAT driver (public/ is
// snapshotted at build time in a production build). The presigned client-
// direct flow (POST /api/upload/presign → PUT → /api/upload/confirm) exists
// for drivers that can presign. Document mode (public/docs via the documents
// service) is deliberately NOT yet driver-mediated — see DEPLOYMENT.md's
// object-storage driver matrix.
//
// Route-kit note: the two modes have DIFFERENT rate-limit buckets chosen
// only after the body is parsed, so the per-mode limits stay in this handler
// (after the body parse, exactly where they always ran) instead of the
// route-level rateLimit slot.

const MAX_BYTES = 4 * 1024 * 1024 // 4 MB decoded (legacy photo path)

// 12 MB raw JSON: covers an 8 MB document (≈10.7 MB base64 + envelope) and a
// 4 MB photo (≈5.4 MB base64) — anything bigger is rejected pre-parse (413).
const MAX_RAW_BODY_BYTES = 12 * 1024 * 1024

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// Document-mode request fields (unknown fields → 400).
const DOC_FIELDS = new Set([
  'mode', 'fileName', 'mimeType', 'contentBase64', 'category', 'title',
  'projectId', 'entityType', 'entityId', 'expiresAt',
])

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

export const POST = route(
  {
    scope: 'api/upload',
    roles: ['contractor', 'admin', 'client'],
    body: { onParseError: 'reject', maxBytes: MAX_RAW_BODY_BYTES },
    onError: genericError(500, 'Upload failed'),
  },
  async (req: NextRequest, session, body) => {
    const parsed = body as Record<string, unknown>

    // ---------------------------------------------------------------- docs
    if (parsed.mode === 'document') {
      return await uploadDocument(parsed, session, req)
    }

    // ------------------------------------------------- legacy photo path
    // Rate limit (S-SEC): document mode has its own 10/min bucket below; the
    // legacy photo path wrote unlimited files to public/photos — same 10/min
    // posture now.
    const limited = await enforceRateLimit(req, 'upload:photo', 10, 60_000)
    if (limited) return limited

    const { dataUrl } = parsed as { dataUrl?: string }
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      return NextResponse.json({ error: 'A data:image/* URL is required' }, { status: 400 })
    }
    const m = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!m) {
      return NextResponse.json({ error: 'Invalid data URL (expected base64 image data)' }, { status: 400 })
    }
    const mime = m[1].toLowerCase()
    const ext = MIME_EXT[mime]
    if (!ext) {
      return NextResponse.json(
        { error: `Unsupported image type ${mime} — use PNG, JPEG, WebP or GIF` },
        { status: 400 },
      )
    }
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length === 0) {
      return NextResponse.json({ error: 'Empty image payload' }, { status: 400 })
    }
    if (buf.length > MAX_BYTES) {
      return NextResponse.json(
        { error: `Image is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the limit is 4 MB (Data Saver compresses uploads)` },
        { status: 413 },
      )
    }

    // W-AUDIT #4: the declared image MIME must match the decoded bytes' magic
    // number — mirrors document mode (a renamed non-image dies here, before
    // it is ever written to public/photos).
    const sniffed = sniffImageMime(buf)
    if (sniffed !== mime) {
      return NextResponse.json(
        {
          error:
            `File content does not match its type: declared ${mime}, ` +
            `bytes look like ${sniffed ?? 'not a recognized image (PNG, JPEG, WebP, GIF)'} — upload rejected`,
        },
        { status: 400 },
      )
    }

    // Task 9-b: write through the storage driver. Local-disk default keeps
    // byte-identical behavior (public/photos/<name>, URL /photos/<name>);
    // the S3-compatible driver lands the bytes in the bucket and the URL is
    // its publicUrl (CDN base or presigned GET). Key shape, caps and the
    // response contract above are unchanged.
    const driver = getStorageDriver()
    const name = `upp-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`
    await driver.put(name, buf, mime)

    return NextResponse.json({ ok: true, url: driver.publicUrl(name), bytes: buf.length })
  },
)

// ------------------------------------------------------------ document mode

async function uploadDocument(
  body: Record<string, unknown>,
  session: NonNullable<GuardSession>,
  req: NextRequest,
): Promise<NextResponse> {
  // Owner-team surface only — the client keeps the photo flow above.
  if (!OWNER_ROLES.includes(session.user.role)) {
    return NextResponse.json(
      {
        error:
          `Document uploads are limited to owner-app roles (${OWNER_ROLES.join(', ')}) — ` +
          `signed in as "${session.user.role}"`,
      },
      { status: 403 },
    )
  }

  // Rate limit FIRST — malformed spam burns the same bucket (W1-SEC pattern).
  const limited = await enforceRateLimit(req, 'upload:document', 10, 60_000)
  if (limited) return limited

  // Unknown fields → 400 (strict body shape).
  for (const key of Object.keys(body)) {
    if (!DOC_FIELDS.has(key)) {
      return NextResponse.json(
        { error: `Unknown field "${key}" — allowed: ${[...DOC_FIELDS].sort().join(', ')}` },
        { status: 400 },
      )
    }
  }

  const { fileName, mimeType, contentBase64, category, title, projectId, entityType, entityId, expiresAt } =
    body as Record<string, string | undefined>

  if (typeof fileName !== 'string' || !fileName.trim()) {
    return NextResponse.json({ error: 'fileName is required' }, { status: 400 })
  }
  if (typeof mimeType !== 'string' || !isDocumentMimeType(mimeType)) {
    return NextResponse.json(
      { error: `mimeType must be one of: application/pdf, image/png, image/jpeg (got ${JSON.stringify(mimeType)})` },
      { status: 400 },
    )
  }
  if (typeof contentBase64 !== 'string' || !BASE64_RE.test(contentBase64)) {
    return NextResponse.json({ error: 'contentBase64 is required (standard base64, no data: prefix)' }, { status: 400 })
  }
  if (!isDocumentCategory(category)) {
    return NextResponse.json(
      { error: `category must be one of: contract, drawing, permit, receipt, boq, invoice, quote, other (got ${JSON.stringify(category)})` },
      { status: 400 },
    )
  }

  // Decode + size cap (8 MB decoded — §53).
  const bytes = Buffer.from(contentBase64, 'base64')
  if (bytes.length === 0) {
    return NextResponse.json({ error: 'Empty document payload' }, { status: 400 })
  }
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    return NextResponse.json(
      { error: `Document is ${(bytes.length / 1024 / 1024).toFixed(1)} MB — the limit is 8 MB` },
      { status: 413 },
    )
  }

  // §53 file-type validation: the DECLARED mime must match the bytes' magic
  // number — a renamed .exe or an SVG wearing a .png hat dies here.
  const sniffed = sniffDocumentMime(bytes)
  if (sniffed !== mimeType) {
    return NextResponse.json(
      {
        error:
          `File content does not match its type: declared ${mimeType}, ` +
          `bytes look like ${sniffed ?? 'not a PDF/PNG/JPEG document'} — upload rejected`,
      },
      { status: 400 },
    )
  }

  if (title !== undefined && (typeof title !== 'string' || title.length > 200)) {
    return NextResponse.json({ error: 'title must be a string of at most 200 characters' }, { status: 400 })
  }
  for (const [field, value] of [['entityType', entityType], ['entityId', entityId]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 60)) {
      return NextResponse.json({ error: `${field} must be a non-empty string of at most 60 characters` }, { status: 400 })
    }
  }
  if (projectId !== undefined && (typeof projectId !== 'string' || !projectId)) {
    return NextResponse.json({ error: 'projectId must be a non-empty string' }, { status: 400 })
  }
  if (projectId) {
    const exists = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
    if (!exists) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  let expiresAtDate: Date | undefined
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'string' || !expiresAt.trim()) {
      return NextResponse.json({ error: 'expiresAt must be an ISO date string' }, { status: 400 })
    }
    expiresAtDate = new Date(expiresAt)
    if (Number.isNaN(expiresAtDate.getTime())) {
      return NextResponse.json({ error: `expiresAt is not a valid date: ${JSON.stringify(expiresAt)}` }, { status: 400 })
    }
  }

  const saved = await saveDocument({
    fileName: sanitizeFileName(fileName), // stored as a DISPLAY string, never a path
    mimeType,
    category,
    bytes,
    title,
    projectId,
    entityType,
    entityId,
    expiresAt: expiresAtDate,
    uploadedBy: { name: session.user.name || session.user.email, role: session.user.role, email: session.user.email },
  })

  return NextResponse.json({
    ok: true,
    attachment: {
      id: saved.id,
      storageKey: saved.storageKey,
      fileName: saved.fileName,
      category: saved.category,
      reviewStatus: saved.reviewStatus,
    },
  })
}
