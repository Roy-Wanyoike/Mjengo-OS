/**
 * #191 — session-expiry drain invariants, pinned behaviorally on the REAL
 * use-mjengo store (same conventions as frontend-robustness.test.ts: sonner
 * and global fetch are mocked; the zustand store is imported real — persist
 * is inert in node, no localStorage).
 *
 * The stranded-outbox scenario, end to end:
 *   · offline with an expired session → mutations queue (existing behavior);
 *   · connectivity returns → setOnline(true) toasts "Back online — syncing"
 *     and drains (existing behavior);
 *   · POST /api/sync answers 401 → the OLD `json?.ok`-falsy branch silently
 *     re-queued everything as 'pending': no toast, no marker, and after
 *     re-login nothing ever drained again (no offline→online transition; the
 *     Sync trigger was disabled while online with a pending-only queue).
 *
 * Pinned here:
 *   · 401 drain → the batch is marked failed + authBlocked with a localized
 *     session-expired lastError and ONE honest error toast — no data loss,
 *     nothing silently 'pending';
 *   · other server-level refusals (500/429/403, with or without a reason) →
 *     items failed with the surfaced reason + toast (the old silent
 *     re-queue-to-pending path is gone);
 *   · a TRUE network-level failure still re-queues as 'pending' (the
 *     never-drop invariant, regression-guarded);
 *   · drainAfterAuth() — the re-login recovery: auth-blocked items re-queue
 *     and the pending queue flushes once when online; no-op when offline or
 *     with nothing pending;
 *   · wiring source pins: app.tsx drains once per authenticated session
 *     instance, the Sync trigger is enabled whenever unresolved items exist,
 *     the login screen acknowledges queued actions, and every new i18n key
 *     exists in BOTH dictionaries.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { toast } from 'sonner'
import { useMjengo, type OutboxItem } from '@/frontend/hooks/use-mjengo'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import { translate } from '@/frontend/i18n/provider'

// ---------------- fetch test doubles (frontend-robustness conventions) ----------------

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

/** A queued outbox item in the §40 'pending' state (pre-drain shape). */
function queuedItem(n: number): OutboxItem {
  return {
    id: `q-${n}`,
    type: 'attendance.checkin',
    payload: { workerId: `w-${n}` },
    label: `Check in worker ${n}`,
    createdAt: Date.now(),
    projectId: 'p0',
    syncStatus: 'pending',
    retryCount: 0,
  }
}

function resetStore(overrides: Record<string, unknown> = {}) {
  useMjengo.setState({
    online: true,
    syncing: false,
    outbox: [queuedItem(1), queuedItem(2)],
    syncHistory: [],
    lastSyncAt: null,
    ...overrides,
  } as never)
}

const state = () => useMjengo.getState()
const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------- 401: the auth-blocked marking ----------------

describe('#191: a 401 drain marks the outbox auth-blocked (never silent, never lost)', () => {
  it('401 → every sent item failed + authBlocked + localized lastError + ONE error toast; items retained', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      res({ error: 'Sign in required' }, false, 401)))

    const result = await state().syncNow()

    // The drain reports the honest batch outcome…
    expect(result).toEqual({ synced: 0, failed: 2, conflicts: 0 })
    // …and every item is marked failed + authBlocked with the localized
    // session-expired copy as lastError (retryCount consumed one attempt).
    expect(state().outbox).toHaveLength(2) // no data loss
    for (const o of state().outbox) {
      expect(o.syncStatus).toBe('failed')
      expect(o.authBlocked).toBe(true)
      expect(o.lastError).toBe(translate(enDict, 'sync.authBlockedItem'))
      expect(o.retryCount).toBe(1)
    }
    expect(state().syncing).toBe(false)
    // One honest toast — the OLD behavior had none (silent re-queue).
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(translate(enDict, 'sync.sessionExpired', { count: 2 }))
    // The drain itself was attempted against /api/sync.
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/sync', expect.anything())
  })

  it('the Kiswahili copies exist and interpolate (store-level t() seam)', async () => {
    // The store reads the locale imperatively; pin the SW dictionary side of
    // the same keys so the EN+SW parity gate has behavioral teeth.
    expect(translate(swDict, 'sync.sessionExpired', { count: 5 }))
      .toBe('Session imeisha — vitendo 5 vilivyowekwa foleni viko salama na vita sawazishwa baada ya kujiandikisha')
    expect(translate(swDict, 'sync.authBlockedItem')).toBe('Session imeisha — jiandikishe ili kusawazisha')
    expect(translate(swDict, 'login.queuedNote', { count: 3 }))
      .toBe('Vitendo 3 vilivyohifadhiwa kwenye kifaa hiki vita sawazishwa utakapojiandikisha.')
  })
})

// ---------------- other server-level refusals: surfaced, not silent ----------------

describe('#191: a non-401 server-level refusal is surfaced (nothing silently pending)', () => {
  it('500 { error } → items failed with the server reason + drain-failed toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      res({ error: 'Sync failed' }, false, 500)))

    const result = await state().syncNow()

    expect(result).toEqual({ synced: 0, failed: 2, conflicts: 0 })
    for (const o of state().outbox) {
      expect(o.syncStatus).toBe('failed')
      expect(o.authBlocked).not.toBe(true) // a data/server problem, not a session one
      expect(o.lastError).toBe('Sync failed')
      expect(o.retryCount).toBe(1)
    }
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(translate(enDict, 'sync.drainFailed', { count: 2, reason: 'Sync failed' }))
  })

  it('429 without a parseable reason → generic drain-failed copy (still surfaced)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({}, false, 429)))

    await state().syncNow()

    for (const o of state().outbox) {
      expect(o.syncStatus).toBe('failed')
      expect(o.lastError).toBe(translate(enDict, 'sync.applyFailed'))
    }
    expect(toast.error).toHaveBeenCalledWith(translate(enDict, 'sync.drainFailed', {
      count: 2,
      reason: translate(enDict, 'sync.applyFailed'),
    }))
  })

  it('a non-JSON error body (proxy 502 page) still marks failed — it must not fall into the network catch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
    } as unknown as FakeRes)))

    await state().syncNow()

    for (const o of state().outbox) {
      expect(o.syncStatus).toBe('failed')
      expect(o.lastError).toBe(translate(enDict, 'sync.applyFailed'))
    }
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})

