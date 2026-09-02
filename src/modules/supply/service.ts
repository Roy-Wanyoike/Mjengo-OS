// Supply & procurement (MjengoOS Finder) module — service layer (agent 2-c).
//
// The Find → Compare → Request → Approve → Order → Deliver → Verify loop,
// called from src/lib/actions/supply.ts (thin actions, fat services — the
// money.ts/land.ts house pattern):
//
//   - compareSuppliers: landed-cost engine + weighted ranking (pure math in
//     compare.ts — the same function the Finder search section runs
//     client-side; one algorithm, no drift)
//   - requests: create (DRAFT, wallet untouched — Finder §2) → update →
//     submit → the approval-rules engine (§11) → decide
//   - approval engine: est total = best RECEIVED quote total, else Σ(avg
//     catalog unitPrice × qty); active rules whose band [min, max) contains
//     the est chain by priority (>250k = client + finance); when the
//     requester's OWN role is the sole required approver → auto-approve
//     ("Auto-approved within limit"); otherwise PENDING Approval rows
//     (entityType 'request' — seeded rows use 'material_request', both are
//     matched on decide). No matching rule → conservative client default.
//   - quotes: request → receive (DOCUMENTED v1 CHOICE: a quote is per-request
//     — unitPrice applies to the FIRST line's material × its qty, plus
//     delivery + transport + fees = totalLanded; multi-line detail waits for
//     real supplier responses) → decline
//   - orders: create from an APPROVED request only (the request's approval
//     counts — orders are born 'approved'; pending_approval/draft stay
//     available for future flows), lines priced from the supplier's catalog
//     by name match with quote-price fallback, PO-YYYY-000NNN codes, then
//     send → confirm (simulated supplier) → dispatch → receive
//   - delivery receive: PHYSICAL GROUND TRUTH (§13) — per-line ordered vs
//     received, photos count, GPS, note; ANY short line → 'discrepancy'
//     (flagged for review, never an accusation) + client & contractor
//     notifications; payment release stays gated by the invoices module's
//     3-way match. DOCUMENTED CHOICE: a short delivery still completes the
//     order ('delivered') — the flag rides the OrderDelivery row, matching
//     the seeded PO-2026-000009 semantics.
//   - rules: upsert/delete the project's §11 bands; suppliers + catalogs
//     minimal working upserts for demo editing (suppliers are network-global
//     rows; the audit event lands on the dispatching project)
//
// Money NEVER moves here — payment flows through the invoices module only.
// Every mutation returns a plain object; applyAction() writes the AuditEvent.
// Notifications (db rows, read by the notification center): approval.requested,
// request.approved, order.sent, delivery.received, delivery.discrepancy.

import { db } from '@/lib/db'
import { currentActor } from './session'
import { compareSuppliers as pureCompare } from './compare'
import { estimateRequestTotal, materialKey } from './insights'
import { requiredApproverRoles } from './policy'
import { materialMatches } from './compare'
import type { CompareResult, RuleLike } from './types'
import type { DeliveryDay } from './types'

// ---------------- input helpers (money.ts/land.ts house conventions) ----------------

