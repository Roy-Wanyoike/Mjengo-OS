/**
 * SW staleness cue (issue #148 / audit FE-11) — the "app updated, reload"
 * prompt for waiting service workers.
 *
 * Covers the three layers of the cue:
 *   · the PURE decisions in src/frontend/sw-handlers.ts (#148 section): the
 *     installed-with-controller prompt rule, the bounded focus/visibility
 *     update check, and the SKIP_WAITING message shape public/sw.js mirrors;
 *   · the WATCH in src/frontend/pwa/sw-update-watch.ts — driven BEHAVIORALLY
 *     with fake containers / registrations / workers / clocks (the issue's
 *     "mocked registration states"): updatefound → installed → prompt,
 *     no prompt on first install, waiting-at-attach, the dev registration-only
 *     posture, the dispose contract, and the Reload action's
 *     SKIP_WAITING → controllerchange → reload ladder (with the grace net);
 *   · SOURCE pins in the house style (readFileSync, the sw-offline-shell /
 *     push-routes idiom): sw.js carries the SKIP_WAITING message handler,
 *     the prompt component wires the cue through the app's toast system with
 *     i18n keys (en + sw dicts pinned), the root layout mounts the cue inside
 *     I18nProvider and no longer carries the old inline registration script,
 *     and the watch calls the canonical helpers instead of re-deriving them.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SKIP_WAITING_MESSAGE_TYPE,
  SKIP_WAITING_RELOAD_GRACE_MS,
  UPDATE_CHECK_MIN_INTERVAL_MS,
  isSkipWaitingMessage,
  shouldCheckForUpdates,
  shouldShowUpdatePrompt,
} from '@/frontend/sw-handlers'
import {
  activateWaitingWorkerAndReload,
  watchServiceWorkerUpdates,
  type WatchedContainer,
  type WatchedRegistration,
  type WatchedWorker,
} from '@/frontend/pwa/sw-update-watch'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'

const SW_SOURCE = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8')
const WATCH_SRC = readFileSync(
  fileURLToPath(new URL('../../src/frontend/pwa/sw-update-watch.ts', import.meta.url)),
  'utf8',
)
const PROMPT_SRC = readFileSync(
  fileURLToPath(new URL('../../src/frontend/pwa/sw-update-prompt.tsx', import.meta.url)),
  'utf8',
)
const LAYOUT_SRC = readFileSync(fileURLToPath(new URL('../../src/app/layout.tsx', import.meta.url)), 'utf8')

// ------------------------------------------------ pure decisions (sw-handlers)

describe('shouldShowUpdatePrompt — installed under a controlled page, only', () => {
  it('a worker that finished installing while an older worker controls the page cues', () => {
    expect(shouldShowUpdatePrompt('installed', true)).toBe(true)
  })

  it('the FIRST install never cues (no controller — that page IS the new version)', () => {
    expect(shouldShowUpdatePrompt('installed', false)).toBe(false)
  })

  it('every other worker state is silent (installing/activating/activated/redundant)', () => {
    for (const state of ['installing', 'activating', 'activated', 'redundant']) {
      expect(shouldShowUpdatePrompt(state, true)).toBe(false)
    }
  })
})

describe('shouldCheckForUpdates — the focus/visibility bound (#148 AC 4)', () => {
  it('never-checked → yes', () => {
    expect(shouldCheckForUpdates(null, 0)).toBe(true)
  })

  it('within the interval → no; at/past the interval → yes (bound is inclusive)', () => {
    expect(shouldCheckForUpdates(1_000_000, 1_000_000 + UPDATE_CHECK_MIN_INTERVAL_MS - 1)).toBe(false)
    expect(shouldCheckForUpdates(1_000_000, 1_000_000 + UPDATE_CHECK_MIN_INTERVAL_MS)).toBe(true)
    expect(shouldCheckForUpdates(1_000_000, 1_000_000 + 10 * UPDATE_CHECK_MIN_INTERVAL_MS)).toBe(true)
  })

  it('the interval is one hour, and the bound is test-overridable', () => {
    expect(UPDATE_CHECK_MIN_INTERVAL_MS).toBe(60 * 60 * 1000)
    expect(shouldCheckForUpdates(100, 199, 100)).toBe(false)
    expect(shouldCheckForUpdates(100, 200, 100)).toBe(true)
  })
})

describe('isSkipWaitingMessage — the message shape sw.js mirrors', () => {
  it('accepts exactly { type: SKIP_WAITING }', () => {
    expect(isSkipWaitingMessage({ type: 'SKIP_WAITING' })).toBe(true)
    expect(SKIP_WAITING_MESSAGE_TYPE).toBe('SKIP_WAITING')
  })

  it('rejects anything else posted at the worker', () => {
    expect(isSkipWaitingMessage({ type: 'OTHER' })).toBe(false)
    expect(isSkipWaitingMessage({})).toBe(false)
    expect(isSkipWaitingMessage(null)).toBe(false)
    expect(isSkipWaitingMessage('SKIP_WAITING')).toBe(false)
    expect(isSkipWaitingMessage([{ type: 'SKIP_WAITING' }])).toBe(false)
  })

  it('the reload grace is a short safety net, not a second wait (3s)', () => {
    expect(SKIP_WAITING_RELOAD_GRACE_MS).toBe(3000)
  })
})

// ------------------------------------------- fakes (mocked registration states)

/** Minimal worker: state + statechange + postMessage recording. */
class FakeWorker implements WatchedWorker {
  state = 'installing'
  messages: unknown[] = []
  private stateListeners: Array<() => void> = []
  addEventListener(_type: 'statechange', listener: () => void): void {
    this.stateListeners.push(listener)
  }
  postMessage(message: unknown): void {
    this.messages.push(message)
  }
  /** Test seam: the browser sets state, then dispatches statechange. */
  setState(state: string): void {
    this.state = state
    for (const listener of [...this.stateListeners]) listener()
  }
}