// ---------------- the never-drop invariant stays intact ----------------

describe('#191: a TRUE network-level failure still re-queues as pending (never drops)', () => {
  it('fetch rejects mid-drain → items return to pending, unmarked, no error toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))

    const result = await state().syncNow()

    expect(result).toBeUndefined() // the catch path returns nothing (unchanged)
    for (const o of state().outbox) {
      expect(o.syncStatus).toBe('pending')
      expect(o.authBlocked).not.toBe(true)
      expect(o.lastError).toBeUndefined()
      expect(o.retryCount).toBe(0)
    }
    expect(toast.error).not.toHaveBeenCalled()
  })
})

// ---------------- drainAfterAuth: the re-login recovery ----------------

describe('#191: drainAfterAuth — re-queues auth-blocked items and flushes once online', () => {
  it('after a 401 drain, drainAfterAuth re-queues the batch and it syncs cleanly', async () => {
    // 1) The expiry: the reconnect drain 401s into auth-blocked failed items.
    vi.stubGlobal('fetch', vi.fn(async () => res({ error: 'Sign in required' }, false, 401)))
    await state().syncNow()
    expect(state().outbox.every((o) => o.syncStatus === 'failed' && o.authBlocked)).toBe(true)

    // 2) The re-login: session authenticated, browser online — the store's
    //    auth-blocked items re-queue and the queue flushes.
    vi.stubGlobal('fetch', vi.fn(async () => res({
      ok: true,
      results: state().outbox.map(({ id }) => ({ id, ok: true })),
      data: null,
      projects: [],
    })))

    const started = await state().drainAfterAuth()

    expect(started).toBe(true)
    expect(state().outbox).toHaveLength(0) // everything synced…
    expect(state().syncHistory).toHaveLength(2) // …and retained (never silently lost)
    expect(state().syncHistory.every((o) => o.syncStatus === 'synced')).toBe(true)
    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'sync.doneOk', { count: 2 }))
  })

  it('a warm session boot with pending (non-auth-blocked) items also drains', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({
      ok: true,
      results: [{ id: 'q-1', ok: true }, { id: 'q-2', ok: true }],
      data: null,
      projects: [],
    })))

    const started = await state().drainAfterAuth()

    expect(started).toBe(true)
    expect(state().outbox).toHaveLength(0)
  })

  it('offline → auth-blocked items still re-queue (they wait as pending), but no drain fires', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ error: 'Sign in required' }, false, 401)))
    await state().syncNow()
    resetStore({ online: false, outbox: state().outbox })

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const started = await state().drainAfterAuth()

    expect(started).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    // The re-queue still happened — the next online transition drains them.
    expect(state().outbox.every((o) => o.syncStatus === 'pending')).toBe(true)
  })

  it('nothing pending and nothing auth-blocked → no drain, returns false', async () => {
    resetStore({ outbox: [] })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const started = await state().drainAfterAuth()

    expect(started).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a non-auth failed item is NOT re-queued by drainAfterAuth (it is a data failure, not a session one)', async () => {
    const failed = { ...queuedItem(1), syncStatus: 'failed' as const, lastError: 'Sync failed', retryCount: 1 }
    resetStore({ outbox: [failed] })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await state().drainAfterAuth()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(state().outbox[0].syncStatus).toBe('failed') // untouched
  })
})

// ---------------- wiring source pins (app.tsx / panel / login screen) ----------------

describe('#191: wiring — the drain is reachable end to end', () => {
  it('app.tsx drains once per authenticated session instance (keyed on next-auth expires)', () => {
    const src = readSrc('src/frontend/mjengo/app.tsx')
    expect(src).toContain('drainAfterAuth()')
    expect(src).toContain('authDrainedFor')
    // The effect gates on an authenticated session AND the browser being
    // online (a session cannot resolve while the radio is down).
    expect(src).toMatch(/status !== 'authenticated'[^]*!online\) return/)
  })

  it('the Sync trigger is enabled whenever unresolved items exist (online + pending-only included)', () => {
    const src = readSrc('src/frontend/mjengo/sync-outbox-panel.tsx')
    // The old stranding rule is gone…
    expect(src).not.toContain('(online && conflicts.length === 0)')
    // …replaced by "unresolved work exists".
    expect(src).toContain('disabled={outbox.length === 0 || syncing}')
    // Clicking it drains the pending queue while online too.
    expect(src).toContain('if (!syncing && pending.length > 0) void syncNow()')
  })

  it('the login screen acknowledges queued actions instead of hiding them', () => {
    const src = readSrc('src/frontend/auth/login-screen.tsx')
    expect(src).toContain("t('login.queuedNote', { count: queuedCount })")
    expect(src).toContain('useMjengo((s) => s.outbox.length)')
  })

  it('every new user-facing key exists in BOTH dictionaries (compile parity + runtime)', () => {
    const keys = [
      'sync.sessionExpired',
      'sync.authBlockedItem',
      'sync.drainFailed',
      'outbox.authBlockedNote',
      'login.queuedNote',
    ]
    for (const key of keys) {
      expect(enKeys().has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys().has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
  })
})

const enKeys = () => new Set(Object.keys(enDict))
const swKeys = () => new Set(Object.keys(swDict))
