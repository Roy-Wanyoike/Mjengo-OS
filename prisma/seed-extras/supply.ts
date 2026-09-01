// MjengoOS v2 — Supply & procurement (Finder) seed (F-1 → F-PROCURE v2).
// Registered from prisma/seed.ts (seedSupply(db)); ALSO runnable standalone:
//   bun prisma/seed-extras/supply.ts   (run BEFORE invoices.ts)
// Standalone runs pass { reseedInvoices: true } so the invoices that hang off
// POs + suppliers are rebuilt at the end with fresh references — safe in ANY
// extras order (invoices before or after supply).
//
// Wipes the supply chain it owns — including Invoice/InvoiceLine, because
// invoices hang off purchase orders + suppliers (parents of this module).
//
// Data: 4 suppliers (Nairobi ×2, Kiambu, Machakos) with contact channels +
// operating hours and full catalogs (category/brand/specification per spec
// §29 — ~40 items covering cement/steel/roofing/ballast/sand/timber/plumbing/
// electrical/paint/tiles/blocks/tools/waterproofing); approval rules exactly
// per Finder spec §11; 4 requests (DRAFT / SUBMITTED contractor-band /
// SUBMITTED client-band / CONVERTED); quotes for the converted request from
// 3 suppliers with different landed costs (one multi-line with validity +
// terms); PO-2026-000012 DELIVERING (dispatched) + PO-2026-000009 DELIVERED
// with a 48-of-50 discrepancy; Site Store inventory history (cement/ballast/
// river sand/steel: opening + received + consumed + damaged + transfer); one
// approved BOQ ("Nyumba Yangu — QS estimate v1") + one draft; one saved
// supplier on the project shortlist. Rows are looked up by NAME (never ids).

import { PrismaClient } from '@prisma/client'
import { seedInvoices } from './invoices'

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