/** Minimal registration: installing/waiting + updatefound + update(). */
class FakeRegistration implements WatchedRegistration {
  installing: FakeWorker | null = null
  waiting: FakeWorker | null = null
  updateCalls = 0
  private updatefoundListeners: Array<() => void> = []
  addEventListener(_type: 'updatefound', listener: () => void): void {
    this.updatefoundListeners.push(listener)
  }
  update(): Promise<unknown> {
    this.updateCalls += 1
    return Promise.resolve(undefined)
  }
  /** Test seam: the browser found an update (updatefound → installing). */
  beginUpdate(worker: FakeWorker): void {
    this.installing = worker
    for (const listener of [...this.updatefoundListeners]) listener()
  }
  /** Test seam: install finished (worker moves to waiting, state installed). */
  finishInstall(): void {
    this.waiting = this.installing
    this.installing?.setState('installed')
  }
}

/** Minimal container: controller + register + controllerchange. */
class FakeContainer implements WatchedContainer {
  controller: object | null = null
  registeredUrls: string[] = []
  private controllerchangeListeners: Array<() => void> = []
  constructor(readonly registration: FakeRegistration = new FakeRegistration()) {}
  register(scriptUrl: string): Promise<WatchedRegistration> {
    this.registeredUrls.push(scriptUrl)
    return Promise.resolve(this.registration)
  }
  addEventListener(_type: 'controllerchange', listener: () => void): void {
    this.controllerchangeListeners.push(listener)
  }
  fireControllerChange(): void {
    for (const listener of [...this.controllerchangeListeners]) listener()
  }
}

/** Flush the register() promise chain inside the watch. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Capturing foreground harness: subscribe/unsubscribe + a fake focus. */
function foregroundHarness() {
  let listener: (() => void) | null = null
  return {
    onForeground: (l: () => void) => {
      listener = l
      return () => {
        listener = null
      }
    },
    focus: () => listener?.(),
    isSubscribed: () => listener !== null,
  }
}

// --------------------------------- watchServiceWorkerUpdates (behavioral)

