// Service-worker update watch (issue #148 / audit FE-11) — the staleness cue,
// client half.
//
// The app is offline-first around a CACHED '/' shell (public/sw.js v3), so a
// new deploy only reaches a RUNNING tab when the user reloads. This module
// owns the browser wiring: it registers the worker (the job of layout.tsx's
// old inline script — moved here because the cue needs the registration
// handle the moment it exists, and a hydrated client module can register AND
// listen without a getRegistration() race), watches for a worker that
// finished installing under the old page, and hands it to the UI
// (src/frontend/pwa/sw-update-prompt.tsx toasts "app updated — reload").
//
// Structure follows the sw-handlers idiom: the DECISIONS are the pure
// functions in src/frontend/sw-handlers.ts (shouldShowUpdatePrompt,
// shouldCheckForUpdates — the canonical, unit-tested statement this module
// CALLS, never re-derives); public/sw.js mirrors the SKIP_WAITING half
// inline. Everything browser-global here is a constructor argument, so
// tests/unit/sw-update-prompt.test.ts drives the whole state machine with
// fake containers, registrations and clocks (the vitest suite runs in node,
// no DOM).
//
// Posture notes:
//  · register() is idempotent per script URL + scope (spec), so re-mounting
//    or a stray duplicate registration is a no-op.
//  · The Reload action is activateWaitingWorkerAndReload below — the classic
//    user-clicks pattern, never an auto-reload: controllerchange fires while
//    the user may be mid-form, and interrupting that is exactly what #148
//    says the cue must not do.

import {
  SKIP_WAITING_MESSAGE_TYPE,
  SKIP_WAITING_RELOAD_GRACE_MS,
  shouldCheckForUpdates,
  shouldShowUpdatePrompt,
} from '@/frontend/sw-handlers'

/**
 * The service-worker members the watch reads — a structural subset, so the
 * real `navigator.serviceWorker` satisfies it and tests can supply minimal
 * fakes with exactly this shape.
 */
export interface WatchedWorker {
  state: string
  addEventListener(type: 'statechange', listener: () => void): void
  postMessage(message: unknown): void
}

export interface WatchedRegistration {
  installing: WatchedWorker | null
  waiting: WatchedWorker | null
  addEventListener(type: 'updatefound', listener: () => void): void
  update(): Promise<unknown>
}

export interface WatchedContainer {
  /** null until a worker controls this page — the first-install guard. */
  controller: object | null
  register(scriptUrl: string): Promise<WatchedRegistration>
  addEventListener(type: 'controllerchange', listener: () => void): void
}

export interface ServiceWorkerWatchOptions {
  /** The app's single static worker (public/sw.js). */
  scriptUrl?: string
  /**
   * The staleness cue. When OMITTED the watch is registration-only — the dev
   * posture (#148 AC 5): the SW still registers (as it always did, dev
   * included — it is load-bearing for push and the offline.html fallback),
   * but no waiting-worker detection and no foreground update checks fire,
   * the same way the SW's own dev rule never caches the shell.
   */
  onUpdateReady?: (registration: WatchedRegistration) => void
  /**
   * Subscribes a listener to "the app came back to the foreground" signals
   * (window focus + visibilitychange→visible). Returns the unsubscribe.
   */
  onForeground?: (listener: () => void) => () => void
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number
}

/**
 * Register the service worker and (when `onUpdateReady` is given) run the
 * staleness watch. Returns the dispose function.
 *
 * Detection covers both arrival paths of a finished-installing worker:
 *  · updatefound → the new worker appears as `registration.installing` →
 *    its statechange to 'installed' with this page already controlled
 *    (shouldShowUpdatePrompt — no cue on first install);
 *  · a worker that was ALREADY waiting (or mid-install) when the watch
 *    attached — its updatefound fired before the listener existed (the
 *    update landed while this tab was closed or unhydrated).
 * One prompt per worker (WeakSet): state transitions never stack toasts, but
 * a second update later in the session still gets its own cue.
 */
export function watchServiceWorkerUpdates(
  container: WatchedContainer,
  options: ServiceWorkerWatchOptions = {},
): () => void {
  const now = options.now ?? Date.now
  const cue = options.onUpdateReady
  let disposed = false
  let registration: WatchedRegistration | null = null
  let lastCheckedAt: number | null = null
  const prompted = new WeakSet<object>()

  const prompt = (reg: WatchedRegistration, worker: object) => {
    if (disposed || !cue || prompted.has(worker)) return
    prompted.add(worker)
    cue(reg)
  }

  const watchInstallingWorker = (reg: WatchedRegistration) => {
    const worker = reg.installing
    if (!worker) return
    worker.addEventListener('statechange', () => {
      if (shouldShowUpdatePrompt(worker.state, container.controller !== null)) {
        prompt(reg, worker)
      }
    })
  }

  // Foreground re-check (focus / tab visible again), bounded to one attempt
  // per UPDATE_CHECK_MIN_INTERVAL_MS by shouldCheckForUpdates — an eager
  // field user flipping between apps must not hammer registration.update().
  const checkForUpdates = () => {
    if (disposed || !registration) return
    const at = now()
    if (!shouldCheckForUpdates(lastCheckedAt, at)) return
    lastCheckedAt = at
    // Best-effort: a failed check (offline tablet) just waits out the bound
    // like a successful one.
    void registration.update().catch(() => {})
  }
  const unsubscribeForeground =
    cue && options.onForeground ? options.onForeground(checkForUpdates) : undefined

  container
    .register(options.scriptUrl ?? '/sw.js')
    .then((reg) => {
      if (disposed) return
      registration = reg
      // register() itself performs the browser's update check — start the
      // bound here so a focus two minutes later does not re-check for
      // nothing.
      lastCheckedAt = now()
      if (!cue) return
      if (reg.waiting && container.controller !== null) prompt(reg, reg.waiting)
      watchInstallingWorker(reg)
      reg.addEventListener('updatefound', () => watchInstallingWorker(reg))
    })
    .catch(() => {
      // Registration failure is non-fatal and expected on flaky field
      // networks: the browser keeps any previous registration alive, and the
      // next foreground window retries. (The promptless dev posture and
      // non-SW browsers never reach this path with a cue attached.)
    })

  return () => {
    disposed = true
    unsubscribeForeground?.()
  }
}

/**
 * The Reload action (#148 AC 2). Classic user-clicks pattern: ask the WAITING
 * worker to skip waiting (sw.js's message handler), then reload once it takes
 * control (controllerchange). The worker has USUALLY activated already —
 * public/sw.js calls skipWaiting() at the end of its install — leaving
 * `registration.waiting` null, in which case a plain reload boots the new
 * shell. Both paths end in exactly one reload: a once-guard plus the
 * SKIP_WAITING_RELOAD_GRACE_MS safety net (a worker that died mid-activate
 * never flips the controller — a click that silently no-ops would be a lie).
 */
export function activateWaitingWorkerAndReload(
  container: WatchedContainer,
  registration: WatchedRegistration,
  reload: () => void,
  schedule: (handler: () => void, ms: number) => void = (handler, ms) => {
    setTimeout(handler, ms)
  },
): void {
  const waiting = registration.waiting
  if (!waiting) {
    reload()
    return
  }
  let reloaded = false
  const reloadOnce = () => {
    if (reloaded) return
    reloaded = true
    reload()
  }
  container.addEventListener('controllerchange', reloadOnce)
  waiting.postMessage({ type: SKIP_WAITING_MESSAGE_TYPE })
  schedule(reloadOnce, SKIP_WAITING_RELOAD_GRACE_MS)
}
