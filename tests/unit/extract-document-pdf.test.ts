/**
 * Route + service wiring of server-side PDF text-layer extraction
 * (issue #42): POST /api/ai/extract-document with a PDF and NO client
 * ocrTextHint now extracts the text layer server-side (lib/pdf-text.ts)
 * and feeds it through the EXACT downstream parse path a client hint
 * would take (same llm() call, same prompt shape, same persisted
 * ocrText/extractedJson/model label — 'zai-chat-llm').
 *
 * Fixtures are REAL PDFs built programmatically (hand-authored object
 * graph + computed xref, one content stream; the builder mirrors
 * tests/unit/pdf-text.test.ts — the parser itself is pinned there).
 * The service reads stored bytes from public/docs/<name> (process.cwd()),
 * so this file writes its fixtures there with unique names and removes
 * them in afterAll — public/docs is runtime state, never repo content.
 *
 * PII parity (honest note): the document-extraction path has NEVER
 * routed through parseDeliveryTranscript/scrubTranscriptPhones — that
 * scrub seam is the VOICE parse path by design (see lib/ai.ts). A
 * client-supplied ocrTextHint also flows to the LLM and into
 * Attachment.ocrText unscrubbed. The pin below asserts server-extracted
 * text gets IDENTICAL treatment (verbatim prompt + storage) — no new
 * PII surface relative to the hint contract, no asymmetric behavior.
 *
 * Mocks (established pattern, tests/unit/pii-scrub-wiring.test.ts):
 * z-ai-web-dev-sdk (chat completions), @/backend/lib/guard (fixed
 * contractor session), @/backend/lib/db (in-memory attachment table).
 * Everything else — route gate, body validation, the service, the real
 * PDF parser — runs for real.
 */
import { mkdir, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { chatCreate } = vi.hoisted(() => ({ chatCreate: vi.fn() }))

vi.mock('z-ai-web-dev-sdk', () => ({
  default: {
    create: vi.fn(async () => ({
      chat: { completions: { create: chatCreate } },
    })),
  },
}))

vi.mock('@/backend/lib/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/lib/guard')>()
  return {
    ...actual,
    getSessionFromReq: vi.fn(async () => ({
      user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null },
    })),
  }
})

vi.mock('@/backend/lib/db', () => {
  const state = {
    attachments: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ id: string; data: Record<string, unknown> }>,
    reset() {
      state.attachments.length = 0
      state.updates.length = 0
    },
  }
  const row = (id: string, storageKey: string): Record<string, unknown> => ({
    id,
    entityType: 'document',
    entityId: 'unattached',
    fileName: 'invoice.pdf',
    storageKey,
    kind: 'invoice_doc',
    uploadedBy: 'foreman@test.dev',
    projectId: null,
    category: 'invoice',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    title: null,
    expiresAt: null,
    reviewStatus: 'pending',
    reviewedBy: 'Someone',
    reviewedAt: new Date('2026-01-01T00:00:00Z'),
    ocrText: null,
    extractedJson: null,
    extractionConfidence: null,
    extractionModel: null,
  })
  const db = {
    __state: state,
    __row: row,
    attachment: {
      async findUnique({ where }: { where: { id: string } }) {
        const found = state.attachments.find((a) => a.id === where?.id)
        return found ? { ...found } : null
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        state.updates.push({ id: where?.id, data })
        const found = state.attachments.find((a) => a.id === where?.id)
        if (!found) throw new Error('attachment row vanished')
        Object.assign(found, data)
        return { ...found }
      },
    },
    auditEvent: { async create() {} },
    project: { async findUnique() { return null } },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { POST } from '@/app/api/ai/extract-document/route'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    attachments: Array<Record<string, unknown>>
    updates: Array<{ id: string; data: Record<string, unknown> }>
    reset: () => void
    __row: (id: string, key: string) => Record<string, unknown>
  }
}
const state = (db as unknown as { __state: State }).__state
const newRow = (db as unknown as { __row: State['__row'] }).__row

// ---------------------------------------------------------------- PDF fixture builder

