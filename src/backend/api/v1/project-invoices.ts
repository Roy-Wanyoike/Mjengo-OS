import { route } from '@/backend/lib/route-kit'
import { getProjectPayload } from '@/backend/lib/mjengo'
import { projectInvoicesQuery, projectIdRef, validateQuery } from './schemas'
import { mapServiceError, pageOfKind, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied } from './scope'

// /api/v1/projects/:id/invoices (Phase C, read-only — the money-governance
// family) — src/app/api/v1/projects/[id]/invoices/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

const iso = (v: Date | null): string | null => (v ? v.toISOString() : null)

/**
 * GET /api/v1/projects/:id/invoices — the project's supplier-invoice
 * lifecycle (Finder §13-15): draft → submitted → approved | rejected |
 * disputed → paid, with totals and payment references. Disputed and paid
 * states are represented exactly as stored — no state is invented or hidden.
 * Read-only — every mutation (invoice.create / update / submit / decide /
 * pay, disputes ride invoice.update) stays on POST /api/actions, documented
 * in the OpenAPI description.
 *
 * NO FEATURE FLAG gates this resource, deliberately: the invoices module
 * shares the Finder tab with supply but is its own module — flags.ts
 * documents that invoice.* is NOT gated by `marketplace`, and the wallet
 * flag never applied to it either. The OpenAPI description carries that
 * honest boundary note.
 *
 * ROLE SCOPING: same as /api/v1/projects/:id (client pinned to their own
 * project, foreign → 403; unknown project → 404).
 *
 * DATA: the invoice rows come from getProjectPayload()'s invoices slice —
 * loadInvoicesSlice(projectId), the invoices module's public read (rows
 * include lines, supplier name and PO code; the A-1-lite ledgerCheck rides
 * the payload for the webapp, not this list). The set is bounded, so
 * pagination is the wallet-list pattern: a deterministic (createdAt DESC,
 * id DESC) total order sliced in the route layer. ?status= (the six
 * InvoiceStatus values) filters BEFORE pagination — a cursor that falls out
 * of the filtered list → 400. Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'projects/:id/invoices GET',
    rateLimit: { bucket: 'v1.projects.invoices', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects/:id/invoices GET', e, 'Project invoices failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = projectIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, projectInvoicesQuery)
    if (!q.ok) return q.response

    const payload = await getProjectPayload(id)
    if (!payload) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, payload.project.id)
    if (denied) return denied

    let invoices = payload.invoices.invoices
    if (q.data.status) {
      invoices = invoices.filter((i) => i.status === q.data.status)
    }
    // Deterministic keyset order: (createdAt DESC, id DESC) — the slice's own
    // newest-first order with the id tiebreak the keyset needs.
    invoices = [...invoices].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )

    // pageOfKind needs { id } rows; map the summary alongside.
    const rows = invoices.map((i) => ({
      id: i.id,
      item: {
        id: i.id,
        invoiceCode: i.invoiceCode,
        status: i.status,
        supplierId: i.supplierId,
        supplierName: i.supplierName,
        orderId: i.orderId,
        orderCode: i.orderCode,
        subtotal: i.subtotal,
        tax: i.tax,
        total: i.total,
        lineCount: i.lines.length,
        dueDate: iso(i.dueDate),
        issuedAt: iso(i.issuedAt),
        submittedAt: iso(i.submittedAt),
        decidedAt: iso(i.decidedAt),
        decidedBy: i.decidedBy,
        paidAt: iso(i.paidAt),
        paidByRole: i.paidByRole,
        paymentMethod: i.paymentMethod,
        paymentReference: i.paymentReference,
        createdBy: i.createdBy,
        createdAt: iso(i.createdAt),
        updatedAt: iso(i.updatedAt),
      },
    }))
    const p = pageOfKind(rows, q.data.limit, q.data.cursor, 'an invoice')
    if (!p.ok) return p.response

    return v1Ok(
      p.page.items.map((r) => r.item),
      { nextCursor: p.page.nextCursor, hasMore: p.page.hasMore },
    )
  },
)
