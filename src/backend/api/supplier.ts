import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { route, genericError } from '@/backend/lib/route-kit'
import { forbidden, sessionSupplierId } from '@/backend/lib/guard'
import type { CatalogItem, Supplier } from '@prisma/client'
import type { QuoteDetail, OrderWithDetail } from '@/backend/modules/supply/types'
import type { InvoiceWithLines } from '@/backend/modules/invoices/types'

// Supplier portal payload — src/app/api/supplier/route.ts is the shim.
// W5-3: the scoped read surface for supplier-role sessions (the supply side
// of the marketplace — suppliers were rows, now they are users). The route is
// SUPPLIER-ONLY (every other role 403s — the buyer reads the same rows through
// their project payload), and the session's supplierId is the ONLY scoping
// input: a supplier sees exactly their own catalog, quotes, orders (with
// deliveries), and invoices, across every buyer project they serve.
//
// The row reads are route-layer implementations over the same includes the
// supply/invoices modules' public reads use (the wallet-transactions
// precedent: the module's slice reads stay project-scoped and untouched; the
// supplier's slice is cross-project by nature, so it lives here).

// ---------------- payload shapes (frontend contract) ----------------

/** One quote the supplier owns, with the RFQ context needed to price it. */
export interface SupplierQuoteRow extends QuoteDetail {
  /** The buyer project the RFQ belongs to (context for the card). */
  projectId: string
  projectName: string
  /** The request's lines — what the site team asked for (qty fixed by them). */
  requestLines: Array<{ id: string; materialName: string; unit: string; qty: number }>
  /** Who raised the request (context — the supplier replies to them). */
  requestedByName: string
  requestedByRole: string
}

/** One purchase order the supplier owns (+ its delivery records). */
export interface SupplierOrderRow extends OrderWithDetail {
  projectId: string
  projectName: string
}

/** One invoice issued by this supplier. */
export interface SupplierInvoiceRow extends InvoiceWithLines {
  projectId: string
  projectName: string
}

/** The full supplier-portal payload (GET /api/supplier). */
export interface SupplierPortalPayload {
  supplier: Supplier
  catalog: CatalogItem[]
  quotes: SupplierQuoteRow[]
  orders: SupplierOrderRow[]
  invoices: SupplierInvoiceRow[]
  /** The buyer projects they serve (id/name/client — context, nothing more). */
  projects: Array<{ id: string; name: string; client: string }>
}

// ---------------- the read ----------------

/**
 * Build the supplier-portal payload for ONE supplier id. Every query is
 * pinned by `where: { supplierId }` — the scoping is the query itself, so a
 * foreign supplier's rows are never even fetched (indistinguishable-from-miss
 * by construction; there is nothing to probe).
 */
export async function getSupplierPortalPayload(supplierId: string): Promise<SupplierPortalPayload | null> {
  const [supplier, quotes, orders, invoices] = await Promise.all([
    db.supplier.findUnique({
      where: { id: supplierId },
      include: { catalogItems: { orderBy: { name: 'asc' } } },
    }),
    db.quote.findMany({
      where: { supplierId },
      orderBy: { createdAt: 'desc' },
      include: {
        request: { include: { lines: true, project: { select: { id: true, name: true } } } },
        supplier: true,
        lines: true,
      },
    }),
    db.purchaseOrder.findMany({
      where: { supplierId },
      orderBy: { createdAt: 'desc' },
      include: {
        lines: true,
        supplier: true,
        request: true,
        project: { select: { id: true, name: true } },
        deliveries: {
          include: { lines: true, photos: { include: { attachment: true }, orderBy: { createdAt: 'asc' } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    }),
    db.invoice.findMany({
      where: { supplierId },
      orderBy: { createdAt: 'desc' },
      include: {
        lines: true,
        supplier: true,
        order: true,
        project: { select: { id: true, name: true } },
      },
    }),
  ])
  // Dangling link (supplierId that resolves to no Supplier row) — honest null:
  // the caller 403s "no supplier linked", never an empty portal pretending.
  if (!supplier) return null

  const quoteRows: SupplierQuoteRow[] = quotes.map((q) => ({
    ...q,
    supplierName: q.supplier.businessName,
    requestCode: q.request.requestCode,
    projectId: q.request.project.id,
    projectName: q.request.project.name,
    requestLines: q.request.lines.map((l) => ({
      id: l.id,
      materialName: l.materialName,
      unit: l.unit,
      qty: l.qty,
    })),
    requestedByName: q.request.requestedByName,
    requestedByRole: q.request.requestedByRole,
  }))

  const orderRows: SupplierOrderRow[] = orders.map((o) => ({
    ...o,
    supplierName: o.supplier.businessName,
    requestCode: o.request?.requestCode ?? null,
    projectId: o.project.id,
    projectName: o.project.name,
    deliveries: o.deliveries,
  }))

  const invoiceRows: SupplierInvoiceRow[] = invoices.map((i) => ({
    ...i,
    supplierName: i.supplier?.businessName ?? null,
    orderCode: i.order?.orderCode ?? null,
    projectId: i.project.id,
    projectName: i.project.name,
  }))

  // The buyer projects they serve — distinct ids across their quotes/orders.
  const projectIds = [
    ...new Set([...orderRows.map((o) => o.projectId), ...invoiceRows.map((i) => i.projectId)]),
  ]
  const projectRows = projectIds.length
    ? await db.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true, client: true } })
    : []

  return {
    supplier,
    catalog: supplier.catalogItems,
    quotes: quoteRows,
    orders: orderRows,
    invoices: invoiceRows,
    projects: projectRows,
  }
}

// ---------------- route ----------------

/**
 * GET /api/supplier — the supplier-role portal payload (their catalog,
 * quotes/RFQs, orders + deliveries, invoices — every row pinned to the
 * session's supplier link).
 *
 * Guard: supplier-role sessions ONLY (401 unsigned, 403 any other role — the
 * buyer side reads the same domain through /api/project). A supplier session
 * with a missing/dangling supplierId 403s 'Supplier account has no supplier
 * linked' (fail closed, mirroring the client 'no project assigned' pin).
 * Rate limit: 60 reads/min per principal (the /api/project cadence).
 */
export const GET = route(
  {
    scope: 'api/supplier GET',
    rateLimit: { bucket: 'supplier.get', limit: 60, windowMs: 60_000 },
    onError: genericError(500, 'Failed to load supplier portal'),
  },
  async (_req: NextRequest, session) => {
    if (session.user.role !== 'supplier') return forbidden(session.user.role)
    const supplierId = sessionSupplierId(session)
    if (!supplierId) {
      return NextResponse.json({ error: 'Supplier account has no supplier linked' }, { status: 403 })
    }
    const payload = await getSupplierPortalPayload(supplierId)
    if (!payload) {
      return NextResponse.json({ error: 'Supplier account has no supplier linked' }, { status: 403 })
    }
    return NextResponse.json({ ok: true, ...payload })
  },
)
