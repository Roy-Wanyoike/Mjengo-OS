/**
 * #141 / audit FE-10 — the supplier dispatch LABEL, kept for the outbox.
 *
 * The decision this suite pins (recorded on the issue and next to the
 * SupplierDispatch type in supplier-portal.tsx): KEEP. When the issue was
 * filed the portal took the label and dropped it (`void label` — the only
 * dispatch path with no client-side action context); #128's supplier outbox
 * then landed and made the label load-bearing exactly as the issue
 * predicted, threading it portal → store → queued OutboxItem → per-item
 * sync sheet. This file pins that contract end to end so it cannot
 * silently regress to a drop:
 *
 *   · TYPE-LEVEL (enforced by `bunx tsc --noEmit` — tests/ sits OUTSIDE
 *     tsc's include, so the signature pins live IN src, the i18n
 *     dicts/check.ts Assert idiom, and are source-pinned here so they
 *     cannot be quietly deleted — the action-schemas meta-pattern):
 *     `SupplierDispatch` keeps its 4th parameter `label: string`, and the
 *     store's dispatch seam takes the SAME 4-tuple (the threading is
 *     compile-safe — dropping/retyping the label on either seam fails tsc);
 *   · BEHAVIORAL (real store, the supplier-outbox.test.ts conventions):
 *     every supplier action family's card-built label lands verbatim on
 *     its queued item, and the label NEVER leaves the client — neither the
 *     online /api/actions body nor the /api/sync drain body carries it
 *     (the server writes its own audit events: AC "no behavior change to
 *     server audit events");
 *   · RENDER + WIRING (source pins — the repo's node-only UI convention,
 *     cf. frontend-a11y.test.ts): the sync sheet renders `{item.label}`
 *     per item (AC "label surfaces in the supplier pending/sync UI"), the
 *     portal forwards it, the store queues it on the OutboxItem, every
 *     supplier call site passes a human label, and NO file under src/
 *     drops a label parameter again — hitting that pin means deciding:
 *     use the label or remove the param honestly (#141's own framing).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { useSupplierOutbox } from '@/frontend/hooks/use-supplier-outbox'

// ---------------- fetch test doubles (supplier-outbox.test.ts conventions) ----------------

interface FakeRes {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

const res = (body: unknown, ok = true, status = 200): FakeRes => ({
  ok,
  status,
  json: async () => body,
})

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

function resetSupplier(overrides: Record<string, unknown> = {}) {
  useSupplierOutbox.setState({
    online: true,
    syncing: false,
    outbox: [],
    syncHistory: [],
    lastSyncAt: null,
    dataVersion: 0,
    ...overrides,
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSupplier()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------- the decision, compile-pinned in src ----------------

describe('#141: the keep-decision is pinned at the type level (in src, enforced by tsc)', () => {
  it('supplier-portal.tsx carries the Assert/Equal guards — the SupplierDispatch 4-tuple keeps `label: string` and the store seam matches the portal seam', () => {
    const src = readSrc('src/frontend/mjengo/supplier/supplier-portal.tsx')
    // The compile-time guards exist (a guard quietly deleted fails HERE at
    // runtime — the action-schemas "satisfies probe" meta-pattern).
    expect(src).toContain('type Assert<T extends true> = T')
    expect(src).toContain('Parameters<SupplierDispatch>')
    expect(src).toContain("ReturnType<typeof useSupplierOutbox.getState>['dispatch']")
    expect(src).toContain('Parameters<SupplierStoreDispatch>')
    // The portal type itself, label and all.
    expect(src).toContain('  label: string,\n) => Promise<boolean>')
  })

  it('the store’s dispatch seam declares the label parameter (the load-bearing half — the queued item)', () => {
    const src = readSrc('src/frontend/hooks/use-supplier-outbox.ts')
    expect(src).toContain('    label: string,\n  ) => Promise<SupplierSendResult>')
  })
})

// ---------------- the label rides the outbox (behavioral, real store) ----------------

describe('#141: the label rides the queued outbox item (behavioral, real store)', () => {
  it('offline dispatch → every supplier action family’s card-built label lands verbatim on its queued item', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    resetSupplier({ online: false })

    // The exact label formats the supplier cards build (pinned at their
    // call sites below): quote submit/decline, order confirm/dispatch,
    // catalog edit.
    const cases: Array<[string, Record<string, unknown>, string | undefined, string]> = [
      ['quote.receive', { id: 'q-1', unitPrice: 120 }, 'proj-1', 'Quote submitted: RFQ-1001'],
      ['quote.decline', { id: 'q-2' }, 'proj-1', 'Quote declined: RFQ-1002'],
      ['order.confirm', { id: 'po-1' }, 'proj-1', 'order.confirm: PO-2026-000001'],
      ['order.dispatch', { id: 'po-2' }, 'proj-1', 'order.dispatch: PO-2026-000002'],
      ['catalog.upsert', { supplierId: 'sup-1', name: 'Cement' }, undefined, 'Catalog updated: Cement'],
    ]

    for (const [type, payload, projectId, label] of cases) {
      const result = await useSupplierOutbox.getState().dispatch(type, payload, projectId, label)
      expect(result).toBe('queued')
    }
    expect(fetchSpy).not.toHaveBeenCalled()

    // The end-to-end keep: the strings a supplier would read in the sync
    // sheet are exactly the strings the cards passed at dispatch.
    expect(useSupplierOutbox.getState().outbox.map((o) => o.label)).toEqual(cases.map((c) => c[3]))
  })

  it('online dispatch → the /api/actions body carries NO label (the server writes its own audit events)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ ok: true, result: { id: 'q-1' } })))

    const result = await useSupplierOutbox.getState().dispatch(
      'quote.receive',
      { id: 'q-1', unitPrice: 120 },
      'proj-1',
      'Quote submitted: RFQ-1001',
    )

    expect(result).toBe('applied')
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toEqual({ type: 'quote.receive', payload: { id: 'q-1', unitPrice: 120 }, projectId: 'proj-1' })
    expect(Object.keys(body)).not.toContain('label')
  })

  it('the /api/sync drain body carries NO label either — the label never leaves the client on any transport', async () => {
    resetSupplier({ online: false })
    await useSupplierOutbox.getState().dispatch(
      'order.confirm',
      { id: 'po-1' },
      'proj-1',
      'order.confirm: PO-2026-000001',
    )

    vi.stubGlobal('fetch', vi.fn(async () => res({
      ok: true,
      results: [{ id: useSupplierOutbox.getState().outbox[0].id, ok: true }],
      data: null,
      projects: [],
    })))
    await useSupplierOutbox.getState().syncNow()

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/sync')
    const body = JSON.parse(String(init.body)) as { actions: Array<Record<string, unknown>> }
    expect(body.actions).toHaveLength(1)
    expect(body.actions[0]).toEqual({
      id: expect.any(String),
      type: 'order.confirm',
      payload: { id: 'po-1' },
      projectId: 'proj-1',
    })
    expect(Object.keys(body.actions[0])).not.toContain('label')
  })
})

// ---------------- render + wiring source pins ----------------

describe('#141: the label surfaces in the supplier pending/sync UI + wiring (source pins)', () => {
  it('the sync sheet renders each queued item’s label — the per-item human string (the keep decision’s user-facing half)', () => {
    const src = readSrc('src/frontend/mjengo/supplier/supplier-sync-control.tsx')
    expect(src).toContain('{item.label}')
    // …inside the per-item row, beside the machine type + queue age.
    expect(src).toContain('{item.type} ·')
  })

  it('the portal threads the label into the store dispatch (the pre-#128 drop is gone)', () => {
    const src = readSrc('src/frontend/mjengo/supplier/supplier-portal.tsx')
    expect(src).toContain('.dispatch(type, actionPayload, projectId, label)')
  })

  it('the store queues the label ON the OutboxItem (the load-bearing seam)', () => {
    const src = readSrc('src/frontend/hooks/use-supplier-outbox.ts')
    const queueBranch = src.slice(src.indexOf('const item: OutboxItem = {'))
    expect(queueBranch.slice(0, 300)).toContain('label,')
  })

  it('every supplier call site passes a human-readable label (quote/order/catalog cards)', () => {
    const quote = readSrc('src/frontend/mjengo/supplier/supplier-quote-card.tsx')
    expect(quote).toContain('`Quote submitted: ${quote.requestCode}`')
    expect(quote).toContain('`Quote declined: ${quote.requestCode}`')
    expect(readSrc('src/frontend/mjengo/supplier/supplier-order-card.tsx')).toContain('`${type}: ${order.orderCode}`')
    expect(readSrc('src/frontend/mjengo/supplier/supplier-catalog.tsx')).toContain('`Catalog updated: ${item.name}`')
  })

  it('no file under src/ drops a label parameter — hitting this pin means deciding: use the label or remove the param honestly', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(path)
        else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && readFileSync(path, 'utf8').includes('void label')) {
          offenders.push(path)
        }
      }
    }
    walk(fileURLToPath(new URL('../../src', import.meta.url)))
    expect(offenders).toEqual([])
  })
})
