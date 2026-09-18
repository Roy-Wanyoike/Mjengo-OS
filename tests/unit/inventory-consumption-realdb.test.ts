/**
 * Consumption posting against a REAL SQLite database (issue #186 / audit
 * TEST-5, the consumption half) — the DB-semantics companion of
 * inventory-consumption.test.ts (stub suite, unchanged and still green).
 *
 * The `consumption.create` action is the Consumption model's ONLY writer,
 * and its rows feed the project payload's spend views (the materials rollup:
 * delivered − consumed = on-site, stock value) and the AI anomaly
 * reconciler. Pinned here against the real tables:
 *
 *  · POSTING — applyAction lands exactly one Consumption row (FK-joined to
 *    the Material catalog) plus the auto-logged AuditEvent (kind 'material');
 *  · VALIDATION — refused payloads leave zero rows AND zero audit entries;
 *  · FK HONESTY — an unknown materialId is rejected by the database (the
 *    applier has no material lookup — unlike delivery.create); an unknown
 *    project refuses before any write;
 *  · THE ROLLUP INVARIANT — deliveries received − consumption = on-site
 *    stock per material, cross-checked with independent raw-SQL SUMs, with
 *    stock value = on-site × unit price and the delivery-side auto-Transactions
 *    feeding summary.materialSpend/budgetSpent (a consumption row posts NO
 *    transaction — spend is delivery-side, draw-down is consumption-side);
 *  · OVER-CONSUMPTION HONESTY — the rollup CLAMPS on-site at zero (it is a
 *    log, not a guard) while the Site Store movement ledger REFUSES
 *    pre-write (its different, honest job) — both behaviors pinned side by
 *    side;
 *  · NON-INTERFERENCE — the two stock surfaces never write each other's
 *    tables: consumption.create appends no StockMovement and leaves derived
 *    closings untouched; inventory.consume appends no Consumption row;
 *  · APPEND-ONLY — an identical replay lands a second row (no fingerprint
 *    dedupe for append-only rows — the sync source pin in the stub suite);
 *  · PROJECT SCOPING — each project's rollup counts only its own
 *    consumptions and deliveries.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

import { disposeRealDb, getRealTestDb, seedProject } from '../helpers/db'
import { applyAction, getProjectPayload } from '@/backend/lib/mjengo'
import { consumeStock, openStock } from '@/backend/modules/inventory/service'
import { loadInventorySlice } from '@/backend/modules/inventory/repository'

const { prisma, sqlite } = getRealTestDb()
afterAll(disposeRealDb)

const count = (table: string, where = ''): number =>
  Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: bigint }).n)

/** Independent raw-SQL total of one material's consumption in one project. */
function rawConsumed(projectId: string, materialId: string): number {
  const row = sqlite
    .prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM Consumption WHERE projectId = ? AND materialId = ?')
    .get(projectId, materialId) as { q: number | bigint }
  return Number(row.q)
}

/** Independent raw-SQL total of one material's delivered quantity. */
function rawDelivered(projectId: string, materialId: string): number {
  const row = sqlite
    .prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM Delivery WHERE projectId = ? AND materialId = ?')
    .get(projectId, materialId) as { q: number | bigint }
  return Number(row.q)
}

/** One Material catalog row (the global catalog — unitPrice in cents). */
function seedMaterial(name: string, unitPriceCents = 75_000n): Promise<{ id: string; unitPrice: bigint }> {
  return prisma.material.create({ data: { name, unit: 'bag', unitPrice: unitPriceCents } })
}