/** A minimal VALID PDF (classic xref) with one plain content stream. */
function buildPdf(content: string): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  const offsets: number[] = []
  const push = (chunk: string | Buffer): void => {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1')
    parts.push(b)
    offset += b.length
  }
  push('%PDF-1.4\n')
  const bodies: Array<Array<string | Buffer>> = [
    [`<< /Type /Catalog /Pages 2 0 R >>`],
    [`<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>`],
    [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`],
    [`<< /Length ${content.length} >>\nstream\n`, Buffer.from(content, 'latin1'), '\nendstream'],
    [`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`],
  ]
  bodies.forEach((pieces, idx) => {
    const num = idx + 1
    offsets[num] = offset
    push(`${num} 0 obj\n`)
    for (const piece of pieces) push(piece)
    push('\nendobj\n')
  })
  const xrefPos = offset
  push(`xref\n0 6\n0000000000 65535 f \n`)
  for (let n = 1; n <= 5; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`)
  return Buffer.concat(parts)
}

const INVOICE_CONTENT =
  'BT /F1 12 Tf 72 720 Td (Karioke Hardware) Tj 0 -14 Td (Invoice #0042) Tj ' +
  '0 -14 Td (Cement bags 80 @ 562.50) Tj 0 -14 Td (Total KES 45000) Tj ET'
const SCANNED_CONTENT = 'BT /F1 12 Tf 72 720 Td ET' // valid PDF, empty text layer
const PHONE_CONTENT = 'BT /F1 12 Tf 72 720 Td (Supplier Tel 0712 345 678) Tj ET'

const INVOICE_PDF = buildPdf(INVOICE_CONTENT)
const SCANNED_PDF = buildPdf(SCANNED_CONTENT)
const PHONE_PDF = buildPdf(PHONE_CONTENT)
const ENCRYPTED_PDF = Buffer.from(
  buildPdf(INVOICE_CONTENT).toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R'),
  'latin1',
)

/** The fixed LLM answer for the parse call (chat seam, jsonMode). */
const LLM_JSON = JSON.stringify({
  docType: 'invoice',
  supplier: 'Karioke Hardware',
  total: 45000,
  currency: 'KES',
  lines: [{ description: 'Cement bags', qty: 80, unitPrice: 562.5, total: 45000 }],
  notes: null,
  confidence: 0.9,
})

// ---------------------------------------------------------------- fixtures on disk

const DOC_NAMES = [`doc-test-${randomUUID()}.pdf`, `doc-test-${randomUUID()}.pdf`, `doc-test-${randomUUID()}.pdf`, `doc-test-${randomUUID()}.pdf`]
const docsDir = path.join(process.cwd(), 'public', 'docs')

beforeAll(async () => {
  await mkdir(docsDir, { recursive: true })
  await Promise.all([
    writeFile(path.join(docsDir, DOC_NAMES[0]), INVOICE_PDF),
    writeFile(path.join(docsDir, DOC_NAMES[1]), SCANNED_PDF),
    writeFile(path.join(docsDir, DOC_NAMES[2]), ENCRYPTED_PDF),
    writeFile(path.join(docsDir, DOC_NAMES[3]), PHONE_PDF),
  ])
})

afterAll(async () => {
  // public/docs is runtime state, never repo content — leave no litter.
  await Promise.all(DOC_NAMES.map((n) => unlink(path.join(docsDir, n)).catch(() => undefined)))
})

function seed(storageKey: string): string {
  const id = `att-${randomUUID()}`
  state.attachments.push(newRow(id, storageKey))
  return id
}

function postReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/ai/extract-document', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  state.reset()
  chatCreate.mockReset()
  chatCreate.mockResolvedValue({ choices: [{ message: { content: LLM_JSON } }] })
})

// ---------------------------------------------------------------- the wiring

