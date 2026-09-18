// Inventory domain service (spec §33/§35) — F-PROCURE implements the real
// business rules. Signatures below are the contract the dispatcher expects:
// every function is atomic with its StockMovement append and returns a
// { inventoryItemId, movement, closingQty } result shape.
//
// DB-2 hardening: every write path runs in ONE db.$transaction (the wallet /
// ledger house pattern — guards INSIDE the transaction, not before it);
// consume/transfer project the closing balance from the movements that
// already exist BEFORE persisting, so over-consumption throws without
// leaving a row; transfers write their out+in legs as one atomic unit; and
// every result reports the REAL derived closingQty (return/damage/adjust
// used to hardcode 0).
//
// Input validation (#210): the movement ledger is the single source of truth
// for stock (nothing is stored), so a bad quantity poisons every derived
// number downstream with no error at write time. Every action therefore
// parses its qty through parseMovementQty at the top of its transaction —
// same fail-closed posture as receiveDelivery's moneyNumber checks: finite
// number, > 0 for the six unsigned types, finite non-zero for adjust (signed
// by design), inside sane bounds. unitCost (where accepted) is finite ≥ 0.

import { db } from '@/backend/lib/db'
import type { TxClient } from '@/backend/modules/ledger/service'
import { derivedClosingQty } from './repository'

export interface MovementResult {
  inventoryItemId: string
  materialName: string
  unit: string
  movementId: string
  type: string
  quantity: number
  closingQty: number
}

/** Sanity cap per movement (#210): finite ≠ sensible — a qty above this is a
 * unit mistake (grams vs bags), not stock. Generous enough for bulk sites. */
const MAX_MOVEMENT_QTY = 1_000_000_000

/**
 * Parse + validate a movement quantity at the service boundary (#210).
 * Numeric strings coerce (moneyNumber semantics — the offline outbox replays
 * JSON where qty is a number, but being strict about typeof would reject
 * honest replays); anything non-finite, non-positive (unsigned types), zero
 * (adjust), or absurd throws BEFORE any row is written.
 */
function parseMovementQty(action: string, raw: unknown, opts: { signed?: boolean } = {}): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new Error(`${action}: qty must be a finite number (got ${typeof raw === 'string' ? `"${raw}"` : String(raw)})`)
  }
  if (opts.signed) {
    if (n === 0) throw new Error(`${action}: qty cannot be zero — adjust up with a positive number, down with a negative one`)
  } else if (n <= 0) {
    throw new Error(`${action}: qty must be greater than zero`)
  }
  if (Math.abs(n) > MAX_MOVEMENT_QTY) {
    throw new Error(`${action}: qty ${n} exceeds the per-movement cap of ${MAX_MOVEMENT_QTY.toLocaleString('en-US')} — check the unit (bags, tonnes…), not the digits`)
  }
  return n
}

/**
 * Optional unit cost (#210): absent → null; present → finite and ≥ 0
 * (a cost is money, never negative — same rule as the supply service).
 */