function kes(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function posNumber(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function moneyNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function optNum(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function notify(
  projectId: string,
  kind: string,
  title: string,
  body: string,
  audienceRole: string,
  recipient: string | null = null,
) {
  await db.notification.create({
    data: { projectId, kind, title, body, audienceRole, recipient },
  })
}

const ROLE_LABELS: Record<string, string> = {
  supervisor: 'Site Supervisor',
  contractor: 'Contractor',
  client: 'Client',
  finance: 'Finance',
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}

// ---------------- code generators ----------------

/** Next request code MR-#### (max numeric suffix on THIS project + 1). */
async function nextRequestCode(projectId: string): Promise<string> {
  const existing = await db.materialRequest.findMany({
    where: { projectId },
    select: { requestCode: true },
  })
  let max = 1000
  for (const { requestCode } of existing) {
    const n = parseInt(requestCode.replace(/^MR-/i, ''), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `MR-${max + 1}`
}

/** Next order code PO-YYYY-000NNN (max NNN on THIS project + 1, current year). */
async function nextOrderCode(projectId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `PO-${year}-`
  const existing = await db.purchaseOrder.findMany({
    where: { projectId, orderCode: { startsWith: prefix } },
    select: { orderCode: true },
  })
  let max = 0
  for (const { orderCode } of existing) {
    const n = parseInt(orderCode.slice(prefix.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(6, '0')}`
}

// ---------------- entity fetchers ----------------

async function getRequestOrThrow(id: unknown, projectId: string) {
  const requestId = String(id ?? '')
  if (!requestId) throw new Error('Request id required')
  const request = await db.materialRequest.findFirst({
    where: { id: requestId, projectId },
    include: { lines: true, quotes: true, orders: true },
  })
  if (!request) throw new Error('Material request not found in this project')
  return request
}

async function getOrderOrThrow(id: unknown, projectId: string) {
  const orderId = String(id ?? '')
  if (!orderId) throw new Error('Order id required')
  const order = await db.purchaseOrder.findFirst({
    where: { id: orderId, projectId },
    include: { lines: true, supplier: true, request: true, deliveries: { include: { lines: true } } },
  })
  if (!order) throw new Error('Purchase order not found in this project')
  return order
}

async function getQuoteOrThrow(id: unknown, projectId: string) {
  const quoteId = String(id ?? '')
  if (!quoteId) throw new Error('Quote id required')
  const quote = await db.quote.findFirst({
    where: { id: quoteId, request: { projectId } },
    include: { request: { include: { lines: true } }, supplier: true },
  })
  if (!quote) throw new Error('Quote not found in this project')
  return quote
}

async function loadSuppliersWithCatalog() {
  return db.supplier.findMany({ include: { catalogItems: { orderBy: { name: 'asc' } } } })
}

/** Site coordinates: first parcel (by createdAt) with coords, else Nairobi. */
async function resolveSite(projectId: string) {
  const parcels = await db.landParcel.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: { lat: true, lng: true, county: true, town: true, plotNumber: true },
  })
  const withCoords = parcels.find((p) => p.lat !== null && p.lng !== null)
  if (withCoords) {
    return {
      lat: withCoords.lat as number,
      lng: withCoords.lng as number,
      label: `Site — ${withCoords.plotNumber}${withCoords.town ? `, ${withCoords.town}` : ''}`,
    }
  }
  return { lat: -1.2921, lng: 36.8219, label: 'Nairobi (default — no parcel coords yet)' }
}

// ---------------- approval engine (Finder §10/§11) ----------------

/** Estimate the request total: best RECEIVED quote, else catalog averages. */
async function estimateForRequest(requestId: string) {
  const [lines, quotes, suppliers] = await Promise.all([
    db.materialRequestLine.findMany({ where: { requestId } }),
    db.quote.findMany({ where: { requestId } }),
    loadSuppliersWithCatalog(),
  ])
  return estimateRequestTotal(
    lines.map((l) => ({ materialName: l.materialName, qty: l.qty })),
    suppliers.map((s) => ({ catalogItems: s.catalogItems })),
    quotes.map((q) => ({ status: q.status, totalLanded: q.totalLanded })),
  )
}

// ---------------- read-side: landed-cost compare ----------------

/** `supply.compare` { materialName, qty, radiusKm?, deliveryDay? } → ranked rows. */
export async function compareSuppliers(
  projectId: string,
  payload: Record<string, unknown>,
): Promise<CompareResult> {
  const materialName = str(payload.materialName)
  if (!materialName) throw new Error('Material name required')
  const qty = posNumber(payload.qty)
  if (qty === null) throw new Error('Quantity must be a number greater than zero')
  const radiusKm = payload.radiusKm === undefined || payload.radiusKm === null || payload.radiusKm === ''
    ? null
    : posNumber(payload.radiusKm)
  const deliveryDay = ['any', 'same_day', 'next_day', 'two_days'].includes(String(payload.deliveryDay))
    ? (String(payload.deliveryDay) as DeliveryDay)
    : 'any'

  const [suppliers, site] = await Promise.all([loadSuppliersWithCatalog(), resolveSite(projectId)])
  return pureCompare(
    { materialName, qty, radiusKm, deliveryDay },
    suppliers.map((s) => ({
      id: s.id,
      businessName: s.businessName,
      county: s.county,
      town: s.town,
      lat: s.lat,
      lng: s.lng,
      deliveryFeeBase: s.deliveryFeeBase,
      freeDeliveryOver: s.freeDeliveryOver,
      minimumOrder: s.minimumOrder,
      reliabilityScore: s.reliabilityScore,
      responseHours: s.responseHours,
      catalogItems: s.catalogItems,
    })),
    site,
  )
}

// ---------------- suppliers + catalog (minimal working, demo editing) ----------------

/** `supplier.upsert` { id?, businessName, county, town?, phone?, … } — network-global rows. */
export async function upsertSupplier(_projectId: string, payload: Record<string, unknown>) {
  const id = str(payload.id)
  const businessName = str(payload.businessName)
  const county = str(payload.county)

  const data: Record<string, unknown> = {}
  if (businessName) data.businessName = businessName
  if (county) data.county = county
  if (payload.town !== undefined) data.town = str(payload.town)
  if (payload.phone !== undefined) data.phone = str(payload.phone)
  if (payload.email !== undefined) data.email = str(payload.email)
  if (payload.warehouseLocation !== undefined) data.warehouseLocation = str(payload.warehouseLocation)
  if (payload.deliveryZones !== undefined) data.deliveryZones = str(payload.deliveryZones) ?? ''
  const deliveryFeeBase = moneyNumber(payload.deliveryFeeBase)
  if (deliveryFeeBase !== null) data.deliveryFeeBase = deliveryFeeBase
  const freeDeliveryOver = moneyNumber(payload.freeDeliveryOver)
  if (freeDeliveryOver !== null) data.freeDeliveryOver = freeDeliveryOver
  const minimumOrder = moneyNumber(payload.minimumOrder)
  if (minimumOrder !== null) data.minimumOrder = minimumOrder
  const reliabilityScore = payload.reliabilityScore !== undefined ? optNum(payload.reliabilityScore) : null
  if (reliabilityScore !== null) data.reliabilityScore = Math.max(0, Math.min(100, Math.round(reliabilityScore)))
  const responseHours = payload.responseHours !== undefined ? optNum(payload.responseHours) : null
  if (responseHours !== null) data.responseHours = Math.max(1, Math.round(responseHours))
  const lat = payload.lat !== undefined ? optNum(payload.lat) : null
  const lng = payload.lng !== undefined ? optNum(payload.lng) : null
  if (lat !== null) data.lat = lat
  if (lng !== null) data.lng = lng

  if (id) {
    const existing = await db.supplier.findUnique({ where: { id } })
    if (!existing) throw new Error('Supplier not found')
    const updated = await db.supplier.update({ where: { id }, data })
    return { id: updated.id, businessName: updated.businessName }
  }
  if (!businessName || !county) throw new Error('New suppliers need a business name and county')
  const created = await db.supplier.create({
    data: {
      businessName,
      county,
      town: (data.town as string | null) ?? null,
      phone: (data.phone as string | null) ?? null,
      email: (data.email as string | null) ?? null,
      warehouseLocation: (data.warehouseLocation as string | null) ?? null,
      deliveryZones: (data.deliveryZones as string) ?? '',
      deliveryFeeBase: (data.deliveryFeeBase as number) ?? 0,
      freeDeliveryOver: (data.freeDeliveryOver as number | null) ?? null,
      minimumOrder: (data.minimumOrder as number) ?? 0,
      reliabilityScore: (data.reliabilityScore as number) ?? 50,
      responseHours: (data.responseHours as number) ?? 24,
      lat: (data.lat as number | null) ?? null,
      lng: (data.lng as number | null) ?? null,
    },
  })
  return { id: created.id, businessName: created.businessName }
}

/** `catalog.upsert` { supplierId, id?, name, unit, unitPrice, stockQty?, minOrderQty? }. */
export async function upsertCatalogItem(_projectId: string, payload: Record<string, unknown>) {
  const supplierId = str(payload.supplierId)
  const id = str(payload.id)
  const name = str(payload.name)
  const unit = str(payload.unit)
  const unitPrice = moneyNumber(payload.unitPrice)
  if (unitPrice === null) throw new Error('Unit price must be zero or more')

  if (id) {
    const existing = await db.catalogItem.findUnique({ where: { id } })
    if (!existing) throw new Error('Catalog item not found')
    if (supplierId && supplierId !== existing.supplierId) {
      throw new Error('Catalog item belongs to a different supplier')
    }
    const data: Record<string, unknown> = {}
    if (name) data.name = name
    if (unit) data.unit = unit
    data.unitPrice = unitPrice
    const stockQty = payload.stockQty !== undefined ? moneyNumber(payload.stockQty) : null
    if (stockQty !== null) data.stockQty = stockQty
    const minOrderQty = payload.minOrderQty !== undefined ? moneyNumber(payload.minOrderQty) : null
    if (minOrderQty !== null) data.minOrderQty = Math.max(1, minOrderQty)
    const updated = await db.catalogItem.update({ where: { id }, data })
    return { id: updated.id, name: updated.name }
  }

  if (!supplierId) throw new Error('supplierId required for a new catalog item')
  const supplier = await db.supplier.findUnique({ where: { id: supplierId } })
  if (!supplier) throw new Error('Supplier not found')
  if (!name) throw new Error('Catalog item name required')
  const created = await db.catalogItem.create({
    data: {
      supplierId,
      name,
      unit: unit ?? 'unit',
      unitPrice,
      stockQty: moneyNumber(payload.stockQty) ?? 0,
      minOrderQty: Math.max(1, moneyNumber(payload.minOrderQty) ?? 1),
    },
  })
  return { id: created.id, name: created.name }
}

// ---------------- material requests ----------------

interface LineInput {
  materialName: string
  unit: string
  qty: number
}

/** Validate + normalize request lines (units default from the matching catalog). */
async function normalizeRequestLines(raw: unknown): Promise<LineInput[]> {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('At least one request line is required')
  const suppliers = await loadSuppliersWithCatalog()
  const lines: LineInput[] = []
  for (const item of raw) {
    const rec = (item ?? {}) as Record<string, unknown>
    const materialName = str(rec.materialName)
    if (!materialName) throw new Error('Every line needs a material name')
    const qty = posNumber(rec.qty)
    if (qty === null) throw new Error(`Line "${materialName}": quantity must be greater than zero`)
    let unit = str(rec.unit)
    if (!unit) {
      // default the unit from the first catalog item matching the name
      for (const s of suppliers) {
        const match = s.catalogItems.find((c) => materialMatches(c.name, materialName))
        if (match) {
          unit = match.unit
          break
        }
      }
    }
    lines.push({ materialName, unit: unit ?? 'unit', qty })
  }
  return lines
}

/** `request.create` { lines, notes? } → DRAFT (wallet untouched — Finder §2). */
export async function createRequest(projectId: string, payload: Record<string, unknown>) {
  const lines = await normalizeRequestLines(payload.lines)
  const actor = await currentActor()
  const requestedByRole = actor.role ?? str(payload.requestedByRole) ?? 'contractor'
  const requestedByName = actor.name ?? str(payload.requestedByName) ?? 'Site Manager'
  const requestCode = await nextRequestCode(projectId)

  const request = await db.materialRequest.create({
    data: {
      projectId,
      requestCode,
      requestedByRole,
      requestedByName,
      notes: str(payload.notes),
      status: 'draft',
      lines: { create: lines.map((l) => ({ materialName: l.materialName, unit: l.unit, qty: l.qty })) },
    },
  })
  return { id: request.id, requestCode, lineCount: lines.length }
}

/** `request.update` { id, lines?, notes? } — edit while DRAFT. */
export async function updateRequest(projectId: string, payload: Record<string, unknown>) {
  const request = await getRequestOrThrow(payload.id, projectId)
  if (request.status !== 'draft') {
    throw new Error(`Only DRAFT requests can be edited — ${request.requestCode} is ${request.status.toUpperCase()}`)
  }
  if (payload.lines !== undefined) {
    const lines = await normalizeRequestLines(payload.lines)
    await db.materialRequestLine.deleteMany({ where: { requestId: request.id } })
    await db.materialRequestLine.createMany({
      data: lines.map((l) => ({ requestId: request.id, materialName: l.materialName, unit: l.unit, qty: l.qty })),
    })
  }
  const data: Record<string, unknown> = {}
  if (payload.notes !== undefined) data.notes = str(payload.notes)
  await db.materialRequest.update({ where: { id: request.id }, data })
  return { id: request.id }
}

/**
 * `request.submit` { id } — into the approval engine (Finder §11).
 * Est total = best RECEIVED quote, else Σ(avg catalog unitPrice × qty).
 * Band-matching rules chain by priority; sole-approver = requester's own role
 * → auto-approve within limit; otherwise PENDING Approval rows per role.
 *
 * §24 client-direct ordering (backend wave): when the CLIENT raised the
 * request, their own rung in the chain is substituted with 'contractor' —
 * the site team that must commit the purchase. By construction this also
 * disables the sole-approver auto-approve shortcut for client requesters:
 * a client's request always waits for a site-team (and/or finance) signer.
 */
export async function submitRequest(projectId: string, payload: Record<string, unknown>) {
  const request = await getRequestOrThrow(payload.id, projectId)
  if (request.status !== 'draft') {
    throw new Error(`Only DRAFT requests can be submitted — ${request.requestCode} is ${request.status.toUpperCase()}`)
  }

  const estimate = await estimateForRequest(request.id)
  const rules: RuleLike[] = await db.approvalRule.findMany({ where: { projectId, active: true } })
  let chain = requiredApproverRoles(rules, estimate.total)
  if (chain.length === 0) chain = ['client'] // conservative default, documented
  // §24: the client never sits on their own approval — their rung falls to
  // the contractor (auto-approve below then cannot fire for a client requester).
  if (request.requestedByRole === 'client') {
    chain = chain.map((r) => (r === 'client' ? 'contractor' : r))
  }

  const now = new Date()

  // Sole required approver IS the requester → auto-approve within limit (§10)
  if (chain.length === 1 && chain[0] === request.requestedByRole) {
    await db.approval.create({
      data: {
        projectId,
        entityType: 'request',
        entityId: request.id,
        approverRole: chain[0],
        approverName: request.requestedByName,
        decision: 'approved',
        note: 'Auto-approved within limit',
        decidedAt: now,
      },
    })
    await db.materialRequest.update({ where: { id: request.id }, data: { status: 'approved' } })
    await notify(
      projectId,
      'request.approved',
      `Auto-approved: ${request.requestCode}`,
      `${kes(estimate.total)} estimated — within the ${roleLabel(chain[0])} limit, no second sign-off needed.`,
      request.requestedByRole,
      null,
    )
    return { id: request.id, status: 'approved', estimatedTotal: estimate.total, autoApproved: true, chain }
  }

  // Otherwise: PENDING approval rows per required role, priority-ordered
  for (const role of chain) {
    await db.approval.create({
      data: {
        projectId,
        entityType: 'request',
        entityId: request.id,
        approverRole: role,
        approverName: roleLabel(role),
        decision: 'pending',
      },
    })
  }
  await db.materialRequest.update({ where: { id: request.id }, data: { status: 'submitted' } })
  await notify(
    projectId,
    'approval.requested',
    `Approval needed: ${request.requestCode}`,
    `${kes(estimate.total)} estimated (${estimate.source === 'quotes' ? 'from quotes' : 'from catalog averages'}) — waiting for the ${roleLabel(chain[0])} decision.`,
    chain[0],
    null,
  )
  return { id: request.id, status: 'submitted', estimatedTotal: estimate.total, chain }
}

/**
 * `request.decide` { id, decision: approve|reject, note? } — the actor's role
 * must match a PENDING approval for that entity; wrong roles are rejected
 * with a clear server-side message (the system controls who decides).
 * All approved → request APPROVED · any rejected → REJECTED.
 */
export async function decideApproval(projectId: string, payload: Record<string, unknown>) {
  const request = await getRequestOrThrow(payload.id, projectId)
  if (request.status !== 'submitted') {
    throw new Error(`${request.requestCode} is ${request.status.toUpperCase()} — not awaiting a decision`)
  }
  const decision = payload.decision
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error("decision must be 'approve' or 'reject'")
  }

  // Seeded rows use entityType 'material_request'; ours use 'request' — both matched.
  const pending = await db.approval.findMany({
    where: {
      projectId,
      entityId: request.id,
      decision: 'pending',
      entityType: { in: ['request', 'material_request'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (!pending.length) throw new Error(`No pending approval found for ${request.requestCode}`)

  // Actor resolution — the same documented pattern as modules/wallet/session.ts
  // requireDeciderRole: the signed-in session role decides; with NO session
  // (share-link / public path — the entry routes upstream already restrict
  // those callers to the CLIENT_ACTIONS allowlist) the decider is the client.
  const actor = await currentActor()
  const actorRole = actor.role ?? 'client'
  // §24 client-direct ordering: a client may raise requests, but may NEVER
  // approve their own — the ladder (submitRequest substituted their rung to
  // the contractor) waits for the site team. Honest refusal, before any
  // approval row is touched.
  if (actorRole === 'client' && request.requestedByRole === 'client') {
    throw new Error(
      `${request.requestCode} was raised by the client — a client cannot approve their own request (spec §24). ` +
        'The site team holds the decision.',
    )
  }
  const myRow = pending.find((p) => p.approverRole === actorRole)
  if (!myRow) {
    const waiting = pending.map((p) => roleLabel(p.approverRole)).join(' and ')
    throw new Error(
      `Only the ${waiting} role may decide ${request.requestCode} — you are ${roleLabel(actorRole)}. ` +
        'The approval chain is waiting for the right signer.',
    )
  }

  const note = str(payload.note)
  const now = new Date()
  const decided = decision === 'approve' ? 'approved' : 'rejected'
  await db.approval.update({
    where: { id: myRow.id },
    data: { decision: decided, decidedAt: now, approverName: actor.name ?? roleLabel(myRow.approverRole), note },
  })

  const all = await db.approval.findMany({
    where: { entityId: request.id, entityType: { in: ['request', 'material_request'] } },
  })
  if (all.some((a) => a.decision === 'rejected')) {
    await db.materialRequest.update({ where: { id: request.id }, data: { status: 'rejected' } })
    return { id: request.id, status: 'rejected' }
  }
  if (all.every((a) => a.decision === 'approved')) {
    await db.materialRequest.update({ where: { id: request.id }, data: { status: 'approved' } })
    const project = await db.project.findUnique({ where: { id: projectId } })
    await notify(
      projectId,
      'request.approved',
      `Approved: ${request.requestCode}`,
      `All required approvals are in — purchase orders can now be created against ${request.requestCode}.`,
      request.requestedByRole || 'contractor',
      project?.client ?? null,
    )
    return { id: request.id, status: 'approved' }
  }
  return { id: request.id, status: 'submitted', decided }
}

// ---------------- quotes ----------------

/** `quote.request` { requestId, supplierIds: string[] } — Quote rows REQUESTED. */
export async function requestQuotes(projectId: string, payload: Record<string, unknown>) {
  const request = await getRequestOrThrow(payload.requestId, projectId)
  if (!['submitted', 'approved', 'converted'].includes(request.status)) {
    throw new Error(`Quotes are requested after submission — ${request.requestCode} is ${request.status.toUpperCase()}`)
  }
  const supplierIds = Array.isArray(payload.supplierIds) ? payload.supplierIds.map((s) => String(s)) : []
  if (!supplierIds.length) throw new Error('Pick at least one supplier to quote')

  const suppliers = await db.supplier.findMany({ where: { id: { in: supplierIds } } })
  if (suppliers.length !== new Set(supplierIds).size) throw new Error('One or more suppliers not found')

  const existing = await db.quote.findMany({
    where: { requestId: request.id, supplierId: { in: supplierIds } },
    select: { supplierId: true },
  })
  const already = new Set(existing.map((q) => q.supplierId))
  const fresh = supplierIds.filter((sid) => !already.has(sid))
  if (!fresh.length) {
    throw new Error('Those suppliers already have quotes on this request — await their response or decline stale ones')
  }
  await db.quote.createMany({
    data: fresh.map((supplierId) => ({
      requestId: request.id,
      supplierId,
      unitPrice: 0,
      deliveryFee: 0,
      transportFee: 0,
      fees: 0,
      totalLanded: 0,
      status: 'requested',
    })),
  })
  return { requestId: request.id, created: fresh.length, requestCode: request.requestCode }
}

/**
 * `quote.receive` { id, unitPrice, deliveryFee?, transportFee?, fees?,
 * deliveryEta?, stockOk?, validUntil?, terms?, lines? } → RECEIVED.
 *
 * v2 (F-PROCURE, spec §32): when `lines` is supplied (one row per REQUEST
 * line, positional — qty fixed from the request, only unitPrice is the
 * supplier's), per-line QuoteLine rows are stored and
 * totalLanded = Σ(qty × price) + deliveryFee + transportFee + fees.
 * Without `lines` the DOCUMENTED v1 CHOICE stands: a quote is per-request —
 * totalLanded = unitPrice × FIRST line's qty + delivery + transport + fees.
 * validUntil/terms ride the Quote row (also editable later via quote.update).
 */
export async function receiveQuote(projectId: string, payload: Record<string, unknown>) {
  const quote = await getQuoteOrThrow(payload.id, projectId)
  if (quote.status !== 'requested') throw new Error(`Quote is already ${quote.status.toUpperCase()}`)
  const deliveryFee = moneyNumber(payload.deliveryFee) ?? 0
  const transportFee = moneyNumber(payload.transportFee) ?? 0
  const fees = moneyNumber(payload.fees) ?? 0
  const deliveryEta = str(payload.deliveryEta)
  const stockOk = payload.stockOk === undefined ? true : Boolean(payload.stockOk)
  const validUntil = payload.validUntil ? new Date(String(payload.validUntil)) : undefined
  const terms = str(payload.terms) ?? undefined

  const rawLines = Array.isArray(payload.lines) ? payload.lines : []

  let unitPrice: number
  let totalLanded: number
  if (rawLines.length) {
    // Multi-line bid: one price per REQUEST line (positional, qty from request)
    const requestLines = quote.request.lines
    if (rawLines.length !== requestLines.length) {
      throw new Error(`This request has ${requestLines.length} line(s) — price every one (${rawLines.length} given)`)
    }
    const priced: Array<{ name: string; unit: string; qty: number; unitPrice: number }> = []
    for (let i = 0; i < requestLines.length; i++) {
      const rec = (rawLines[i] ?? {}) as Record<string, unknown>
      const price = posNumber(rec.unitPrice)
      if (price === null) throw new Error(`Line "${requestLines[i].materialName}": quoted unit price must be greater than zero`)
      priced.push({ name: requestLines[i].materialName, unit: requestLines[i].unit, qty: requestLines[i].qty, unitPrice: price })
    }
    unitPrice = priced[0].unitPrice // header price = primary (first) line — compare-basis
    totalLanded = Math.round(
      priced.reduce((s, l) => s + l.qty * l.unitPrice, 0) * 100 + (deliveryFee + transportFee + fees) * 100,
    ) / 100
    await db.quoteLine.deleteMany({ where: { quoteId: quote.id } })
    await db.quoteLine.createMany({
      data: priced.map((l) => ({ quoteId: quote.id, name: l.name, unit: l.unit, qty: l.qty, unitPrice: l.unitPrice, lineTotal: Math.round(l.qty * l.unitPrice * 100) / 100 })),
    })
  } else {
    unitPrice = posNumber(payload.unitPrice) ?? -1
    if (unitPrice <= 0) throw new Error('Quoted unit price must be greater than zero')
    const firstLine = quote.request.lines[0]
    if (!firstLine) throw new Error('The request has no lines to quote against')
    totalLanded = Math.round((unitPrice * firstLine.qty + deliveryFee + transportFee + fees) * 100) / 100
  }

  const updated = await db.quote.update({
    where: { id: quote.id },
    data: { unitPrice, deliveryFee, transportFee, fees, totalLanded, deliveryEta, stockOk, validUntil, terms, status: 'received' },
  })
  return { id: updated.id, totalLanded, lineCount: rawLines.length || undefined }
}

/** `quote.decline` { id, reason? } — supplier declined (reason rides the audit). */
export async function declineQuote(projectId: string, payload: Record<string, unknown>) {
  const quote = await getQuoteOrThrow(payload.id, projectId)
  if (quote.status !== 'requested') throw new Error(`Only REQUESTED quotes can be declined — this one is ${quote.status.toUpperCase()}`)
  await db.quote.update({ where: { id: quote.id }, data: { status: 'declined' } })
  return { id: quote.id }
}

// ---------------- purchase orders ----------------

/**
 * `order.create` { requestId, supplierId, quoteId?, paymentSource?, note? }
 * → only from an APPROVED request (its approval counts — orders are born
 * 'approved'; §12). Lines priced from the supplier's catalog by name match,
 * falling back to the quote's unit price. PO-YYYY-000NNN code.
 */
export async function createOrder(projectId: string, payload: Record<string, unknown>) {
  const requestId = str(payload.requestId)
  if (!requestId) throw new Error('requestId required — purchase orders come from approved requests')
  const request = await getRequestOrThrow(requestId, projectId)
  if (request.status !== 'approved') {
    throw new Error(
      `Purchase orders are created from APPROVED requests — ${request.requestCode} is ${request.status.toUpperCase()}`,
    )
  }
  const supplierId = str(payload.supplierId)
  if (!supplierId) throw new Error('supplierId required')
  const supplier = await db.supplier.findUnique({ where: { id: supplierId }, include: { catalogItems: true } })
  if (!supplier) throw new Error('Supplier not found')

  // Optional quote link — must belong to this request + supplier
  let quote: Awaited<ReturnType<typeof getQuoteOrThrow>> | null = null
  const quoteId = str(payload.quoteId)
  if (quoteId) {
    quote = await getQuoteOrThrow(quoteId, projectId)
    if (quote.requestId !== request.id || quote.supplierId !== supplierId) {
      throw new Error('The selected quote does not match this request/supplier')
    }
  }

  // Price every request line: supplier catalog first, quote price fallback
  const lineData: Array<{ name: string; unit: string; qty: number; unitPrice: number; lineTotal: number }> = []
  for (const line of request.lines) {
    let unitPrice: number | null = null
    const exact = supplier.catalogItems.find((c) => materialKey(c.name) === materialKey(line.materialName))
    const fuzzy = supplier.catalogItems.find((c) => materialMatches(c.name, line.materialName))
    const catalogHit = exact ?? fuzzy
    if (catalogHit) unitPrice = catalogHit.unitPrice
    else if (quote && quote.status === 'received' && quote.unitPrice > 0 && line.id === request.lines[0]?.id) {
      unitPrice = quote.unitPrice
    }
    if (unitPrice === null) {
      throw new Error(
        `${supplier.businessName} does not stock "${line.materialName}" — pick a supplier that stocks it or request a quote first`,
      )
    }
    const lineTotal = Math.round(unitPrice * line.qty * 100) / 100
    lineData.push({ name: line.materialName, unit: line.unit, qty: line.qty, unitPrice, lineTotal })
  }

  const subtotal = Math.round(lineData.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100
  const deliveryFee =
    supplier.freeDeliveryOver !== null && subtotal >= supplier.freeDeliveryOver ? 0 : supplier.deliveryFeeBase
  const total = Math.round((subtotal + deliveryFee) * 100) / 100

  const paymentSource = ['client', 'contractor', 'project_wallet', 'finance'].includes(String(payload.paymentSource))
    ? String(payload.paymentSource)
    : 'client'
  const actor = await currentActor()
  // §24 client-direct ordering: a client-created request produces a
  // client-created PO — payload fallback only matters for sessionless
  // (share-link) traffic, same trust boundary as createRequest's requester.
  const createdByRole = actor.role ?? str(payload.createdByRole) ?? 'contractor'
  const orderCode = await nextOrderCode(projectId)

  const order = await db.purchaseOrder.create({
    data: {
      orderCode,
      projectId,
      requestId: request.id,
      supplierId,
      subtotal,
      deliveryFee,
      total,
      status: 'approved', // the request's approval counts (documented)
      paymentSource,
      createdByRole,
      note: str(payload.note),
      lines: { create: lineData },
    },
  })
  await db.materialRequest.update({ where: { id: request.id }, data: { status: 'converted' } })
  return { id: order.id, orderCode, total, subtotal, deliveryFee }
}

/** `order.update` { id, note? } — note edits (v1 orders are born approved; edits are notes). */
export async function updateOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.id, projectId)
  const data: Record<string, unknown> = {}
  if (payload.note !== undefined) data.note = str(payload.note)
  if (!Object.keys(data).length) throw new Error('Nothing to update — v1 order edits are notes')
  await db.purchaseOrder.update({ where: { id: order.id }, data })
  return { id: order.id }
}

/** `order.approve` { id, note? } — band-checked; only meaningful for draft/pending orders. */
export async function approveOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.id, projectId)
  if (!['draft', 'pending_approval'].includes(order.status)) {
    throw new Error(`${order.orderCode} is ${order.status.toUpperCase()} — orders from approved requests need no separate approval`)
  }
  const rules: RuleLike[] = await db.approvalRule.findMany({ where: { projectId, active: true } })
  const chain = requiredApproverRoles(rules, order.total)
  const actor = await currentActor()
  if (actor.role && !chain.includes(actor.role)) {
    throw new Error(
      `Only ${chain.map(roleLabel).join(' / ') || 'the client'} may approve ${order.orderCode} at ${kes(order.total)} — you are signed in as ${roleLabel(actor.role)}`,
    )
  }
  const now = new Date()
  const pending = await db.approval.findFirst({
    where: { entityType: 'purchase_order', entityId: order.id, decision: 'pending' },
  })
  if (pending) {
    await db.approval.update({
      where: { id: pending.id },
      data: { decision: 'approved', decidedAt: now, approverName: actor.name ?? roleLabel(pending.approverRole), note: str(payload.note) },
    })
  } else {
    await db.approval.create({
      data: {
        projectId,
        entityType: 'purchase_order',
        entityId: order.id,
        approverRole: actor.role ?? chain[0] ?? 'client',
        approverName: actor.name ?? roleLabel(chain[0] ?? 'client'),
        decision: 'approved',
        note: str(payload.note) ?? 'Approved via order.approve',
        decidedAt: now,
      },
    })
  }
  await db.purchaseOrder.update({ where: { id: order.id }, data: { status: 'approved' } })
  return { id: order.id, status: 'approved' }
}

/** `order.send` { id } → SENT (+ contractor notification). */
export async function sendOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.id, projectId)
  if (order.status !== 'approved') {
    throw new Error(`Only APPROVED orders can be sent — ${order.orderCode} is ${order.status.toUpperCase()}`)
  }
  await db.purchaseOrder.update({ where: { id: order.id }, data: { status: 'sent' } })
  await notify(
    projectId,
    'order.sent',
    `PO sent: ${order.orderCode}`,
    `${kes(order.total)} sent to ${order.supplier.businessName} — awaiting their confirmation.`,
    'contractor',
    null,
  )
  return { id: order.id, status: 'sent', orderCode: order.orderCode }
}

/** `order.confirm` { id, note? } → CONFIRMED — supplier confirms (simulated). */
export async function confirmOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.id, projectId)
  if (order.status !== 'sent') {
    throw new Error(`Only SENT orders can be confirmed — ${order.orderCode} is ${order.status.toUpperCase()}`)
  }
  await db.purchaseOrder.update({
    where: { id: order.id },
    data: { status: 'confirmed', note: str(payload.note) ?? order.note },
  })
  return { id: order.id, status: 'confirmed', orderCode: order.orderCode }
}

/** `order.dispatch` { orderId } → DELIVERING + OrderDelivery DISPATCHED. */
export async function dispatchOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.orderId ?? payload.id, projectId)
  if (!['sent', 'confirmed'].includes(order.status)) {
    throw new Error(`Only SENT or CONFIRMED orders can be dispatched — ${order.orderCode} is ${order.status.toUpperCase()}`)
  }
  const existing = await db.orderDelivery.findFirst({ where: { orderId: order.id } })
  if (existing) throw new Error(`${order.orderCode} already has a dispatch record`)

  const now = new Date()
  await db.purchaseOrder.update({ where: { id: order.id }, data: { status: 'delivering' } })
  const delivery = await db.orderDelivery.create({
    data: {
      orderId: order.id,
      status: 'dispatched',
      dispatchedAt: now,
      note: str(payload.note) ?? `Truck dispatched — ${order.lines.length} line(s), ${kes(order.total)}`,
    },
  })
  return { id: order.id, deliveryId: delivery.id, status: 'delivering', orderCode: order.orderCode }
}

/** `order.cancel` { id, reason } — from SENT/CONFIRMED, with a reason. */
export async function cancelOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.id, projectId)
  if (!['sent', 'confirmed'].includes(order.status)) {
    throw new Error(`Only SENT or CONFIRMED orders can be cancelled — ${order.orderCode} is ${order.status.toUpperCase()}`)
  }
  const reason = str(payload.reason)
  if (!reason) throw new Error('A cancellation reason is required')
  await db.purchaseOrder.update({ where: { id: order.id }, data: { status: 'cancelled', note: `Cancelled — ${reason}` } })
  return { id: order.id, status: 'cancelled', orderCode: order.orderCode }
}

/** `order.close` { id, note? } — from DELIVERED. */
export async function closeOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.id, projectId)
  if (order.status !== 'delivered') {
    throw new Error(`Only DELIVERED orders can be closed — ${order.orderCode} is ${order.status.toUpperCase()}`)
  }
  await db.purchaseOrder.update({
    where: { id: order.id },
    data: { status: 'closed', note: str(payload.note) ? `Closed — ${str(payload.note)}` : 'Closed after verified delivery' },
  })
  return { id: order.id, status: 'closed', orderCode: order.orderCode }
}

// ---------------- delivery verification (Finder §13 — ground truth) ----------------

/**
 * `delivery.receive` { deliveryId, lines: [{ orderLineId, qtyReceived,
 * qtyRejected?, damageNote?, condition? }], note?, gpsLat?, gpsLng?,
 * photoCount? } — per-line physical counts + inspection + evidence.
 * Accepts a truck that is DISPATCHED (§26 leg skipped — back-compat) or
 * ARRIVED (the driver leg ran: assign → dispatch → transit → arrive).
 * ANY qtyReceived < qtyOrdered → OrderDelivery 'discrepancy' ("Ordered X ·
 * Received Y — N missing, flagged for review") + client & contractor
 * notifications. Documented: the order still completes (DELIVERED) — the flag
 * rides the delivery row for review, matching seeded PO-2026-000009; payment
 * release stays gated by the invoices module's 3-way match.
 *
 * INVENTORY INTEGRATION (spec §28/§33/§34 — F-PROCURE): the same receive also
 * posts the store ledger — per line, net received = qtyReceived − qtyRejected
 * becomes a 'received' StockMovement (InventoryItem upsert keyed material +
 * unit + location 'Site Store', supplier from the PO, reference = orderCode);
 * the rejected quantity becomes 'damaged' when the line was inspected
 * damaged/with a damage note, else 'returned'. recordedBy = the receiver.
 * CatalogItem.stockQty is clamped = max(0, stockQty − qtyOrdered) for the
 * line's catalog item (supplier + name match; skipped silently when the
 * supplier's catalog has no such item — some POs price off quotes).
 * TODO(photos): photoCount is an integer count for v1 — real photo attach
 * lands with object storage (roadmap A-5).
 */
export async function receiveDelivery(projectId: string, payload: Record<string, unknown>) {
  const deliveryId = str(payload.deliveryId)
  if (!deliveryId) throw new Error('deliveryId required')
  const delivery = await db.orderDelivery.findFirst({
    where: { id: deliveryId, order: { projectId } },
    include: { order: { include: { lines: true, supplier: true } }, lines: true },
  })
  if (!delivery) throw new Error('Delivery not found in this project')
  if (delivery.status === 'in_transit') {
    // §26 driver leg: the truck has not reached the site yet — count at the gate.
    throw new Error(
      'The truck is still in transit — record the arrival (delivery.arrive) before receiving',
    )
  }
  if (delivery.status !== 'dispatched' && delivery.status !== 'arrived') {
    throw new Error(`Delivery is already ${delivery.status.toUpperCase()} — it cannot be re-received`)
  }
  const rawLines = Array.isArray(payload.lines) ? payload.lines : []
  if (!rawLines.length) throw new Error('Per-line received quantities are required — count what physically arrived')

  // Validate every line input against the PO lines (counts + inspection)
  const received: Array<{
    orderLineId: string
    orderLineName: string
    unit: string
    unitPrice: number
    qtyOrdered: number
    qtyReceived: number
    qtyRejected: number
    damageNote: string | null
    condition: string
  }> = []
  for (const item of rawLines) {
    const rec = (item ?? {}) as Record<string, unknown>
    const orderLine = delivery.order.lines.find((l) => l.id === String(rec.orderLineId))
    if (!orderLine) throw new Error('One or more lines do not belong to this purchase order')
    const qtyReceived = moneyNumber(rec.qtyReceived)
    if (qtyReceived === null) throw new Error(`Line "${orderLine.name}": received quantity must be zero or more`)
    const qtyRejected = moneyNumber(rec.qtyRejected) ?? 0
    if (qtyRejected < 0) throw new Error(`Line "${orderLine.name}": rejected quantity must be zero or more`)
    if (qtyReceived - qtyRejected < 0) {
      throw new Error(`Line "${orderLine.name}": rejected (${qtyRejected}) cannot exceed what arrived (${qtyReceived})`)
    }
    const conditionRaw = str(rec.condition) ?? 'ok'
    const condition = ['ok', 'damaged', 'partial'].includes(conditionRaw) ? conditionRaw : 'ok'
    received.push({
      orderLineId: orderLine.id,
      orderLineName: orderLine.name,
      unit: orderLine.unit,
      unitPrice: orderLine.unitPrice,
      qtyOrdered: orderLine.qty,
      qtyReceived,
      qtyRejected,
      damageNote: str(rec.damageNote),
      condition,
    })
  }

  const note = str(payload.note)
  const photoCount = Math.max(0, Math.round(Number(payload.photoCount ?? 0)) || 0)
  const gpsLat = optNum(payload.gpsLat)
  const gpsLng = optNum(payload.gpsLng)
  const actor = await currentActor()
  const receivedBy = actor.name ?? str(payload.receivedBy) ?? 'Site team'

  await db.orderDeliveryLine.deleteMany({ where: { deliveryId: delivery.id } })
  await db.orderDeliveryLine.createMany({
    data: received.map((r) => ({
      deliveryId: delivery.id,
      orderLineId: r.orderLineId,
      qtyOrdered: r.qtyOrdered,
      qtyReceived: r.qtyReceived,
      qtyRejected: r.qtyRejected,
      damageNote: r.damageNote,
      condition: r.condition,
    })),
  })

  // ---- Site Store posting (spec §33/§34): movements + catalog stock clamp ----
  const inventoryResult = await postDeliveryToInventory(
    projectId,
    { supplierId: delivery.order.supplierId, orderCode: delivery.order.orderCode },
    received,
    receivedBy,
  )

  const short = received.filter((r) => r.qtyReceived < r.qtyOrdered)
  const orderCode = delivery.order.orderCode
  const supplierName = delivery.order.supplier.businessName
  const now = new Date()

  if (short.length > 0) {
    // Physical ground truth ≠ paperwork — flagged for review, never an accusation
    const first = short[0]
    const missing = Math.round((first.qtyOrdered - first.qtyReceived) * 100) / 100
    const rejectedTotal = received.reduce((s, r) => s + r.qtyRejected, 0)
    const autoSummary = `Ordered ${first.qtyOrdered} · Received ${first.qtyReceived} — ${missing} missing, flagged for review${rejectedTotal > 0 ? ` · ${Math.round(rejectedTotal * 100) / 100} rejected on inspection` : ''}`
    const fullNote =
      note
        ? `${autoSummary} — ${note}`
        : short.length > 1
          ? `${autoSummary} (${short.length} short lines in total — see per-line counts)`
          : autoSummary

    await db.orderDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'discrepancy',
        receivedAt: now,
        receivedBy,
        note: fullNote,
        photoCount,
        gpsLat,
        gpsLng,
      },
    })
    await db.purchaseOrder.update({ where: { id: delivery.order.id }, data: { status: 'delivered' } })

    const body = `${orderCode} (${supplierName}): ${autoSummary}. Photos: ${photoCount}. Reconcile with the supplier before releasing payment.`
    await notify(projectId, 'delivery.discrepancy', `Delivery discrepancy: ${orderCode}`, body, 'client', null)
    await notify(projectId, 'delivery.discrepancy', `Delivery discrepancy: ${orderCode}`, body, 'contractor', null)
    return { id: delivery.id, orderId: delivery.order.id, status: 'discrepancy', shortLines: short.length, inventory: inventoryResult }
  }

  await db.orderDelivery.update({
    where: { id: delivery.id },
    data: { status: 'received', receivedAt: now, receivedBy, note: note ?? 'All lines received in full', photoCount, gpsLat, gpsLng },
  })
  await db.purchaseOrder.update({ where: { id: delivery.order.id }, data: { status: 'delivered' } })
  await notify(
    projectId,
    'delivery.received',
    `Delivery received: ${orderCode}`,
    `${supplierName} delivered in full — verified on the ground by ${receivedBy}${photoCount ? ` with ${photoCount} photo(s)` : ''}.`,
    'contractor',
    null,
  )
  return { id: delivery.id, orderId: delivery.order.id, status: 'received', shortLines: 0, inventory: inventoryResult }
}

/**
 * Post delivery lines into the Site Store ledger (spec §33/§34):
 *   · net = qtyReceived − qtyRejected → StockMovement 'received'
 *     (InventoryItem upsert keyed material+unit+location 'Site Store',
 *      supplier from the PO, reference = the PO code)
 *   · qtyRejected → 'damaged' when condition==='damaged' or a damageNote is
 *     present, else 'returned'
 *   · CatalogItem.stockQty clamped to max(0, stock − qtyOrdered) for the
 *     supplier's matching item (name exact, then fuzzy; silent skip on no match)
 * Returns a plain summary for the audit trail + toasts.
 */
async function postDeliveryToInventory(
  projectId: string,
  order: { supplierId: string; orderCode: string },
  lines: Array<{
    orderLineName: string
    unit: string
    unitPrice: number
    qtyOrdered: number
    qtyReceived: number
    qtyRejected: number
    damageNote: string | null
    condition: string
  }>,
  recordedBy: string,
) {
  const movements: Array<{ materialName: string; type: string; quantity: number }> = []
  const catalogClamped: string[] = []

  for (const line of lines) {
    // 1) Site Store stock line (upsert keyed project+material+location)
    const item = await db.inventoryItem.upsert({
      where: { projectId_materialName_location: { projectId, materialName: line.orderLineName, location: 'Site Store' } },
      update: { unit: line.unit, supplierId: order.supplierId },
      create: { projectId, materialName: line.orderLineName, unit: line.unit, location: 'Site Store', supplierId: order.supplierId },
    })

    // 2) net received → 'received' movement (unitCost from the PO line)
    const net = Math.round((line.qtyReceived - line.qtyRejected) * 100) / 100
    if (net > 0) {
      await db.stockMovement.create({
        data: {
          projectId,
          inventoryItemId: item.id,
          type: 'received',
          quantity: net,
          unitCost: line.unitPrice,
          reference: order.orderCode,
          note: line.condition !== 'ok' || line.damageNote ? `Inspected ${line.condition}${line.damageNote ? ` — ${line.damageNote}` : ''}` : null,
          recordedBy,
        },
      })
      movements.push({ materialName: line.orderLineName, type: 'received', quantity: net })
    }

    // 3) rejected qty → 'damaged' or 'returned' movement
    if (line.qtyRejected > 0) {
      const rejectedType = line.condition === 'damaged' || line.damageNote ? 'damaged' : 'returned'
      await db.stockMovement.create({
        data: {
          projectId,
          inventoryItemId: item.id,
          type: rejectedType,
          quantity: line.qtyRejected,
          unitCost: null,
          reference: order.orderCode,
          note: line.damageNote ?? `Rejected on inspection (${line.condition})`,
          recordedBy,
        },
      })
      movements.push({ materialName: line.orderLineName, type: rejectedType, quantity: line.qtyRejected })
    }

    // 4) clamp the supplier's catalog stock for the ordered quantity (silent skip)
    const catalogItems = await db.catalogItem.findMany({ where: { supplierId: order.supplierId } })
    const hit = catalogItems.find((c) => c.name === line.orderLineName) ?? catalogItems.find((c) => materialMatches(c.name, line.orderLineName))
    if (hit) {
      await db.catalogItem.update({
        where: { id: hit.id },
        data: { stockQty: Math.max(0, Math.round((hit.stockQty - line.qtyOrdered) * 100) / 100) },
      })
      catalogClamped.push(hit.name)
    }
  }

  return { movementsPosted: movements.length, movements, catalogClamped }
}

/**
 * `delivery.dispatch` { deliveryId, note? } — the §26 driver-leg departure:
 * the truck with the ASSIGNED driver physically leaves for the site.
 * Requires driverName on the row (delivery.assign first — honest error
 * otherwise), stamps departedAt and keeps status 'dispatched' (deliveries
 * are born dispatched by order.dispatch; transit/arrive advance the leg).
 * An optional note still replaces the delivery note (v1 note-update
 * behavior rides along; it is no longer required).
 */
export async function updateDispatch(projectId: string, payload: Record<string, unknown>) {
  const deliveryId = str(payload.deliveryId)
  if (!deliveryId) throw new Error('deliveryId required')
  const delivery = await db.orderDelivery.findFirst({
    where: { id: deliveryId, order: { projectId } },
  })
  if (!delivery) throw new Error('Delivery not found in this project')
  if (delivery.status !== 'dispatched') {
    throw new Error(`Only DISPATCHED deliveries can depart — this one is ${delivery.status.toUpperCase()}`)
  }
  if (!str(delivery.driverName)) {
    throw new Error(
      'Assign a driver before dispatching the truck — delivery.assign { deliveryId, driverName, … } first (spec §26)',
    )
  }
  if (delivery.departedAt) {
    throw new Error(
      `Truck already departed at ${delivery.departedAt.toISOString()} — use delivery.transit / delivery.arrive for the next legs`,
    )
  }
  const note = str(payload.note)
  const updated = await db.orderDelivery.update({
    where: { id: delivery.id },
    data: { departedAt: new Date(), dispatchedAt: delivery.dispatchedAt ?? new Date(), note: note ?? delivery.note },
  })
  return { id: updated.id, departedAt: updated.departedAt, driverName: updated.driverName }
}

// ---------------- approval rules (Finder §11 — project-configurable) ----------------

const APPROVER_ROLES = ['supervisor', 'contractor', 'client', 'finance']

/** `rule.upsert` { id?, minAmount, maxAmount?, approverRole, priority?, active? }. */
export async function upsertRule(projectId: string, payload: Record<string, unknown>) {
  const minAmount = moneyNumber(payload.minAmount)
  if (minAmount === null) throw new Error('minAmount must be zero or more')
  const maxAmount = payload.maxAmount === undefined || payload.maxAmount === null ? null : moneyNumber(payload.maxAmount)
  if (maxAmount !== null && maxAmount <= minAmount) {
    throw new Error('maxAmount must be greater than minAmount (or empty for no ceiling)')
  }
  const approverRole = str(payload.approverRole)
  if (!approverRole || !APPROVER_ROLES.includes(approverRole)) {
    throw new Error(`approverRole must be one of ${APPROVER_ROLES.join(', ')}`)
  }
  const priority = payload.priority !== undefined ? optNum(payload.priority) : null
  const active = payload.active === undefined ? true : Boolean(payload.active)

  const id = str(payload.id)
  if (id) {
    const existing = await db.approvalRule.findFirst({ where: { id, projectId } })
    if (!existing) throw new Error('Approval rule not found in this project')
    const updated = await db.approvalRule.update({
      where: { id },
      data: {
        minAmount,
        maxAmount,
        approverRole,
        priority: priority !== null ? Math.round(priority) : existing.priority,
        active,
      },
    })
    return { id: updated.id }
  }
  const created = await db.approvalRule.create({
    data: {
      projectId,
      minAmount,
      maxAmount,
      approverRole,
      priority: priority !== null ? Math.round(priority) : 100,
      active,
    },
  })
  return { id: created.id }
}

/** `rule.delete` { id } — remove an approval band. */
export async function deleteRule(projectId: string, payload: Record<string, unknown>) {
  const id = str(payload.id)
  if (!id) throw new Error('Rule id required')
  const existing = await db.approvalRule.findFirst({ where: { id, projectId } })
  if (!existing) throw new Error('Approval rule not found in this project')
  await db.approvalRule.delete({ where: { id } })
  return { id }
}
