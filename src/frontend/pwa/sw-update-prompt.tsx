'use client'

// The SW staleness cue UI (issue #148 / audit FE-11). When a new service
// worker finishes installing while this tab keeps running the old cached
// shell, a non-blocking toast offers "Reload" — the classic user-clicks
// pattern (never an auto-reload: the user may be mid-form, and #148's whole
// point is that THEY choose the moment).
//
// Renders null. Its whole job is the mount effect — register + watch via
// src/frontend/pwa/sw-update-watch.ts (dependency-injected, unit-tested with
// fake registrations) — and the sonner toast it fires through the root
// <Toaster /> when the watch reports a waiting worker. Mounted ONCE from the
// root layout inside <I18nProvider> (it needs useT; the toast reads the
// current locale at prompt time, so a mid-session language switch still
// renders the cue in the user's language).

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'
import {
  activateWaitingWorkerAndReload,
  watchServiceWorkerUpdates,
  type WatchedRegistration,
} from '@/frontend/pwa/sw-update-watch'

/**
 * The "user is looking at the app again" signals (#148 AC 4): window focus,
 * and a visibilitychange back to visible (phone unlock / app switcher).
 * Hiding the tab never checks — nothing can act on the result.
 */
function onForeground(listener: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'visible') listener()
  }
  window.addEventListener('focus', listener)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    window.removeEventListener('focus', listener)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

export function SwUpdatePrompt() {
  const t = useT()
  // The watch effect runs ONCE ([] deps — re-running it on every locale
  // switch would re-register listeners); the toast reads the CURRENT locale
  // at prompt time through the ref, kept fresh by the sync effect below.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    // DEV NO-OP (#148 AC 5): `next dev` recompiles constantly and its SW
    // never caches the shell — an update toast there would be pure noise, so
    // the CUE (prompt + foreground update checks) only arms in production
    // builds. The REGISTRATION itself still runs in dev, exactly like the
    // layout's old inline script this module replaced: the dev SW is
    // load-bearing for push notifications and the offline.html fallback.
    const cueEnabled = process.env.NODE_ENV === 'production'

    const showUpdatePrompt = (registration: WatchedRegistration) => {
      toast(tRef.current('sw.update.title'), {
        description: tRef.current('sw.update.body'),
        // Non-blocking but patient: the toast stays until the user decides
        // (Reload / Later are the dismissal; swipe works too) and never
        // steals focus or state from whatever is on screen.
        duration: Infinity,
        action: {
          label: tRef.current('sw.update.reload'),
          onClick: () =>
            activateWaitingWorkerAndReload(
              navigator.serviceWorker,
              registration,
              () => window.location.reload(),
            ),
        },
        cancel: {
          label: tRef.current('sw.update.later'),
          // Deliberately empty: dismissing is a choice, not a failure — the
          // update applies on the next reload regardless (the worker already
          // activated at install; see sw-update-watch.ts).
          onClick: () => {},
        },
      })
    }

    let dispose: (() => void) | undefined
    const start = () => {
      dispose = watchServiceWorkerUpdates(
        navigator.serviceWorker,
        cueEnabled ? { onUpdateReady: showUpdatePrompt, onForeground } : {},
      )
    }
    // Registration still waits for window load — the old inline script's
    // rule — so it never competes with first paint. If hydration finished
    // after load (slow field network), start immediately.
    if (document.readyState === 'complete') start()
    else window.addEventListener('load', start, { once: true })

    return () => {
      window.removeEventListener('load', start)
      dispose?.()
    }
  }, [])

  return null
}