function parseUnitCost(action: string, raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${action}: unitCost must be zero or more (got ${typeof raw === 'string' ? `"${raw}"` : String(raw)})`)
  }
  return n
}

async function upsertItem(
  tx: TxClient,
  projectId: string,
  materialName: string,
  unit: string,
  location: string,
  supplierId?: string | null,
) {
  return tx.inventoryItem.upsert({
    where: { projectId_materialName_location: { projectId, materialName, location } },
    update: { unit, supplierId: supplierId ?? undefined },
    create: { projectId, materialName, unit, location, supplierId: supplierId ?? null },
    include: { movements: true },
  })
}

async function appendMovement(
  tx: TxClient,
  projectId: string,
  inventoryItemId: string,
  type: string,
  quantity: number,
  unitCost: number | null,
  reference: string | null,
  note: string | null,
  recordedBy: string,
) {
  return tx.stockMovement.create({
    data: { projectId, inventoryItemId, type, quantity, unitCost, reference, note, recordedBy },
  })
}

/** Item scoped to the project, WITH its movement log, inside a transaction. */
async function findItem(tx: TxClient, projectId: string, inventoryItemId: string) {
  const item = await tx.inventoryItem.findFirst({ where: { id: inventoryItemId, projectId }, include: { movements: true } })
  if (!item) throw new Error('Inventory item not found')
  return item
}

export async function openStock(projectId: string, p: any): Promise<MovementResult> {
  return db.$transaction(async (tx) => {
    const qty = parseMovementQty('inventory.open', p.qty)
    const unitCost = parseUnitCost('inventory.open', p.unitCost)
    const item = await upsertItem(tx, projectId, String(p.materialName), String(p.unit), p.location ?? 'Site Store', p.supplierId ?? null)
    const movement = await appendMovement(tx, projectId, item.id, 'opening', qty, unitCost, null, p.note ?? null, p.recordedBy ?? 'Site Manager')
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
  })
}

export async function receiveStock(projectId: string, p: any): Promise<MovementResult> {
  return db.$transaction(async (tx) => {
    const qty = parseMovementQty('inventory.receive', p.qty)
    const unitCost = parseUnitCost('inventory.receive', p.unitCost)
    const item = await upsertItem(tx, projectId, String(p.materialName), String(p.unit), p.location ?? 'Site Store', p.supplierId ?? null)
    const movement = await appendMovement(tx, projectId, item.id, 'received', qty, unitCost, p.reference ?? null, p.note ?? null, p.recordedBy ?? 'Site Manager')
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
  })
}

export async function consumeStock(projectId: string, p: any): Promise<MovementResult> {
  return db.$transaction(async (tx) => {
    const qty = parseMovementQty('inventory.consume', p.qty)
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    // DB-2: project the closing balance from the movements that ALREADY exist
    // before touching the database — over-consumption must throw without
    // persisting a row (the old code appended first and only then checked).
    if (derivedClosingQty(item.movements) - qty < 0) {
      throw new Error('Cannot consume more than closing stock')
    }
    const movement = await appendMovement(tx, projectId, item.id, 'consumed', qty, null, p.reference ?? null, p.note ?? null, p.recordedBy ?? 'Site Manager')
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
  })
}

export async function transferStock(projectId: string, p: any): Promise<any> {
  // DB-2: the out and in legs are ONE atomic unit — the old code wrote them
  // back-to-back with no transaction, so a failure between them stranded the
  // "out" half and silently lost stock. The out leg is guarded by the same
  // negative-stock projection as consume.
  return db.$transaction(async (tx) => {
    const qty = parseMovementQty('inventory.transfer', p.qty)
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    if (derivedClosingQty(item.movements) - qty < 0) {
      throw new Error('Cannot transfer more than closing stock')
    }
    const out = await appendMovement(tx, projectId, item.id, 'transferred_out', qty, null, null, `→ ${p.toLocation}: ${p.note ?? ''}`, p.recordedBy ?? 'Site Manager')
    const to = await upsertItem(tx, projectId, item.materialName, item.unit, String(p.toLocation), item.supplierId)
    const into = await appendMovement(tx, projectId, to.id, 'transferred_in', qty, null, null, `← ${item.location}`, p.recordedBy ?? 'Site Manager')
    return { from: { inventoryItemId: item.id, movementId: out.id }, to: { inventoryItemId: to.id, movementId: into.id } }
  })
}

export async function returnStock(projectId: string, p: any): Promise<MovementResult> {
  return db.$transaction(async (tx) => {
    const qty = parseMovementQty('inventory.return', p.qty)
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    const movement = await appendMovement(tx, projectId, item.id, 'returned', qty, null, null, p.note ?? null, p.recordedBy ?? 'Site Manager')
    // DB-2: real derived closing — this path used to hardcode closingQty: 0.
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
  })
}

export async function damageStock(projectId: string, p: any): Promise<MovementResult> {
  return db.$transaction(async (tx) => {
    const qty = parseMovementQty('inventory.damage', p.qty)
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    const movement = await appendMovement(tx, projectId, item.id, 'damaged', qty, null, null, String(p.damageNote ?? 'damaged'), p.recordedBy ?? 'Site Manager')
    // DB-2: real derived closing — this path used to hardcode closingQty: 0.
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
  })
}

export async function adjustStock(projectId: string, p: any): Promise<MovementResult> {
  return db.$transaction(async (tx) => {
    // Signed by design: negative adjusts down, positive adjusts up — zero is
    // a no-op that would only pollute the ledger.
    const qty = parseMovementQty('inventory.adjust', p.qty, { signed: true })
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    const movement = await appendMovement(tx, projectId, item.id, 'adjusted', qty, null, null, String(p.reason ?? 'count correction'), p.recordedBy ?? 'Site Manager')
    // DB-2: real derived closing — this path used to hardcode closingQty: 0.
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
  })
}

// ---- Stock reconciliation (issue #194) ---------------------------------------
// The count → variance → count-linked adjustment loop. Design invariants:
//
//   · EXPECTED IS A SNAPSHOT. expectedQty is the derived closing AS OF the
//     count's countedAt (movements with createdAt ≤ countedAt). A count
//     recorded offline and flushed hours later still snapshots the world the
//     site actually saw when the bags were counted — movements logged in
//     between are excluded.
//   · VARIANCE HAS ONE DEFINITION. variance = expected − counted (>0: the
//     book overstates physical stock). It is computed on read
//     (repository.countVariance), never stored — the same discipline as
//     movementDelta.
//   · THE LEDGER NEVER EDITS HISTORY. Posting from a count APPENDS one
//     `adjusted` movement per non-zero-variance line (qty = counted −
//     expected, the negation of variance — the ledger moves TOWARD the
//     count) and then flips the count row open → posted. No existing
//     StockMovement row is ever touched.
//   · POSTING IS IDEMPOTENT-BY-REFUSAL. A count whose status is already
//     'posted' refuses with an honest error instead of double-adjusting.
//     (The offline outbox's §57 idem key already stops the same queued item
//     from applying twice; this guard is the second, payload-level lock.)
//   · ADJUSTMENTS ARE RELATIVE TO THE SNAPSHOT. Movements recorded between
//     the count and the post stay in the ledger on top of the adjustment —
//     the post-count closing is expected + adjustment + everything since,
//     and the audit trail says exactly why.

/** Movement-ledger reference convention for count-linked adjustments (lineage). */
export function countReference(countId: string): string {
  return `count:${countId}`
}

/** One counted line as dispatched (offline payload shape — raw numbers). */
interface CountLineInput {
  inventoryItemId: string
  countedQty: number
}

/** Validate + normalise one counted line: finite, ≥ 0 (a count can find zero), sane cap. */
function parseCountedQty(line: { inventoryItemId?: unknown; countedQty?: unknown }): CountLineInput {
  const id = String(line.inventoryItemId ?? '')
  if (!id) throw new Error('inventory.count: every counted line needs an inventoryItemId')
  const qty = Number(line.countedQty)
  if (!Number.isFinite(qty) || qty < 0) {
    throw new Error(`inventory.count: countedQty must be zero or more (got ${typeof line.countedQty === 'string' ? `"${line.countedQty}"` : String(line.countedQty)})`)
  }
  if (qty > MAX_MOVEMENT_QTY) {
    throw new Error(`inventory.count: countedQty ${qty} exceeds the cap of ${MAX_MOVEMENT_QTY.toLocaleString('en-US')} — check the unit (bags, tonnes…), not the digits`)
  }
  return { inventoryItemId: id, countedQty: qty }
}

export interface RecordCountResult {
  countId: string
  countedBy: string
  countedAt: string
  itemCount: number
  variances: Array<{
    inventoryItemId: string
    materialName: string
    unit: string
    expectedQty: number
    countedQty: number
    variance: number
  }>
}

/**
 * Record a physical stock count session (inventory.count): one StockCount
 * row + one StockCountItem per counted line, with the expected snapshot
 * pinned at countedAt. Atomic — a bad line writes nothing.
 */
export async function recordStockCount(projectId: string, p: any): Promise<RecordCountResult> {
  return db.$transaction(async (tx) => {
    const countedBy = String(p.countedBy ?? '').trim()
    if (!countedBy) {
      throw new Error('inventory.count: countedBy is required — record who ran the physical count')
    }
    const rawCounts = Array.isArray(p.counts) ? p.counts : []
    if (rawCounts.length === 0) {
      throw new Error('inventory.count: at least one counted line is required — an empty session records nothing')
    }
    const countedAt = p.countedAt ? new Date(p.countedAt) : new Date()
    if (Number.isNaN(countedAt.getTime())) {
      throw new Error('inventory.count: countedAt must be a valid date')
    }

    // Validate + dedupe every line BEFORE any write (the DB unique
    // (countId, inventoryItemId) is the second lock, not the first).
    const lines = new Map<string, number>()
    for (const raw of rawCounts) {
      const line = parseCountedQty(raw ?? {})
      if (lines.has(line.inventoryItemId)) {
        throw new Error(`inventory.count: inventory item ${line.inventoryItemId} is counted twice in one session`)
      }
      lines.set(line.inventoryItemId, line.countedQty)
    }

    // Project-scoped read of every counted item WITH its movement log — the
    // snapshot is derived from exactly these rows.
    const items = await tx.inventoryItem.findMany({
      where: { projectId, id: { in: [...lines.keys()] } },
      include: { movements: true },
    })
    if (items.length !== lines.size) {
      throw new Error('inventory.count: one or more inventory items were not found in this project')
    }

    const count = await tx.stockCount.create({
      data: {
        projectId,
        countedBy,
        countedAt,
        note: p.note ? String(p.note) : null,
        status: 'open',
      },
    })

    const variances: RecordCountResult['variances'] = []
    for (const item of items) {
      const countedQty = lines.get(item.id)!
      // THE SNAPSHOT: derived closing as of countedAt (append-only log →
      // history is queryable; later movements cannot rewrite it).
      const expectedQty = derivedClosingQty(
        item.movements.filter((m) => m.createdAt <= countedAt),
      )
      await tx.stockCountItem.create({
        data: { countId: count.id, inventoryItemId: item.id, countedQty, expectedQty },
      })
      variances.push({
        inventoryItemId: item.id,
        materialName: item.materialName,
        unit: item.unit,
        expectedQty,
        countedQty,
        variance: expectedQty - countedQty,
      })
    }

    return {
      countId: count.id,
      countedBy,
      countedAt: countedAt.toISOString(),
      itemCount: items.length,
      variances,
    }
  })
}

export interface PostCountResult {
  countId: string
  postedAt: string
  postedBy: string
  movements: Array<{
    inventoryItemId: string
    materialName: string
    unit: string
    movementId: string | null
    adjustment: number
    closingQty: number
  }>
}

/**
 * Post the count-linked adjustments for a recorded count
 * (inventory.count.post): append one `adjusted` StockMovement per
 * non-zero-variance line (reference 'count:<countId>' — the auditable
 * lineage), stamp each line's postedQty, then flip the count open → posted.
 * Refuses an already-posted count (idempotent-by-refusal). NEVER edits an
 * existing movement row.
 */
export async function postCountAdjustments(projectId: string, p: any): Promise<PostCountResult> {
  return db.$transaction(async (tx) => {
    const countId = String(p.countId ?? '')
    if (!countId) throw new Error('inventory.count.post: countId is required')
    const postedBy = String(p.postedBy ?? p.recordedBy ?? 'Site Manager')

    // Project-scoped fetch with the counted lines and their items' movement logs.
    const count = await tx.stockCount.findFirst({
      where: { id: countId, projectId },
      include: { items: { include: { inventoryItem: { include: { movements: true } } } } },
    })
    if (!count) throw new Error('Stock count not found')
    if (count.status === 'posted') {
      throw new Error(
        `Stock count ${countId} is already posted${count.postedAt ? ` (${count.postedAt.toISOString()})` : ''} — posting twice would double-adjust. Record a new count instead.`,
      )
    }
    if (count.items.length === 0) {
      throw new Error(`Stock count ${countId} has no counted lines — nothing to post`)
    }

    const reference = countReference(count.id)
    const note = `stock count ${count.id.slice(-6)} by ${count.countedBy}`
    const movements: PostCountResult['movements'] = []
    for (const line of count.items) {
      // One definition, negated: the adjustment moves the ledger TOWARD the
      // count (counted − expected). Zero-variance lines post NO movement.
      const adjustment = line.countedQty - line.expectedQty
      const item = line.inventoryItem
      if (adjustment === 0) {
        await tx.stockCountItem.update({ where: { id: line.id }, data: { postedQty: 0 } })
        movements.push({
          inventoryItemId: line.inventoryItemId,
          materialName: item.materialName,
          unit: item.unit,
          movementId: null,
          adjustment: 0,
          closingQty: derivedClosingQty(item.movements),
        })
        continue
      }
      const movement = await appendMovement(
        tx,
        projectId,
        line.inventoryItemId,
        'adjusted',
        adjustment,
        null,
        reference,
        `${note}: expected ${line.expectedQty}, counted ${line.countedQty}`,
        postedBy,
      )
      await tx.stockCountItem.update({ where: { id: line.id }, data: { postedQty: adjustment } })
      movements.push({
        inventoryItemId: line.inventoryItemId,
        materialName: item.materialName,
        unit: item.unit,
        movementId: movement.id,
        adjustment,
        closingQty: derivedClosingQty(item.movements.concat([movement])),
      })
    }

    const postedAt = new Date()
    await tx.stockCount.update({
      where: { id: count.id },
      data: { status: 'posted', postedAt, postedBy },
    })

    return { countId: count.id, postedAt: postedAt.toISOString(), postedBy, movements }
  })
}

// ---- BOQ ----

export async function createBoq(projectId: string, p: any) {
  const count = await db.boq.count({ where: { projectId } })
  const boq = await db.boq.create({
    data: { projectId, name: String(p.name ?? `BOQ v${count + 1}`), version: count + 1 },
  })
  if (Array.isArray(p.lines)) {
    for (const l of p.lines) {
      await db.boqLine.create({
        data: {
          boqId: boq.id,
          materialName: String(l.materialName),
          unit: String(l.unit ?? 'unit'),
          qty: Number(l.qty ?? 1),
          estUnitPrice: Number(l.estUnitPrice ?? 0),
          category: l.category ?? null,
          note: l.note ?? null,
        },
      })
    }
  }
  return { id: boq.id, name: boq.name, version: boq.version, lines: (p.lines ?? []).length }
}

export async function upsertBoqLine(projectId: string, p: any) {
  const boq = await db.boq.findFirst({ where: { id: String(p.boqId), projectId } })
  if (!boq) throw new Error('BOQ not found')
  const data = {
    materialName: String(p.materialName),
    unit: String(p.unit ?? 'unit'),
    qty: Number(p.qty ?? 1),
    estUnitPrice: Number(p.estUnitPrice ?? 0),
    category: p.category ?? null,
    note: p.note ?? null,
  }
  const line = p.id
    ? await db.boqLine.update({ where: { id: String(p.id) }, data })
    : await db.boqLine.create({ data: { boqId: boq.id, ...data } })
  return { id: line.id }
}

export async function deleteBoqLine(projectId: string, p: any) {
  const line = await db.boqLine.findFirst({
    where: { id: String(p.id), boq: { projectId } },
  })
  if (!line) throw new Error('BOQ line not found')
  await db.boqLine.delete({ where: { id: line.id } })
  return { id: line.id }
}

export async function approveBoq(projectId: string, p: any) {
  const boq = await db.boq.findFirst({ where: { id: String(p.id), projectId } })
  if (!boq) throw new Error('BOQ not found')
  if (boq.status === 'approved') throw new Error('BOQ already approved')
  return db.boq.update({ where: { id: boq.id }, data: { status: 'approved' } })
}

export async function boqToRequest(projectId: string, p: any) {
  const boq = await db.boq.findFirst({
    where: { id: String(p.id), projectId },
    include: { lines: true },
  })
  if (!boq) throw new Error('BOQ not found')
  const lines = p.lineIds?.length ? boq.lines.filter((l) => p.lineIds.includes(l.id)) : boq.lines
  if (!lines.length) throw new Error('BOQ has no lines')
  const count = await db.materialRequest.count({ where: { projectId } })
  const requestCode = `MR-${1000 + count + 1}`
  const request = await db.materialRequest.create({
    data: {
      projectId,
      requestCode,
      requestedByRole: p.requestedByRole ?? 'contractor',
      requestedByName: p.requestedByName ?? 'Site Manager',
      notes: `From BOQ "${boq.name}" v${boq.version}`,
      status: 'draft',
      lines: {
        create: lines.map((l) => ({ materialName: l.materialName, unit: l.unit, qty: l.qty })),
      },
    },
  })
  return { id: request.id, requestCode, lines: lines.length }
}

// ---- Supplier shortlist & quote detail ----

export async function saveSupplier(projectId: string, p: any) {
  const supplier = await db.supplier.findUnique({ where: { id: String(p.supplierId) } })
  if (!supplier) throw new Error('Supplier not found')
  const saved = await db.savedSupplier.upsert({
    where: { projectId_supplierId: { projectId, supplierId: supplier.id } },
    update: { note: p.note ?? undefined },
    create: { projectId, supplierId: supplier.id, savedBy: p.savedBy ?? 'Site Manager', note: p.note ?? null },
  })
  return { id: saved.id }
}

export async function unsaveSupplier(projectId: string, p: any) {
  const saved = await db.savedSupplier.findFirst({
    where: { projectId, supplierId: String(p.supplierId) },
  })
  if (saved) await db.savedSupplier.delete({ where: { id: saved.id } })
  return { removed: true }
}

export async function updateQuote(projectId: string, p: any) {
  const quote = await db.quote.findFirst({
    where: { id: String(p.id), request: { projectId } },
  })
  if (!quote) throw new Error('Quote not found')
  const updated = await db.quote.update({
    where: { id: quote.id },
    data: {
      validUntil: p.validUntil ? new Date(p.validUntil) : undefined,
      terms: p.terms ?? undefined,
    },
  })
  if (Array.isArray(p.lines)) {
    await db.quoteLine.deleteMany({ where: { quoteId: quote.id } })
    for (const l of p.lines) {
      await db.quoteLine.create({
        data: {
          quoteId: quote.id,
          name: String(l.name),
          unit: String(l.unit ?? 'unit'),
          qty: Number(l.qty ?? 1),
          unitPrice: Number(l.unitPrice ?? 0),
          lineTotal: Number(l.qty ?? 1) * Number(l.unitPrice ?? 0),
        },
      })
    }
  }
  return { id: updated.id, validUntil: updated.validUntil, terms: updated.terms }
}
