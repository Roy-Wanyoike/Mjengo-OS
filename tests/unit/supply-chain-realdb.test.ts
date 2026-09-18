/**
 * THE supply-chain walk against a REAL SQLite database (issue #184 / audit
 * register TEST-6) — RFQ → quote → PO → delivery WITH DISCREPANCY → invoice
 * → 3-way verdict → ledger posting, end to end through the REAL services on
 * the REAL engine.
 *
 * Before this file, NO single test walked the chain: the stub suites prove
 * each module's logic in isolation (three-way.test.ts pins the pure matcher;
 * v1-supply.test.ts the route contracts) and db-integrity-constraints.test.ts
 * pins the raw constraints — but the seams BETWEEN them (the FK graph
 * Quote→PurchaseOrder→OrderDelivery→OrderDeliveryLine→StockMovement, the
 * status ladders, the money hand-off into the ledger at invoice payment) only
 * exist against a real database with the real migration history applied.
 *
 * The walk (one project, one supplier, one bag of cement short):
 *   request → submit (approval engine, client rung) → approve → quote
 *   requested → quote received → PO created (born approved, catalog-priced,
 *   PO-YYYY-000001) → sent → confirmed → dispatched → RECEIVED SHORT + a
 *   damaged line (45 of 50 arrived, 2 rejected: discrepancy status, honest
 *   notifications, net-43 stock movement, catalog stock clamp) → invoice for
 *   the full 50 → client approves → threeWayCheck flags the gap → payInvoice
 *   REFUSES without acknowledgement → escrow funded → payInvoice with
 *   acknowledgeMismatch posts the balanced ledger entry (ESCROW → EXPENSE),
 *   flips the invoice paid, decrements the escrow projection.
 *
 * Then the cross-cutting invariants that only make sense over the whole
 * chain: every posted ledger transaction is balanced, the escrow projection
 * equals the derived ESCROW truth, the PO/invoice business codes are unique
 * per project at the DB level, one delivery per PO, over-delivery refused
 * at receive, and closing stock equals the movement equation.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

import { disposeRealDb, getRealTestDb, seedProject } from '../helpers/db'
import {
  confirmOrder,
  createOrder,
  createRequest,
  decideApproval,
  dispatchOrder,
  receiveDelivery,
  receiveQuote,
  requestQuotes,
  sendOrder,
  submitRequest,
  upsertCatalogItem,
  upsertSupplier,
} from '@/backend/modules/supply/service'
import {
  createInvoice,
  decideInvoice,
  payInvoice,
  submitInvoice,
  threeWayCheck,
} from '@/backend/modules/invoices/service'
import { derivedBalance } from '@/backend/modules/ledger/service'
import { postEscrowTopup } from '@/backend/modules/wallet/service'
import { loadInventorySlice } from '@/backend/modules/inventory/repository'

const { prisma, sqlite } = getRealTestDb()
afterAll(disposeRealDb)

const count = (table: string): number => Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: bigint }).n)

describe('TEST-6: the full procurement walk on a real database', () => {
  it('RFQ → quote → PO → short delivery → invoice → 3-way verdict → ledger posting, all real', async () => {
    // ------------------------------------------------------ ground truth seeds
    const project = await seedProject(prisma, { name: 'TEST-6 Walk', client: 'Amina Hassan' })
    const supplier = await upsertSupplier(project.id, {
      businessName: 'Test-6 Cement Works',
      county: 'Nairobi',
      town: 'Industrial Area',
      deliveryFeeBase: 1500, // KSh — rides every PO (no free-delivery threshold)
      reliabilityScore: 88,
      responseHours: 6,
    })
    const catalog = await upsertCatalogItem(project.id, {
      supplierId: supplier.id,
      name: 'Cement',
      unit: 'bag',
      unitPrice: 750, // KSh per bag
      stockQty: 100,
      minOrderQty: 10,
    })

    // ------------------------------------------------------------ 1. the RFQ
    const request = await createRequest(project.id, {
      lines: [{ materialName: 'Cement', unit: 'bag', qty: 50 }],
      notes: 'Foundation pour',
    })
    expect(request.requestCode).toMatch(/^MR-\d+$/)
    expect((await prisma.materialRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('draft')

    // --------------------------------------------------- 2. submit → approval
    const submitted = await submitRequest(project.id, { id: request.id })
    // No approval rules seeded → the conservative client default holds the
    // request; the pending Approval row is real.
    expect(submitted.status).toBe('submitted')
    expect(submitted.chain).toEqual(['client'])
    expect(submitted.autoApproved).toBeUndefined()
    const pendingApproval = await prisma.approval.findFirstOrThrow({
      where: { entityId: request.id, entityType: 'request', decision: 'pending' },
    })
    expect(pendingApproval.approverRole).toBe('client')

    // -------------------------------------------------------- 3. client decides
    // Sessionless actor resolves to the client role — the site team raised it.
    const decided = await decideApproval(project.id, { id: request.id, decision: 'approve', note: 'proceed' })
    expect(decided.status).toBe('approved')
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: pendingApproval.id } })).decision).toBe('approved')

    // ------------------------------------------------------------ 4. the quote
    const quoted = await requestQuotes(project.id, { requestId: request.id, supplierIds: [supplier.id] })
    expect(quoted.created).toBe(1)
    const quote = await prisma.quote.findFirstOrThrow({ where: { requestId: request.id } })
    expect(quote.status).toBe('requested')
    const received = await receiveQuote(project.id, {
      id: quote.id,
      unitPrice: 750,
      deliveryFee: 1500,
      deliveryEta: 'next_day',
    })
    // 50 × KSh 750 + KSh 1,500 delivery = KSh 39,000 landed.
    expect(received.totalLanded).toBe(39_000)

    // ------------------------------------------------------ 5. the PO (born approved)
    const order = await createOrder(project.id, {
      requestId: request.id,
      supplierId: supplier.id,
      quoteId: quote.id,
      paymentSource: 'client',
    })
    const year = new Date().getFullYear()
    expect(order.orderCode).toBe(`PO-${year}-000001`)
    expect(order.subtotal).toBe(37_500) // 50 bags × KSh 750
    expect(order.total).toBe(39_000) // + KSh 1,500 delivery
    const poRow = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true } })
    expect(poRow.status).toBe('approved') // the request's approval counts (§12)
    expect(poRow.requestId).toBe(request.id)
    expect(poRow.lines).toHaveLength(1)
    expect(poRow.lines[0].unitPrice).toBe(750_00n) // cents
    // The request is now converted — it cannot be re-ordered.
    expect((await prisma.materialRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('converted')

    // --------------------------------------------------- 6. send → confirm → dispatch
    expect((await sendOrder(project.id, { id: order.id })).status).toBe('sent')
    expect((await confirmOrder(project.id, { id: order.id })).status).toBe('confirmed')
    const dispatch = await dispatchOrder(project.id, { orderId: order.id })
    expect(dispatch.status).toBe('delivering')
    const delivery = await prisma.orderDelivery.findUniqueOrThrow({ where: { id: dispatch.deliveryId } })
    expect(delivery.status).toBe('dispatched')

    // ------------------------------- 7. receive SHORT with a damaged line: 45 of 50, 2 rejected
    const received45 = await receiveDelivery(project.id, {
      deliveryId: delivery.id,
      lines: [
        {
          orderLineId: poRow.lines[0].id,
          qtyReceived: 45,
          qtyRejected: 2,
          condition: 'damaged',
          damageNote: 'torn bags, hardened cement',
        },
      ],
      gpsLat: -1.2921,
      gpsLng: 36.8219,
      note: 'Counted at the gate with the foreman',
    })
    // The discrepancy flag rides the delivery; the order still completes.
    expect(received45.status).toBe('discrepancy')
    expect(received45.shortLines).toBe(1)
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('delivered')

    // Physical truth rows: net 43 into the Site Store + 2 damaged.
    const deliveryLine = await prisma.orderDeliveryLine.findFirstOrThrow({ where: { deliveryId: delivery.id } })
    expect(deliveryLine.qtyOrdered).toBe(50)
    expect(deliveryLine.qtyReceived).toBe(45)
    expect(deliveryLine.qtyRejected).toBe(2)
    const movements = await prisma.stockMovement.findMany({ where: { reference: order.orderCode } })
    expect(movements.map((m) => m.type).sort()).toEqual(['damaged', 'received'])
    expect(movements.find((m) => m.type === 'received')?.quantity).toBe(43)
    expect(movements.find((m) => m.type === 'damaged')?.quantity).toBe(2)
    // #282 — the movement carries the PO line's integer CENTS (75,000n =
    // KSh 750): the money stays in cents from catalog → PO → movement; the
    // old writer stored centsToKes(75_000n) = 750 into the BigInt cents
    // column, understating stockValue ÷100 on every read.
    expect(movements.find((m) => m.type === 'received')?.unitCost).toBe(75_000n)
    expect(movements.find((m) => m.type === 'damaged')?.unitCost).toBeNull()
    // The supplier's catalog stock was clamped by the ORDERED quantity.
    expect((await prisma.catalogItem.findUniqueOrThrow({ where: { id: catalog.id } })).stockQty).toBe(50)

    // The discrepancy is flagged to both audiences — real Notification rows.
    const flagged = await prisma.notification.findMany({ where: { projectId: project.id, kind: 'delivery.discrepancy' } })
    expect(flagged.map((n) => n.audienceRole).sort()).toEqual(['client', 'contractor'])

    // ---------------------------------------------------------- 8. the invoice (full 50)
    const invoice = await createInvoice(project.id, {
      orderId: order.id,
      lines: [{ name: 'Cement', qty: 50, unitPrice: 750 }],
      note: 'as per PO',
    })
    expect(invoice.invoiceCode).toMatch(/^INV-\d{4}-\d{6}$/)
    expect(invoice.total).toBe(37_500) // the supplier bills the FULL 50
    expect((await submitInvoice(project.id, { id: invoice.id })).status).toBe('submitted')
    expect((await decideInvoice(project.id, { id: invoice.id, decision: 'approve', note: 'approved' })).status).toBe('approved')

    // ------------------------------------------------- 9. the 3-way verdict (TEST-6)
    const report = await threeWayCheck(project.id, { id: invoice.id })
    expect(report.mode).toBe('three-way')
    expect(report.hasOrder).toBe(true)
    expect(report.hasDelivery).toBe(true)
    expect(report.lines[0]).toMatchObject({ poQty: 50, invQty: 50, deliveredQty: 45 })
    const short = report.mismatches.find((m) => m.issue.includes('short'))
    expect(short).toBeDefined()
    expect(short!.issue).toContain('5 short')

    // ---------------------------------------- 10. payment refuses without acknowledgement
    await expect(
      payInvoice(project.id, { id: invoice.id, method: 'wallet', by: 'Amina Hassan' }),
    ).rejects.toThrow(/3-way match shows 1 open item\(s\).*acknowledgeMismatch/s)
    // Refused payment moved nothing.
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe('approved')
    expect(await prisma.transaction.findMany({ where: { projectId: project.id } })).toHaveLength(0)

    // ------------------------------------------------- 11. fund escrow, then pay WITH acknowledgement
    const topUp = await postEscrowTopup(project.id, 4_000_000n, 'Amina Hassan', { reference: 'TOP-TEST6', role: 'client' }) // KSh 40,000.00
    expect(topUp.balance).toBe(4_000_000n)
    expect(await derivedBalance(`ESCROW:${project.id}`)).toBe(4_000_000n)

    const paid = await payInvoice(project.id, {
      id: invoice.id,
      method: 'wallet',
      by: 'Amina Hassan',
      acknowledgeMismatch: true,
    })
    expect(paid.status).toBe('paid')
    expect(paid.balance).toBe(2500) // KSh 2,500.00 left in escrow (40,000 − 37,500)

    // The money rows: invoice paid, ONE Transaction row, escrow projection down.
    const invoiceRow = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(invoiceRow.status).toBe('paid')
    expect(invoiceRow.paymentMethod).toBe('wallet')
    const txnRows = await prisma.transaction.findMany({ where: { projectId: project.id } })
    expect(txnRows).toHaveLength(1)
    expect(txnRows[0].type).toBe('invoice')
    expect(txnRows[0].amount).toBe(3_750_000n)
    expect(txnRows[0].ledgerTxnId).toBeTruthy()
    const projection = await prisma.escrowWallet.findUniqueOrThrow({ where: { projectId: project.id } })
    expect(projection.balance).toBe(250_000n)
    expect(await derivedBalance(`ESCROW:${project.id}`)).toBe(250_000n) // projection === derived truth
    // NOTE (documented posting convention, pinned as-is): the escrow path
    // posts "debit ESCROW / credit EXPENSE" (spendEscrowInTx docstring) — the
    // MIRROR of the external-rail path's "debit EXPENSE / credit CASH". An
    // expense account is debit-normal, so this walk's escrow-funded payment
    // leaves EXPENSE:<projectId> at credit − debit = −3,750,000n. Pinned
    // honestly rather than "fixed" here — flipping a documented posting pair
    // is a money-semantics decision for the maintainers, not test infra.
    expect(await derivedBalance(`EXPENSE:${project.id}`)).toBe(-3_750_000n)

    // The acknowledged discrepancy left its Approval-trail row.
    const ackRow = await prisma.approval.findFirstOrThrow({
      where: { entityType: 'invoice', entityId: invoice.id, decision: 'approved', note: { contains: 'open 3-way item' } },
    })
    expect(ackRow.approverName).toBe('Amina Hassan')

    // The ledger transaction behind the payment is posted and balanced.
    const ledgerTxn = await prisma.ledgerTransaction.findUniqueOrThrow({
      where: { id: txnRows[0].ledgerTxnId! },
      include: { entries: true },
    })
    expect(ledgerTxn.status).toBe('posted')
    expect(ledgerTxn.idempotencyKey).toBe(`invoice.pay:${invoice.id}`)
    const debit = ledgerTxn.entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0n)
    const credit = ledgerTxn.entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0n)
    expect(debit).toBe(credit)
    expect(debit).toBe(3_750_000n)

    // ------------------------------------------------ cross-cutting walk invariants
    // Every posted ledger transaction in the whole walk is balanced (the
    // migration-14 gate held for every writer).
    const unbalanced = sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM LedgerTransaction t
         WHERE t.status IN ('posted', 'reversed')
           AND (SELECT COALESCE(SUM(CASE WHEN side = 'debit' THEN amount END), 0) FROM LedgerEntry e WHERE e.txnId = t.id)
             != (SELECT COALESCE(SUM(CASE WHEN side = 'credit' THEN amount END), 0) FROM LedgerEntry e WHERE e.txnId = t.id)`,
      )
      .get() as { n: bigint }
    expect(Number(unbalanced.n)).toBe(0)

    // Closing stock obeys the inventory equation over the REAL movement log:
    // 43 received − 2 damaged = 41 net in the Site Store.
    const slice = await loadInventorySlice(project.id)
    expect(slice.items).toHaveLength(1)
    expect(slice.items[0].materialName).toBe('Cement')
    expect(slice.items[0].closingQty).toBe(41)
    expect(slice.items[0].receivedQty).toBe(43)
    expect(slice.items[0].damagedQty).toBe(2)
    // #282 end-to-end through the whole chain: catalog KSh 750 → PO cents
    // 75,000 → movement cents 75,000 → stockValue 41 × KSh 750 = KSh 30,750,
    // with movement rows reading back as KSh at the DTO boundary.
    expect(slice.items[0].stockValue).toBe(30_750)
    expect(slice.movements.find((m) => m.type === 'received')?.unitCost).toBe(750)
  })

  it('PO business codes are unique per project at the DB level (DB-8)', async () => {
    const project = await seedProject(prisma, { name: 'TEST-6 codes' })
    const supplier = await upsertSupplier(project.id, { businessName: 'Code Probe Supplies', county: 'Kiambu' })
    await upsertCatalogItem(project.id, { supplierId: supplier.id, name: 'Ballast', unit: 'tonne', unitPrice: 900, stockQty: 30 })
    const request = await createRequest(project.id, { lines: [{ materialName: 'Ballast', unit: 'tonne', qty: 5 }] })
    await submitRequest(project.id, { id: request.id })
    await decideApproval(project.id, { id: request.id, decision: 'approve' })
    const order = await createOrder(project.id, { requestId: request.id, supplierId: supplier.id })

    const poRow = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })
    await expect(
      prisma.purchaseOrder.create({
        data: {
          orderCode: poRow.orderCode, // same project, same code
          projectId: project.id,
          supplierId: supplier.id,
          subtotal: 1n,
          total: 1n,
          createdByRole: 'contractor',
        },
      }),
    ).rejects.toThrow(/Unique constraint failed/)
    // The same code in a DIFFERENT project is legal (per-project generators).
    const other = await seedProject(prisma, { name: 'TEST-6 codes B' })
    await expect(
      prisma.purchaseOrder.create({
        data: {
          orderCode: poRow.orderCode,
          projectId: other.id,
          supplierId: supplier.id,
          subtotal: 1n,
          total: 1n,
          createdByRole: 'contractor',
        },
      }),
    ).resolves.toBeTruthy()
  })

  it('guards: one delivery per PO; over-delivery refused at receive; a second receive refused', async () => {
    const project = await seedProject(prisma, { name: 'TEST-6 guards' })
    const supplier = await upsertSupplier(project.id, { businessName: 'Guard Supplies', county: 'Machakos' })
    await upsertCatalogItem(project.id, { supplierId: supplier.id, name: 'Sand', unit: 'tonne', unitPrice: 1200, stockQty: 40 })
    const request = await createRequest(project.id, { lines: [{ materialName: 'Sand', unit: 'tonne', qty: 10 }] })
    await submitRequest(project.id, { id: request.id })
    await decideApproval(project.id, { id: request.id, decision: 'approve' })
    const order = await createOrder(project.id, { requestId: request.id, supplierId: supplier.id })
    await sendOrder(project.id, { id: order.id })
    await confirmOrder(project.id, { id: order.id })
    const dispatch = await dispatchOrder(project.id, { orderId: order.id })

    // One delivery record per order — the second dispatch refuses (the order
    // is DELIVERING now, so the status guard fires first; the delivery-row
    // guard is the defense-in-depth behind it).
    await expect(dispatchOrder(project.id, { orderId: order.id })).rejects.toThrow(/Only SENT or CONFIRMED orders can be dispatched/)
    expect(await prisma.orderDelivery.findMany({ where: { orderId: order.id } })).toHaveLength(1)

    // Over-delivery (#201): what ARRIVED can never exceed what was ordered.
    const poRow = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true } })
    await expect(
      receiveDelivery(project.id, {
        deliveryId: dispatch.deliveryId,
        lines: [{ orderLineId: poRow.lines[0].id, qtyReceived: 11 }],
      }),
    ).rejects.toThrow(/over-delivery is not accepted at receive/)
    // The refusal wrote nothing — delivery still awaiting receive.
    expect((await prisma.orderDelivery.findUniqueOrThrow({ where: { id: dispatch.deliveryId } })).status).toBe('dispatched')
    expect(await prisma.stockMovement.findMany({ where: { projectId: project.id } })).toHaveLength(0)

    // A clean full receive then refuses a second receive (already RECEIVED).
    const ok = await receiveDelivery(project.id, {
      deliveryId: dispatch.deliveryId,
      lines: [{ orderLineId: poRow.lines[0].id, qtyReceived: 10 }],
    })
    expect(ok.status).toBe('received')
    await expect(
      receiveDelivery(project.id, {
        deliveryId: dispatch.deliveryId,
        lines: [{ orderLineId: poRow.lines[0].id, qtyReceived: 10 }],
      }),
    ).rejects.toThrow(/cannot be re-received/)
    // Net stock: 10 tonnes in, nothing damaged.
    const slice = await loadInventorySlice(project.id)
    expect(slice.items[0].closingQty).toBe(10)
    expect(count('OrderDelivery')).toBeGreaterThanOrEqual(2)
  })
})
