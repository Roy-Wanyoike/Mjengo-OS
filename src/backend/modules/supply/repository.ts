// Supply & procurement (Finder) module — data access.
//
// loadSupplySlice(projectId) loads the procurement network for the project:
// suppliers (+ catalogs, global), requests (+lines, quotes, orders),
// approval rules + approvals, quotes (scoped via request → projectId),
// purchase orders (+lines +deliveries +delivery lines) and the project's
// SavedSupplier ids (spec §30 "save supplier" — the directory sorts those
// first and badges them).

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
    db.purchaseOrder.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
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
    }),
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

  const orderRows: OrderWithDetail[] = orders.map((o) => {
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
    orders: orderRows,
    savedSupplierIds: savedSuppliers.map((s) => s.supplierId),
  }
}
