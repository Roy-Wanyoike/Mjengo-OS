// Supply & procurement (Finder) module — data access.
//
// loadSupplySlice(projectId) loads the procurement network for the project:
// suppliers (+ catalogs, global), requests (+lines, quotes, orders),
// approval rules + approvals, quotes (scoped via request → projectId),
// purchase orders (+lines +deliveries +delivery lines) and the project's
// SavedSupplier ids (spec §30 "save supplier" — the directory sorts those
// first and badges them).
//
// Issue #155 (audit API-4): the DETAIL surfaces (getProjectPayload — the
// webapp's main read — and the module's own service paths) keep that full
// network, but the v1 LIST surfaces (/api/v1/supply/orders,
// /api/v1/projects/:id/deliveries) now read loadSupplyOrdersBounded()
// instead — the orders network alone, take-capped at the DB. The two routes
// project only order summaries / delivery records, so paying for the
// supplier directory + request/quote network per page was pure waste.

import { db } from '@/backend/lib/db'
import { centsToKes } from '@/backend/lib/money'
import type {
  SupplySlice, SupplierWithCatalog, RequestWithLines, QuoteDetail, OrderWithDetail,
} from './types'

// KSh mappers (issue #122): every money field crosses cents→KSh exactly once,
// here at the slice boundary — bigint never reaches the payload.

const toCatalogKes = (c: import('@prisma/client').CatalogItem) => ({ ...c, unitPrice: centsToKes(c.unitPrice) })

const toQuoteKes = (
  q: import('@prisma/client').Quote & { lines: import('@prisma/client').QuoteLine[] },
  names: { supplierName: string; requestCode: string },
): QuoteDetail => {
  // issue #122: the raw supplier relation (pulled by the include at
  // runtime, absent from the static type) carries BigInt money fields —
  // deleted here (supplierName is the contract); a spread-through would
  // crash JSON serialization of the whole project payload.
  const dto = {
    ...q,
    supplierName: names.supplierName,
    requestCode: names.requestCode,
    unitPrice: centsToKes(q.unitPrice),
    deliveryFee: centsToKes(q.deliveryFee),
    transportFee: centsToKes(q.transportFee),
    fees: centsToKes(q.fees),
    totalLanded: centsToKes(q.totalLanded),
    lines: q.lines.map((l) => ({ ...l, unitPrice: centsToKes(l.unitPrice), lineTotal: centsToKes(l.lineTotal) })),
  } as QuoteDetail & { supplier?: unknown }
  delete dto.supplier
  return dto
}

/**
 * DB-level bound for the supply LIST reads (issue #155 / audit API-4): 200
 * purchase orders per read — the v1 list routes document limit 1-200, so the
 * bound equals their max page and no documented single page is truncated
 * (~2 orders of magnitude above the ~4-order seed fixtures). Projects with
 * more orders see the list end at the window boundary (hasMore: false) —
 * the search-route MAX_SCAN honesty convention. The per-order delivery
 * include stays uncapped BY DESIGN: an order is fulfilled once (re-deliveries
 * are the discrepancy exception path), so the per-order delivery set is
 * bounded in practice by the domain shape, not by table growth — the
 * monotonic axis here is the order count, and that is the capped one.
 */
export const SUPPLY_ORDERS_LIST_TAKE = 200

/**
 * The orders network of one project — ONE findMany with the exact includes
 * the order/delivery DTOs need (lines, supplier, request code, deliveries
 * with lines + photo links); no N+1 by construction (same single query
 * loadSupplySlice always issued). Shared by the full slice (detail surfaces,
 * no cap) and the bounded list read below.
 */