describe('consumption.create — posting onto the real tables', () => {
  it('lands exactly one FK-joined Consumption row plus the auto-logged audit entry', async () => {
    const project = await seedProject(prisma, { name: 'Consumption Walk' })
    const material = await seedMaterial('Cement')

    const r = await applyAction(
      'consumption.create',
      { materialId: material.id, quantity: 30, phaseName: 'Foundation', note: 'blinding layer' },
      project.id,
    )
    expect(r.id).toBeTruthy()

    // The row, read back through Prisma with its material join.
    const row = await prisma.consumption.findFirstOrThrow({
      where: { projectId: project.id },
      include: { material: true },
    })
    expect(row.quantity).toBe(30)
    expect(row.phaseName).toBe('Foundation')
    expect(row.note).toBe('blinding layer')
    expect(row.materialId).toBe(material.id)
    expect(row.material.name).toBe('Cement')
    expect(row.date).toBeInstanceOf(Date)

    // …and through raw SQL (independent of Prisma's mapping).
    expect(count('Consumption', `WHERE projectId = '${project.id}'`)).toBe(1)
    expect(rawConsumed(project.id, material.id)).toBe(30)

    // The Bias-Free Ledger entry applyAction auto-writes.
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { projectId: project.id } })
    expect(audit.kind).toBe('material')
    expect(audit.summary).toBe(`Recorded consumption: 30× material ${material.id.slice(-6)}`)
    expect(audit.actor).toBe('Site Manager')
    expect(audit.role).toBe('contractor')
    expect(audit.meta).toContain('"type":"consumption.create"')
  })

  it('refused payloads leave zero rows and zero audit entries', async () => {
    const project = await seedProject(prisma, { name: 'Refusals' })
    const material = await seedMaterial('Ballast')
    const bad: Array<Record<string, unknown>> = [
      { quantity: 5 }, // materialId missing
      { materialId: '', quantity: 5 }, // materialId empty
      { materialId: material.id }, // quantity missing
      { materialId: material.id, quantity: 0 },
      { materialId: material.id, quantity: -3 },
      { materialId: material.id, quantity: '5' }, // string — offline JSON drift
    ]
    for (const payload of bad) {
      await expect(applyAction('consumption.create', payload, project.id)).rejects.toThrow(
        'materialId and positive quantity required',
      )
    }
    expect(count('Consumption', `WHERE projectId = '${project.id}'`)).toBe(0)
    expect(count('AuditEvent', `WHERE projectId = '${project.id}'`)).toBe(0)
  })

  it('rejects an unknown material through the database FK (the applier has no material lookup)', async () => {
    const project = await seedProject(prisma, { name: 'FK Honesty' })
    const consumptionsBefore = count('Consumption')
    // delivery.create guards at the applier ('Unknown material');
    // consumption.create does not — the FK is the guard, and it is real.
    await expect(
      applyAction('consumption.create', { materialId: 'mat-does-not-exist', quantity: 5 }, project.id),
    ).rejects.toThrow(/foreign key constraint/i)
    expect(count('Consumption', `WHERE projectId = '${project.id}'`)).toBe(0)

    // The constraint is enforced by the engine itself, not by Prisma courtesy.
    expect(() =>
      sqlite
        .prepare(`INSERT INTO Consumption (id, projectId, materialId, quantity, date, createdAt) VALUES ('c-bad', ?, 'mat-nope', 1, 0, 0)`)
        .run(project.id),
    ).toThrow(/FOREIGN KEY constraint failed/i)

    // An unknown project refuses before any write (resolveProjectId).
    await expect(
      applyAction('consumption.create', { materialId: 'whatever', quantity: 5 }, 'project-nope'),
    ).rejects.toThrow('Project not found')
    expect(count('Consumption')).toBe(consumptionsBefore) // nothing landed anywhere
  })

  it('THE HONEST GAP, real-engine half: NaN/Infinity pass the applier guard — the engine rejects them', async () => {
    // Pinned as observed (the stub suite pins the applier side: its guard is
    // `typeof number` + `<= 0`, so NaN/Infinity reach the write). The real
    // engine's serializer refuses both — nothing lands — so the DB layer is
    // the ONLY backstop today. Prisma's error text is honestly confusing
    // ("Argument `project` is missing" — the actual problem is the
    // non-finite quantity), so only the stable invocation preamble is
    // pinned. A future Number.isFinite guard in the applier fails the stub
    // pin on purpose — update BOTH files with the fix.
    const project = await seedProject(prisma, { name: 'Gap Probe' })
    const material = await seedMaterial('Sand')
    for (const qty of [NaN, Infinity]) {
      await expect(
        applyAction('consumption.create', { materialId: material.id, quantity: qty }, project.id),
      ).rejects.toThrow(/Invalid `db\.consumption\.create\(\)` invocation/)
    }
    expect(count('Consumption', `WHERE projectId = '${project.id}'`)).toBe(0)
  })
})

