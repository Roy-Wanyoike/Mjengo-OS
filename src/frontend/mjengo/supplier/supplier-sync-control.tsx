'use client'

// #128 — the supplier portal's sync control (compact variant of the owner
// sync-outbox-panel): a pending/syncing indicator with the queued count in
// the portal header, and the per-item outbox sheet behind it (§40 lifecycle
// pending → syncing → synced | failed | conflict, retryCount/lastError, the
// #132 bounded auto-retry notes, the #191 auth-blocked note).
//
// Deliberate differences from the owner panel, honestly smaller:
//   · the control RENDERS ONLY while there is outbox work (queued/failed/
//     conflicted/syncing) — the supplier header is a narrow light-on-dark
//     bar (Refresh · Sync · Settings · Sign out); a permanently-disabled
//     Sync button would be noise, the count badge is the honest signal;
//   · no keep-server/keep-mine resolution buttons: no supplier action family
//     is entity-versioned or financial today, so the server cannot emit a
//     §41 conflict for a supplier item (pinned by tests — if that ever
//     changes, this sheet needs the resolution UI, not a silent drop). A
//     conflict-shaped result still renders its reason verbatim.
//
// All user-visible copy runs through useT() — the shared outbox.* family
// where the words are the same concept as the owner panel, plus the
// supplier.outbox.* family for the supplier-specific bits (en + sw).

import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  CloudOff, Loader2, RefreshCw, TriangleAlert,
} from 'lucide-react'

import { AUTO_RETRY_MAX_ATTEMPTS, type OutboxItem } from '@/frontend/lib/outbox'
import { useSupplierOutbox } from '@/frontend/hooks/use-supplier-outbox'
import { Button } from '@/frontend/ui/button'
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger,
} from '@/frontend/ui/sheet'
import { useT } from '@/frontend/i18n/provider'

const SCROLLBAR =
  '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full'