describe('watchServiceWorkerUpdates — detection', () => {
  it('registers the app worker once, and a cue-less watch (dev posture) still registers but subscribes to nothing', async () => {
    const plain = new FakeContainer()
    watchServiceWorkerUpdates(plain)
    await settled()
    expect(plain.registeredUrls).toEqual(['/sw.js'])

    const devHarness = foregroundHarness()
    const dev = new FakeContainer()
    watchServiceWorkerUpdates(dev, { onForeground: devHarness.onForeground })
    await settled()
    expect(dev.registeredUrls).toEqual(['/sw.js'])
    // Registration-only: no cue → no foreground subscription, and an update
    // landing under the running tab stays silent (#148 AC 5 — dev no-ops).
    expect(devHarness.isSubscribed()).toBe(false)
    dev.controller = {}
    dev.registration.beginUpdate(new FakeWorker())
    dev.registration.finishInstall()
    // Nothing to assert a prompt against — the cue was never passed.
  })

  it('updatefound → installed with a controller → exactly ONE prompt, carrying the registration', async () => {
    const container = new FakeContainer()
    const prompted: WatchedRegistration[] = []
    watchServiceWorkerUpdates(container, { onUpdateReady: (reg) => prompted.push(reg) })
    await settled()
    container.controller = {} // an older worker already controls this page
    container.registration.beginUpdate(new FakeWorker())
    container.registration.finishInstall()
    expect(prompted).toEqual([container.registration])
  })

  it('the same worker cannot re-prompt on later state changes, but a SECOND update still cues', async () => {
    const container = new FakeContainer()
    let prompts = 0
    watchServiceWorkerUpdates(container, { onUpdateReady: () => (prompts += 1) })
    await settled()
    container.controller = {}
    const first = new FakeWorker()
    container.registration.beginUpdate(first)
    container.registration.finishInstall()
    first.setState('activating')
    first.setState('installed') // even a pathological double 'installed'
    expect(prompts).toBe(1)
    container.registration.beginUpdate(new FakeWorker())
    container.registration.finishInstall()
    expect(prompts).toBe(2)
  })

  it('the FIRST install never prompts (no controller — that page is the new version)', async () => {
    const container = new FakeContainer()
    let prompts = 0
    watchServiceWorkerUpdates(container, { onUpdateReady: () => (prompts += 1) })
    await settled()
    container.controller = null
    container.registration.beginUpdate(new FakeWorker())
    container.registration.finishInstall()
    expect(prompts).toBe(0)
  })

  it('a worker ALREADY waiting at attach cues immediately (update landed while this tab was closed)', async () => {
    const registration = new FakeRegistration()
    registration.waiting = new FakeWorker()
    const container = new FakeContainer(registration)
    container.controller = {}
    const prompted: WatchedRegistration[] = []
    watchServiceWorkerUpdates(container, { onUpdateReady: (reg) => prompted.push(reg) })
    await settled()
    expect(prompted).toEqual([registration])
  })

  it('a waiting worker at attach does NOT cue on an uncontrolled page (fresh install race)', async () => {
    const registration = new FakeRegistration()
    registration.waiting = new FakeWorker()
    const container = new FakeContainer(registration)
    container.controller = null
    let prompts = 0
    watchServiceWorkerUpdates(container, { onUpdateReady: () => (prompts += 1) })
    await settled()
    expect(prompts).toBe(0)
  })

  it('a worker mid-install at attach (its updatefound fired before the listener) still cues', async () => {
    const registration = new FakeRegistration()
    registration.installing = new FakeWorker()
    const container = new FakeContainer(registration)
    const prompted: WatchedRegistration[] = []
    watchServiceWorkerUpdates(container, { onUpdateReady: (reg) => prompted.push(reg) })
    await settled()
    expect(prompted).toEqual([])
    container.controller = {}
    registration.finishInstall()
    expect(prompted).toEqual([registration])
  })

  it('a rejected registration never crashes the page (flaky field network)', async () => {
    const container = new FakeContainer()
    container.register = () => Promise.reject(new Error('network gone'))
    let prompts = 0
    watchServiceWorkerUpdates(container, { onUpdateReady: () => (prompts += 1) })
    await settled()
    await settled()
    expect(prompts).toBe(0)
  })

  it('dispose silences the cue and unsubscribes the foreground listener', async () => {
    const container = new FakeContainer()
    const harness = foregroundHarness()
    let prompts = 0
    const dispose = watchServiceWorkerUpdates(container, {
      onUpdateReady: () => (prompts += 1),
      onForeground: harness.onForeground,
    })
    await settled()
    expect(harness.isSubscribed()).toBe(true)
    dispose()
    expect(harness.isSubscribed()).toBe(false)
    container.controller = {}
    container.registration.beginUpdate(new FakeWorker())
    container.registration.finishInstall()
    expect(prompts).toBe(0)
  })
})

