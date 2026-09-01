import { NextRequest, NextResponse } from 'next/server'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { randomBytes } from 'crypto'
import { withGuard, OWNER_ROLES } from '@/lib/guard'
import { enforceRateLimit } from '@/lib/rate-limit'
import { db } from '@/lib/db'
import { saveDocument, sniffDocumentMime } from '@/modules/documents/service'
import {
  isDocumentCategory,
  isDocumentMimeType,
  MAX_DOCUMENT_BYTES,
  sanitizeFileName,
} from '@/modules/documents/types'

// Upload v2 (spec §84 photo seam + Doc A §60/§53 document intelligence).
//
// TWO modes, one route:
//
// 1. LEGACY (unchanged, byte-for-byte): POST { dataUrl } — the Copilot
//    fresh-photo flow. Validates a data:image/* URL, decodes it, enforces
//    the 4 MB decoded cap, writes public/photos/upp-*.jpg and returns
//    { ok, url, bytes }. The URL is what /api/ai/analyze-photo and the
//    photo.apply action consume — do not change this shape.
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
// NOTE: files written at runtime are served by the Next dev server; in a
// frozen production build, public/ is snapshotted at build time — a durable
// object store with signed URLs would replace this seam (§53, documented,
// not hidden).

export const dynamic = 'force-dynamic'

const MAX_BYTES = 4 * 1024 * 1024 // 4 MB decoded (legacy photo path)

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

export const POST = withGuard(
  async (req: NextRequest, session) => {
    try {
      let body: Record<string, unknown>
      try {
        body = (await req.json()) as Record<string, unknown>
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 })
      }

      // ---------------------------------------------------------------- docs
      if (body.mode === 'document') {
        return await uploadDocument(body, session, req)
      }

      // ------------------------------------------------- legacy photo path
      const { dataUrl } = body as { dataUrl?: string }
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

      const dir = path.join(process.cwd(), 'public', 'photos')
      await mkdir(dir, { recursive: true })
      const name = `upp-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`
      await writeFile(path.join(dir, name), buf)

      return NextResponse.json({ ok: true, url: `/photos/${name}`, bytes: buf.length })
    } catch (e) {
      console.error('[api/upload]', e)
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
    }
  },
  { roles: ['contractor', 'admin', 'client'] },
)

// ------------------------------------------------------------ document mode

async function uploadDocument(
  body: Record<string, unknown>,
  session: { user: { name: string; role: string; email: string } },
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
