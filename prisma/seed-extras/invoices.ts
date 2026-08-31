// MjengoOS v2 — Invoices seed (F-1).
// Registered from prisma/seed.ts (seedInvoices(db)); ALSO runnable standalone:
//   bun prisma/seed-extras/invoices.ts   (run AFTER supply.ts — references POs)
//
// Wipes ONLY the models it owns (InvoiceLine, Invoice). Three invoices on
// project 1:
//   · INV-2026-000021 PAID — MPESA-8HKT4Q2A, paidByRole client. NOTE
//     (deliberate): no Transaction row — the historical ledger already carries
//     material spend; only new runtime payments (agent 2-d's invoice.pay)
//     write ledger entries, so the seed never double-counts money.
//   · INV-2026-000027 APPROVED — awaiting payment (for PO-2026-000009).
//   · INV-2026-000031 SUBMITTED — awaiting the client decision (for
//     PO-2026-000012; 3-way match pending — delivery not yet recorded).

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

function daysAgo(n: number, hour = 10, minute = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d
}

function daysAhead(n: number, hour = 10, minute = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() + n)
  d.setHours(hour, minute, 0, 0)
  return d
}

export async function seedInvoices(db: PrismaClient): Promise<void> {
  // FK-safe wipe of ONLY the models this seed owns
  await db.invoiceLine.deleteMany()
  await db.invoice.deleteMany()

  const p1 = await db.project.findFirst({ where: { name: { contains: 'Nyumba Yangu' } } })
  if (!p1) throw new Error('Project 1 (Nyumba Yangu) missing — run `bun prisma/seed.ts` first')

  const [karenTimber, nairobiHardware, kiambuRoad] = await Promise.all([
    db.supplier.findFirst({ where: { businessName: 'Karen Timber & Hardware' } }),
    db.supplier.findFirst({ where: { businessName: 'Nairobi Hardware Centre' } }),
    db.supplier.findFirst({ where: { businessName: 'Kiambu Road Building Supplies' } }),
  ])
  const po9 = await db.purchaseOrder.findFirst({ where: { orderCode: 'PO-2026-000009' } })
  const po12 = await db.purchaseOrder.findFirst({ where: { orderCode: 'PO-2026-000012' } })
  if (!karenTimber || !nairobiHardware || !kiambuRoad || !po9 || !po12) {
    throw new Error('Suppliers / purchase orders missing — run `bun prisma/seed-extras/supply.ts` first')
  }

  // ---------------- INV-2026-000021 — PAID ----------------
  const inv21 = await db.invoice.create({
    data: {
      invoiceCode: 'INV-2026-000021',
      projectId: p1.id,
      orderId: null,
      supplierId: karenTimber.id,
      status: 'paid',
      subtotal: 44200,
      tax: 0, // VAT-inclusive pricing (demo)
      total: 46000, // incl. delivery
      dueDate: daysAgo(16, 12),
      issuedAt: daysAgo(24, 11),
      submittedAt: daysAgo(23, 9),
      decidedAt: daysAgo(22, 18),
      decidedBy: 'Amina (Client)',
      paidAt: daysAgo(20, 13),
      paidByRole: 'client',
      paymentMethod: 'mpesa',
      paymentReference: 'MPESA-8HKT4Q2A',
      createdBy: 'Karen Timber & Hardware',
      note: 'Roofing package deposit — paid via M-Pesa. No Transaction row seeded (ledger already carries material spend — runtime payments only).',
      createdAt: daysAgo(24, 11),
    },
  })
  await db.invoiceLine.createMany({
    data: [
      { invoiceId: inv21.id, name: 'Roofing sheet — box profile 30G (2m)', qty: 30, unitPrice: 1150, lineTotal: 34500 },
      { invoiceId: inv21.id, name: 'Binding wire (25kg roll)', qty: 2, unitPrice: 4850, lineTotal: 9700 },
      { invoiceId: inv21.id, name: 'Delivery — Karen to Kitengela', qty: 1, unitPrice: 1800, lineTotal: 1800 },
    ],
  })

  // ---------------- INV-2026-000027 — APPROVED (awaiting payment) ----------------
  const inv27 = await db.invoice.create({
    data: {
      invoiceCode: 'INV-2026-000027',
      projectId: p1.id,
      orderId: po9.id,
      supplierId: nairobiHardware.id,
      status: 'approved', // decided, awaiting payment
      subtotal: 59250,
      tax: 0,
      total: 62750,
      dueDate: daysAhead(9, 12),
      issuedAt: daysAgo(7, 11),
      submittedAt: daysAgo(6, 9),
      decidedAt: daysAgo(5, 16),
      decidedBy: 'Amina (Client)',
      createdBy: 'Nairobi Hardware Centre',
      note: 'For PO-2026-000009. Approved for payment pending the 2-bag shortfall reconciliation with the supplier.',
      createdAt: daysAgo(7, 11),
    },
  })
  await db.invoiceLine.createMany({
    data: [
      { invoiceId: inv27.id, name: 'Cement 50kg (32.5N)', qty: 50, unitPrice: 795, lineTotal: 39750 },
      { invoiceId: inv27.id, name: 'Ballast (screened)', qty: 10, unitPrice: 1950, lineTotal: 19500 },
      { invoiceId: inv27.id, name: 'Delivery — Industrial Area to Kitengela', qty: 1, unitPrice: 3500, lineTotal: 3500 },
    ],
  })
  // Approval trail for the decision (entityType invoice — plain fields, no FK)
  await db.approval.create({
    data: {
      projectId: p1.id,
      entityType: 'invoice',
      entityId: inv27.id,
      approverRole: 'client',
      approverName: 'Amina (Client)',
      decision: 'approved',
      note: 'Approved from the client view — payment pending delivery reconciliation.',
      decidedAt: daysAgo(5, 16),
      createdAt: daysAgo(6, 9, 30),
    },
  })

  // ---------------- INV-2026-000031 — SUBMITTED (awaiting client decision) ----------------
  const inv31 = await db.invoice.create({
    data: {
      invoiceCode: 'INV-2026-000031',
      projectId: p1.id,
      orderId: po12.id,
      supplierId: kiambuRoad.id,
      status: 'submitted',
      subtotal: 136000,
      tax: 0,
      total: 138500,
      dueDate: daysAhead(7, 12),
      issuedAt: daysAgo(3, 11),
      submittedAt: daysAgo(1, 9),
      createdBy: 'Kiambu Road Building Supplies',
      note: 'For PO-2026-000012. 3-way match PENDING — delivery not yet recorded; do not release payment until counts land.',
      createdAt: daysAgo(3, 11),
    },
  })
  await db.invoiceLine.createMany({
    data: [
      { invoiceId: inv31.id, name: 'Cement 50kg (32.5N)', qty: 50, unitPrice: 760, lineTotal: 38000 },
      { invoiceId: inv31.id, name: 'Steel bar Y12 (12m length)', qty: 10, unitPrice: 9800, lineTotal: 98000 },
      { invoiceId: inv31.id, name: 'Delivery — Kiambu Road to Kitengela', qty: 1, unitPrice: 2500, lineTotal: 2500 },
    ],
  })
  // Pending client decision (138,500 → client band)
  await db.approval.create({
    data: {
      projectId: p1.id,
      entityType: 'invoice',
      entityId: inv31.id,
      approverRole: 'client',
      approverName: 'Amina (Client)',
      decision: 'pending',
      createdAt: daysAgo(1, 9, 30),
    },
  })

  console.log('seedInvoices: 3 invoices (1 paid w/ MPESA ref, 1 approved, 1 submitted)')
}

// Standalone runner (Bun): `bun prisma/seed-extras/invoices.ts`
if ((import.meta as { main?: boolean }).main === true) {
  seedInvoices(db)
    .catch((e) => { console.error(e); process.exit(1) })
    .finally(() => db.$disconnect())
}
