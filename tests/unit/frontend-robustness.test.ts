/**
 * FE-6 (issue #80) — use-mjengo data-flow invariants, pinned behaviorally:
 *
 *   · load sequencing: a LATE stale load()/switchProject() response (rapid
 *     P1→P2 switching over a slow link) must never overwrite the newer
 *     project's data / activeProjectId, nor fire its "Switched to …" toast;
 *   · dispatch honesty: a server refusal surfaces the REAL { error } text in
 *     the toast (money-tab's aiReview pattern, via the W7 store-level t());
 *     a refusal without a reason falls back to the generic copy;
 *   · offline-queue toast honesty: a network-level failure while online
 *     queues optimistically AND fires the queued copy — the caller's
 *     `online`-keyed toast would otherwise claim the ONLINE copy.
 *
 * The zustand store is imported real (persist is inert in node — no
 * localStorage); sonner and global fetch are mocked. Fetch mocks are
 * deferred-promise based so tests can resolve responses OUT OF ORDER,
 * which is exactly the race being pinned.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { toast } from 'sonner'
import { useMjengo } from '@/frontend/hooks/use-mjengo'

// ---------------- fetch test doubles ----------------

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

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Minimal ProjectPayload shape (only what load/switch/dispatch touch). */
function projectPayload(id: string, name = `Project ${id}`): Record<string, unknown> {
  return {
    project: { id, name, client: 'Client', location: 'Nairobi', status: 'active', shareToken: null },
    summary: { dayCount: 1, progressPct: 0, budgetSpent: 0, budgetTotal: 0, budgetSpentPct: 0, wagesUnpaid: 0, unackedAlerts: 0 },
    phases: [], workers: [], materials: [], deliveries: [], consumptions: [],
    transactions: [], notifications: [], alerts: [], photos: [], photoComments: [],
    milestones: [], variations: [], escrow: null, zones: [], payments: [],
    requests: [], quotes: [], orders: [], invoices: [], intel: { flags: {} },
  }
}

function resetStore(overrides: Record<string, unknown> = {}) {
  useMjengo.setState({
    data: projectPayload('p0', 'Base project') as never,
    projects: [],
    activeProjectId: 'p0',
    viewMode: 'owner',
    shareToken: null,
    clientRole: false,
    shareError: null,
    actionBusy: null,
    loading: false,
    online: true,
    syncing: false,
    outbox: [],
    syncHistory: [],
    lastSyncAt: null,
    ...overrides,
  } as never)
}

const state = () => useMjengo.getState()

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------- FE-6a · load/switchProject sequencing ----------------

describe('FE-6a: rapid switchProject — a late stale response is discarded', () => {
  it('the older project resolving AFTER the newer one cannot overwrite it', async () => {
    // P1's fetch is slow (resolves last); P2's is fast. Before the fix, P1's
    // late set() would flip data + activeProjectId back to the wrong project.
    const p1 = deferred<FakeRes>()
    const p2 = deferred<FakeRes>()
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      (url as string).includes('projectId=p1') ? p1.promise : p2.promise))

    const first = state().switchProject('p1')
    const second = state().switchProject('p2')

    p2.resolve(res(projectPayload('p2')))
    await second
    expect(state().data?.project.id).toBe('p2')
    expect(state().activeProjectId).toBe('p2')
    expect(state().loading).toBe(false)

    // The stale P1 response lands LAST — it must be ignored entirely.
    p1.resolve(res(projectPayload('p1')))
    await first
    expect(state().data?.project.id).toBe('p2') // ← the race this test pins
    expect(state().activeProjectId).toBe('p2')
    expect(state().loading).toBe(false)
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('Switched to Project p2')
    expect(toast.success).not.toHaveBeenCalledWith('Switched to Project p1')
  })

  it('a load() superseded mid-flight by a switch never clobbers the newer data', async () => {
    const listD = deferred<FakeRes>()   // /api/projects
    const projD = deferred<FakeRes>()   // /api/project?projectId=p0 (the load's)
    const swD = deferred<FakeRes>()     // /api/project?projectId=p2 (the switch's)
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const u = url as string
      if (u.startsWith('/api/projects')) return listD.promise
      if (u.includes('projectId=p2')) return swD.promise
      return projD.promise
    }))

    const loadPromise = state().load() // captures seq + activeProjectId p0
    const switchPromise = state().switchProject('p2') // bumps the sequence

    swD.resolve(res(projectPayload('p2')))
    await switchPromise
    expect(state().data?.project.id).toBe('p2')

    // The superseded load's responses resolve last — discarded.
    listD.resolve(res({ ok: true, projects: [{ id: 'p0' }, { id: 'p2' }] }))
    projD.resolve(res(projectPayload('p0')))
    await loadPromise
    expect(state().data?.project.id).toBe('p2') // ← stale load must not win
    expect(state().activeProjectId).toBe('p2')
  })
})