describe('the materials rollup invariant — received − consumed = on-site (per material)', () => {
  it('feeds the project payload: quantities, stock value and the delivery-side spend views', async () => {
    const project = await seedProject(prisma, { name: 'Rollup Walk' })
    const material = await seedMaterial('Cement Rollup', 75_000n) // KSh 750/bag

    // Two deliveries (no unitCost → the catalog price; each posts an
    // auto-Transaction of qty × price).
    await applyAction('delivery.create', { materialId: material.id, quantity: 100, supplier: 'Bamburi' }, project.id)
    await applyAction('delivery.create', { materialId: material.id, quantity: 50, supplier: 'Bamburi' }, project.id)
    // Two consumption draws.
    await applyAction('consumption.create', { materialId: material.id, quantity: 30, phaseName: 'Foundation' }, project.id)
    await applyAction('consumption.create', { materialId: material.id, quantity: 20 }, project.id)

    // Independent raw-SQL oracles.
    expect(rawDelivered(project.id, material.id)).toBe(150)
    expect(rawConsumed(project.id, material.id)).toBe(50)
    expect(count('"Transaction"', `WHERE projectId = '${project.id}' AND type = 'material'`)).toBe(2)

    const payload = await getProjectPayload(project.id)
    expect(payload).not.toBeNull()
    const m = payload!.materials.find((x) => x.id === material.id)!
    expect(m.deliveredQty).toBe(150)
    expect(m.consumedQty).toBe(50)
    // THE INVARIANT: received − consumed = on-site.
    expect(m.onSiteQty).toBe(m.deliveredQty - m.consumedQty)
    expect(m.onSiteQty).toBe(100)
    // Stock value = on-site × unit price (cents math surfaced as KSh).
    expect(m.unitPrice).toBe(750)
    expect(m.stockValue).toBe(75_000) // 100 bags × KSh 750
    expect(m.deliveredCost).toBe(112_500) // 150 × KSh 750

    // The consumptions slice carries the material join for the UI.
    expect(payload!.consumptions).toHaveLength(2)
    for (const c of payload!.consumptions) {
      expect(c.materialId).toBe(material.id)
      expect(c.materialName).toBe('Cement Rollup')
      expect(c.unit).toBe('bag')
    }

    // Spend views: the delivery-side auto-Transactions feed the summary; a
    // consumption row posts NO Transaction (draw-down is not spend).
    expect(payload!.summary.materialSpend).toBe(112_500)
    expect(payload!.summary.budgetSpent).toBe(112_500)
    expect(count('"Transaction"', `WHERE projectId = '${project.id}'`)).toBe(2)
  })

  it('over-consumption CLAMPS the rollup at zero while the movement ledger REFUSES pre-write', async () => {
    const project = await seedProject(prisma, { name: 'Clamp Walk' })
    const material = await seedMaterial('Nails Rollup', 5_000n) // KSh 50/kg
    await applyAction('delivery.create', { materialId: material.id, quantity: 10, supplier: 'Duka' }, project.id)

    // Draw 14 against 10 delivered: the rollup is a LOG, not a guard — the
    // row lands and the discrepancy stays visible to the anomaly reconciler.
    await applyAction('consumption.create', { materialId: material.id, quantity: 14 }, project.id)
    expect(count('Consumption', `WHERE projectId = '${project.id}'`)).toBe(1)

    const payload = await getProjectPayload(project.id)
    const m = payload!.materials.find((x) => x.id === material.id)!
    expect(m.consumedQty).toBe(14) // the over-draw is visible, not hidden
    expect(m.onSiteQty).toBe(0) // clamped — never a negative stock number
    expect(m.stockValue).toBe(0) // nothing on site → honest zero value

    // The Site Store movement ledger does the OTHER honest job: it refuses
    // the same over-draw BEFORE any row is written (DB-2, #119/#184).
    const opened = await openStock(project.id, { materialName: 'Nails Rollup', unit: 'kg', qty: 10 })
    await expect(
      consumeStock(project.id, { inventoryItemId: opened.inventoryItemId, qty: 14 }),
    ).rejects.toThrow('Cannot consume more than closing stock')
    const movementCount = count('StockMovement', `WHERE inventoryItemId = '${opened.inventoryItemId}'`)
    expect(movementCount).toBe(1) // only the opening row
    const slice = await loadInventorySlice(project.id)
    expect(slice.items.find((i) => i.id === opened.inventoryItemId)!.closingQty).toBe(10)
  })

  it('keeps each project\u2019s rollup to its own consumptions (cross-project isolation)', async () => {
    const projectA = await seedProject(prisma, { name: 'Isolation A' })
    const projectB = await seedProject(prisma, { name: 'Isolation B' })
    // ONE global catalog material serving both projects.
    const material = await seedMaterial('Shared Rebar', 12_000n)
    await applyAction('delivery.create', { materialId: material.id, quantity: 10, supplier: 'Tononoka' }, projectA.id)
    await applyAction('delivery.create', { materialId: material.id, quantity: 4, supplier: 'Tononoka' }, projectB.id)
    await applyAction('consumption.create', { materialId: material.id, quantity: 6 }, projectA.id)

    const a = (await getProjectPayload(projectA.id))!.materials.find((x) => x.id === material.id)!
    const b = (await getProjectPayload(projectB.id))!.materials.find((x) => x.id === material.id)!
    expect(a.consumedQty).toBe(6)
    expect(a.onSiteQty).toBe(4)
    expect(b.consumedQty).toBe(0) // B never sees A's draw
    expect(b.onSiteQty).toBe(4)
    expect(rawConsumed(projectA.id, material.id)).toBe(6)
    expect(rawConsumed(projectB.id, material.id)).toBe(0)
  })
})

