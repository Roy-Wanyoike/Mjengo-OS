/**
 * Issue #153 — GET /api/ai/extract-document (the review-queue read that gives
 * the route family its consumer surface). Pinned here:
 *
 *   · happy path: ?projectId&reviewStatus=pending → 200 { ok, documents[] }
 *     with the parsed extraction draft (extractedJson string → object), and
 *     the listDocuments query shape verified (entityType 'document',
 *     projectId scoping, reviewStatus filter);
 *   · no reviewStatus param → the filter is OMITTED (all statuses);
 *   · projectId REQUIRED — absent → 400 (no default-project guessing on a
 *     queue a human decides from);
 *   · unknown projectId → 404; bad reviewStatus value → 400;
 *   · role gate mirrored from the shared /api/ai/* policy: a client-role
 *     session → 403, no session → 401, and the db is never touched;
 *   · extraction parse honesty: null extractedJson → extraction null; a
 *     corrupt JSON string → null (never a 500); Dates serialize to ISO.
 *
 * Mocks (established pattern, tests/unit/extract-document-pdf.test.ts):
 * @/backend/lib/guard (session) + @/backend/lib/db (attachment.findMany,
 * project.findUnique). The route gate, rate limit (memory store) and the
 * service's listDocuments run for real.
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  session: {
    user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null },
  } as unknown as Record<string, unknown> | null,
}))

vi.mock('@/backend/lib/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/lib/guard')>()
  return {
    ...actual,
    getSessionFromReq: vi.fn(async () => h.session),
  }
})

const findManyCalls: Array<{ where: Record<string, unknown> }> = []
const projectLookups: string[] = []

vi.mock('@/backend/lib/db', () => {
  const state = {
    rows: [] as Array<Record<string, unknown>>,
  }
  return {
    db: {
      __state: state,
      project: {
        async findUnique({ where }: { where: { id: string } }) {
          projectLookups.push(where?.id)
          return where?.id === 'p-1' ? { id: 'p-1' } : null
        },
      },
      attachment: {
        async findMany(args: { where: Record<string, unknown> }) {
          findManyCalls.push({ where: args?.where ?? {} })
          return state.rows.map((r) => ({ ...r }))
        },
      },
    },
  }
})

import { GET } from '@/app/api/ai/extract-document/route'
import { db } from '@/backend/lib/db'

const state = (db as unknown as { __state: { rows: Array<Record<string, unknown>> } }).__state

function getReq(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/ai/extract-document${query}`, { method: 'GET' })
}

/** A queue row as listDocuments returns it (extractedJson is the raw column). */
function queueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'att-1',
    fileName: 'invoice-karioke.pdf',
    title: 'Karioke Hardware invoice',
    category: 'invoice',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    storageKey: '/docs/doc-test-1.pdf',
    projectId: 'p-1',
    entityType: 'document',
    entityId: 'unattached',
    expiresAt: null,
    reviewStatus: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    extractionConfidence: 0.9,
    extractionModel: 'zai-chat-llm',
    uploadedBy: 'foreman@test.dev',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    extractedJson: JSON.stringify({
      docType: 'invoice',
      supplier: 'Karioke Hardware',
      total: 45000,
      currency: 'KES',
      lines: [{ description: 'Cement bags', qty: 80, unitPrice: 562.5, total: 45000 }],
      notes: null,
    }),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  findManyCalls.length = 0
  projectLookups.length = 0
  state.rows = []
  process.env.NEXTAUTH_SECRET = 'unit-test-secret'
})

