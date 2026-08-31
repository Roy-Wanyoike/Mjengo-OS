// Supply & procurement (Finder) module — data access.
//
// loadSupplySlice(projectId) loads the procurement network for the project:
// suppliers (+ catalogs, global), requests (+lines, quotes, orders),
// approval rules + approvals, quotes (scoped via request → projectId), and
// purchase orders (+lines +deliveries +delivery lines).

import { db } from '@/lib/db'
import type {
  SupplySlice, SupplierWithCatalog, RequestWithLines, QuoteDetail, OrderWithDetail,
} from './types'

export async function loadSupplySlice(projectId: string): Promise<SupplySlice> {
  const [suppliers, requests, approvalRules, approvals, quotes, orders] = await Promise.all([
    db.supplier.findMany({
      orderBy: [{ verificationState: 'desc' }, { businessName: 'asc' }],
      include: { catalogItems: { orderBy: { name: 'asc' } } },
    }),
    db.materialRequest.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: {
        lines: true,
        quotes: { include: { supplier: true }, orderBy: { totalLanded: 'asc' } },
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
      include: { supplier: true, request: true },
      orderBy: { totalLanded: 'asc' },
    }),
    db.purchaseOrder.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: {
        lines: true,
        supplier: true,
        request: true,
        deliveries: { include: { lines: true }, orderBy: { createdAt: 'desc' } },
      },
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
  }
}