describe('consumption ↔ stock movements — two ledgers, no cross-writes', () => {
  it('consumption.create appends no StockMovement and leaves derived closings untouched', async () => {
    const project = await seedProject(prisma, { name: 'Ledger A' })
    const material = await seedMaterial('Ledger Cement', 75_000n)
    await openStock(project.id, { materialName: 'Ledger Cement', unit: 'bag', qty: 40, location: 'Site Store' })
    const before = count('StockMovement')

    await applyAction('consumption.create', { materialId: material.id, quantity: 12 }, project.id)

    expect(count('StockMovement')).toBe(before) // the movement log is untouched
    const slice = await loadInventorySlice(project.id)
    const item = slice.items.find((i) => i.materialName === 'Ledger Cement')!
    expect(item.closingQty).toBe(40) // derived closing unchanged
    expect(item.consumedQty).toBe(0) // the movement ledger's own consumed sum
  })

  it('inventory.consume appends its movement but no Consumption row', async () => {
    const project = await seedProject(prisma, { name: 'Ledger B' })
    const material = await seedMaterial('Ledger Ballast', 3_000n)
    const before = count('Consumption')

    const opened = await openStock(project.id, { materialName: 'Ledger Ballast', unit: 'tonne', qty: 8 })
    const consumed = await consumeStock(project.id, { inventoryItemId: opened.inventoryItemId, qty: 3 })

    expect(consumed.closingQty).toBe(5)
    expect(count('Consumption')).toBe(before) // the materials rollup is untouched
    expect(count('StockMovement', `WHERE inventoryItemId = '${opened.inventoryItemId}'`)).toBe(2)
    // …and the rollup's material row still shows zero consumed for this
    // project (only the Site Store ledger moved).
    const payload = await getProjectPayload(project.id)
    const m = payload!.materials.find((x) => x.id === material.id)!
    expect(m.consumedQty).toBe(0)
    expect(m.deliveredQty).toBe(0)
  })

  it('an identical replay lands a second row (append-only — no fingerprint dedupe)', async () => {
    const project = await seedProject(prisma, { name: 'Replay' })
    const material = await seedMaterial('Rebar Replay', 12_000n)
    const payload = { materialId: material.id, quantity: 6, note: 'walling' }
    const a = await applyAction('consumption.create', payload, project.id)
    const b = await applyAction('consumption.create', payload, project.id)
    expect(a.id).not.toBe(b.id)
    expect(count('Consumption', `WHERE projectId = '${project.id}'`)).toBe(2)
    expect(rawConsumed(project.id, material.id)).toBe(12) // both legitimate entries count
  })
})
