import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { threeWayCheck } from '@/backend/modules/invoices/service'
import { invoiceDetailQuery, invoiceRef, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, supplierSessionId } from './scope'

// /api/v1/invoices/:id (Phase C, read-only — the money-governance family) —
// src/app/api/v1/invoices/[id]/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

const iso = (v: Date | null): string | null => (v ? v.toISOString() : null)

/**
 * GET /api/v1/invoices/:id — one supplier invoice with its full lifecycle,
 * lines, totals, payment references AND the 3-way-match verdict (PO ↔
 * invoice ↔ delivery, modules/invoices/three-way.ts — the same
 * matchThreeWay run the pay gate and the Finder matrix use, re-computed per
 * request: never stored, never stale).
 *
 * The verdict is WARN-ONLY by design (the module's honesty rules): every
 * discrepancy is "review required" language, never an accusation —
 * mismatches list what the paperwork vs the physical counts show; the human
 * decides (an authorized payment with open items carries the payer's
 * acknowledgeMismatch decision in the Approval trail). Disputed and paid
 * states are represented exactly as stored.
 *
 * Read-only — mutations stay on POST /api/actions (invoice.submit / decide /
 * pay), the OpenAPI description says so. NO FEATURE FLAG: flags.ts documents
 * that invoice.* is NOT gated by `marketplace` (its own module sharing the
 * Finder tab) and the wallet flag never applied to it.
 *
 * ROLE SCOPING: resolve first, pin second (the v1 payments precedent) — the
 * id (cuid) OR invoiceCode (e.g. INV-2026-000031) resolves the invoice, then
 * a client-role session must be pinned to the invoice's own project (else
 * 403 'Not permitted for this project'). Unknown invoice → 404. SUPPLIER
 * sessions (W5-3) get the strictest pin: a foreign supplier's invoice
 * answers the SAME 404 'Invoice not found' as an unknown id —
 * indistinguishable from a miss; no link → 403 fail closed.
 *
 * DATA: the detail row is read here with the loadInvoicesSlice include
 * (lines + supplier + order — the wallet-transactions precedent: the
 * module's public read is the whole-project slice); the verdict comes from
 * the module's own read-only threeWayCheck — one algorithm, one source of
 * truth, no route-side re-implementation. Pagination does not apply (one
 * object). Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'invoices/:id GET',
    rateLimit: { bucket: 'v1.invoice.get', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('invoices/:id GET', e, 'Invoice detail failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = invoiceRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, invoiceDetailQuery)
    if (!q.ok) return q.response

    const invoice = await db.invoice.findFirst({
      where: { OR: [{ id }, { invoiceCode: id }] },
      include: { lines: true, supplier: true, order: { select: { orderCode: true } } },
    })
    if (!invoice) return v1Err(404, 'Invoice not found')
    const denied = clientProjectDenied(session, invoice.projectId)
    if (denied) return denied
    // W5-3 supplier row pin: a foreign supplier's invoice answers EXACTLY like
    // an unknown id (same 404 body). No link → fail-closed 403.
    const supplierId = supplierSessionId(session)
    if (session.user.role === 'supplier') {
      if (!supplierId) return v1Err(403, 'Supplier account has no supplier linked')
      if (invoice.supplierId !== supplierId) return v1Err(404, 'Invoice not found')
    }

    // The 3-way verdict — the invoices module's own read-only check (the
    // exact function /api/actions invoice.threeWayCheck runs; recomputed
    // here so the detail and the pay gate can never disagree).
    const verdict = await threeWayCheck(invoice.projectId, { id: invoice.id })

    return v1Ok({
      id: invoice.id,
      invoiceCode: invoice.invoiceCode,
      projectId: invoice.projectId,
      status: invoice.status,
      supplierId: invoice.supplierId,
      supplierName: invoice.supplier?.businessName ?? null,
      orderId: invoice.orderId,
      orderCode: invoice.order?.orderCode ?? null,
      subtotal: invoice.subtotal,
      tax: invoice.tax,
      total: invoice.total,
      lines: invoice.lines.map((l) => ({
        id: l.id,
        name: l.name,
        qty: l.qty,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
      })),
      dueDate: iso(invoice.dueDate),
      issuedAt: iso(invoice.issuedAt),
      submittedAt: iso(invoice.submittedAt),
      decidedAt: iso(invoice.decidedAt),
      decidedBy: invoice.decidedBy,
      paidAt: iso(invoice.paidAt),
      paidByRole: invoice.paidByRole,
      paymentMethod: invoice.paymentMethod,
      paymentReference: invoice.paymentReference,
      createdBy: invoice.createdBy,
      note: invoice.note,
      threeWayMatch: verdict,
      createdAt: iso(invoice.createdAt),
      updatedAt: iso(invoice.updatedAt),
    })
  },
)