describe('GET /api/ai/extract-document — the review queue (issue #153)', () => {
  it('happy path: pending queue with the parsed extraction draft + the exact listDocuments query shape', async () => {
    state.rows = [queueRow()]
    const res = await GET(getReq('?projectId=p-1&reviewStatus=pending'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean; documents?: Array<Record<string, unknown>> }
    expect(body.ok).toBe(true)
    expect(body.documents).toHaveLength(1)
    const doc = body.documents![0]
    // the draft is PARSED (object, not the raw JSON string) and rides as `extraction`
    expect(doc.extraction).toEqual({
      docType: 'invoice',
      supplier: 'Karioke Hardware',
      total: 45000,
      currency: 'KES',
      lines: [{ description: 'Cement bags', qty: 80, unitPrice: 562.5, total: 45000 }],
      notes: null,
    })
    // the raw column is REPLACED, not leaked alongside
    expect(doc.extractedJson).toBeUndefined()
    expect(doc.reviewStatus).toBe('pending')
    expect(doc.id).toBe('att-1')
    // Date → ISO string (JSON serialization)
    expect(doc.createdAt).toBe('2026-09-01T10:00:00.000Z')
    // the service query: document-mode attachments, project-scoped, status-filtered
    expect(findManyCalls).toHaveLength(1)
    expect(findManyCalls[0].where).toEqual({
      entityType: 'document',
      projectId: 'p-1',
      reviewStatus: 'pending',
    })
  })

  it('no reviewStatus param → the filter is omitted (all statuses)', async () => {
    state.rows = []
    const res = await GET(getReq('?projectId=p-1'))
    expect(res.status).toBe(200)
    expect(findManyCalls[0].where).toEqual({ entityType: 'document', projectId: 'p-1' })
  })

  it('extraction honesty: null extractedJson → extraction null; a corrupt JSON string → null (never a 500)', async () => {
    state.rows = [
      queueRow({ id: 'att-none', extractedJson: null }),
      queueRow({ id: 'att-corrupt', extractedJson: '{"docType": "invoice", oops' }),
    ]
    const res = await GET(getReq('?projectId=p-1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { documents?: Array<Record<string, unknown>> }
    expect(body.documents).toHaveLength(2)
    const byId = new Map(body.documents!.map((d) => [d.id, d.extraction]))
    expect(byId.get('att-none')).toBeNull()
    expect(byId.get('att-corrupt')).toBeNull()
  })

  it('projectId is REQUIRED — absent → 400 with the honest reason, db untouched', async () => {
    const res = await GET(getReq(''))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('projectId is required')
    expect(findManyCalls).toHaveLength(0)
    expect(projectLookups).toHaveLength(0)
  })

  it('unknown projectId → 404 (the queue never falls back to another project)', async () => {
    const res = await GET(getReq('?projectId=p-does-not-exist'))
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('Project not found')
    expect(findManyCalls).toHaveLength(0)
  })

  it('bad reviewStatus → 400 with the allowlist', async () => {
    const res = await GET(getReq('?projectId=p-1&reviewStatus=maybe'))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('pending, approved, rejected')
    expect(findManyCalls).toHaveLength(0)
  })
})

describe('GET /api/ai/extract-document — the shared AI route gate', () => {
  it('client-role session → 403 (the site-team allowlist), db untouched', async () => {
    h.session = { user: { id: 'u-2', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p-1' } }
    try {
      const res = await GET(getReq('?projectId=p-1'))
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toContain('site-team roles')
      expect(findManyCalls).toHaveLength(0)
    } finally {
      h.session = { user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null } }
    }
  })

  it('no session → 401', async () => {
    const prev = h.session
    h.session = null
    try {
      const res = await GET(getReq('?projectId=p-1'))
      expect(res.status).toBe(401)
    } finally {
      h.session = prev
    }
  })

  it('supervisor + admin are on the allowlist (the panel mirrors the route)', async () => {
    for (const role of ['supervisor', 'admin']) {
      h.session = { user: { id: 'u-3', email: `${role}@test.dev`, name: role, role, projectId: null } }
      const res = await GET(getReq('?projectId=p-1'))
      expect(res.status, `${role} should read the queue`).toBe(200)
    }
    h.session = { user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null } }
  })
})
