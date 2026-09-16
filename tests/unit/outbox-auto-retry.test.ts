/**
 * #132 — bounded auto-retry invariants for failed outbox items, pinned
 * behaviorally on the REAL use-mjengo store (same conventions as
 * outbox-auth-drain.test.ts: sonner mocked, global fetch stubbed, the
 * zustand store imported real — persist is inert in node). Fake timers
 * drive the 5s → 30s → 2min backoff cadence without sleeping.
 *
 * The field scenario, end to end:
 *   · a drain that hard-fails (per-item error or a server-level 5xx/429)
 *     stamps a BOUNDED auto-retry schedule onto the item: nextAttemptAt =
 *     now + 5s, autoAttempts = 1 — persisted with the outbox so a reload
 *     does not reset it;
 *   · while online, a single module-level timer fires at the soonest
 *     nextAttemptAt, re-queues the due failures into one drain, and each
 *     subsequent failure re-stamps 30s → 2min → nothing: at most 3
 *     AUTOMATIC attempts, then manual-only (the panel's retry footer);
 *   · a reconnect (setOnline false → true) runs the retry pass immediately
 *     for DUE items (they join the pending drain) and keeps the schedule
 *     for not-yet-due ones; going offline parks the timer;
 *   · auth-blocked (#191) and conflict items are structurally exempt —
 *     they wait for a sign-in / a human §41 decision;
 *   · manual retryAll stays the human escape hatch and overrides schedule;
 *   · the outbox panel communicates the scheduled state.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { toast } from 'sonner'
import {
  useMjengo,
  AUTO_RETRY_MAX_ATTEMPTS,
  AUTO_RETRY_DELAYS_MS,
  type OutboxItem,
} from '@/frontend/hooks/use-mjengo'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import { translate } from '@/frontend/i18n/provider'

// ---------------- fetch test doubles (outbox-auth-drain conventions) ----------------

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
const fetchCalls = () => vi.mocked(fetch).mock.calls.length
const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

/** A server-level refusal body (the #191 surfaced-refusal path). */
const refuse500 = () => res({ error: 'Sync failed' }, false, 500)

/** A per-item hard failure body ({ ok: true } envelope, one failing result per live item). */
const failItems = () =>
  res({
    ok: true,
    results: state().outbox.map(({ id }) => ({ id, ok: false, error: 'Row is locked' })),
    data: null,
    projects: [],
  })

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllTimers()
  vi.clearAllMocks()
  resetStore()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ---------------- failure → schedule stamping ----------------

describe('#132: a hard failure stamps a bounded auto-retry schedule', () => {
  it('a server-level 500 refusal schedules the first retry at +5s (and arms the timer)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refuse500()))

    await state().syncNow()

    for (const o of state().outbox) {
      expect(o.syncStatus).toBe('failed')
      expect(o.autoAttempts).toBe(1)
      expect(o.nextAttemptAt).toBe(Date.now() + AUTO_RETRY_DELAYS_MS[0])
    }
    // Not yet due — one tick short of the backoff, nothing re-queues.
    await vi.advanceTimersByTimeAsync(AUTO_RETRY_DELAYS_MS[0] - 1)
    expect(fetchCalls()).toBe(1)
    expect(state().outbox.every((o) => o.syncStatus === 'failed')).toBe(true)
    // …then the timer fires the automatic attempt.
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchCalls()).toBe(2)
  })

  it('a per-item hard failure (ok envelope, failing result) schedules the same way', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => failItems()))

    await state().syncNow()

    for (const o of state().outbox) {
      expect(o.syncStatus).toBe('failed')
      expect(o.lastError).toBe('Row is locked')
      expect(o.autoAttempts).toBe(1)
      expect(o.nextAttemptAt).toBeGreaterThan(Date.now())
    }
  })
})

// ---------------- the backoff cadence + attempt cap ----------------