export async function seedSupply(db: PrismaClient, opts: { reseedInvoices?: boolean } = {}): Promise<void> {
  // FK-safe wipe of ONLY the models this seed owns (invoices included —
  // they are children of POs/suppliers; seedInvoices re-seeds them)
  await db.invoiceLine.deleteMany()
  await db.invoice.deleteMany()
  await db.quoteLine.deleteMany()
  await db.orderDeliveryLine.deleteMany()
  await db.orderDelivery.deleteMany()
  await db.purchaseOrderLine.deleteMany()
  await db.purchaseOrder.deleteMany()
  await db.quote.deleteMany()
  await db.approval.deleteMany()
  await db.materialRequestLine.deleteMany()
  await db.materialRequest.deleteMany()
  await db.approvalRule.deleteMany()
  await db.stockMovement.deleteMany()
  await db.inventoryItem.deleteMany()
  await db.boqLine.deleteMany()
  await db.boq.deleteMany()
  await db.savedSupplier.deleteMany()
  await db.catalogItem.deleteMany()
  await db.supplier.deleteMany()

  const p1 = await db.project.findFirst({ where: { name: { contains: 'Nyumba Yangu' } } })
  if (!p1) throw new Error('Project 1 (Nyumba Yangu) missing — run `bun prisma/seed.ts` first')
  const project = p1 // non-null for the helpers below (closures don't narrow)
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
        operatingHours: 'Mon-Sat 07:00-18:00',
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
        operatingHours: 'Mon-Fri 08:00-17:30 · Sat 08:30-13:00',
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
        operatingHours: 'Mon-Sat 06:30-17:00',
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
        operatingHours: 'Mon-Sat 07:30-17:00 · Sun closed',
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

  // ---------------- catalogs (spec §29: category/brand/specification) ----------------
  interface CatalogItem {
    name: string
    unit: string
    unitPrice: number
    stockQty: number
    minOrderQty: number
    category: string
    brand?: string
    specification?: string
  }
  const catalogs: Array<[string, CatalogItem[]]> = [
    [kiambuRoad.id, [
      { name: 'Cement 50kg (32.5N)', unit: 'bag', unitPrice: 760, stockQty: 1200, minOrderQty: 50, category: 'cement', brand: 'Simba', specification: '32.5N 50kg bag' },
      { name: 'Steel bar Y12 (12m length)', unit: 'length', unitPrice: 9800, stockQty: 240, minOrderQty: 10, category: 'steel', brand: 'Devki', specification: 'Y12 deformed bar, 12m' },
      { name: 'Ballast (screened)', unit: 'tonne', unitPrice: 1800, stockQty: 90, minOrderQty: 10, category: 'ballast', specification: 'screened 3/4 inch' },
      { name: 'River sand', unit: 'tonne', unitPrice: 2200, stockQty: 60, minOrderQty: 5, category: 'sand', specification: 'river sand, unwashed' },
      { name: 'Binding wire (25kg roll)', unit: 'roll', unitPrice: 4850, stockQty: 40, minOrderQty: 2, category: 'steel', specification: 'annealed tie wire, 25kg roll' },
      { name: 'Roofing sheet — box profile 30G (2m)', unit: 'sheet', unitPrice: 1050, stockQty: 300, minOrderQty: 20, category: 'roofing', brand: 'Mabati Rolling Mills', specification: 'box profile 30G, 2m, pre-painted' },
      { name: 'Steel bar D10 (12m length)', unit: 'length', unitPrice: 4650, stockQty: 180, minOrderQty: 10, category: 'steel', brand: 'Devki', specification: 'D10 deformed bar, 12m' },
      { name: 'PVC solvent cement 500ml', unit: 'tin', unitPrice: 850, stockQty: 150, minOrderQty: 2, category: 'plumbing', brand: 'Plasco', specification: 'heavy-duty solvent cement' },
      { name: 'Ceramic wall tiles 300×600mm (m²)', unit: 'm²', unitPrice: 1150, stockQty: 500, minOrderQty: 15, category: 'tiles', brand: 'Goodwill', specification: 'glossy white wall tile' },
    ]],
    [nairobiHardware.id, [
      { name: 'Cement 50kg (32.5N)', unit: 'bag', unitPrice: 795, stockQty: 2000, minOrderQty: 100, category: 'cement', brand: 'Bamburi', specification: '32.5N 50kg bag' },
      { name: 'Steel bar Y12 (12m length)', unit: 'length', unitPrice: 10200, stockQty: 320, minOrderQty: 10, category: 'steel', brand: 'Doshi', specification: 'Y12 deformed bar, 12m' },
      { name: 'Ballast (screened)', unit: 'tonne', unitPrice: 1950, stockQty: 120, minOrderQty: 10, category: 'ballast', specification: 'screened 3/4 inch' },
      { name: 'River sand', unit: 'tonne', unitPrice: 2300, stockQty: 85, minOrderQty: 5, category: 'sand', specification: 'river sand, unwashed' },
      { name: 'Binding wire (25kg roll)', unit: 'roll', unitPrice: 5100, stockQty: 55, minOrderQty: 2, category: 'steel', specification: 'annealed tie wire, 25kg roll' },
      { name: 'Roofing sheet — box profile 30G (2m)', unit: 'sheet', unitPrice: 1120, stockQty: 500, minOrderQty: 20, category: 'roofing', brand: 'Mabati Rolling Mills', specification: 'box profile 30G, 2m, pre-painted' },
      { name: 'Machine-cut stones (9")', unit: 'piece', unitPrice: 55, stockQty: 8000, minOrderQty: 500, category: 'blocks', specification: '9-inch machine-cut stone' },
      { name: 'Waterproofing membrane (1m roll)', unit: 'roll', unitPrice: 1850, stockQty: 120, minOrderQty: 5, category: 'finishes', specification: 'torch-on APP membrane, 1m roll' },
      { name: 'PVC pipe 4" (3m length)', unit: 'length', unitPrice: 1250, stockQty: 400, minOrderQty: 10, category: 'plumbing', brand: 'Plasco', specification: 'Class B, solvent weld' },
      { name: 'Electrical cable 2.5mm² (100m roll)', unit: 'roll', unitPrice: 5400, stockQty: 60, minOrderQty: 2, category: 'electrical', brand: 'Ozone', specification: 'twin & earth, copper' },
      { name: 'Gloss paint 4L — white', unit: 'tin', unitPrice: 3200, stockQty: 90, minOrderQty: 2, category: 'paint', brand: 'Crown', specification: 'silk acrylic, interior' },
      { name: 'Ceramic floor tiles 600×600mm (m²)', unit: 'm²', unitPrice: 1350, stockQty: 800, minOrderQty: 20, category: 'tiles', brand: 'Goodwill', specification: 'vitrified, matte grey' },
      { name: 'Concrete blocks (6" hollow)', unit: 'block', unitPrice: 75, stockQty: 3000, minOrderQty: 100, category: 'blocks', specification: '6-inch hollow, machine-vibrated' },
      { name: 'Tools rental — concrete vibrator (day)', unit: 'day', unitPrice: 3500, stockQty: 3, minOrderQty: 1, category: 'tools', specification: 'petrol poker vibrator, with operator' },
    ]],
    [machakosAgg.id, [
      { name: 'Cement 50kg (32.5N)', unit: 'bag', unitPrice: 810, stockQty: 800, minOrderQty: 50, category: 'cement', brand: 'Devki', specification: '32.5N 50kg bag' },
      { name: 'Steel bar Y12 (12m length)', unit: 'length', unitPrice: 10050, stockQty: 160, minOrderQty: 10, category: 'steel', brand: 'Devki', specification: 'Y12 deformed bar, 12m' },
      { name: 'Ballast (screened)', unit: 'tonne', unitPrice: 1750, stockQty: 200, minOrderQty: 10, category: 'ballast', specification: 'screened 3/4 inch' },
      { name: 'River sand', unit: 'tonne', unitPrice: 2100, stockQty: 150, minOrderQty: 5, category: 'sand', specification: 'river sand, unwashed' },
      { name: 'Binding wire (25kg roll)', unit: 'roll', unitPrice: 4600, stockQty: 30, minOrderQty: 2, category: 'steel', specification: 'annealed tie wire, 25kg roll' },
      { name: 'Roofing sheet — box profile 30G (2m)', unit: 'sheet', unitPrice: 1220, stockQty: 240, minOrderQty: 20, category: 'roofing', brand: 'Mabati Rolling Mills', specification: 'box profile 30G, 2m, pre-painted' },
      { name: 'Undercoat paint 20L', unit: 'tin', unitPrice: 8900, stockQty: 40, minOrderQty: 2, category: 'paint', brand: 'Duracoat', specification: 'alkyd primer, exterior' },
      { name: 'Waterproofing compound 20L', unit: 'tin', unitPrice: 6500, stockQty: 30, minOrderQty: 2, category: 'finishes', specification: 'acrylic waterproofing slurry' },
    ]],
    [karenTimber.id, [
      { name: 'Cement 50kg (32.5N)', unit: 'bag', unitPrice: 745, stockQty: 450, minOrderQty: 20, category: 'cement', brand: 'Simba', specification: '32.5N 50kg bag' },
      { name: 'Steel bar Y12 (12m length)', unit: 'length', unitPrice: 9950, stockQty: 120, minOrderQty: 5, category: 'steel', brand: 'Doshi', specification: 'Y12 deformed bar, 12m' },
      { name: 'Ballast (screened)', unit: 'tonne', unitPrice: 1850, stockQty: 40, minOrderQty: 5, category: 'ballast', specification: 'screened 3/4 inch' },
      { name: 'River sand', unit: 'tonne', unitPrice: 2250, stockQty: 25, minOrderQty: 5, category: 'sand', specification: 'river sand, unwashed' },
      { name: 'Binding wire (25kg roll)', unit: 'roll', unitPrice: 5150, stockQty: 20, minOrderQty: 2, category: 'steel', specification: 'annealed tie wire, 25kg roll' },
      { name: 'Roofing sheet — box profile 30G (2m)', unit: 'sheet', unitPrice: 1080, stockQty: 180, minOrderQty: 10, category: 'roofing', brand: 'Mabati Rolling Mills', specification: 'box profile 30G, 2m, pre-painted' },
      { name: 'Steel bar D8 (12m length)', unit: 'length', unitPrice: 3050, stockQty: 90, minOrderQty: 5, category: 'steel', brand: 'Doshi', specification: 'D8 deformed bar, 12m' },
      { name: 'Timber — cypress 2"×4" (4.8m)', unit: 'piece', unitPrice: 320, stockQty: 600, minOrderQty: 50, category: 'timber', specification: 'sawn cypress 50×100mm × 4.8m' },
      { name: 'Plywood sheet 18mm (8ft × 4ft)', unit: 'sheet', unitPrice: 3900, stockQty: 120, minOrderQty: 5, category: 'timber', specification: 'BWP 18mm shuttering ply' },
    ]],
  ]
  let catalogCount = 0
  for (const [supplierId, items] of catalogs) {
    await db.catalogItem.createMany({
      data: items.map(({ name, unit, unitPrice, stockQty, minOrderQty, category, brand, specification }) => ({
        supplierId, name, unit, unitPrice, stockQty, minOrderQty, category, brand: brand ?? null, specification: specification ?? null,
      })),
    })
    catalogCount += items.length
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
  await db.materialRequestLine.createMany({
    data: [
      { requestId: mr1042.id, materialName: 'Cement 50kg (32.5N)', unit: 'bag', qty: 50 },
      { requestId: mr1042.id, materialName: 'Steel bar Y12 (12m length)', unit: 'length', qty: 10 },
    ],
  })

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

  // MR-1045 — client-band request (est ~KSh 121k → client decides; logged-in
  // client-role sessions get the Decide buttons via request.decide)
  const mr1045 = await db.materialRequest.create({
    data: {
      projectId: p1.id,
      requestCode: 'MR-1045',
      requestedByRole: 'supervisor',
      requestedByName: 'Mwangi Kariuki (Foreman)',
      notes: 'Roofing + floor finishes package — needs the client decision (over the KSh 50k band).',
      status: 'submitted',
      createdAt: daysAgo(1, 11),
    },
  })
  await db.materialRequestLine.createMany({
    data: [
      { requestId: mr1045.id, materialName: 'Roofing sheet — box profile 30G (2m)', unit: 'sheet', qty: 60 },
      { requestId: mr1045.id, materialName: 'Ceramic floor tiles 600×600mm (m²)', unit: 'm²', qty: 40 },
    ],
  })
  await db.approval.create({
    data: {
      projectId: p1.id,
      entityType: 'material_request',
      entityId: mr1045.id,
      approverRole: 'client',
      approverName: 'Amina (Client)',
      decision: 'pending',
      createdAt: daysAgo(1, 11, 30),
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
  // Karen Timber's quote is the multi-line demo: per-line prices (§32) +
  // validity window + terms.
  const karenQuote = await db.quote.create({
    data: {
      requestId: mr1042.id,
      supplierId: karenTimber.id,
      unitPrice: 745,
      deliveryFee: 1800,
      transportFee: 0,
      fees: 250, // offloading fee
      totalLanded: 138800, // 50×745 + 10×9950 + 1800 + 250
      deliveryEta: 'same day',
      validUntil: daysAhead(21, 17),
      terms: '50% on delivery, 50% after 14 days · prices hold 21 days',
      stockOk: true,
      status: 'received',
      createdAt: daysAgo(13, 10),
    },
  })
  await db.quoteLine.createMany({
    data: [
      { quoteId: karenQuote.id, name: 'Cement 50kg (32.5N)', unit: 'bag', qty: 50, unitPrice: 745, lineTotal: 37250 },
      { quoteId: karenQuote.id, name: 'Steel bar Y12 (12m length)', unit: 'length', qty: 10, unitPrice: 9950, lineTotal: 99500 },
    ],
  })
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
        validUntil: daysAhead(14, 17),
        terms: 'Payment on delivery · 14-day validity',
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
        validUntil: daysAgo(1, 17), // EXPIRED — demo of the greyed/expired row (§32)
        stockOk: true,
        status: 'received',
        createdAt: daysAgo(13, 12),
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
      { deliveryId: delivery9.id, orderLineId: po9Cement.id, qtyOrdered: 50, qtyReceived: 48, qtyRejected: 0, condition: 'ok' },
      { deliveryId: delivery9.id, orderLineId: po9Ballast.id, qtyOrdered: 10, qtyReceived: 10, qtyRejected: 0, condition: 'ok' },
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

  // ---------------- BOQs (spec §28) ----------------
  const boqV1 = await db.boq.create({
    data: {
      projectId: p1.id,
      name: 'Nyumba Yangu — QS estimate v1',
      version: 1,
      status: 'approved',
      createdAt: daysAgo(20, 10),
    },
  })
  await db.boqLine.createMany({
    data: [
      { boqId: boqV1.id, materialName: 'Cement 50kg (32.5N)', unit: 'bag', qty: 200, estUnitPrice: 760, category: 'structural' },
      { boqId: boqV1.id, materialName: 'Ballast (screened)', unit: 'tonne', qty: 30, estUnitPrice: 1800, category: 'structural' },
      { boqId: boqV1.id, materialName: 'River sand', unit: 'tonne', qty: 20, estUnitPrice: 2200, category: 'structural' },
      { boqId: boqV1.id, materialName: 'Steel bar Y12 (12m length)', unit: 'length', qty: 30, estUnitPrice: 9800, category: 'structural' },
      { boqId: boqV1.id, materialName: 'Machine-cut stones (9")', unit: 'piece', qty: 3000, estUnitPrice: 55, category: 'walling' },
      { boqId: boqV1.id, materialName: 'Roofing sheet — box profile 30G (2m)', unit: 'sheet', qty: 60, estUnitPrice: 1050, category: 'roofing' },
      { boqId: boqV1.id, materialName: 'Ceramic floor tiles 600×600mm (m²)', unit: 'm²', qty: 45, estUnitPrice: 1350, category: 'finishes' },
    ],
  })
  const boqV2 = await db.boq.create({
    data: {
      projectId: p1.id,
      name: 'Nyumba Yangu — interior finishes draft',
      version: 2,
      status: 'draft',
      createdAt: daysAgo(2, 14),
    },
  })
  await db.boqLine.createMany({
    data: [
      { boqId: boqV2.id, materialName: 'Gloss paint 4L — white', unit: 'tin', qty: 6, estUnitPrice: 3200, category: 'finishes' },
      { boqId: boqV2.id, materialName: 'Undercoat paint 20L', unit: 'tin', qty: 2, estUnitPrice: 8900, category: 'finishes' },
      { boqId: boqV2.id, materialName: 'Ceramic wall tiles 300×600mm (m²)', unit: 'm²', qty: 18, estUnitPrice: 1150, category: 'finishes' },
    ],
  })

  // ---------------- saved supplier shortlist (spec §30) ----------------
  await db.savedSupplier.create({
    data: {
      projectId: p1.id,
      supplierId: kiambuRoad.id,
      savedBy: 'Site Manager',
      note: 'Best landed cost on MR-1042 — first call for structural loads.',
      createdAt: daysAgo(5, 16),
    },
  })

  // ---------------- Site Store inventory history (spec §33/§35) ----------------
  // Lookup suppliers + PO references by name — never hardcoded ids.
  const kiambu = await db.supplier.findFirst({ where: { businessName: { contains: 'Kiambu Road' } } })
  const nairobi = await db.supplier.findFirst({ where: { businessName: { contains: 'Nairobi Hardware' } } })
  const po9Ref = await db.purchaseOrder.findFirst({ where: { orderCode: 'PO-2026-000009' } })
  const foreman = 'Mwangi Kariuki (Foreman)'
  const storekeeper = 'Joseph Mwenda (Storekeeper)'

  async function item(materialName: string, unit: string, supplierId: string | null, location = 'Site Store') {
    return db.inventoryItem.create({
      data: { projectId: project.id, materialName, unit, location, supplierId },
    })
  }
  async function move(
    inventoryItemId: string,
    type: string,
    quantity: number,
    when: Date,
    recordedBy: string,
    unitCost: number | null = null,
    reference: string | null = null,
    note: string | null = null,
  ) {
    await db.stockMovement.create({
      data: { projectId: project.id, inventoryItemId, type, quantity, unitCost, reference, note, recordedBy, createdAt: when },
    })
  }

  // Cement — opening + received (48 of 50, PO-2026-000009) + damaged (4 bags
  // set by rain) + consumed + transfer to the Slab store
  const cement = await item('Cement 50kg (32.5N)', 'bag', nairobi?.id ?? null)
  await move(cement.id, 'opening', 20, daysAgo(12, 8), foreman, 760, null, 'Opening count at handover')
  await move(cement.id, 'received', 48, daysAgo(8, 14), foreman, 795, po9Ref?.orderCode ?? 'PO-2026-000009', '48 of 50 — 2 missing, flagged for review')
  await move(cement.id, 'damaged', 4, daysAgo(6, 9), storekeeper, null, po9Ref?.orderCode ?? 'PO-2026-000009', '4 bags set by rain')
  await move(cement.id, 'consumed', 15, daysAgo(4, 17), foreman, null, null, 'Foundation mortar, courses 1-8')
  await move(cement.id, 'transferred_out', 10, daysAgo(4, 17, 30), storekeeper, null, null, '→ Slab store: ring beam pour staging')
  const cementSlab = await item('Cement 50kg (32.5N)', 'bag', nairobi?.id ?? null, 'Slab store')
  await move(cementSlab.id, 'transferred_in', 10, daysAgo(4, 17, 30), storekeeper, null, null, '← Site Store')

  // Ballast — opening + received (PO-2026-000009) + consumed
  const ballast = await item('Ballast (screened)', 'tonne', nairobi?.id ?? null)
  await move(ballast.id, 'opening', 5, daysAgo(12, 8), foreman, 1800, null, 'Blinding stock from the access road works')
  await move(ballast.id, 'received', 10, daysAgo(8, 14), foreman, 1950, po9Ref?.orderCode ?? 'PO-2026-000009', 'Delivered in full')
  await move(ballast.id, 'consumed', 8, daysAgo(3, 16), foreman, null, null, 'Slab hardcore backfill')

  // River sand — opening + consumed (now LOW: 1 of 3 left)
  const sand = await item('River sand', 'tonne', kiambu?.id ?? null)
  await move(sand.id, 'opening', 3, daysAgo(12, 8), foreman, 2200, null, null)
  await move(sand.id, 'consumed', 2, daysAgo(5, 11), foreman, null, null, 'Screed batch A')

  // Steel — opening + consumed
  const steel = await item('Steel bar Y12 (12m length)', 'length', kiambu?.id ?? null)
  await move(steel.id, 'opening', 12, daysAgo(11, 9), foreman, 9800, null, 'Delivered with the starter pack')
  await move(steel.id, 'consumed', 6, daysAgo(2, 15), foreman, null, null, 'Column starters + lintel cage')

  // Standalone re-run: rebuild the invoices that reference these fresh POs
  if (opts.reseedInvoices) {
    await seedInvoices(db)
  }

  const counts = {
    suppliers: 4,
    catalogItems: catalogCount,
    requests: 4,
    quotes: 5,
    orders: 2,
    boqs: 2,
    inventoryItems: 5,
    movements: 13,
  }
  console.log(
    `seedSupply: ${counts.suppliers} suppliers, ${counts.catalogItems} catalog items (§29 metadata), 5 approval rules, ` +
      `${counts.requests} requests (incl. client-band MR-1045), ${counts.quotes} quotes (1 multi-line w/ validity+terms, 1 expired), ` +
      `${counts.orders} POs (1 delivering, 1 delivered w/ discrepancy), ${counts.boqs} BOQs (1 approved, 1 draft), ` +
      `1 saved supplier, ${counts.inventoryItems} stock lines / ${counts.movements} movements${opts.reseedInvoices ? ', invoices reseeded' : ''}`,
  )
}

// Standalone runner (Bun): `bun prisma/seed-extras/supply.ts`
// reseedInvoices: invoices hang off the fresh POs — rebuild them so any extras
// order (invoices before or after supply) ends consistent.
if ((import.meta as { main?: boolean }).main === true) {
  seedSupply(db, { reseedInvoices: true })
    .catch((e) => { console.error(e); process.exit(1) })
    .finally(() => db.$disconnect())
}