describe('watchServiceWorkerUpdates — bounded foreground checks (#148 AC 4)', () => {
  it('register() itself is the first check: an early focus re-checks nothing', async () => {
    const container = new FakeContainer()
    const harness = foregroundHarness()
    let nowMs = 1_000_000
    watchServiceWorkerUpdates(container, {
      onUpdateReady: () => {},
      onForeground: harness.onForeground,
      now: () => nowMs,
    })
    await settled()
    nowMs += 5 * 60 * 1000 // five minutes later, tab refocused
    harness.focus()
    expect(container.registration.updateCalls).toBe(0)
  })

  it('past the interval a focus checks ONCE; the next eager focus waits out the bound again', async () => {
    const container = new FakeContainer()
    const harness = foregroundHarness()
    let nowMs = 1_000_000
    watchServiceWorkerUpdates(container, {
      onUpdateReady: () => {},
      onForeground: harness.onForeground,
      now: () => nowMs,
    })
    await settled()
    nowMs += UPDATE_CHECK_MIN_INTERVAL_MS + 1000
    harness.focus()
    harness.focus() // still within the new bound window
    expect(container.registration.updateCalls).toBe(1)
    nowMs += UPDATE_CHECK_MIN_INTERVAL_MS
    harness.focus()
    expect(container.registration.updateCalls).toBe(2)
  })

  it('a FAILED check (offline tablet) is swallowed — no unhandled rejection, bound keeps ticking', async () => {
    const container = new FakeContainer()
    const harness = foregroundHarness()
    let nowMs = 1_000_000
    container.registration.update = () => Promise.reject(new Error('offline'))
    watchServiceWorkerUpdates(container, {
      onUpdateReady: () => {},
      onForeground: harness.onForeground,
      now: () => nowMs,
    })
    await settled()
    nowMs += UPDATE_CHECK_MIN_INTERVAL_MS
    harness.focus()
    await settled()
    await settled()
  })
})

// ----------------------- activateWaitingWorkerAndReload (the Reload action)

describe('activateWaitingWorkerAndReload — the Reload click (#148 AC 2)', () => {
  it('a WAITING worker gets the SKIP_WAITING ask, then the page reloads on controllerchange — exactly once', () => {
    const registration = new FakeRegistration()
    registration.waiting = new FakeWorker()
    const container = new FakeContainer()
    const scheduled: Array<{ handler: () => void; ms: number }> = []
    let reloads = 0
    activateWaitingWorkerAndReload(
      container,
      registration,
      () => (reloads += 1),
      (handler, ms) => scheduled.push({ handler, ms }),
    )
    expect(registration.waiting.messages).toEqual([{ type: 'SKIP_WAITING' }])
    expect(scheduled.map((s) => s.ms)).toEqual([SKIP_WAITING_RELOAD_GRACE_MS])
    expect(reloads).toBe(0) // the click never reloads before control flips
    container.fireControllerChange()
    container.fireControllerChange() // pathological double event
    scheduled[0].handler() // the grace timer firing late
    expect(reloads).toBe(1)
  })

  it('no controllerchange ever comes → the grace net still reloads (a click must not no-op)', () => {
    const registration = new FakeRegistration()
    registration.waiting = new FakeWorker()
    const container = new FakeContainer()
    const scheduled: Array<() => void> = []
    let reloads = 0
    activateWaitingWorkerAndReload(
      container,
      registration,
      () => (reloads += 1),
      (handler) => scheduled.push(handler),
    )
    expect(reloads).toBe(0)
    scheduled[0]()
    expect(reloads).toBe(1)
  })

  it('an ALREADY-ACTIVE worker (sw.js skipWaiting()d at install) → a plain reload, no message, no listener', () => {
    const registration = new FakeRegistration()
    registration.waiting = null
    const container = new FakeContainer()
    const scheduled: Array<() => void> = []
    let reloads = 0
    activateWaitingWorkerAndReload(
      container,
      registration,
      () => (reloads += 1),
      (handler) => scheduled.push(handler),
    )
    expect(reloads).toBe(1)
    container.fireControllerChange() // no listener was armed
    expect(reloads).toBe(1)
    expect(scheduled).toEqual([])
  })
})

