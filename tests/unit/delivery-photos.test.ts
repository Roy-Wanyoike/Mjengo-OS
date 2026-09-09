/**
 * Delivery evidence-photo invariants (issue "Photo attachments on delivery
 * verification") — src/backend/modules/supply/{service,repository,policy}.ts.
 *
 * delivery.receive accepts attachment ids from PRIOR /api/upload calls
 * (payload.photoIds + payload.lines[].photoIds), validates them fail-closed
 * (exist · THIS project · image), links them as DeliveryPhoto rows (line
 * refs scoped to the fresh OrderDeliveryLine — the discrepancy evidence),
 * and photoCount becomes the honest count of real links (a client-supplied
 * count is ignored). Pinned here:
 *  · link-on-verify: full receive links whole-delivery photos, discrepancy
 *    receive scopes that line's photos to the per-line count row;
 *  · the replay query (loadSupplySlice) returns the links WITH their
 *    Attachment rows (storageKey/mimeType), scoped exactly as recorded;
 *  · idempotency: re-running the linker with the same ids links nothing new
 *    (pre-filter + the unique(deliveryId, attachmentId) index the stub
 *    enforces like SQLite), and a re-RECEIVE is refused by the status guard —
 *    no path can double-apply the verification;
 *  · validation is fail-closed BEFORE any rows are written (unknown id /
 *    foreign-project file / non-image attachment / non-array) — nothing
 *    records on a bad photo set;
 *  · honest counts: photoCount mirrors the links (a typed number is ignored);
 *  · role policy: WHO may receive (and thus attach) is decided upstream —
 *    supplyCan pins the site-team matrix; the service itself does no role
 *    check (it runs for any caller the guards let through) but DOES enforce
 *    attachment ownership — a foreign project's file is never attached.
 *
 * @/backend/lib/db is swapped for an in-memory stub (the notify-channels /
 * outbox-versions pattern). currentActor() resolves null outside a request
 * scope, so receivedBy falls back to the payload (exercised on purpose).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    seq: 0,
    orders: new Map<string, Row>(), // PurchaseOrder
    orderLines: new Map<string, Row>(), // PurchaseOrderLine
    suppliers: new Map<string, Row>(),
    deliveries: new Map<string, Row>(), // OrderDelivery
    deliveryLines: new Map<string, Row>(), // OrderDeliveryLine
    attachments: new Map<string, Row>(), // Attachment
    deliveryPhotos: new Map<string, Row>(), // DeliveryPhoto
    inventoryItems: new Map<string, Row>(), // upsert keyed project+material+location
    stockMovements: [] as Row[],
    notifications: [] as Row[],
    writes: { lineDeleteMany: 0, deliveryUpdate: 0, photoCreateMany: 0 },
    reset() {
      state.seq = 0
      for (const m of [state.orders, state.orderLines, state.suppliers, state.deliveries, state.deliveryLines, state.attachments, state.deliveryPhotos, state.inventoryItems]) m.clear()
      state.stockMovements = []
      state.notifications = []
      state.writes = { lineDeleteMany: 0, deliveryUpdate: 0, photoCreateMany: 0 }
    },
  }

  const id = (prefix: string) => `${prefix}_${++state.seq}`

  /** Just enough of Prisma's where: equality, { in: [...] }, relation order.projectId. */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'order') {
        const po = state.orders.get(row.orderId as string)
        if (!po || !matches(po, cond as Row)) return false
        continue
      }
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(row[key])) return false
          continue
        }
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  const db = {
    __state: state,
    // ---- receiveDelivery path ----
    orderDelivery: {
      async findFirst({ where, include }: { where: Row; include?: Row }) {
        const row = [...state.deliveries.values()].find((r) => matches(r, where))
        if (!row) return null
        if (!include) return { ...row }
        const po = state.orders.get(row.orderId as string) as Row
        const supplier = state.suppliers.get(po.supplierId as string) as Row
        return {
          ...row,
          order: {
            ...po,
            lines: [...state.orderLines.values()].filter((l) => l.orderId === po.id),
            supplier: { ...supplier },
          },
          lines: [...state.deliveryLines.values()].filter((l) => l.deliveryId === row.id),
        }
      },
      async update({ where, data }: { where: { id: string }; data: Row }) {
        const row = state.deliveries.get(where.id)
        if (!row) throw new Error(`stub: orderDelivery ${where.id} not found`)
        Object.assign(row, data)
        state.writes.deliveryUpdate++
        return { ...row }
      },
    },
    orderDeliveryLine: {
      async deleteMany({ where }: { where: Row }) {
        const doomed = [...state.deliveryLines.values()].filter((r) => matches(r, where))
        for (const r of doomed) state.deliveryLines.delete(r.id as string)
        state.writes.lineDeleteMany++
        return { count: doomed.length }
      },
      async createMany({ data }: { data: Row[] }) {
        for (const d of data) {
          const row = { id: id('dl'), ...d }
          state.deliveryLines.set(row.id as string, row)
        }
        return { count: data.length }
      },
      async findMany({ where }: { where: Row }) {
        return [...state.deliveryLines.values()].filter((r) => matches(r, where)).map((r) => ({ ...r }))
      },
    },
    attachment: {
      async findMany({ where }: { where: Row }) {
        return [...state.attachments.values()].filter((r) => matches(r, where)).map((r) => ({ ...r }))
      },
    },
    deliveryPhoto: {
      async createMany({ data }: { data: Row[] }) {
        state.writes.photoCreateMany++
        for (const d of data) {
          const key = `${d.deliveryId}:${d.attachmentId}`
          for (const existing of state.deliveryPhotos.values()) {
            if (`${existing.deliveryId}:${existing.attachmentId}` === key) {
              // SQLite would raise P2002 on the unique index — the service
              // pre-filters and catches this; the stub keeps it honest.
              throw new Error(`Unique constraint failed: DeliveryPhoto_deliveryId_attachmentId_key (${key})`)
            }
          }
          const row = { id: id('dp'), createdAt: new Date(), ...d }
          state.deliveryPhotos.set(row.id as string, row)
        }
        return { count: data.length }
      },
      async findMany({ where }: { where: Row }) {
        return [...state.deliveryPhotos.values()].filter((r) => matches(r, where)).map((r) => ({ ...r }))
      },
      async count({ where }: { where: Row }) {
        return [...state.deliveryPhotos.values()].filter((r) => matches(r, where)).length
      },
    },
    purchaseOrder: {
      async update({ where, data }: { where: { id: string }; data: Row }) {
        const row = state.orders.get(where.id)
        if (!row) throw new Error(`stub: purchaseOrder ${where.id} not found`)
        Object.assign(row, data)
        return { ...row }
      },
      // The replay path: loadSupplySlice includes deliveries + lines + photos
      // (+ each photo's attachment) exactly as the repository asks.
      async findMany({ where, include }: { where: Row; include?: Row }) {
        return [...state.orders.values()]
          .filter((r) => matches(r, where))
          .map((o) => ({
            ...o,
            lines: [...state.orderLines.values()].filter((l) => l.orderId === o.id),
            supplier: { ...(state.suppliers.get(o.supplierId as string) as Row) },
            request: null,
            deliveries: include?.deliveries
              ? [...state.deliveries.values()]
                  .filter((d) => d.orderId === o.id)
                  .map((d) => ({
                    ...d,
                    lines: [...state.deliveryLines.values()].filter((l) => l.deliveryId === d.id),
                    photos: [...state.deliveryPhotos.values()]
                      .filter((p) => p.deliveryId === d.id)
                      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
                      .map((p) => ({
                        ...p,
                        attachment: { ...(state.attachments.get(p.attachmentId as string) as Row) },
                      })),
                  }))
              : [],
          }))
      },
    },
    notification: {
      async create({ data }: { data: Row }) {
        const row = { id: id('notif'), ...data }
        state.notifications.push(row)
        return { ...row }
      },
    },
    // ---- Site Store posting (postDeliveryToInventory) ----
    inventoryItem: {
      async upsert({ where, update, create }: { where: Row; update: Row; create: Row }) {
        const composite = where.projectId_materialName_location as { projectId: string; materialName: string; location: string }
        const key = `${composite.projectId}|${composite.materialName}|${composite.location}`
        const row = state.inventoryItems.get(key)
        if (row) {
          Object.assign(row, update)
          return { ...row }
        }
        const created = { id: id('inv'), ...create }
        state.inventoryItems.set(key, created)
        return { ...created }
      },
    },
    stockMovement: {
      async create({ data }: { data: Row }) {
        const row = { id: id('sm'), ...data }
        state.stockMovements.push(row)
        return { ...row }
      },
    },
    catalogItem: {
      async findMany() { return [] },
      async update() { return {} },
    },
    // ---- loadSupplySlice's other reads (out of scope — empty) ----
    supplier: { async findMany() { return [] } },
    materialRequest: { async findMany() { return [] } },
    approvalRule: { async findMany() { return [] } },
    approval: { async findMany() { return [] } },
    quote: { async findMany() { return [] } },
    savedSupplier: { async findMany() { return [] } },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import {
  collectDeliveryPhotoRefs,
  linkDeliveryPhotos,
  receiveDelivery,
  type DeliveryPhotoRefs,
} from '@/backend/modules/supply/service'
import { loadSupplySlice } from '@/backend/modules/supply/repository'
import { supplyCan } from '@/backend/modules/supply/policy'

const state = (db as unknown as { __state: {
  deliveries: Map<string, Record<string, unknown>>
  deliveryLines: Map<string, Record<string, unknown>>
  deliveryPhotos: Map<string, Record<string, unknown>>
  attachments: Map<string, Record<string, unknown>>
  orders: Map<string, Record<string, unknown>>
  orderLines: Map<string, Record<string, unknown>>
  suppliers: Map<string, Record<string, unknown>>
  notifications: Array<Record<string, unknown>>
  stockMovements: Array<Record<string, unknown>>
  inventoryItems: Map<string, Record<string, unknown>>
  writes: { lineDeleteMany: number; deliveryUpdate: number; photoCreateMany: number }
  reset: () => void
} }).__state

const P1 = 'proj-1'
const P2 = 'proj-2'

/** Seed one dispatched delivery under P1 with two PO lines + photo attachments. */
function seed(deliveryId = 'del_1') {
  state.orders.set('po_1', {
    id: 'po_1', orderCode: 'PO-2026-000101', projectId: P1, supplierId: 'sup_1',
    status: 'delivering', subtotal: 1000, deliveryFee: 0, total: 1000,
    paymentSource: 'client', createdByRole: 'contractor', note: null,
    createdAt: new Date(), updatedAt: new Date(),
  })
  state.suppliers.set('sup_1', { id: 'sup_1', businessName: 'Kisumu Builders', createdAt: new Date() })
  state.orderLines.set('pl_1', { id: 'pl_1', orderId: 'po_1', name: 'Cement', unit: 'bag', qty: 100, unitPrice: 10, lineTotal: 1000 })
  state.orderLines.set('pl_2', { id: 'pl_2', orderId: 'po_1', name: 'Ballast', unit: 'tonne', qty: 20, unitPrice: 0, lineTotal: 0 })
  state.deliveries.set(deliveryId, {
    id: deliveryId, orderId: 'po_1', status: 'dispatched', dispatchedAt: new Date(),
    receivedAt: null, receivedBy: null, note: null, photoUrls: '[]', photoCount: 0,
    gpsLat: null, gpsLng: null, createdAt: new Date(),
    driverName: null, driverPhone: null, vehicleReg: null, etaAt: null, departedAt: null, arrivedAt: null,
  })
  // Attachments as /api/upload document mode would leave them: image files on
  // THIS project, plus the honest fixtures validation must reject.
  state.attachments.set('att_a', {
    id: 'att_a', entityType: 'order_delivery', entityId: deliveryId, fileName: 'gate.jpg',
    storageKey: '/docs/doc-1.jpg', kind: 'other_doc', uploadedBy: 'clerk@site.dev', projectId: P1,
    category: 'other', mimeType: 'image/jpeg', sizeBytes: 2048, title: 'delivery evidence',
    createdAt: new Date(), reviewStatus: 'pending',
  })
  state.attachments.set('att_b', {
    id: 'att_b', entityType: 'order_delivery', entityId: deliveryId, fileName: 'bags.png',
    storageKey: '/docs/doc-2.png', kind: 'other_doc', uploadedBy: 'clerk@site.dev', projectId: P1,
    category: 'other', mimeType: 'image/png', sizeBytes: 4096, title: 'delivery evidence',
    createdAt: new Date(), reviewStatus: 'pending',
  })
  state.attachments.set('att_pdf', {
    id: 'att_pdf', entityType: 'document', entityId: 'unattached', fileName: 'delivery-note.pdf',
    storageKey: '/docs/doc-3.pdf', kind: 'other_doc', uploadedBy: 'clerk@site.dev', projectId: P1,
    category: 'other', mimeType: 'application/pdf', sizeBytes: 8192, title: null,
    createdAt: new Date(), reviewStatus: 'pending',
  })
  state.attachments.set('att_foreign', {
    id: 'att_foreign', entityType: 'order_delivery', entityId: 'del_9', fileName: 'other-site.jpg',
    storageKey: '/docs/doc-4.jpg', kind: 'other_doc', uploadedBy: 'x@y.dev', projectId: P2,
    category: 'other', mimeType: 'image/jpeg', sizeBytes: 1024, title: null,
    createdAt: new Date(), reviewStatus: 'pending',
  })
  return deliveryId
}

const links = () => [...state.deliveryPhotos.values()]
const lineFor = (orderLineId: string) =>
  [...state.deliveryLines.values()].find((l) => l.orderLineId === orderLineId)

beforeEach(() => {
  state.reset()
})

describe('link-on-verify — receive links real attachments', () => {
  it('full receive: whole-delivery photos link, photoCount mirrors the links, result carries photosLinked', async () => {
    const deliveryId = seed()
    const result = await receiveDelivery(P1, {
      deliveryId,
      lines: [
        { orderLineId: 'pl_1', qtyReceived: 100 },
        { orderLineId: 'pl_2', qtyReceived: 20 },
      ],
      photoIds: ['att_a', 'att_b'],
      receivedBy: 'Foreman Otieno',
      gpsLat: -1.29, gpsLng: 36.82,
    })

    expect(result.status).toBe('received')
    expect(result.photosLinked).toBe(2)
    expect(links()).toHaveLength(2)
    for (const link of links()) {
      expect(link.deliveryId).toBe(deliveryId)
      expect(link.deliveryLineId).toBeNull() // whole-delivery evidence
      expect(link.attachedBy).toBe('Foreman Otieno')
    }
    const delivery = state.deliveries.get(deliveryId) as Record<string, unknown>
    expect(delivery.status).toBe('received')
    expect(delivery.photoCount).toBe(2) // honest count — real links
    // Site Store still posted (photo wiring must not disturb the store ledger)
    expect(state.stockMovements.length).toBeGreaterThan(0)
    // Notification copy carries the REAL count
    expect(String(state.notifications[0].body)).toContain('2 photo(s)')
  })

  it('legacy typed photoCount is ignored — the count is derived from links', async () => {
    const deliveryId = seed()
    const result = await receiveDelivery(P1, {
      deliveryId,
      lines: [{ orderLineId: 'pl_1', qtyReceived: 100 }, { orderLineId: 'pl_2', qtyReceived: 20 }],
      photoCount: 99, // the old dishonest field — never trusted again
    })
    expect(result.photosLinked).toBe(0)
    expect((state.deliveries.get(deliveryId) as Record<string, unknown>).photoCount).toBe(0)
    expect(links()).toHaveLength(0)
  })

  it('no photos: byte-identical legacy behavior (no link reads, no photo writes)', async () => {
    const deliveryId = seed()
    const result = await receiveDelivery(P1, {
      deliveryId,
      lines: [{ orderLineId: 'pl_1', qtyReceived: 100 }, { orderLineId: 'pl_2', qtyReceived: 20 }],
    })
    expect(result.status).toBe('received')
    expect(state.writes.photoCreateMany).toBe(0)
    expect(links()).toHaveLength(0)
  })
})

describe('discrepancy evidence — a line\u2019s photos ride its count record', () => {
  it('short + damaged line: its photoIds scope to that line\u2019s OrderDeliveryLine row', async () => {
    const deliveryId = seed()
    const result = await receiveDelivery(P1, {
      deliveryId,
      lines: [
        {
          orderLineId: 'pl_1',
          qtyReceived: 96,
          qtyRejected: 4,
          condition: 'damaged',
          damageNote: '4 bags set by rain',
          photoIds: ['att_a'], // the damage evidence
        },
        { orderLineId: 'pl_2', qtyReceived: 20 },
      ],
      photoIds: ['att_b'], // whole-delivery evidence
      receivedBy: 'Clerk Wanjiku',
    })

    expect(result.status).toBe('discrepancy')
    expect(result.shortLines).toBe(1)
    expect(result.photosLinked).toBe(2)

    const cementLine = lineFor('pl_1')
    expect(cementLine).toBeTruthy()
    const attALink = links().find((l) => l.attachmentId === 'att_a')
    expect(attALink?.deliveryLineId).toBe(cementLine?.id) // scoped to the line's count
    const attBLink = links().find((l) => l.attachmentId === 'att_b')
    expect(attBLink?.deliveryLineId).toBeNull() // whole-delivery

    expect((state.deliveries.get(deliveryId) as Record<string, unknown>).photoCount).toBe(2)
    // both discrepancy notifications carry the real photo count
    expect(state.notifications.filter((n) => String(n.kind) === 'delivery.discrepancy')).toHaveLength(2)
    for (const n of state.notifications) {
      if (n.kind === 'delivery.discrepancy') expect(String(n.body)).toContain('Photos: 2')
    }
  })
})

describe('replay — the payload query returns the attachments', () => {
  it('loadSupplySlice ships every delivery\u2019s photos with their Attachment rows, scoped as recorded', async () => {
    const deliveryId = seed()
    await receiveDelivery(P1, {
      deliveryId,
      lines: [
        { orderLineId: 'pl_1', qtyReceived: 96, qtyRejected: 4, condition: 'damaged', photoIds: ['att_a'] },
        { orderLineId: 'pl_2', qtyReceived: 20 },
      ],
      photoIds: ['att_b'],
    })

    const slice = await loadSupplySlice(P1)
    const order = slice.orders.find((o) => o.id === 'po_1')
    expect(order).toBeTruthy()
    const delivery = order!.deliveries.find((d) => d.id === deliveryId)!
    expect(delivery.lines).toHaveLength(2)
    expect(delivery.photos).toHaveLength(2)

    const cementLineId = lineFor('pl_1')?.id
    const lineScoped = delivery.photos.find((p) => p.attachmentId === 'att_a')
    expect(lineScoped?.deliveryLineId).toBe(cementLineId)
    expect(lineScoped?.attachment.storageKey).toBe('/docs/doc-1.jpg') // the URL the UI renders
    expect(lineScoped?.attachment.mimeType).toBe('image/jpeg')

    const general = delivery.photos.find((p) => p.attachmentId === 'att_b')
    expect(general?.deliveryLineId).toBeNull()
    expect(general?.attachment.fileName).toBe('bags.png')
  })
})

describe('idempotency — re-linking can never duplicate evidence', () => {
  it('re-running the linker with the same ids links nothing new (unique pair enforced)', async () => {
    const deliveryId = seed()
    await receiveDelivery(P1, {
      deliveryId,
      lines: [
        { orderLineId: 'pl_1', qtyReceived: 96, qtyRejected: 4, condition: 'damaged', photoIds: ['att_a'] },
        { orderLineId: 'pl_2', qtyReceived: 20 },
      ],
      photoIds: ['att_b'],
    })
    expect(links()).toHaveLength(2)

    // The same ids submitted again (a replayed payload / a re-verify attempt
    // racing the status guard): the pre-filter skips what is already linked.
    const refs: DeliveryPhotoRefs = await collectDeliveryPhotoRefs(P1, { photoIds: ['att_b'] }, [
      { orderLineId: 'pl_1', qtyReceived: 96, photoIds: ['att_a'] },
    ])
    const map = new Map([[lineFor('pl_1')!.id as string, lineFor('pl_1')!.id as string]])
    const count = await linkDeliveryPhotos(deliveryId, refs, map, 'Clerk Wanjiku')
    expect(count).toBe(2)
    expect(links()).toHaveLength(2) // no duplicates
    // The unique index the stub enforces keeps a raw double-write impossible:
    await expect(
      (db as unknown as { deliveryPhoto: { createMany: (a: unknown) => Promise<unknown> } }).deliveryPhoto.createMany({
        data: [{ deliveryId, attachmentId: 'att_a', deliveryLineId: null, attachedBy: 'x' }],
      }),
    ).rejects.toThrow(/Unique constraint/)
  })

  it('a re-RECEIVE is refused by the status guard — the verification cannot double-apply', async () => {
    const deliveryId = seed()
    const payload = {
      deliveryId,
      lines: [
        { orderLineId: 'pl_1', qtyReceived: 96, qtyRejected: 4, condition: 'damaged', photoIds: ['att_a'] },
        { orderLineId: 'pl_2', qtyReceived: 20 },
      ],
      photoIds: ['att_b'],
    }
    await receiveDelivery(P1, payload)
    await expect(receiveDelivery(P1, payload)).rejects.toThrow(/already (RECEIVED|DISCREPANCY)/)
    expect(links()).toHaveLength(2) // untouched by the refused replay
    // and the Site Store did not double-post
    const cementItem = [...state.inventoryItems.values()].find((i) => i.materialName === 'Cement')
    const netCement = state.stockMovements
      .filter((m) => m.type === 'received' && m.inventoryItemId === cementItem?.id)
      .reduce((s, m) => s + (m.quantity as number), 0)
    expect(netCement).toBe(92) // 96 − 4 rejected, posted ONCE
  })
})

describe('validation — fail-closed BEFORE any delivery rows are written', () => {
  it.each([
    ['unknown attachment id', { photoIds: ['att_missing'] }, /not found — upload it via \/api\/upload/],
    ['foreign-project attachment', { photoIds: ['att_foreign'] }, /belongs to another project/],
    ['non-image attachment', { photoIds: ['att_pdf'] }, /is not a photo/],
    ['non-array photoIds', { photoIds: 'att_a' }, /must be an array/],
  ])('%s', async (_label, extra, pattern) => {
    const deliveryId = seed()
    await expect(
      receiveDelivery(P1, {
        deliveryId,
        lines: [{ orderLineId: 'pl_1', qtyReceived: 100 }, { orderLineId: 'pl_2', qtyReceived: 20 }],
        ...extra,
      }),
    ).rejects.toThrow(pattern as RegExp)
    // Nothing recorded: no line rewrite, no status flip, no links
    expect(state.writes.lineDeleteMany).toBe(0)
    expect(state.writes.deliveryUpdate).toBe(0)
    expect(links()).toHaveLength(0)
    expect((state.deliveries.get(deliveryId) as Record<string, unknown>).status).toBe('dispatched')
  })

  it('cap: an absurd photo set is refused up front', async () => {
    const deliveryId = seed()
    const many = Array.from({ length: 25 }, (_, i) => `att_${i}`)
    await expect(
      receiveDelivery(P1, {
        deliveryId,
        lines: [{ orderLineId: 'pl_1', qtyReceived: 100 }, { orderLineId: 'pl_2', qtyReceived: 20 }],
        photoIds: many,
      }),
    ).rejects.toThrow(/At most 24 evidence photos/)
  })

  it('an id referenced both whole-delivery AND on a line is line-scoped (most specific wins)', async () => {
    const deliveryId = seed()
    const refs = await collectDeliveryPhotoRefs(P1, { photoIds: ['att_a'] }, [
      { orderLineId: 'pl_1', qtyReceived: 100, photoIds: ['att_a'] },
    ])
    expect(refs.delivery).toEqual([]) // att_a moved to the line scope
    expect(refs.byOrderLine.get('pl_1')).toEqual(['att_a'])
  })
})

describe('role policy — who may attach is decided upstream; the service enforces ownership', () => {
  it('supplyCan: only the site team may run delivery.receive (the guards\u2019 matrix)', () => {
    for (const role of ['contractor', 'supervisor', 'procurement', 'finance', 'admin'] as const) {
      expect(supplyCan(role, 'delivery.receive')).toBe(true)
    }
    expect(supplyCan('client', 'delivery.receive')).toBe(false)
    expect(supplyCan('share_client' as 'client', 'delivery.receive')).toBe(false)
  })

  it('the service runs for any caller the guards let through (no role re-check) — but a foreign project\u2019s file is never attached', async () => {
    // No session context at all here (currentActor → null, receivedBy falls
    // back): the service trusts the upstream guards and links valid refs.
    const deliveryId = seed()
    const result = await receiveDelivery(P1, {
      deliveryId,
      lines: [{ orderLineId: 'pl_1', qtyReceived: 100 }, { orderLineId: 'pl_2', qtyReceived: 20 }],
      photoIds: ['att_a'],
    })
    expect(result.photosLinked).toBe(1)
    expect((state.deliveries.get(deliveryId) as Record<string, unknown>).receivedBy).toBe('Site team')

    // Ownership is a SERVICE-level rule, independent of any role:
    const deliveryId2 = seed('del_2')
    await expect(
      receiveDelivery(P1, {
        deliveryId: deliveryId2,
        lines: [{ orderLineId: 'pl_1', qtyReceived: 100 }, { orderLineId: 'pl_2', qtyReceived: 20 }],
        photoIds: ['att_foreign'],
      }),
    ).rejects.toThrow(/belongs to another project/)
  })
})

