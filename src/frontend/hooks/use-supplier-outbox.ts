'use client'

// #128 — the SUPPLIER portal's offline outbox: queue → persisted → drain parity
// with the owner app (issue #128 / audit FE-4).
//
// THE ARCHITECTURE (deliberate — read before touching):
//   · SEPARATE STORE, SEPARATE SESSION. The supplier session (next-auth role
//     'supplier', supplierId-linked) is NOT the owner session, and this store
//     is NOT the owner store: its own zustand instance, its own persisted
//     localStorage key (`mjengo-supplier-outbox`), its own drain. The owner
//     app's `mjengo-os-store` outbox and this one can never entangle — an
//     owner item is never drained from here and a supplier item never drains
//     through the owner store (pinned by tests).
//   · SHARED CORE, NOT SHARED STATE. The genuinely-common machinery — the §40
//     item shape + lifecycle, the #132 bounded auto-retry engine, the
//     migration normalizer — lives in src/frontend/lib/outbox.ts and is
//     consumed by BOTH stores. Transports, reducers and refresh paths stay
//     per-app: the owner drain applies server project payloads into its own
//     reducer; the supplier drain applies NOTHING client-side — the portal
//     re-reads GET /api/supplier (its source of truth) whenever a drain
//     synced rows (dataVersion).
//   · TRANSPORT: POST /api/sync, supplier-scoped (the supply-side mirror of
//     the client pin — see src/backend/api/sync.ts): SUPPLIER_ACTIONS
//     allowlist per item, session-stamped __supplierId, rows pinned to the
//     supplier's own link by assertSupplierScope server-side, §57 per-item
//     idempotency, and NEVER a buyer payload in the response.
//   · NO OPTIMISTIC MIRROR (honest limitation, documented): the owner queue
//     writes optimistic local updates via reduceLocal because the owner app
//     holds the project payload. The supplier portal's payload is a scoped
//     server read; mirroring quote totals / order lifecycles client-side
//     would duplicate server derivation. Queued actions are visible per-item
//     in the sync sheet instead, and the portal refreshes after every drain.
//
// Drains fire on the offline→online transition (setOnline), on session
// (re)authentication (drainAfterAuth — #191 parity: a 401 drain marks the
// batch auth-blocked, never silently re-queued), on the bounded auto-retry
// schedule (#132: 5s → 30s → 2min, max 3, then manual-only), and manually
// from the supplier sync sheet.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from 'sonner'
import { SUPPLIER_ACTIONS } from '@/shared/supplier-actions'
import { useLocalePrefs } from '@/frontend/i18n/store'
import { translate } from '@/frontend/i18n/provider'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import type { ActionType } from '@/backend/lib/mjengo'
import {
  uid,
  normalizeOutboxItem,
  withAutoRetrySchedule,
  SYNC_HISTORY_CAP,
  createAutoRetryEngine,
  type OutboxItem,
  type SyncItemResult,
} from '@/frontend/lib/outbox'

/**
 * Toast-time translator (same seam as use-mjengo's): the store lives outside
 * React render, so the locale is read imperatively at call time.
 */
const t = (key: string, vars?: Record<string, string | number>): string =>
  translate(useLocalePrefs.getState().language === 'sw' ? swDict : enDict, key, vars)

/**
 * One honest toast for a refused /api/actions call (FE-6b pattern — the
 * server's { error } text reaches the user verbatim; a refusal without a
 * reason falls back to the generic copy).
 */
function serverRefusalToast(json: unknown): string {
  const reason =
    json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
      ? (json as { error: string }).error.trim()
      : ''
  return reason ? t('sync.serverRefused', { reason }) : t('sync.applyFailed')
}

/** What a supplier dispatch resolved to (the portal branches its reload on it). */
export type SupplierSendResult =
  /** The server applied it (online path) — the portal re-reads /api/supplier. */
  | 'applied'
  /** Queued in the persisted outbox — it drains on reconnect. */
  | 'queued'
  /** Refused (allowlist or the server's own refusal) — already surfaced. */
  | 'refused'