// ---------------- FE-6b · dispatch error surfacing ----------------

describe('FE-6b: dispatch surfaces the REAL server error', () => {
  it("a refused /api/actions call toasts 'Server refused: <server text>'", async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      res({ ok: false, error: 'Material "Cement" already exists in this project' }, false, 400)))

    const ok = await state().dispatch('material.create', { name: 'Cement', unit: 'bag', unitPrice: 120 }, 'Add material Cement')

    expect(ok).toBe(false)
    expect(state().outbox).toHaveLength(0) // refused ≠ queued
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('Server refused: Material "Cement" already exists in this project')
  })

  it('a refusal without a reason falls back to the generic apply-failed copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ ok: false }, false, 500)))

    const ok = await state().dispatch('material.create', { name: 'Sand', unit: 'ton', unitPrice: 80 }, 'Add material Sand')

    expect(ok).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('Could not apply your version')
  })

  it('a successful online dispatch applies data and fires NO toast of its own', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ ok: true, data: projectPayload('p0', 'Refreshed') })))

    const ok = await state().dispatch('material.create', { name: 'Cement', unit: 'bag', unitPrice: 120 }, 'Add material Cement')

    expect(ok).toBe(true)
    expect(state().outbox).toHaveLength(0)
    expect(toast.success).not.toHaveBeenCalled() // callers own the success copy
    expect(toast.error).not.toHaveBeenCalled()
  })
})

// ---------------- FE-6c · offline-queue toast honesty ----------------

describe('FE-6c: network-fail-while-online queues AND toasts the queued copy', () => {
  it('optimistically queues, applies locally, and says "Saved on-device — queued"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))

    const ok = await state().dispatch('material.create', { name: 'Cement', unit: 'bag', unitPrice: 120 }, 'Add material Cement')

    // The action is NOT lost — optimistic write + queue (spec §40 behavior).
    expect(ok).toBe(true)
    expect(state().outbox).toHaveLength(1)
    expect(state().outbox[0].syncStatus).toBe('pending')
    expect(state().outbox[0].type).toBe('material.create')
    expect(state().data?.materials).toHaveLength(1) // optimistic local write
    // The store's `online` flag is NOT flipped by dispatch (the browser's
    // online/offline events own that transition — flipping it here would
    // strand the store offline with no 'online' event to revive it).
    expect(state().online).toBe(true)
    // The honest queued copy — previously the caller keyed off `online`
    // (still true in its render closure) and toasted the ONLINE copy.
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('Saved on-device — queued (1)')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('the queued count grows with the queue (honest per-action copy)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))

    await state().dispatch('material.create', { name: 'Cement', unit: 'bag', unitPrice: 120 }, 'Add material Cement')
    await state().dispatch('material.create', { name: 'Sand', unit: 'ton', unitPrice: 80 }, 'Add material Sand')

    expect(state().outbox).toHaveLength(2)
    expect(toast.success).toHaveBeenLastCalledWith('Saved on-device — queued (2)')
  })
})