async function loadOrdersNetwork(projectId: string, take?: number): Promise<OrderWithDetail[]> {
  const orders = await db.purchaseOrder.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      lines: true,
      supplier: true,
      request: true,
      // Evidence photos replay with the delivery (issue "Photo attachments
      // on delivery verification"): the join row carries the line scope
      // (deliveryLineId — the discrepancy evidence), the Attachment row
      // carries storageKey (the URL the UI renders, same as site photos).
      deliveries: {
        include: { lines: true, photos: { include: { attachment: true }, orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  return orders.map((o) => {
    // issue #122: raw supplier/request relations (runtime includes) carry
    // BigInt money — deleted here (supplierName/requestCode are the
    // contract), same as the quote DTO above.
    const dto = {
      ...o,
      subtotal: centsToKes(o.subtotal),
      deliveryFee: centsToKes(o.deliveryFee),
      total: centsToKes(o.total),
      supplierName: o.supplier.businessName,
      requestCode: o.request?.requestCode ?? null,
      deliveries: o.deliveries,
      lines: o.lines.map((l) => ({ ...l, unitPrice: centsToKes(l.unitPrice), lineTotal: centsToKes(l.lineTotal) })),
    } as OrderWithDetail & { supplier?: unknown; request?: unknown }
    delete dto.supplier
    delete dto.request
    return dto
  })
}

/**
 * The bounded orders read for v1 LIST surfaces (issue #155): exactly the
 * slice's `orders` array (same DTO, same order), take-capped at
 * {@link SUPPLY_ORDERS_LIST_TAKE}. The supplier pin / status filter / cursor
 * pagination still run in the route layer over this window — a filtered page
 * beyond the window reports hasMore: false (the documented bound).
 */
export async function loadSupplyOrdersBounded(projectId: string): Promise<OrderWithDetail[]> {
  return loadOrdersNetwork(projectId, SUPPLY_ORDERS_LIST_TAKE)
}

export async function loadSupplySlice(projectId: string): Promise<SupplySlice> {
  const [suppliers, requests, approvalRules, approvals, quotes, orders, savedSuppliers] = await Promise.all([
    db.supplier.findMany({
      orderBy: [{ verificationState: 'desc' }, { businessName: 'asc' }],
      include: { catalogItems: { orderBy: { name: 'asc' } } },
    }),
    db.materialRequest.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: {
        lines: true,
        quotes: { include: { supplier: true, lines: true }, orderBy: { totalLanded: 'asc' } },
        orders: true,
      },
    }),
    db.approvalRule.findMany({
      where: { projectId },
      orderBy: [{ priority: 'asc' }, { minAmount: 'asc' }],
    }),
    db.approval.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
    db.quote.findMany({
      where: { request: { projectId } },
      include: { supplier: true, request: true, lines: true },
      orderBy: { totalLanded: 'asc' },
    }),
    // DETAIL surface: the full, uncapped orders network (the webapp Finder
    // tab renders the whole procurement state; the bounded variant above is
    // the list-route read — see the #155 note in the header).
    loadOrdersNetwork(projectId),
    db.savedSupplier.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { supplierId: true },
    }),
  ])

  const supplierRows: SupplierWithCatalog[] = suppliers.map((s) => ({
    ...s,
    deliveryFeeBase: centsToKes(s.deliveryFeeBase),
    freeDeliveryOver: s.freeDeliveryOver === null ? null : centsToKes(s.freeDeliveryOver),
    minimumOrder: centsToKes(s.minimumOrder),
    catalogItems: s.catalogItems.map(toCatalogKes),
  }))

  const requestRows: RequestWithLines[] = requests.map((r) => ({
    ...r,
    quotes: r.quotes.map(
      (q): QuoteDetail => toQuoteKes(q, { supplierName: q.supplier.businessName, requestCode: r.requestCode }),
    ),
    orders: r.orders.map((o) => ({
      ...o,
      subtotal: centsToKes(o.subtotal),
      deliveryFee: centsToKes(o.deliveryFee),
      total: centsToKes(o.total),
    })),
  }))

  const quoteRows: QuoteDetail[] = quotes.map((q) =>
    toQuoteKes(q, { supplierName: q.supplier.businessName, requestCode: q.request.requestCode }),
  )

  return {
    suppliers: supplierRows,
    requests: requestRows,
    approvalRules: approvalRules.map((r) => ({
      ...r,
      minAmount: centsToKes(r.minAmount),
      maxAmount: r.maxAmount === null ? null : centsToKes(r.maxAmount),
    })),
    approvals,
    quotes: quoteRows,
    // Already KSh-mapped + relation-stripped by loadOrdersNetwork (the single
    // shared orders query — the mapping lives with the query so the bounded
    // list variant and the full slice can never drift apart).
    orders,
    savedSupplierIds: savedSuppliers.map((s) => s.supplierId),
  }
}
