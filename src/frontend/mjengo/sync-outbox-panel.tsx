// Offline outbox panel (issue "Outbox conflict metadata + entity versions").
//
// The header's Sync control becomes the trigger for this sheet, which renders
// the outbox queue PER ITEM (spec §40 lifecycle: pending → syncing → synced |
// failed | conflict) and — the new part — the entity-version REJECTION detail:
// a stale-version item shows the reason, the server version it must re-base
// onto, and the deterministic keep-server suggestion chip (§41: the server
// version is the DEFAULT suggestion — never a silent overwrite), with the two
// honest resolutions (keep server / keep mine) for human-decides rows.
// Plain-string copy matches the app's existing sync surfaces (offline banner
// in app.tsx, toasts in use-mjengo.ts); the trigger button reuses the
// header's translated labels.
'use client'

import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  Check, CheckCheck, CloudOff, Loader2, RefreshCw, TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'

import { useMjengo, type OutboxItem } from '@/frontend/hooks/use-mjengo'
import { Button } from '@/frontend/ui/button'
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger,
} from '@/frontend/ui/sheet'
import { useT } from '@/frontend/i18n/provider'

const SCROLLBAR =
  '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full'

/** Lifecycle pill for one outbox item (spec §40) — REJECTED is the stale-version state. */
function StatusPill({ item }: { item: OutboxItem }) {
  const rejected = item.syncStatus === 'conflict' && item.conflictStatus === 'REJECTED'
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: 'Queued', cls: 'bg-stone-100 text-stone-600' },
    syncing: { label: 'Syncing…', cls: 'bg-blue-100 text-blue-700' },
    failed: { label: 'Failed', cls: 'bg-red-100 text-red-700' },
    conflict: rejected
      ? { label: 'Rejected', cls: 'bg-red-100 text-red-700' }
      : { label: 'Conflict', cls: 'bg-amber-100 text-amber-800' },
  }
  const meta = map[item.syncStatus] ?? map.pending
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${meta.cls}`}>
      {item.syncStatus === 'syncing' && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
      {meta.label}
    </span>
  )
}

/** The entity-version rejection detail (stale-version): numbers + keep-server chip. */
function StaleVersionDetail({ item }: { item: OutboxItem }) {
  if (item.conflictStatus !== 'REJECTED') return null
  const base = typeof item.conflictBaseVersion === 'number' ? item.conflictBaseVersion : null
  const server = typeof item.conflictServerVersion === 'number' ? item.conflictServerVersion : null
  return (
    <div className="mt-1.5 space-y-1.5">
      <p className="text-xs text-red-700 leading-snug">
        {server !== null
          ? `Rejected — your edit was made against version ${base ?? '?'} of this record, but the server is at version ${server} (it changed while you were offline).`
          : 'Rejected — the record changed on the server while you were offline.'}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {server !== null && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-stone-900 text-stone-100 text-[10px] font-semibold">
            Server version {server}
          </span>
        )}
        {item.suggestion === 'keep-server' && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[10px] font-semibold border border-amber-200">
            <Check className="w-3 h-3" aria-hidden /> Suggested: keep the server version
          </span>
        )}
      </div>
    </div>
  )
}

/** One queued outbox item, with conflict resolution where the server rejected it. */
function OutboxRow({
  item,
  onResolve,
}: {
  item: OutboxItem
  onResolve: (id: string, choice: 'keep-server' | 'keep-mine') => void
}) {
  const isConflict = item.syncStatus === 'conflict'
  return (
    <li className="px-4 py-3 border-b border-stone-100 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-900 truncate">{item.label}</p>
          <p className="text-[11px] text-stone-400 mt-0.5">
            {item.type} · queued {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
            {item.syncStatus === 'failed' && item.retryCount ? ` · ${item.retryCount} attempt${item.retryCount > 1 ? 's' : ''}` : ''}
          </p>
        </div>
        <StatusPill item={item} />
      </div>

      {isConflict && (
        <div className="mt-1.5">
          <StaleVersionDetail item={item} />
          {item.conflictStatus !== 'REJECTED' && item.conflictReason && (
            <p className="text-xs text-amber-800 leading-snug">{item.conflictReason}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              className="min-h-9 h-9"
              onClick={() => onResolve(item.id, 'keep-server')}
            >
              <CheckCheck className="w-3.5 h-3.5" aria-hidden /> Keep server version
            </Button>
            {item.conflictRule !== 'server-wins' && (
              <Button
                size="sm"
                variant="outline"
                className="min-h-9 h-9"
                onClick={() => onResolve(item.id, 'keep-mine')}
              >
                Keep my version
              </Button>
            )}
            {item.conflictRule === 'server-wins' && (
              <span className="text-[10px] text-stone-400 self-center">
                Financial rows — the server always wins; only a new correcting action changes money history.
              </span>
            )}
          </div>
        </div>
      )}

      {item.syncStatus === 'failed' && item.lastError && (
        <p className="mt-1.5 text-xs text-red-700 leading-snug">{item.lastError}</p>
      )}
    </li>
  )
}

/**
 * Header sync control + per-item outbox sheet. The trigger keeps the
 * historical Sync button (flush the queue when offline); it stays reachable
 * whenever unresolved conflicts exist — coming back online auto-drains the
 * queue and surfaces exactly those conflicts for a human decision.
 */
export function SyncOutboxPanel() {
  const { online, outbox, syncing, syncNow, lastSyncAt, resolveConflict, retryAll } = useMjengo()
  const t = useT()
  const [open, setOpen] = useState(false)

  const conflicts = outbox.filter((o) => o.syncStatus === 'conflict')
  const failed = outbox.filter((o) => o.syncStatus === 'failed')
  // Conflicts first (they need a human), then failures, then the live queue.
  const ordered = [
    ...conflicts,
    ...failed,
    ...outbox.filter((o) => o.syncStatus === 'pending' || o.syncStatus === 'syncing'),
  ]

  async function resolve(id: string, choice: 'keep-server' | 'keep-mine') {
    const ok = await resolveConflict(id, choice)
    if (ok && choice === 'keep-server' && conflicts.length === 1) setOpen(false)
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          // Historical enable: flush while offline with a queue. Reachable
          // while ONLINE only when unresolved conflicts await a decision.
          disabled={outbox.length === 0 || syncing || (online && conflicts.length === 0)}
          onClick={() => {
            if (!online && outbox.length > 0 && !syncing) void syncNow()
          }}
          aria-label={
            conflicts.length > 0
              ? `${t('header.aria.sync')} — ${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''} need a decision`
              : t('header.aria.sync')
          }
          className="gap-1.5 border-stone-700 bg-stone-900 text-stone-200 hover:bg-stone-800 hover:text-white relative"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} aria-hidden />
          <span className="hidden sm:inline">{syncing ? t('header.syncing') : t('header.sync')}</span>
          {outbox.length > 0 && (
            <span
              className={`absolute -top-1.5 -right-1.5 ${
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
          <SheetTitle className="text-base text-stone-900">Offline outbox</SheetTitle>
          <SheetDescription className="text-xs text-stone-400">
            {outbox.length === 0
              ? 'Nothing queued — every action is synced.'
              : conflicts.length > 0
                ? `${conflicts.length} item${conflicts.length > 1 ? 's' : ''} need${conflicts.length > 1 ? '' : 's'} your decision · ${outbox.length - conflicts.length} queued/failed`
                : `${outbox.length} queued action${outbox.length > 1 ? 's' : ''}`}
            {lastSyncAt ? ` · last sync ${formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true })}` : ''}
          </SheetDescription>
        </SheetHeader>

        {outbox.length === 0 ? (
          <div className="px-4 py-10 text-center flex-1" role="status">
            <CloudOff className="w-6 h-6 text-stone-300 mx-auto" aria-hidden />
            <p className="mt-2 text-sm text-stone-500">All caught up</p>
            <p className="mt-1 text-xs text-stone-400">
              Actions taken offline queue here, then flush to the server when you reconnect.
            </p>
          </div>
        ) : (
          <ul className="flex-1 min-h-0 max-h-[64vh] overflow-y-auto" aria-label="Queued and conflicted offline actions">
            {ordered.map((o) => (
              <OutboxRow key={o.id} item={o} onResolve={(id, choice) => void resolve(id, choice)} />
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
                <TriangleAlert className="w-4 h-4" aria-hidden /> Retry {failed.length} failed action{failed.length > 1 ? 's' : ''} — one attempt, no loops
              </Button>
            ) : (
              <p className="w-full text-center text-[11px] text-stone-400 px-2">
                Conflicts stay in the queue until you decide — nothing is silently overwritten.
              </p>
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}
