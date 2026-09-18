/**
 * Issue #136 / audit FE-7 — the online/offline SIMULATION toggle is gated
 * out of production builds.
 *
 * Two pin families:
 *
 *   · BEHAVIORAL const-eval — the gate lives in the importable module
 *     `src/frontend/lib/dev-affordances.ts`, so it is re-imported under a
 *     mutated NODE_ENV (the whatsapp-route.test.ts WEBHOOK_OPEN_POSTURE
 *     matrix pattern): production folds SHOW_CONNECTIVITY_SIM to `false`
 *     (what a `next build` inlines via DefinePlugin before the minifier
 *     dead-code-eliminates the gated markup), dev/test keep it `true`.
 *
 *   · SOURCE pins (the frontend-a11y.test.ts convention — vitest is
 *     node-only, no DOM): the toggle markup in header.tsx sits INSIDE the
 *     gate, and the REAL connectivity surfaces are provably NOT gated —
 *     app.tsx still mirrors browser online/offline events into the store,
 *     the amber offline banner still renders on real offline state, the
 *     store keeps setOnline (the browser-event path AND the unit suites'
 *     offline-flow harness: outbox-auto-retry / supplier-outbox /
 *     outbox-auth-drain all drive it directly on the store), and the i18n
 *     key family survives with copy that names the pill a dev/QA tool.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

// ---------------- behavioral: the gate's const-eval ----------------

describe('#136: SHOW_CONNECTIVITY_SIM const-evals on NODE_ENV', () => {
  const originalEnv = process.env.NODE_ENV

  /** Import a FRESH copy of the gate module under the current process.env. */
  async function importGate(): Promise<boolean> {
    vi.resetModules()
    const mod = await import('@/frontend/lib/dev-affordances')
    return mod.SHOW_CONNECTIVITY_SIM
  }

  afterEach(() => {
    // ALWAYS restored (the whatsapp-route.test.ts finally-restore pattern).
    if (originalEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalEnv
  })

  it('production → false (a prod build folds the constant; the pill is DCE fodder)', async () => {
    process.env.NODE_ENV = 'production'
    expect(await importGate()).toBe(false)
  })

  it('development → true (next dev keeps the QA affordance)', async () => {
    process.env.NODE_ENV = 'development'
    expect(await importGate()).toBe(true)
  })

  it('test → true (vitest NODE_ENV=test — the toggle stays renderable under test)', async () => {
    process.env.NODE_ENV = 'test'
    expect(await importGate()).toBe(true)
  })

  it('no NODE_ENV at all (bare container) → true — the gate fails OPEN, not closed', async () => {
    // A runtime that never sets NODE_ENV is by definition not a production
    // build (Next ALWAYS inlines one), so the affordance stays available —
    // the same default-posture call the webhook matrix makes for non-prod.
    delete process.env.NODE_ENV
    expect(await importGate()).toBe(true)
  })
})

// ---------------- source pins: the toggle markup is inside the gate ----------------

describe('#136: the header simulation pill is wrapped in the gate', () => {
  const src = readSrc('src/frontend/mjengo/header.tsx')

  it('imports the shared gate constant (no ad-hoc env check inside the component)', () => {
    expect(src).toContain("from '@/frontend/lib/dev-affordances'")
    expect(src).toContain('SHOW_CONNECTIVITY_SIM')
  })

  it('the gate module is the module-scope NODE_ENV fold itself', () => {
    const gate = readSrc('src/frontend/lib/dev-affordances.ts')
    expect(gate).toContain(
      "export const SHOW_CONNECTIVITY_SIM = process.env.NODE_ENV !== 'production'",
    )
  })

  it('the pill (Switch override + simNote tooltip + sim label) is inside {SHOW_CONNECTIVITY_SIM && (}', () => {
    const gateOpen = src.indexOf('{SHOW_CONNECTIVITY_SIM && (')
    expect(gateOpen).toBeGreaterThanOrEqual(0)
    // The gated region runs from the gate to the next header control (the
    // sync/outbox panel) — everything the issue names must be INSIDE it.
    const boundary = src.indexOf('<SyncOutboxPanel', gateOpen)
    expect(boundary).toBeGreaterThan(gateOpen)
    const region = src.slice(gateOpen, boundary)
    expect(region).toContain('onCheckedChange={setOnline}') // the override control
    expect(region).toContain("t('header.simNote')") // the dev-tool tooltip
    expect(region).toContain("t('header.aria.toggleConnectivity')")
    expect(region).toContain("t('header.offlineSim')") // the honest "sim" label
  })

  it('the Switch remains the ONLY markup consumer of setOnline in the header', () => {
    expect((src.match(/onCheckedChange=\{setOnline\}/g) ?? []).length).toBe(1)
  })
})

// ---------------- source pins: the REAL connectivity surfaces are NOT gated ----------------

describe('#136: real connectivity state survives the gate untouched', () => {
  it('app.tsx still mirrors navigator.onLine + browser online/offline events into the store', () => {
    const app = readSrc('src/frontend/mjengo/app.tsx')
    expect(app).toContain('useMjengo.setState({ online: navigator.onLine })')
    expect(app).toContain("window.addEventListener('offline', onOffline)")
    expect(app).toContain("window.addEventListener('online', onOnline)")
  })

  it('the amber offline banner still renders on real offline state (the honest indicator)', () => {
    const app = readSrc('src/frontend/mjengo/app.tsx')
    expect(app).toContain('{!online && !isClientSurface && (')
    expect(app).toContain("t('app.offline.banner')")
  })

  it("the store's setOnline stays in every runtime (browser-event path + the unit suites' offline harness)", () => {
    const store = readSrc('src/frontend/hooks/use-mjengo.ts')
    expect(store).toContain('setOnline: (v) => {')
  })

  it('the header synced indicator sits OUTSIDE the gate (real last-sync state)', () => {
    const src = readSrc('src/frontend/mjengo/header.tsx')
    const gateOpen = src.indexOf('{SHOW_CONNECTIVITY_SIM && (')
    const boundary = src.indexOf('<SyncOutboxPanel', gateOpen)
    const synced = src.indexOf("t('header.synced')")
    expect(synced).toBeGreaterThan(boundary) // after the gated region closes
  })
})

// ---------------- i18n: keys retained, copy names the dev tool ----------------

describe('#136: the sim-note copy clarifies the pill is a dev/QA tool', () => {
  it('en + sw simNote both name it a Dev/QA tool hidden from production', () => {
    expect(enDict['header.simNote']).toMatch(/dev\/qa/i)
    expect(enDict['header.simNote']).toMatch(/production/i)
    expect(swDict['header.simNote']).toMatch(/dev\/qa/i)
    expect(swDict['header.simNote']).toMatch(/uzalishaji/i)
  })

  it('the whole toggle key family survives (no raw strings introduced)', () => {
    const keys = [
      'header.online',
      'header.offlineSim',
      'header.aria.online',
      'header.aria.offline',
      'header.aria.toggleConnectivity',
      'header.simNote',
    ] as const
    for (const k of keys) {
      expect(typeof enDict[k] === 'string' && enDict[k].length > 0, `en.${k}`).toBe(true)
      expect(typeof swDict[k] === 'string' && swDict[k].length > 0, `sw.${k}`).toBe(true)
    }
  })
})