describe('#132: the cadence is 5s → 30s → 2min, then manual-only (3 automatic attempts)', () => {
  it('the full exhaustion sequence: initial + 3 automatic drains, then no more', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => failItems()))
    const t0 = Date.now()

    // Attempt 1 (the drain that failed): schedules attempt 2 at +5s.
    await state().syncNow()
    expect(fetchCalls()).toBe(1)

    // Attempt 2 (auto #1) fails → schedules attempt 3 at +30s.
    await vi.advanceTimersByTimeAsync(AUTO_RETRY_DELAYS_MS[0])
    expect(fetchCalls()).toBe(2)
    let item = state().outbox[0]
    expect(item.syncStatus).toBe('failed')
    expect(item.retryCount).toBe(2)
    expect(item.autoAttempts).toBe(2)
    expect(item.nextAttemptAt).toBe(t0 + AUTO_RETRY_DELAYS_MS[0] + AUTO_RETRY_DELAYS_MS[1])

    // Attempt 3 (auto #2) fails → schedules attempt 4 at +2min.
    await vi.advanceTimersByTimeAsync(AUTO_RETRY_DELAYS_MS[1])
    expect(fetchCalls()).toBe(3)
    item = state().outbox[0]
    expect(item.autoAttempts).toBe(3)
    expect(item.nextAttemptAt).toBe(t0 + AUTO_RETRY_DELAYS_MS[0] + AUTO_RETRY_DELAYS_MS[1] + AUTO_RETRY_DELAYS_MS[2])

    // Attempt 4 (auto #3) fails → NO further schedule: manual-only from here.
    await vi.advanceTimersByTimeAsync(AUTO_RETRY_DELAYS_MS[2])
    expect(fetchCalls()).toBe(4)
    for (const o of state().outbox) {
      expect(o.syncStatus).toBe('failed')
      expect(o.autoAttempts).toBe(AUTO_RETRY_MAX_ATTEMPTS)
      expect(o.nextAttemptAt).toBeUndefined()
    }

    // Nothing fires ever again on its own.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fetchCalls()).toBe(4)
  })

  it('a SUCCESSFUL automatic retry clears the failure (full recovery, retained in history)', async () => {
    // First drain hard-fails…
    vi.stubGlobal('fetch', vi.fn(async () => refuse500()))
    await state().syncNow()
    expect(state().outbox.every((o) => o.syncStatus === 'failed')).toBe(true)

    // …the server recovers before the backoff elapses.
    vi.mocked(fetch).mockImplementation(async () =>
      res({
        ok: true,
        results: state().outbox.map(({ id }) => ({ id, ok: true })),
        data: null,
        projects: [],
      }))

    await vi.advanceTimersByTimeAsync(AUTO_RETRY_DELAYS_MS[0])

    expect(fetchCalls()).toBe(2)
    expect(state().outbox).toHaveLength(0)
    expect(state().syncHistory).toHaveLength(2)
    expect(state().syncHistory.every((o) => o.syncStatus === 'synced')).toBe(true)
    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'sync.doneOk', { count: 2 }))
  })
})

// ---------------- the reconnect retry pass ----------------

describe('#132: a reconnect runs the retry pass for failed items', () => {
  it('DUE failed items re-queue into the reconnect drain (with the honest toast)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      res({ ok: true, results: [{ id: 'q-1', ok: true }], data: null, projects: [] })))
    resetStore({
      online: false,
      outbox: [{ ...queuedItem(1), syncStatus: 'failed', lastError: 'Sync failed', retryCount: 1, autoAttempts: 1, nextAttemptAt: Date.now() - 1_000 }],
    })

    state().setOnline(true)

    // The due failure joined the pending drain — one fetch, no timer wait.
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCalls()).toBe(1)
    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'sync.backOnlineDraining'))
    expect(state().outbox).toHaveLength(0) // recovered without a human
  })

  it('not-yet-due items keep their schedule across a reconnect (backoff respected)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refuse500()))
    resetStore({
      online: false,
      outbox: [{ ...queuedItem(1), syncStatus: 'failed', lastError: 'Sync failed', retryCount: 1, autoAttempts: 1, nextAttemptAt: Date.now() + 30_000 }],
    })

    state().setOnline(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchCalls()).toBe(0) // backoff still binding — no premature retry
    expect(state().outbox[0].syncStatus).toBe('failed')

    // …and fires exactly when the schedule said it would.
    await vi.advanceTimersByTimeAsync(25_000)
    expect(fetchCalls()).toBe(1)
  })

  it('going offline parks the timer; the next reconnect recovers it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refuse500()))
    await state().syncNow() // arms the +5s timer

    state().setOnline(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchCalls()).toBe(1) // timer cleared — no offline drain attempts

    state().setOnline(true) // due by now → the reconnect pass drains it
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCalls()).toBe(2)
  })
})

// ---------------- exemptions: conflicts + auth-blocked stay human/session-only ----------------

