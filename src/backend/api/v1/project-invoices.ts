import { db } from '@/backend/lib/db'
import { centsToKes } from '@/backend/lib/money'
import { route } from '@/backend/lib/route-kit'
import { afterCreatedAtId, cursorRowOr400 } from './keyset'
import { projectInvoicesQuery, projectIdRef, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, membershipProjectDenied, supplierSessionId } from './scope'

// /api/v1/projects/:id/invoices (Phase C, read-only — the money-governance
// family) — src/app/api/v1/projects/[id]/invoices/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

const iso = (v: Date | null): string | null => (v ? v.toISOString() : null)

/**
 * Cents → KSh at the row boundary (issue #122) — the milestone-rows /
 * worker-rows dual-type convention: production Prisma rows carry BigInt
 * cents (converted here, exactly once), while the structural row types also
 * admit plain KSh numbers so shaped fixtures ride the same mapper.
 */
const kes = (v: number | bigint): number => (typeof v === 'bigint' ? centsToKes(v) : v)

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
 * project, foreign → 403; unknown project → 404). SUPPLIER sessions (W5-3)
 * read ROW-PINNED: only THEIR OWN invoices in the project (a supplier with no
 * link → 403 fail closed — never another supplier's money rows).
 *
 * DATA (issue #154 / audit API-3): DIRECT READ — db.invoice.findMany scoped
 * `where: { projectId }` (the same rows the invoices module's
 * loadInvoicesSlice returns), with only the joins the summary needs: line
 * IDS (the count), the supplier's businessName and the order's code — the
 * slice's own flattening, projected field-for-field. The old path
 * materialized the whole ~20-read getProjectPayload to slice the invoices
 * out of it (and rode the slice's transactions/wallet/milestones reads for
 * a ledgerCheck this list never served); the page cost is now O(page): the
 * supplier row-pin, ?status=, the keyset boundary and take = limit + 1 all
 * ride the single query (the #155 attendance pattern), ordered
 * (createdAt DESC, id DESC) — the same total order the route's old
 * in-memory sort produced. Rate limit: 120/min per principal.
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

    // Unknown project → 404 (the attendance/deliveries resolve step).
    const project = await db.project.findUnique({ where: { id } })
    if (!project) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, id)
    if (denied) return denied
    // SEC-6 (issue #174): the site-team membership pin — supervisor /
    // procurement / qs / finance read only the projects they hold a
    // ProjectMembership row on (fail closed on zero rows); contractor/admin
    // keep the explicit portfolio-wide grant. Same uniform 403 body as the
    // client pin, after the resolve (resolve-then-pin, the v1 precedent).
    const membershipDenied = await membershipProjectDenied(session, id)
    if (membershipDenied) return membershipDenied
    // W5-3 supplier row pin: their invoices only (fail closed with no link).
    const supplierId = supplierSessionId(session)
    if (session.user.role === 'supplier' && !supplierId) {
      return v1Err(403, 'Supplier account has no supplier linked')
    }

    // Keyset cursor (#155 convention): resolve by id, refuse unless the row
    // belongs to THIS filtered list (project + status filter + the
    // supplier's own row pin).
    const cursor = q.data.cursor
    let boundary: { createdAt: Date; id: string } | null = null
    if (cursor) {
      const c = await cursorRowOr400(
        () =>
          db.invoice.findFirst({
            where: {
              id: cursor,
              projectId: id,
              ...(q.data.status ? { status: q.data.status } : {}),
              ...(supplierId ? { supplierId } : {}),
            },
          }),
        'an invoice',
      )
      if (!c.ok) return c.response
      boundary = { createdAt: c.row.createdAt, id: c.row.id }
    }

    // One query: scope + row pin + filter + boundary + (createdAt DESC,
    // id DESC) + take limit+1 — the slice's own newest-first order with the
    // id tiebreak the keyset needs.
    const rows = await db.invoice.findMany({
      where: {
        projectId: id,
        ...(q.data.status ? { status: q.data.status } : {}),
        ...(supplierId ? { supplierId } : {}),
        ...(boundary ? afterCreatedAtId(boundary, 'desc') : {}),
      },
      include: {
        lines: { select: { id: true } },
        supplier: { select: { businessName: true } },
        order: { select: { orderCode: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.data.limit + 1,
    })

    const hasMore = rows.length > q.data.limit
    const invoices = rows.slice(0, q.data.limit)
    const nextCursor = hasMore ? invoices[invoices.length - 1]?.id ?? null : null

    return v1Ok(
      invoices.map((i) => ({
        id: i.id,
        invoiceCode: i.invoiceCode,
        status: i.status,
        supplierId: i.supplierId,
        supplierName: i.supplier?.businessName ?? null,
        orderId: i.orderId,
        orderCode: i.order?.orderCode ?? null,
        subtotal: kes(i.subtotal),
        tax: kes(i.tax),
        total: kes(i.total),
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
      })),
      { nextCursor, hasMore },
    )
  },
)
