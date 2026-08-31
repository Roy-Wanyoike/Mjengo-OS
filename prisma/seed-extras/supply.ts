// MjengoOS v2 — Supply & procurement (Finder) seed (F-1).
// Registered from prisma/seed.ts (seedSupply(db)); ALSO runnable standalone:
//   bun prisma/seed-extras/supply.ts   (run BEFORE invoices.ts)
//
// Wipes the supply chain it owns — including Invoice/InvoiceLine, because
// invoices hang off purchase orders + suppliers (parents of this module);
// invoices.ts re-creates them afterwards. Run order when standalone:
// professionals → land → supply → invoices → intel.
//
// Data per F-1 spec: 4 suppliers (Nairobi ×2, Kiambu, Machakos) with
// realistic Kenyan catalog prices; approval rules exactly per Finder spec §11;
// 3 requests (DRAFT / SUBMITTED w/ pending approval / CONVERTED); quotes for
// the converted request from 3 suppliers with different landed costs; PO-2026-
// 000012 DELIVERING (dispatched, no delivery yet) + PO-2026-000009 DELIVERED
// with a 48-of-50 discrepancy.

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

export async function seedSupply(db: PrismaClient): Promise<void> {
  // FK-safe wipe of ONLY the models this seed owns (invoices included —
  // they are children of POs/suppliers; invoices.ts re-seeds them)
  await db.invoiceLine.deleteMany()
  await db.invoice.deleteMany()
  await db.orderDeliveryLine.deleteMany()
  await db.orderDelivery.deleteMany()
  await db.purchaseOrderLine.deleteMany()
  await db.purchaseOrder.deleteMany()
  await db.quote.deleteMany()
  await db.approval.deleteMany()
  await db.materialRequestLine.deleteMany()
  await db.materialRequest.deleteMany()
  await db.approvalRule.deleteMany()
  await db.catalogItem.deleteMany()
  await db.supplier.deleteMany()

  const p1 = await db.project.findFirst({ where: { name: { contains: 'Nyumba Yangu' } } })
  if (!p1) throw new Error('Project 1 (Nyumba Yangu) missing — run `bun prisma/seed.ts` first')

  // ---------------- suppliers (4) ----------------
  const [kiambuRoad, nairobiHardware, machakosAgg, karenTimber] = await Promise.all([
    db.supplier.create({
      data: {
        businessName: 'Kiambu Road Building Supplies',
        county: 'Kiambu',
        town: 'Kiambu Road',
        lat: -1.1834,
        lng: 36.7914,
        phone: '0722334455',
        email: 'sales@kiamburoadsupplies.co.ke',
        warehouseLocation: 'Godown 12, Kiambu Road, near ABC Place',
        deliveryZones: 'Nairobi,Kiambu,Kajiado',
        deliveryFeeBase: 2500,
        freeDeliveryOver: 100000,
        minimumOrder: 10000,
        verificationState: 4,
        reliabilityScore: 86,
        responseHours: 6,
        createdAt: daysAgo(150, 9),
      },
    }),
    db.supplier.create({
      data: {
        businessName: 'Nairobi Hardware Centre',
        county: 'Nairobi',
        town: 'Industrial Area',
        lat: -1.3008,
        lng: 36.8319,
        phone: '0711222333',
        email: 'orders@nairobihardware.co.ke',
        warehouseLocation: 'Shed 7, Popo Lane, Industrial Area',
        deliveryZones: 'Nairobi,Kiambu,Machakos,Kajiado',
        deliveryFeeBase: 3500,
        freeDeliveryOver: 150000,
        minimumOrder: 15000,
        verificationState: 3,
        reliabilityScore: 74,
        responseHours: 12,
        createdAt: daysAgo(210, 9),
      },
    }),
    db.supplier.create({
      data: {
        businessName: 'Machakos Aggregates & Steel',
        county: 'Machakos',
        town: 'Machakos',
        lat: -1.5177,
        lng: 37.2634,
        phone: '0733444555',
        email: 'info@machakosaggregates.co.ke',
        warehouseLocation: 'Mombasa Road yard, past Machakos junction',
        deliveryZones: 'Machakos,Makueni,Kitui',
        deliveryFeeBase: 4500,
        freeDeliveryOver: 200000,
        minimumOrder: 20000,
        verificationState: 2,
        reliabilityScore: 62,
        responseHours: 24,
        createdAt: daysAgo(95, 9),
      },
    }),
    db.supplier.create({
      data: {
        businessName: 'Karen Timber & Hardware',
        county: 'Nairobi',
        town: 'Karen',
        lat: -1.3142,
        lng: 36.7048,
        phone: '0790666777',
        email: 'hello@karentimber.co.ke',
        warehouseLocation: 'Karen Road, opposite Hardy shopping centre',
        deliveryZones: 'Nairobi,Kajiado',
        deliveryFeeBase: 1800,
        freeDeliveryOver: 60000,
        minimumOrder: 5000,
        verificationState: 4,
        reliabilityScore: 80,
        responseHours: 4,
        createdAt: daysAgo(70, 9),
      },
    }),
  ])

  // ---------------- catalogs (6-10 items each, realistic KES) ----------------
  type Item = [string, string, number, number, number] // name, unit, price, stock, minOrder
  const catalogs: Array<[string, Item[]]> = [
    [kiambuRoad.id, [
      ['Cement 50kg (32.5N)', 'bag', 760, 1200, 50],
      ['Steel bar Y12 (12m length)', 'length', 9800, 240, 10],
      ['Ballast (screened)', 'tonne', 1800, 90, 10],
      ['River sand', 'tonne', 2200, 60, 5],
      ['Binding wire (25kg roll)', 'roll', 4850, 40, 2],
      ['Roofing sheet — box profile 30G (2m)', 'sheet', 1050, 300, 20],
      ['Steel bar D10 (12m length)', 'length', 4650, 180, 10],
    ]],
    [nairobiHardware.id, [
      ['Cement 50kg (32.5N)', 'bag', 795, 2000, 100],
      ['Steel bar Y12 (12m length)', 'length', 10200, 320, 10],
      ['Ballast (screened)', 'tonne', 1950, 120, 10],
      ['River sand', 'tonne', 2300, 85, 5],
      ['Binding wire (25kg roll)', 'roll', 5100, 55, 2],
      ['Roofing sheet — box profile 30G (2m)', 'sheet', 1120, 500, 20],
      ['Machine-cut stones (9")', 'piece', 55, 8000, 500],
      ['Waterproofing membrane (1m roll)', 'roll', 1850, 120, 5],
    ]],
    [machakosAgg.id, [
      ['Cement 50kg (32.5N)', 'bag', 810, 800, 50],
      ['Steel bar Y12 (12m length)', 'length', 10050, 160, 10],
      ['Ballast (screened)', 'tonne', 1750, 200, 10],
      ['River sand', 'tonne', 2100, 150, 5],
      ['Binding wire (25kg roll)', 'roll', 4600, 30, 2],
      ['Roofing sheet — box profile 30G (2m)', 'sheet', 1220, 240, 20],
    ]],
    [karenTimber.id, [
      ['Cement 50kg (32.5N)', 'bag', 745, 450, 20],
      ['Steel bar Y12 (12m length)', 'length', 9950, 120, 5],
      ['Ballast (screened)', 'tonne', 1850, 40, 5],
      ['River sand', 'tonne', 2250, 25, 5],
      ['Binding wire (25kg roll)', 'roll', 5150, 20, 2],
      ['Roofing sheet — box profile 30G (2m)', 'sheet', 1080, 180, 10],
      ['Steel bar D8 (12m length)', 'length', 3050, 90, 5],
    ]],
  ]
  for (const [supplierId, items] of catalogs) {
    await db.catalogItem.createMany({
      data: items.map(([name, unit, unitPrice, stockQty, minOrderQty]) => ({
        supplierId, name, unit, unitPrice, stockQty, minOrderQty,
      })),
    })
  }

  // ---------------- approval rules (Finder spec §11, project 1) ----------------
  await db.approvalRule.createMany({
    data: [
      { projectId: p1.id, minAmount: 0, maxAmount: 10000, approverRole: 'supervisor', priority: 10 },
      { projectId: p1.id, minAmount: 10000, maxAmount: 50000, approverRole: 'contractor', priority: 20 },
      { projectId: p1.id, minAmount: 50000, maxAmount: 250000, approverRole: 'client', priority: 30 },
      // >250k: client AND finance both sign off (chained)
      { projectId: p1.id, minAmount: 250000, maxAmount: null, approverRole: 'client', priority: 40 },
      { projectId: p1.id, minAmount: 250000, maxAmount: null, approverRole: 'finance', priority: 41 },
    ],
  })

  // ---------------- material requests ----------------
  const mr1042 = await db.materialRequest.create({
    data: {
      projectId: p1.id,
      requestCode: 'MR-1042',
      requestedByRole: 'supervisor',
      requestedByName: 'Mwangi Kariuki (Foreman)',
      notes: 'Foundation-to-walling package — cement for the ring beam pour + Y12 steel for lintels/columns.',
      status: 'converted', // → PO-2026-000012
      createdAt: daysAgo(14, 8),
    },
  })
  const mr1042Lines = await Promise.all([
    db.materialRequestLine.create({ data: { requestId: mr1042.id, materialName: 'Cement 50kg (32.5N)', unit: 'bag', qty: 50 } }),
    db.materialRequestLine.create({ data: { requestId: mr1042.id, materialName: 'Steel bar Y12 (12m length)', unit: 'length', qty: 10 } }),
  ])
  void mr1042Lines

  const mr1043 = await db.materialRequest.create({
    data: {
      projectId: p1.id,
      requestCode: 'MR-1043',
      requestedByRole: 'supervisor',
      requestedByName: 'Joseph Mwenda',
      notes: 'Hardcore for the slab backfill + river sand for screeding. Quotes pending from 2 suppliers.',
      status: 'submitted',
      createdAt: daysAgo(3, 9),
    },
  })
  await db.materialRequestLine.createMany({
    data: [
      { requestId: mr1043.id, materialName: 'Ballast (screened)', unit: 'tonne', qty: 10 },
      { requestId: mr1043.id, materialName: 'River sand', unit: 'tonne', qty: 5 },
    ],
  })
  // Pending approval decision (~KSh 29,300 → contractor band 10k-50k)
  await db.approval.create({
    data: {
      projectId: p1.id,
      entityType: 'material_request',
      entityId: mr1043.id,
      approverRole: 'contractor',
      approverName: 'Site Manager',
      decision: 'pending',
      createdAt: daysAgo(3, 9, 30),
    },
  })

  const mr1044 = await db.materialRequest.create({
    data: {
      projectId: p1.id,
      requestCode: 'MR-1044',
      requestedByRole: 'contractor',
      requestedByName: 'Site Manager',
      notes: 'Roofing package — holding as DRAFT until the client picks the mabati colour.',
      status: 'draft',
      createdAt: daysAgo(1, 15),
    },
  })
  await db.materialRequestLine.createMany({
    data: [
      { requestId: mr1044.id, materialName: 'Binding wire (25kg roll)', unit: 'roll', qty: 2 },
      { requestId: mr1044.id, materialName: 'Roofing sheet — box profile 30G (2m)', unit: 'sheet', qty: 20 },
    ],
  })

  // ---------------- quotes (MR-1042: 3 received w/ different landed costs) ----------------
  await db.quote.createMany({
    data: [
      {
        requestId: mr1042.id,
        supplierId: kiambuRoad.id,
        unitPrice: 760, // cement (primary line)
        deliveryFee: 2500,
        transportFee: 500,
        fees: 0,
        totalLanded: 139000, // 50×760 + 10×9800 + 2500 + 500
        deliveryEta: '2 days',
        stockOk: true,
        status: 'received',
        createdAt: daysAgo(13, 11),
      },
      {
        requestId: mr1042.id,
        supplierId: nairobiHardware.id,
        unitPrice: 795,
        deliveryFee: 3500,
        transportFee: 0,
        fees: 0,
        totalLanded: 145250, // 50×795 + 10×10200 + 3500
        deliveryEta: 'next day',
        stockOk: true,
        status: 'received',
        createdAt: daysAgo(13, 12),
      },
      {
        requestId: mr1042.id,
        supplierId: karenTimber.id,
        unitPrice: 745,
        deliveryFee: 1800,
        transportFee: 0,
        fees: 250, // offloading fee
        totalLanded: 138800, // 50×745 + 10×9950 + 1800 + 250
        deliveryEta: 'same day',
        stockOk: true,
        status: 'received',
        createdAt: daysAgo(13, 10),
      },
    ],
  })
  // MR-1043: 2 quotes REQUESTED (awaiting supplier response)
  await db.quote.createMany({
    data: [
      { requestId: mr1043.id, supplierId: nairobiHardware.id, unitPrice: 0, deliveryFee: 0, transportFee: 0, fees: 0, totalLanded: 0, status: 'requested', createdAt: daysAgo(2, 10) },
      { requestId: mr1043.id, supplierId: machakosAgg.id, unitPrice: 0, deliveryFee: 0, transportFee: 0, fees: 0, totalLanded: 0, status: 'requested', createdAt: daysAgo(2, 10) },
    ],
  })

  // ---------------- purchase orders ----------------
  // PO-2026-000009 — DELIVERED with a 48-of-50 discrepancy (Nairobi Hardware)
  const po9 = await db.purchaseOrder.create({
    data: {
      orderCode: 'PO-2026-000009',
      projectId: p1.id,
      requestId: null, // direct order (no material request)
      supplierId: nairobiHardware.id,
      subtotal: 59250, // 50 cement ×795 + 10 ballast ×1950
      deliveryFee: 3500,
      total: 62750,
      status: 'delivered',
      paymentSource: 'client',
      createdByRole: 'contractor',
      note: 'Direct order — slab backfill package before the walling pour.',
      createdAt: daysAgo(16, 9),
    },
  })
  const po9Cement = await db.purchaseOrderLine.create({
    data: { orderId: po9.id, name: 'Cement 50kg (32.5N)', unit: 'bag', qty: 50, unitPrice: 795, lineTotal: 39750 },
  })
  const po9Ballast = await db.purchaseOrderLine.create({
    data: { orderId: po9.id, name: 'Ballast (screened)', unit: 'tonne', qty: 10, unitPrice: 1950, lineTotal: 19500 },
  })
  await db.approval.create({
    data: {
      projectId: p1.id,
      entityType: 'purchase_order',
      entityId: po9.id,
      approverRole: 'client', // 62,750 → client band (50k-250k)
      approverName: 'Amina (Client)',
      decision: 'approved',
      note: 'Approved from the client view — 3 quotes compared first.',
      decidedAt: daysAgo(15, 17),
      createdAt: daysAgo(16, 9, 30),
    },
  })
  const delivery9 = await db.orderDelivery.create({
    data: {
      orderId: po9.id,
      status: 'discrepancy', // 48 of 50 cement bags received
      dispatchedAt: daysAgo(9, 8),
      receivedAt: daysAgo(8, 14),
      receivedBy: 'Mwangi Kariuki (Foreman)',
      note: '2 bags missing — supplier notified. Photos + delivery note on file; awaiting supplier response.',
      photoCount: 3,
      gpsLat: -1.2921,
      gpsLng: 36.8219,
      createdAt: daysAgo(9, 8),
    },
  })
  await db.orderDeliveryLine.createMany({
    data: [
      { deliveryId: delivery9.id, orderLineId: po9Cement.id, qtyOrdered: 50, qtyReceived: 48 },
      { deliveryId: delivery9.id, orderLineId: po9Ballast.id, qtyOrdered: 10, qtyReceived: 10 },
    ],
  })

  // PO-2026-000012 — DELIVERING (dispatched, no delivery record yet)
  const po12 = await db.purchaseOrder.create({
    data: {
      orderCode: 'PO-2026-000012',
      projectId: p1.id,
      requestId: mr1042.id, // converted from MR-1042
      supplierId: kiambuRoad.id,
      subtotal: 136000, // 50 cement ×760 + 10 Y12 ×9800
      deliveryFee: 2500,
      total: 138500,
      status: 'delivering',
      paymentSource: 'client',
      createdByRole: 'contractor',
      note: 'Best landed cost of the 3 quotes (2nd on unit price, first overall). Truck dispatched with delivery note DN-8812.',
      createdAt: daysAgo(6, 9),
    },
  })
  await db.purchaseOrderLine.createMany({
    data: [
      { orderId: po12.id, name: 'Cement 50kg (32.5N)', unit: 'bag', qty: 50, unitPrice: 760, lineTotal: 38000 },
      { orderId: po12.id, name: 'Steel bar Y12 (12m length)', unit: 'length', qty: 10, unitPrice: 9800, lineTotal: 98000 },
    ],
  })
  await db.approval.create({
    data: {
      projectId: p1.id,
      entityType: 'purchase_order',
      entityId: po12.id,
      approverRole: 'client', // 138,500 → client band (50k-250k)
      approverName: 'Amina (Client)',
      decision: 'approved',
      note: 'Approved from the client view after comparing landed costs.',
      decidedAt: daysAgo(5, 18),
      createdAt: daysAgo(6, 9, 30),
    },
  })

  console.log('seedSupply: 4 suppliers, 28 catalog items, 5 approval rules, 3 requests, 5 quotes, 2 POs (1 delivering, 1 delivered w/ discrepancy)')
}

// Standalone runner (Bun): `bun prisma/seed-extras/supply.ts`
if ((import.meta as { main?: boolean }).main === true) {
  seedSupply(db)
    .catch((e) => { console.error(e); process.exit(1) })
    .finally(() => db.$disconnect())
}
