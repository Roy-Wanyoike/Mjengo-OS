// Invoices module — data access.
//
// loadInvoicesSlice(projectId) loads the project's invoices with lines and
// supplier/order links flattened into display fields.

import { db } from '@/lib/db'
import type { InvoicesSlice, InvoiceWithLines } from './types'

export async function loadInvoicesSlice(projectId: string): Promise<InvoicesSlice> {
  const invoices = await db.invoice.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    include: { lines: true, supplier: true, order: true },
  })

  const rows: InvoiceWithLines[] = invoices.map((i) => ({
    ...i,
    supplierName: i.supplier?.businessName ?? null,
    orderCode: i.order?.orderCode ?? null,
  }))

  return { invoices: rows }
}