/** Lifecycle pill for one outbox item (spec §40) — same states as the owner panel. */
function StatusPill({ item }: { item: OutboxItem }) {
  const t = useT()
  const rejected = item.syncStatus === 'conflict' && item.conflictStatus === 'REJECTED'
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: t('outbox.status.queued'), cls: 'bg-stone-100 text-stone-600' },
    syncing: { label: t('outbox.status.syncing'), cls: 'bg-blue-100 text-blue-700' },
    failed: { label: t('outbox.status.failed'), cls: 'bg-red-100 text-red-700' },
    conflict: rejected
      ? { label: t('outbox.status.rejected'), cls: 'bg-red-100 text-red-700' }
      : { label: t('outbox.status.conflict'), cls: 'bg-amber-100 text-amber-800' },
  }
  const meta = map[item.syncStatus] ?? map.pending
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${meta.cls}`}>
      {item.syncStatus === 'syncing' && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
      {meta.label}
    </span>
  )
}

/** One queued supplier action, with the honest failure/conflict context. */
function OutboxRow({ item }: { item: OutboxItem }) {
  const t = useT()
  return (
    <li className="px-4 py-3 border-b border-stone-100 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-900 truncate">{item.label}</p>
          {/* FE-4 (issue #80) contrast: stone-600 on white (6.99:1). */}
          <p className="text-[11px] text-stone-600 mt-0.5">
            {item.type} · {t('outbox.queuedAgo', { when: formatDistanceToNow(new Date(item.createdAt), { addSuffix: true }) })}
            {item.syncStatus === 'failed' && item.retryCount ? ` · ${t('outbox.attempts', { count: item.retryCount })}` : ''}
          </p>
        </div>
        <StatusPill item={item} />
      </div>

      {item.syncStatus === 'conflict' && (
        <div className="mt-1.5">
          {/* Server copy verbatim (backend message), then the honest note that
              there is no self-serve resolution on the supplier surface. */}
          {item.conflictReason && (
            <p className="text-xs text-amber-800 leading-snug">{item.conflictReason}</p>
          )}
          <p className="mt-1 text-xs text-stone-600 leading-snug">
            {t('supplier.outbox.conflictNote')}
          </p>
        </div>
      )}

      {item.syncStatus === 'failed' && item.lastError && (
        <p className="mt-1.5 text-xs text-red-700 leading-snug">{item.lastError}</p>
      )}

      {/* #132: a scheduled auto-retry replaces the bare red chip — the item
          failed, but a bounded attempt (5s → 30s → 2min, max 3) is already
          booked; once those are used up the manual footer is the only path. */}
      {item.syncStatus === 'failed' && typeof item.nextAttemptAt === 'number' && (
        <p className="mt-1 text-[11px] text-stone-600 leading-snug">
          {t('outbox.autoRetryNote', {
            attempts: item.autoAttempts ?? 0,
            max: AUTO_RETRY_MAX_ATTEMPTS,
            when: new Date(item.nextAttemptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          })}
        </p>
      )}
      {item.syncStatus === 'failed' &&
        typeof item.nextAttemptAt !== 'number' &&
        (item.autoAttempts ?? 0) >= AUTO_RETRY_MAX_ATTEMPTS && (
        <p className="mt-1 text-[11px] text-stone-600 leading-snug">
          {t('outbox.autoRetryExhausted', { max: AUTO_RETRY_MAX_ATTEMPTS })}
        </p>
      )}

      {/* #191: an auth-blocked failure waits for a SIGN-IN, not a retry. */}
      {item.syncStatus === 'failed' && item.authBlocked && (
        <p className="mt-1 text-[11px] text-stone-600 leading-snug">
          {t('outbox.authBlockedNote')}
        </p>
      )}
    </li>
  )
}

/**
 * Header sync control + per-item outbox sheet for the supplier portal. The
 * trigger appears whenever unresolved work exists (the queue only ever holds
 * pending/syncing/failed/conflict — synced items move to history) and stays
 * reachable for failures and conflicts; clicking it drains the pending queue
 * while online (same contract as the owner Sync trigger).
 */
export function SupplierSyncControl() {
  const { outbox, syncing, syncNow, lastSyncAt, retryAll } = useSupplierOutbox()
  const t = useT()
  const [open, setOpen] = useState(false)

  const conflicts = outbox.filter((o) => o.syncStatus === 'conflict')
  const failed = outbox.filter((o) => o.syncStatus === 'failed')
  const pending = outbox.filter((o) => (o.syncStatus ?? 'pending') === 'pending')
  // Conflicts first (they need attention), then failures, then the live queue.
  const ordered = [
    ...conflicts,
    ...failed,
    ...outbox.filter((o) => o.syncStatus === 'pending' || o.syncStatus === 'syncing'),
  ]

  // Compact variant: nothing queued and nothing syncing → no control (the
  // badge IS the pending indicator; a dead button would be noise).
  if (outbox.length === 0 && !syncing) return null

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          // Enabled whenever unresolved items exist — the outbox only ever
          // holds pending/syncing/failed/conflict, so a non-empty outbox IS
          // unresolved work. Clicking drains the pending queue while online.
          disabled={outbox.length === 0 || syncing}
          onClick={() => {
            if (!syncing && pending.length > 0) void syncNow()
          }}
          aria-label={
            conflicts.length > 0
              ? `${t('header.aria.sync')} — ${t('outbox.aria.conflictsPending', { count: conflicts.length })}`
              : t('header.aria.sync')
          }
          className="h-11 min-h-11 text-xs text-stone-300 hover:text-stone-100 gap-1.5 relative"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} aria-hidden />
          <span className="hidden sm:inline">{syncing ? t('header.syncing') : t('header.sync')}</span>
          {outbox.length > 0 && (
            <span
              className={`absolute -top-1 -right-1 ${
                conflicts.length > 0 ? 'bg-red-500' : 'bg-amber-500'
              } text-stone-950 text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center`}
              aria-label={t('header.aria.queuedActions', { count: outbox.length })}
            >
              {outbox.length > 9 ? '9+' : outbox.length}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="sm:max-w-md w-full p-0 gap-0">
        <SheetHeader className="p-4 pb-3 border-b border-stone-100">
          <SheetTitle className="text-base text-stone-900">{t('outbox.title')}</SheetTitle>
          <SheetDescription className="text-xs text-stone-600">
            {outbox.length === 0
              ? t('outbox.empty')
              : conflicts.length > 0
                ? t('outbox.metaConflicts', { count: conflicts.length, rest: outbox.length - conflicts.length })
                : t('outbox.metaQueued', { count: outbox.length })}
            {lastSyncAt ? ` · ${t('outbox.lastSync', { when: formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true }) })}` : ''}
          </SheetDescription>
        </SheetHeader>

        {outbox.length === 0 ? (
          <div className="px-4 py-10 text-center flex-1" role="status">
            <CloudOff className="w-6 h-6 text-stone-300 mx-auto" aria-hidden />
            <p className="mt-2 text-sm text-stone-500">{t('outbox.allCaughtUp')}</p>
            <p className="mt-1 text-xs text-stone-600">
              {t('outbox.emptyHint')}
            </p>
          </div>
        ) : (
          <ul className={`flex-1 min-h-0 max-h-[64vh] overflow-y-auto ${SCROLLBAR}`} aria-label={t('outbox.listAria')}>
            {ordered.map((o) => (
              <OutboxRow key={o.id} item={o} />
            ))}
          </ul>
        )}

        {(failed.length > 0 || conflicts.length > 0) && (
          <SheetFooter className="border-t border-stone-100 p-2">
            {failed.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="w-full min-h-11 gap-1.5 text-stone-600 hover:text-stone-900"
                onClick={retryAll}
              >
                <TriangleAlert className="w-4 h-4" aria-hidden /> {t('outbox.retryFailed', { count: failed.length })}
              </Button>
            ) : (
              // Conflicts only — the honest note (no self-serve resolution on
              // the supplier surface; see the file header).
              <p className="w-full text-center text-[11px] text-stone-600 px-2">
                {t('supplier.outbox.conflictNote')}
              </p>
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}