describe('POST /api/ai/extract-document — PDF without ocrTextHint (issue #42)', () => {
  it('extracts the text layer server-side and succeeds through the same parse path as a hint', async () => {
    const id = seed(`/docs/${DOC_NAMES[0]}`)
    const res = await POST(postReq({ attachmentId: id }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.simulated).toBe(false)
    expect(body.model).toBe('zai-chat-llm')
    expect(body.confidence).toBe(0.9)
    expect(body.reviewStatus).toBe('pending')
    const extraction = body.extraction as Record<string, unknown>
    expect(extraction.docType).toBe('invoice')
    expect(extraction.supplier).toBe('Karioke Hardware')
    expect(extraction.total).toBe(45000)

    // ONE chat-LLM call, prompt shaped exactly like the hint path:
    expect(chatCreate).toHaveBeenCalledTimes(1)
    const prompt = String(chatCreate.mock.calls[0][0].messages[1].content)
    expect(prompt).toContain('PDF file name: invoice.pdf')
    expect(prompt).toContain('Extracted text:')
    expect(prompt).toContain('"""')
    expect(prompt).toContain('Karioke Hardware')
    expect(prompt).toContain('Invoice #0042')
    expect(prompt).toContain('Total KES 45000')
  })

  it('persists the extraction draft exactly as a hint run would (ocrText = extracted layer, model, review reset)', async () => {
    const id = seed(`/docs/${DOC_NAMES[0]}`)
    await POST(postReq({ attachmentId: id }))
    expect(state.updates).toHaveLength(1)
    const data = state.updates[0].data
    expect(data.extractionModel).toBe('zai-chat-llm')
    expect(data.reviewStatus).toBe('pending')
    expect(data.reviewedBy).toBeNull()
    expect(data.reviewedAt).toBeNull()
    // ocrText carries the extracted text layer (trimmed), like a hint run
    expect(String(data.ocrText)).toContain('Karioke Hardware')
    expect(String(data.ocrText)).toContain('Invoice #0042')
    const parsed = JSON.parse(String(data.extractedJson)) as Record<string, unknown>
    expect(parsed.docType).toBe('invoice')
  })

  it('a supplied ocrTextHint still WINS — the server extraction is not even attempted for the prompt', async () => {
    const id = seed(`/docs/${DOC_NAMES[0]}`)
    const res = await POST(postReq({ attachmentId: id, ocrTextHint: 'Alpha Supplies, 12 bags cement, KES 9000' }))
    expect(res.status).toBe(200)
    expect(chatCreate).toHaveBeenCalledTimes(1)
    const prompt = String(chatCreate.mock.calls[0][0].messages[1].content)
    expect(prompt).toContain('Alpha Supplies, 12 bags cement, KES 9000')
    // the PDF's own text layer did NOT leak into the prompt
    expect(prompt).not.toContain('Karioke Hardware')
    expect(prompt).not.toContain('Invoice #0042')
    // the row stores the hint, not the server extraction
    expect(String(state.updates[0].data.ocrText)).toBe('Alpha Supplies, 12 bags cement, KES 9000')
  })

  it('PII parity: server-extracted text reaches the LLM exactly as a client hint would (voice-seam scrub does not apply to this path by design)', async () => {
    const id = seed(`/docs/${DOC_NAMES[3]}`)
    const res = await POST(postReq({ attachmentId: id }))
    expect(res.status).toBe(200)
    const prompt = String(chatCreate.mock.calls[0][0].messages[1].content)
    // The document path (hint AND server extraction alike) has never routed
    // through scrubTranscriptPhones — identical treatment is the contract.
    expect(prompt).toContain('Supplier Tel 0712 345 678')
    expect(String(state.updates[0].data.ocrText)).toContain('0712 345 678')
  })
})

describe('POST /api/ai/extract-document — honest failures stay honest (no faked extraction)', () => {
  it('scanned PDF (empty text layer, no hint) → the same 400 error shape, a clear reason, NO LLM call, NO row write', async () => {
    const id = seed(`/docs/${DOC_NAMES[1]}`)
    const res = await POST(postReq({ attachmentId: id }))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain('no extractable text layer')
    expect(String(body.error)).toContain('ocrTextHint')
    expect(chatCreate).not.toHaveBeenCalled()
    expect(state.updates).toHaveLength(0)
  })

  it('scanned PDF WITH a hint still works (the hint is the fallback, unchanged)', async () => {
    const id = seed(`/docs/${DOC_NAMES[1]}`)
    const res = await POST(postReq({ attachmentId: id, ocrTextHint: 'client-side OCR of the scan' }))
    expect(res.status).toBe(200)
    expect(chatCreate).toHaveBeenCalledTimes(1)
    expect(String(chatCreate.mock.calls[0][0].messages[1].content)).toContain('client-side OCR of the scan')
  })

  it('encrypted PDF (no hint) → 400 with the extraction-failure reason, NO LLM call, NO row write', async () => {
    const id = seed(`/docs/${DOC_NAMES[2]}`)
    const res = await POST(postReq({ attachmentId: id }))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain('PDF text extraction failed')
    expect(String(body.error)).toContain('encrypted')
    expect(chatCreate).not.toHaveBeenCalled()
    expect(state.updates).toHaveLength(0)
  })

  it('unknown attachment → 404 (unchanged, before any PDF work)', async () => {
    const res = await POST(postReq({ attachmentId: 'att-does-not-exist' }))
    expect(res.status).toBe(404)
    expect(chatCreate).not.toHaveBeenCalled()
  })
})