interface SupplierOutboxState {
  online: boolean
  syncing: boolean
  outbox: OutboxItem[]
  /** Synced + conflict-resolved items, retained (capped) as history for inspection. */
  syncHistory: OutboxItem[]
  lastSyncAt: number | null
  /**
   * Bumped once per drain that synced ≥ 1 item — the portal's signal to
   * re-read GET /api/supplier (this store owns no payload of its own). Not
   * persisted: a reload has no in-flight drain to react to.
   */
  dataVersion: number
  setOnline: (v: boolean) => void
  /**
   * Offline-first supplier dispatch: online → POST /api/actions (the scoped
   * transport the portal always used); offline / network-failed → queue.
   * Server refusals are final and honest (toast + 'refused') — they are NOT
   * queued (an identical payload would fail again).
   */
  dispatch: (
    type: ActionType,
    payload: Record<string, unknown>,
    projectId: string | undefined,
    label: string,
  ) => Promise<SupplierSendResult>
  /** Drain every PENDING item through POST /api/sync (supplier-scoped server-side). */
  syncNow: () => Promise<{ synced: number; failed: number; conflicts: number } | undefined>
  /** Re-queue every failed item for ONE manual drain attempt (no auto-retry loops). */
  retryAll: () => void
  /**
   * #191 parity — re-login recovery: a drain that hit an expired session left
   * the queue auth-blocked (failed + authBlocked); once a session
   * authenticates again, re-queue those items and flush the pending queue
   * once (when online). Deliberately silent — syncNow owns result toasts.
   */
  drainAfterAuth: () => Promise<boolean>
}

/**
 * #132 — the shared bounded auto-retry engine, bound to THIS store (see
 * lib/outbox.ts; the owner store runs its own instance against its own
 * state — the cadence is shared, the state never is).
 */
const autoRetry = createAutoRetryEngine({
  getState: () => useSupplierOutbox.getState(),
  requeue: (ids) =>
    useSupplierOutbox.setState({
      outbox: useSupplierOutbox.getState().outbox.map((o) =>
        ids.has(o.id)
          ? { ...o, syncStatus: 'pending' as const, nextAttemptAt: undefined }
          : o),
    }),
  syncNow: () => useSupplierOutbox.getState().syncNow(),
})