// ------------------------------------------- source pins (no silent drift)

describe('public/sw.js — the SKIP_WAITING message handler is wired', () => {
  it('exactly one message listener, mirroring isSkipWaitingMessage, appended after the push handlers', () => {
    expect(SW_SOURCE.match(/self\.addEventListener\('message'/g)).toEqual(["self.addEventListener('message'"])
    const messageSection = SW_SOURCE.slice(SW_SOURCE.indexOf("self.addEventListener('message'"))
    expect(messageSection).toContain("event.data.type === 'SKIP_WAITING'")
    expect(messageSection).toContain('self.skipWaiting()')
    // Non-object / null / array data must stay inert (the mirror's guards).
    expect(messageSection).toContain('typeof event.data === \'object\'')
    expect(messageSection).toContain('!Array.isArray(event.data)')
    // Appended, per the file's append-only convention.
    expect(SW_SOURCE.indexOf("self.addEventListener('message'")).toBeGreaterThan(
      SW_SOURCE.indexOf("self.addEventListener('notificationclick'"),
    )
  })

  it('the install-time skipWaiting stays (the already-active path the plain reload relies on)', () => {
    const installSection = SW_SOURCE.slice(0, SW_SOURCE.indexOf('// ---------------- activate'))
    expect(installSection).toContain('await self.skipWaiting()')
  })
})

describe('src/frontend/pwa/sw-update-watch.ts — calls the canonical helpers, not re-derivations', () => {
  it('the prompt decision and the update-check bound come from sw-handlers', () => {
    expect(WATCH_SRC).toContain('shouldShowUpdatePrompt(worker.state, container.controller !== null)')
    expect(WATCH_SRC).toContain('shouldCheckForUpdates(lastCheckedAt, at)')
    // No inline re-derivation of either rule.
    expect(WATCH_SRC).not.toContain("=== 'installed' &&")
    expect(WATCH_SRC).not.toContain('UPDATE_CHECK_MIN_INTERVAL_MS -')
  })

  it('the Reload action posts the typed message and arms the grace net', () => {
    expect(WATCH_SRC).toContain('postMessage({ type: SKIP_WAITING_MESSAGE_TYPE })')
    expect(WATCH_SRC).toContain('schedule(reloadOnce, SKIP_WAITING_RELOAD_GRACE_MS)')
    expect(WATCH_SRC).toContain("container.addEventListener('controllerchange', reloadOnce)")
  })
})

describe('src/frontend/pwa/sw-update-prompt.tsx — the cue runs through the app toast system', () => {
  it('arms only in production; registration itself survives in dev (#148 AC 5)', () => {
    expect(PROMPT_SRC).toContain("process.env.NODE_ENV === 'production'")
    expect(PROMPT_SRC).toContain("cueEnabled ? { onUpdateReady: showUpdatePrompt, onForeground } : {}")
  })

  it('toasts the i18n-keyed copy with a patient, dismissible, non-blocking posture (#148 AC 1 + 3)', () => {
    expect(PROMPT_SRC).toContain("tRef.current('sw.update.title')")
    expect(PROMPT_SRC).toContain("tRef.current('sw.update.body')")
    expect(PROMPT_SRC).toContain('duration: Infinity')
    expect(PROMPT_SRC).toContain("label: tRef.current('sw.update.reload')")
    expect(PROMPT_SRC).toContain("label: tRef.current('sw.update.later')")
  })

  it("the Reload action is the watch's activateWaitingWorkerAndReload → window.location.reload", () => {
    expect(PROMPT_SRC).toContain('activateWaitingWorkerAndReload(')
    expect(PROMPT_SRC).toContain('() => window.location.reload()')
  })

  it('the foreground adapter listens to focus + back-to-visible only, and still defers registration to window load', () => {
    expect(PROMPT_SRC).toContain("window.addEventListener('focus', listener)")
    expect(PROMPT_SRC).toContain("document.addEventListener('visibilitychange', onVisibility)")
    expect(PROMPT_SRC).toContain("document.visibilityState === 'visible'")
    expect(PROMPT_SRC).toContain("document.readyState === 'complete'")
    expect(PROMPT_SRC).toContain("window.addEventListener('load', start, { once: true })")
  })
})

describe('src/app/layout.tsx — the cue is mounted inside I18nProvider, the inline script is gone', () => {
  it('mounts <SwUpdatePrompt /> inside <I18nProvider> (useT throws outside a provider)', () => {
    expect(LAYOUT_SRC).toContain('<SwUpdatePrompt />')
    const providerAt = LAYOUT_SRC.indexOf('<I18nProvider>')
    const promptAt = LAYOUT_SRC.indexOf('<SwUpdatePrompt />')
    const providerEnd = LAYOUT_SRC.indexOf('</I18nProvider>')
    expect(promptAt).toBeGreaterThan(providerAt)
    expect(promptAt).toBeLessThan(providerEnd)
  })

  it('the old inline registration script is gone — registration lives in the tested client module', () => {
    expect(LAYOUT_SRC).not.toContain("navigator.serviceWorker.register('/sw.js')")
    // The lang-sync inline script (the nonce consumer) survives untouched —
    // its pins live in html-lang.test.ts / security-headers.test.ts.
    expect(LAYOUT_SRC).toContain("localStorage.getItem('mjengo-os-settings')")
  })
})

describe('sw.update.* dictionaries — bilingual, both keys, no placeholders', () => {
  const UPDATE_KEYS = ['sw.update.title', 'sw.update.body', 'sw.update.reload', 'sw.update.later'] as const

  it('every key exists in en + sw with a non-empty value', () => {
    for (const key of UPDATE_KEYS) {
      expect(typeof enDict[key] === 'string' && enDict[key].trim().length > 0, `en.${key}`).toBe(true)
      expect(typeof swDict[key] === 'string' && swDict[key].trim().length > 0, `sw.${key}`).toBe(true)
    }
  })

  it('the prompt renders real copy in both languages (spot values)', () => {
    expect(enDict['sw.update.title']).toBe('A new version is ready')
    expect(swDict['sw.update.title']).toBe('Toleo jipya limeandaliwa')
    expect(enDict['sw.update.reload']).toBe('Reload')
    expect(swDict['sw.update.reload']).toBe('Pakia upya')
    expect(swDict['sw.update.later']).toBe('Baadaye')
  })

  it('every literal tRef.current(...) key the prompt component uses resolves in both dictionaries', () => {
    const literalKeys = [...PROMPT_SRC.matchAll(/\btRef\.current\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1])
    expect(literalKeys.length).toBeGreaterThanOrEqual(UPDATE_KEYS.length)
    for (const key of new Set(literalKeys)) {
      expect(enDict[key], `en.ts is missing "${key}" (used by sw-update-prompt.tsx)`).toBeDefined()
      expect(swDict[key], `sw.ts is missing "${key}" (used by sw-update-prompt.tsx)`).toBeDefined()
    }
  })
})
