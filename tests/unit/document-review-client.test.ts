/**
 * Issue #153 — the frontend fetch contract of the document-review consumer
 * (src/frontend/mjengo/copilot/document-review.ts), pinned at the module
 * boundary the way frontend-robustness.test.ts pins the store's data flow:
 * global fetch is stubbed and every request shape + error-surfacing rule is
 * asserted against the REAL route contracts:
 *
 *   · fetchDocumentQueue → GET /api/ai/extract-document?projectId&reviewStatus
 *     (no-store, no body) — pending by default;
 *   · extractDocumentDraft → POST { attachmentId } ONLY (no ocrTextHint ever
 *     originates from this surface — the server reads the stored bytes);
 *   · reviewDocumentDraft → PUT { attachmentId, decision } ONLY — the UI never
 *     sends a `reviewer` free-text claim, so the route always stamps the
 *     signed-in session (auditable by design);
 *   · error surfacing: a server { error } body rides through verbatim; an
 *     !ok response without a parsable body and a network-level throw both
 *     return error: null (the caller shows localized generic copy).
 *
 * Plus static source pins (frontend-a11y.test.ts convention) for the panel
 * wiring: the copilot tab mounts the panel as its 4th sub-tab, the panel
 * renders the approve/reject gate through the client module, and the UI role
 * gate mirrors the route's AI_ROUTE_ROLES allowlist.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  fetchDocumentQueue,
  extractDocumentDraft,
  reviewDocumentDraft,
} from '@/frontend/mjengo/copilot/document-review'

// ---------------- fetch test doubles (frontend-robustness convention) ----------------

interface FakeRes {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

const res = (body: unknown, ok = true, status = 200): FakeRes => ({
  ok,
  status,
  json: async () => body,
})

const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = []

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init })
    return res({ ok: true, documents: [] })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const lastCall = () => calls[calls.length - 1]

// ---------------- the queue read ----------------

describe('fetchDocumentQueue — GET request shape', () => {
  it('GETs the route with projectId + the pending filter, no-store, no body', async () => {
    await fetchDocumentQueue('p-1')
    expect(calls).toHaveLength(1)
    const call = lastCall()
    expect(String(call.input)).toBe('/api/ai/extract-document?projectId=p-1&reviewStatus=pending')
    expect((call.init as { method?: string }).method).toBeUndefined() // a plain GET — no method override
    expect((call.init as { cache?: string }).cache).toBe('no-store')
    expect((call.init as { body?: unknown }).body).toBeUndefined()
  })

  it('encodes the projectId and passes an explicit status through', async () => {
    await fetchDocumentQueue('p 1&x', 'approved')
    expect(String(lastCall().input)).toBe(
      '/api/ai/extract-document?projectId=p+1%26x&reviewStatus=approved',
    )
  })

  it('returns the documents on ok', async () => {
    const documents = [{
      id: 'att-1', fileName: 'invoice.pdf', title: null, category: 'invoice',
      mimeType: 'application/pdf', sizeBytes: 10, storageKey: '/docs/x.pdf',
      reviewStatus: 'pending', reviewedBy: null, reviewedAt: null,
      extractionConfidence: 0.9, extractionModel: 'zai-chat-llm',
      uploadedBy: 'a@b.c', createdAt: '2026-09-01T10:00:00Z',
      extraction: { docType: 'invoice', supplier: null, total: 1, currency: 'KES', lines: [], notes: null },
    }]
    vi.stubGlobal('fetch', vi.fn(async () => res({ ok: true, documents })))
    const out = await fetchDocumentQueue('p-1')
    expect(out).toEqual({ ok: true, documents })
  })
})

// ---------------- the extraction run ----------------

describe('extractDocumentDraft — POST request shape', () => {
  it('POSTs { attachmentId } ONLY — no ocrTextHint from this surface', async () => {
    await extractDocumentDraft('att-9')
    const call = lastCall()
    expect(String(call.input)).toBe('/api/ai/extract-document')
    expect((call.init as { method?: string }).method).toBe('POST')
    expect((call.init as Record<string, unknown>).headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String((call.init as { body?: string }).body))).toEqual({ attachmentId: 'att-9' })
  })

  it('surfaces the fresh draft fields on ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({
      ok: true, simulated: false, model: 'glm-5v-turbo', confidence: 0.75,
      extraction: { docType: 'receipt', supplier: 'X', total: 2, currency: null, lines: [], notes: 'blurry' },
      attachmentId: 'att-9', reviewStatus: 'pending',
    })))
    const out = await extractDocumentDraft('att-9')
    expect(out).toEqual({
      ok: true, attachmentId: 'att-9', model: 'glm-5v-turbo', confidence: 0.75,
      extraction: { docType: 'receipt', supplier: 'X', total: 2, currency: null, lines: [], notes: 'blurry' },
      reviewStatus: 'pending',
    })
  })
})

// ---------------- the human review gate ----------------

describe('reviewDocumentDraft — PUT request shape (the human gate)', () => {
  it('PUTs { attachmentId, decision } ONLY — never a reviewer free-text claim', async () => {
    await reviewDocumentDraft('att-9', 'approved')
    await reviewDocumentDraft('att-9', 'rejected')
    for (const call of calls) {
      expect(String(call.input)).toBe('/api/ai/extract-document')
      expect((call.init as { method?: string }).method).toBe('PUT')
      expect((call.init as Record<string, unknown>).headers).toEqual({ 'Content-Type': 'application/json' })
    }
    expect(JSON.parse(String((calls[0].init as { body?: string }).body))).toEqual({ attachmentId: 'att-9', decision: 'approved' })
    expect(JSON.parse(String((calls[1].init as { body?: string }).body))).toEqual({ attachmentId: 'att-9', decision: 'rejected' })
    // the pinned contract: no reviewer field EVER crosses the wire from the UI
    for (const call of calls) {
      expect(JSON.parse(String((call.init as { body?: string }).body))).not.toHaveProperty('reviewer')
    }
  })

  it('returns the stamped verdict on ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({
      ok: true, attachmentId: 'att-9', reviewStatus: 'approved',
      reviewedBy: 'Foreman', reviewedAt: '2026-09-01T12:00:00.000Z',
    })))
    const out = await reviewDocumentDraft('att-9', 'approved')
    expect(out).toEqual({
      ok: true, attachmentId: 'att-9', reviewStatus: 'approved',
      reviewedBy: 'Foreman', reviewedAt: '2026-09-01T12:00:00.000Z',
    })
  })
})

// ---------------- error surfacing ----------------

describe('error surfacing — the honest text rides through; network → null', () => {
  it('a server { error } body is returned verbatim (scanned PDF, unreadable file…)', async () => {
    for (const fn of [
      () => fetchDocumentQueue('p-1'),
      () => extractDocumentDraft('att-9'),
      () => reviewDocumentDraft('att-9', 'rejected'),
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => res({ error: 'PDF has no extractable text layer (likely a scanned/image-only PDF)' }, false, 400)))
      await expect(fn()).resolves.toEqual({
        ok: false,
        error: 'PDF has no extractable text layer (likely a scanned/image-only PDF)',
      })
    }
  })

  it('an error response without a parsable body → error null (caller substitutes localized copy)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(null, false, 500)))
    await expect(fetchDocumentQueue('p-1')).resolves.toEqual({ ok: false, error: null })
  })

  it('a body whose error is not a string is not trusted → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ error: { deep: true } }, false, 400)))
    await expect(extractDocumentDraft('att-9')).resolves.toEqual({ ok: false, error: null })
  })

  it('a network-level throw → error null, never an exception past the boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(fetchDocumentQueue('p-1')).resolves.toEqual({ ok: false, error: null })
    await expect(extractDocumentDraft('att-9')).resolves.toEqual({ ok: false, error: null })
    await expect(reviewDocumentDraft('att-9', 'approved')).resolves.toEqual({ ok: false, error: null })
  })

  it('a 200 whose body is not a documents array is not trusted (shape check)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ ok: true, documents: 'nope' })))
    await expect(fetchDocumentQueue('p-1')).resolves.toEqual({ ok: false, error: null })
  })
})

// ---------------- static source pins (frontend-a11y convention) ----------------

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

describe('the review panel wiring (source pins)', () => {
  it('copilot-tab mounts the Documents panel as its 4th sub-tab', () => {
    const src = readSrc('src/frontend/mjengo/copilot-tab.tsx')
    expect(src).toContain("import { DocumentsPanel } from '@/frontend/mjengo/copilot/documents-panel'")
    expect(src).toContain("useState<'photo' | 'voice' | 'scan' | 'docs'>")
    expect(src).toContain("{tab === 'docs' && <DocumentsPanel online={online} />}")
    expect(src).toContain("t('copilot.tab.docs')")
  })

  it('the panel decides through the client module (no inline fetch), with the role mirror', () => {
    const src = readSrc('src/frontend/mjengo/copilot/documents-panel.tsx')
    // fetches go through the pinned contract module
    expect(src).toContain("from './document-review'")
    expect(src).toContain('fetchDocumentQueue(projectId')
    expect(src).toContain('reviewDocumentDraft(doc.id, decision)')
    expect(src).toContain("decide(selected, 'approved')")
    expect(src).toContain("decide(selected, 'rejected')")
    // the UI role gate mirrors the route's allowlist (fail closed, not navigation trust)
    expect(src).toContain("const AI_REVIEW_ROLES: readonly string[] = ['contractor', 'admin', 'supervisor']")
    expect(src).toContain('if (!canReview)')
    // the audit affordance points at the evidence tab (+ admin audit log)
    expect(src).toContain("new CustomEvent('mjengo:tab', { detail: { tab: 'evidence' } })")
    expect(src).toContain("new CustomEvent('mjengo:tab', { detail: { tab: 'audit' } })")
    // loading + error states render (spec §84 — no dead UI)
    expect(src).toContain('role="status"')
    expect(src).toContain('role="alert"')
    expect(src).toContain("t('copilot.docs.retry')")
  })

  it('the copilot docs keys exist in BOTH dictionaries (en/sw parity)', async () => {
    const { enDict } = await import('@/frontend/i18n/dicts/en')
    const { swDict } = await import('@/frontend/i18n/dicts/sw')
    for (const key of [
      'copilot.tab.docs', 'copilot.docs.queueTitle', 'copilot.docs.queueDesc',
      'copilot.docs.draftTitle', 'copilot.docs.draftDesc', 'copilot.docs.approve',
      'copilot.docs.reject', 'copilot.docs.gateTitle', 'copilot.docs.gateNote',
      'copilot.docs.auditNote', 'copilot.docs.viewEvidence', 'copilot.docs.viewAudit',
      'copilot.docs.lockedTitle', 'copilot.docs.lockedBody', 'copilot.docs.emptyQueue',
      'copilot.docs.toast.approved', 'copilot.docs.toast.rejected', 'copilot.docs.toast.decideFailed',
      'copilot.docs.toast.extracted', 'copilot.docs.toast.extractFailed', 'copilot.docs.toast.needOnline',
      'copilot.docs.cat.contract', 'copilot.docs.cat.drawing', 'copilot.docs.cat.permit',
      'copilot.docs.cat.receipt', 'copilot.docs.cat.boq', 'copilot.docs.cat.invoice',
      'copilot.docs.cat.quote', 'copilot.docs.cat.other', 'copilot.docs.f.docType',
      'copilot.docs.f.supplier', 'copilot.docs.f.total', 'copilot.docs.f.line',
      'copilot.docs.f.qty', 'copilot.docs.f.unitPrice', 'copilot.docs.f.notes',
      'ev.kind.document',
    ]) {
      expect(typeof enDict[key] === 'string' && enDict[key].length > 0, `en.${key}`).toBe(true)
      expect(typeof swDict[key] === 'string' && swDict[key].length > 0, `sw.${key}`).toBe(true)
    }
  })

  it('the evidence ledger + admin audit filter expose the document kind (audit affordance)', () => {
    const evidence = readSrc('src/frontend/mjengo/evidence-tab.tsx')
    expect(evidence).toContain("document: { label: 'ev.kind.document'")
    const audit = readSrc('src/frontend/mjengo/audit-tab.tsx')
    expect(audit).toContain("'document', // API-2 (issue #153)")
  })
})