export const useSupplierOutbox = create<SupplierOutboxState>()(
  persist(
    (set, get) => ({
      online: true,
      syncing: false,
      outbox: [],
      syncHistory: [],
      lastSyncAt: null,
      dataVersion: 0,

      setOnline: (v) => {
        const wasOnline = get().online
        set({ online: v })
        if (!v) {
          // Going offline parks the auto-retry schedule (#132): nothing
          // useful can drain without a network, and the next offline→online
          // transition re-runs the retry pass below.
          autoRetry.clear()
          return
        }
        if (wasOnline) return
        // Fresh reconnect: failed items whose bounded backoff has elapsed
        // re-queue NOW, joining the pending drain below.
        autoRetry.requeueDue()
        const pendingCount = get().outbox.filter((o) => (o.syncStatus ?? 'pending') === 'pending').length
        const conflictCount = get().outbox.filter((o) => o.syncStatus === 'conflict').length
        if (pendingCount > 0) {
          toast.success(t('sync.backOnlineDraining'))
          void get().syncNow()
        } else if (conflictCount > 0) {
          toast.info(t('sync.backOnlineConflicts', { count: conflictCount }))
        } else {
          toast.success(t('sync.backOnline'))
        }
        autoRetry.arm()
      },

      dispatch: async (type, payload, projectId, label) => {
        // Client-side mirror of the server allowlist: only SUPPLIER_ACTIONS
        // can ever drain through the supplier session — refuse anything else
        // up front instead of queueing an item that is dead on arrival.
        if (!(SUPPLIER_ACTIONS as readonly string[]).includes(type)) {
          toast.error(t('supplier.outbox.notPermitted'))
          return 'refused'
        }
        if (get().online) {
          try {
            const res = await fetch('/api/actions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type, payload, projectId }),
            })
            const json = (await res.json()) as { ok?: boolean; error?: string }
            if (json.ok) {
              set({ lastSyncAt: Date.now() })
              return 'applied'
            }
            // Honest failure: the server's own message (wrong status /
            // foreign id → the same words as a miss; never a stack). A
            // refusal is final — it is NOT queued.
            toast.error(serverRefusalToast(json), { duration: 8000 })
            console.error('supplier action failed', json.error)
            return 'refused'
          } catch {
            // Network-level failure while we believed we were online (dropped
            // connection, server unreachable): mirror the offline branch —
            // queue for sync so a field supplier never silently loses the
            // action (the owner dispatch contract).
          }
        }
        // Offline (or the radio just dropped): queue. The label rides the
        // item — the per-item sync sheet renders it (FE-10 resolved here:
        // the supplier dispatch finally KEEPS its action context).
        const item: OutboxItem = {
          id: uid(),
          type,
          payload,
          label,
          createdAt: Date.now(),
          projectId: projectId ?? null,
          syncStatus: 'pending',
          retryCount: 0,
        }
        set({ outbox: [...get().outbox, item] })
        toast.success(t('field.savedQueued', { count: get().outbox.length }))
        return 'queued'
      },

      /**
       * Drain loop (spec §40, supplier half): flush every PENDING item
       * through the supplier-scoped POST /api/sync. Per-item outcomes mark
       * the lifecycle: synced | failed | conflict.
       *   · synced items move into `syncHistory` (retained, capped) and bump
       *     `dataVersion` once per drain — the portal re-reads /api/supplier
       *   · failed items stay queued with retryCount + lastError and the
       *     BOUNDED auto-retry schedule (#132), then manual-only via retryAll
       *   · conflict items stay with the server's reason (no §41 resolution
       *     UI on the supplier surface — no supplier action family is
       *     versioned or financial today, pinned by tests; if that ever
       *     changes the panel needs keep-server/keep-mine)
       *   · 401 marks the batch auth-blocked (#191) — drainAfterAuth recovers
       *   · a network-level failure re-queues items as pending (never drops)
       */
      syncNow: async () => {
        if (get().syncing) return
        const queue = get().outbox.filter((o) => (o.syncStatus ?? 'pending') === 'pending')
        if (!queue.length) { set({ lastSyncAt: Date.now() }); return }
        const sentIds = new Set(queue.map((q) => q.id))
        set({
          syncing: true,
          outbox: get().outbox.map((o) => (sentIds.has(o.id) ? { ...o, syncStatus: 'syncing' as const } : o)),
        })
        try {
          const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              actions: queue.map(({ id, type, payload, projectId }) => ({ id, type, payload, projectId })),
            }),
          })
          // #191 parity: an expired session refuses the WHOLE batch for auth,
          // not data — mark it auth-blocked (failed + session-expired
          // lastError) and tell the supplier their work is safe and will
          // sync after sign-in. drainAfterAuth() re-queues it once a session
          // returns.
          if (res.status === 401) {
            const json = await res.json().catch(() => null)
            console.error('supplier sync refused: session expired', json && typeof json === 'object' ? (json as { error?: unknown }).error : res.status)
            set({
              outbox: get().outbox.map((o) => (o.syncStatus === 'syncing'
                ? {
                    ...o,
                    syncStatus: 'failed' as const,
                    authBlocked: true,
                    lastError: t('sync.authBlockedItem'),
                    retryCount: (o.retryCount ?? 0) + 1,
                  }
                : o)),
            })
            toast.error(t('sync.sessionExpired', { count: queue.length }))
            return { synced: 0, failed: queue.length, conflicts: 0 }
          }
          // Defensive parse: a non-JSON error body (proxy 502 page) must not
          // fall into the network-failure catch — the server DID answer.
          const json = await res.json().catch(() => null)
          if (json?.ok) {
            const results = (json.results ?? []) as SyncItemResult[]
            const byId = new Map(results.map((r) => [r.id, r]))
            let synced = 0, failed = 0, conflicts = 0
            const marked = get().outbox.map((o) => {
              const r = byId.get(o.id)
              if (!r) return o // not part of this drain
              if (r.ok) { synced += 1; return { ...o, syncStatus: 'synced' as const, syncedAt: Date.now(), lastError: undefined } }
              if ('conflict' in r) {
                conflicts += 1
                return {
                  ...o,
                  syncStatus: 'conflict' as const,
                  conflictReason: r.reason,
                  conflictRule: r.rule,
                  conflictAt: Date.now(),
                  conflictStatus: r.status,
                  conflictServerVersion: r.serverVersion,
                  conflictBaseVersion: r.baseVersion,
                  suggestion: r.suggestion,
                }
              }
              failed += 1
              return {
                ...o,
                syncStatus: 'failed' as const,
                lastError: r.error,
                retryCount: (o.retryCount ?? 0) + 1,
                // #132: schedule the bounded automatic retry (skipped once
                // the 3 attempts are used up — the sheet's retry footer is
                // the manual escape hatch from there on).
                ...withAutoRetrySchedule(o),
              }
            })
            // Retain: live queue keeps pending/syncing/failed/conflict;
            // synced items → history (capped). A drain that synced rows also
            // bumps dataVersion — the portal re-reads /api/supplier.
            const live = marked.filter((o) => o.syncStatus !== 'synced')
            const finished = marked.filter((o) => o.syncStatus === 'synced')
            set({
              outbox: live,
              syncHistory: [...get().syncHistory, ...finished].slice(-SYNC_HISTORY_CAP),
              lastSyncAt: Date.now(),
              ...(synced > 0 ? { dataVersion: get().dataVersion + 1 } : {}),
            })
            if (conflicts > 0) {
              toast.warning(t('sync.doneConflicts', { synced, total: results.length, conflicts }))
            } else if (failed > 0) {
              toast.error(t('sync.doneFailed', { synced, failed }))
            } else if (synced > 0) {
              toast.success(t('sync.doneOk', { count: synced }))
            }
            return { synced, failed, conflicts }
          }
          // #191 parity: any other server-level rejection (500/429/403…) is
          // SURFACED, never silently re-queued as pending: items keep their
          // place as failed with the server's reason as lastError (the
          // sheet's retry footer is the recovery UI). Only a TRUE
          // network-level failure (the catch below) re-queues as pending.
          const reason =
            json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string' && (json as { error: string }).error.trim()
              ? (json as { error: string }).error
              : t('sync.applyFailed')
          console.error('supplier sync refused', json && typeof json === 'object' ? (json as { error?: unknown }).error : res.status)
          set({
            outbox: get().outbox.map((o) => (o.syncStatus === 'syncing'
              ? {
                  ...o,
                  syncStatus: 'failed' as const,
                  lastError: reason,
                  retryCount: (o.retryCount ?? 0) + 1,
                  ...withAutoRetrySchedule(o),
                }
              : o)),
          })
          toast.error(t('sync.drainFailed', { count: queue.length, reason }))
          return { synced: 0, failed: queue.length, conflicts: 0 }
        } catch (e) {
          console.error('supplier sync failed', e)
          // Network failure mid-drain: nothing applied client-side — re-queue, never drop.
          set({ outbox: get().outbox.map((o) => (o.syncStatus === 'syncing' ? { ...o, syncStatus: 'pending' as const } : o)) })
        } finally {
          set({ syncing: false })
          // #132: arm the auto-retry timer for any freshly-scheduled
          // failures (no-op when nothing is scheduled).
          autoRetry.arm()
        }
      },

      retryAll: () => {
        const failed = get().outbox.filter((o) => o.syncStatus === 'failed')
        if (!failed.length) { toast.info(t('sync.nothingFailed')); return }
        set({ outbox: get().outbox.map((o) => (o.syncStatus === 'failed'
          ? { ...o, syncStatus: 'pending' as const, nextAttemptAt: undefined }
          : o)) })
        toast.success(t('sync.retrying', { count: failed.length }))
        void get().syncNow()
      },

      drainAfterAuth: async () => {
        const authBlocked = get().outbox.filter((o) => o.syncStatus === 'failed' && o.authBlocked)
        if (authBlocked.length > 0) {
          set({
            outbox: get().outbox.map((o) => (o.syncStatus === 'failed' && o.authBlocked
              ? { ...o, syncStatus: 'pending' as const, authBlocked: false, lastError: undefined, nextAttemptAt: undefined }
              : o)),
          })
        }
        // #132: a session boot is also a fine moment to restore the
        // auto-retry timer (covers a reload with scheduled failures).
        autoRetry.arm()
        const hasPending = get().outbox.some((o) => (o.syncStatus ?? 'pending') === 'pending')
        if (!get().online || !hasPending || get().syncing) return false
        await get().syncNow()
        return true
      },
    }),
    {
      // The supplier outbox's OWN persisted key — deliberately NOT the owner
      // store's `mjengo-os-store`: different session, different surface, no
      // shared state (the session-scoping tests pin both keys).
      name: 'mjengo-supplier-outbox',
      version: 1,
      migrate: (persisted: unknown) => {
        const s = (persisted ?? {}) as Partial<SupplierOutboxState> & { outbox?: OutboxItem[] }
        return {
          ...s,
          outbox: (s.outbox ?? []).map(normalizeOutboxItem),
          syncHistory: (s.syncHistory ?? []).map(normalizeOutboxItem),
        } as SupplierOutboxState
      },
      onRehydrateStorage: () => (state) => {
        // Belt-and-braces: any stale shape is normalised after rehydration;
        // the #132 schedule is restored (the persisted nextAttemptAt stamps
        // survive, the timer itself does not). Deferred a tick because this
        // callback can run while the module is still initialising; inert in
        // node/tests (no storage → zustand never calls this back there).
        if (state?.outbox) state.outbox = state.outbox.map(normalizeOutboxItem)
        if (state?.syncHistory) state.syncHistory = state.syncHistory.map(normalizeOutboxItem)
        setTimeout(() => autoRetry.arm(), 0)
      },
      partialize: (s) => ({
        online: s.online,
        outbox: s.outbox,
        syncHistory: s.syncHistory,
        lastSyncAt: s.lastSyncAt,
      }),
    },
  ),
)

/**
 * Dev/debug console hook (mirrors the owner store's __MJENGO_DEBUG__):
 * `window.__MJENGO_SUPPLIER_DEBUG__()` returns the live supplier-outbox state
 * plus a derived `conflicts` array — for console verification of the
 * supplier sync lifecycle.
 */
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__MJENGO_SUPPLIER_DEBUG__ = () => {
    const s = useSupplierOutbox.getState()
    return { ...s, conflicts: s.outbox.filter((o) => o.syncStatus === 'conflict') }
  }
}