describe('#132: conflict and auth-blocked items are never auto-retried', () => {
  it('a conflict stays a conflict across the reconnect pass (only the failed item re-queues)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      res({ ok: true, results: [{ id: 'q-1', ok: true }], data: null, projects: [] })))
    resetStore({
      online: false,
      outbox: [
        { ...queuedItem(1), syncStatus: 'failed', lastError: 'Sync failed', retryCount: 1, autoAttempts: 1, nextAttemptAt: Date.now() - 1 },
        { ...queuedItem(2), syncStatus: 'conflict', conflictReason: 'stale version', conflictRule: 'human-decides' },
      ],
    })

    state().setOnline(true)
    await vi.advanceTimersByTimeAsync(0)

    const conflict = state().outbox.find((o) => o.id === 'q-2')
    expect(conflict?.syncStatus).toBe('conflict') // untouched — §41 human-only
    expect(state().outbox.find((o) => o.id === 'q-1')).toBeUndefined() // synced away
    expect(state().syncHistory).toHaveLength(1)
  })

  it('a 401 drain (#191) never schedules a backoff — the items wait for sign-in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ error: 'Sign in required' }, false, 401)))

    await state().syncNow()

    for (const o of state().outbox) {
      expect(o.syncStatus).toBe('failed')
      expect(o.authBlocked).toBe(true)
      expect(o.nextAttemptAt).toBeUndefined() // no schedule — drainAfterAuth owns these
      expect(o.autoAttempts).toBeUndefined() // the auth-blocked arm never stamps one
    }
    // Blindly retrying without a session would just 401 again.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fetchCalls()).toBe(1)
  })
})

// ---------------- manual retryAll: the human escape hatch ----------------

describe('#132: retryAll overrides the schedule (and is the exhausted fallback)', () => {
  it('retryAll re-queues immediately, stripping nextAttemptAt — no waiting out the backoff', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refuse500()))
    await state().syncNow() // failed, scheduled at +5s

    vi.mocked(fetch).mockImplementation(async () =>
      res({ ok: true, results: state().outbox.map(({ id }) => ({ id, ok: true })), data: null, projects: [] }))
    state().retryAll()

    // Re-queued straight into the drain (syncing), schedule stripped — the
    // manual retry does not wait out the backoff.
    for (const o of state().outbox) {
      expect(o.syncStatus).toBe('syncing')
      expect(o.nextAttemptAt).toBeUndefined()
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCalls()).toBe(2) // drained NOW, not at the scheduled time
    expect(state().outbox).toHaveLength(0)
  })
})

// ---------------- persistence + wiring source pins ----------------

describe('#132: wiring — the schedule persists and the panel communicates it', () => {
  it('the schedule fields are persisted outbox state (normalize + rehydrate restore)', () => {
    const src = readSrc('src/frontend/hooks/use-mjengo.ts')
    // OutboxItem carries the fields…
    expect(src).toContain('autoAttempts?: number')
    expect(src).toContain('nextAttemptAt?: number')
    // …normalizeOutboxItem migrates old persisted items to a clean slate…
    expect(src).toContain('autoAttempts: typeof item.autoAttempts === \'number\' ? item.autoAttempts : 0')
    // …and the rehydrate hook re-arms the timer so a reload keeps the schedule.
    expect(src).toContain('setTimeout(() => armAutoRetryTimer(), 0)')
  })

  it('the outbox panel renders the scheduled + exhausted states (no bare red chip)', () => {
    const src = readSrc('src/frontend/mjengo/sync-outbox-panel.tsx')
    expect(src).toContain("t('outbox.autoRetryNote'")
    expect(src).toContain("t('outbox.autoRetryExhausted'")
    expect(src).toContain('AUTO_RETRY_MAX_ATTEMPTS')
  })

  it('every new user-facing key exists in BOTH dictionaries with the same placeholders', () => {
    const keys = ['outbox.autoRetryNote', 'outbox.autoRetryExhausted'] as const
    for (const key of keys) {
      expect(enDict[key], `en.ts is missing "${key}"`).toBeTypeOf('string')
      expect(swDict[key], `sw.ts is missing "${key}"`).toBeTypeOf('string')
      const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
      expect(vars(swDict[key]), `sw.${key} placeholder drift`).toBe(vars(enDict[key]))
    }
    // Interpolation works through the real translate() in both languages.
    expect(translate(enDict, 'outbox.autoRetryNote', { attempts: 1, max: 3, when: '14:32' }))
      .toBe('Auto-retry attempt 1 of 3 — next try 14:32')
    expect(translate(swDict, 'outbox.autoRetryNote', { attempts: 1, max: 3, when: '14:32' }))
      .toBe('Kujaribu tena kiotomatiki — ujaribu wa 1 kati ya 3 mnamo 14:32')
  })
})
