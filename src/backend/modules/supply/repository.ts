// Supply & procurement (Finder) module — data access.
//
// loadSupplySlice(projectId) loads the procurement network for the project:
// suppliers (+ catalogs, global), requests (+lines, quotes, orders),
// approval rules + approvals, quotes (scoped via request → projectId),
// purchase orders (+lines +deliveries +delivery lines) and the project's
// SavedSupplier ids (spec §30 "save supplier" — the directory sorts those
// first and badges them).

import { db } from '@/backend/lib/db'
import type {
  SupplySlice, SupplierWithCatalog, RequestWithLines, QuoteDetail, OrderWithDetail,
} from './types'

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
    catalogItems: s.catalogItems,
  }))

  const requestRows: RequestWithLines[] = requests.map((r) => ({
    ...r,
    quotes: r.quotes.map(
      (q): QuoteDetail => ({
        ...q,
        supplierName: q.supplier.businessName,
        requestCode: r.requestCode,
      }),
    ),
    orders: r.orders,
  }))

  const quoteRows: QuoteDetail[] = quotes.map((q) => ({
    ...q,
    supplierName: q.supplier.businessName,
    requestCode: q.request.requestCode,
  }))

  const orderRows: OrderWithDetail[] = orders.map((o) => ({
    ...o,
    supplierName: o.supplier.businessName,
    requestCode: o.request?.requestCode ?? null,
    deliveries: o.deliveries,
  }))

  return {
    suppliers: supplierRows,
    requests: requestRows,
    approvalRules,
    approvals,
    quotes: quoteRows,
    orders: orderRows,
    savedSupplierIds: savedSuppliers.map((s) => s.supplierId),
  }
}
