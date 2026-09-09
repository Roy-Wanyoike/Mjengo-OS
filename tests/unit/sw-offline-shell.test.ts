/**
 * PWA offline-first reload promise (issue #78 / audit FE-1 + FE-8/9/11).
 *
 * Covers the v3 service-worker offline strategy and its PWA polish:
 *   · the PURE decision helpers in src/frontend/sw-handlers.ts (the canonical
 *     statement public/sw.js mirrors inline — the push-routes idiom): the
 *     dev/prod HTML-shell cache rule, the single '/' shell cache key, and the
 *     photo LRU eviction order;
 *   · the offline session-gate decision in src/frontend/mjengo/offline-boot.ts
 *     (the "continue offline" short-circuit app.tsx wires into its auth gate);
 *   · sw.js SOURCE pins for the v3 strategy (VERSION bump, prod-gated shell
 *     caching, offline.html still the final fallback, photo LRU wiring) —
 *     push-routes.test.ts keeps the older invariants (one fetch listener,
 *     /api network-only, push handlers appended);
 *   · manifest identity (id/lang), a VALID 32×32 favicon.ico, the bilingual
 *     offline.html, the copilot capture attribute, and the W7 i18n keys
 *     (parity itself is enforced by i18n.test.ts + dicts/check.ts).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEV_HOSTNAMES,
  PHOTO_CACHE_CAP,
  navigationShellKey,
  photoLruEvictions,
  shouldCacheNavigationHtml,
} from '@/frontend/sw-handlers'
import { AUTH_LOADING_TIMEOUT_MS, shouldOfflineBoot } from '@/frontend/mjengo/offline-boot'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'

const SW_SOURCE = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8')
const MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../public/manifest.webmanifest', import.meta.url)), 'utf8'),
) as { id?: string; lang?: string; start_url?: string }
const OFFLINE_HTML = readFileSync(fileURLToPath(new URL('../../public/offline.html', import.meta.url)), 'utf8')
const COPILOT_SRC = readFileSync(
  fileURLToPath(new URL('../../src/frontend/mjengo/copilot-tab.tsx', import.meta.url)),
  'utf8',
)
const APP_SRC = readFileSync(fileURLToPath(new URL('../../src/frontend/mjengo/app.tsx', import.meta.url)), 'utf8')
const FAVICON = readFileSync(fileURLToPath(new URL('../../public/favicon.ico', import.meta.url)))

// ---------------------------------------------- pure helpers (sw-handlers.ts)

describe('shouldCacheNavigationHtml — dev keeps the no-stale-shell rule', () => {
  it('dev hostnames never cache HTML', () => {
    for (const host of DEV_HOSTNAMES) expect(shouldCacheNavigationHtml(host)).toBe(false)
    expect(shouldCacheNavigationHtml('localhost')).toBe(false)
    expect(shouldCacheNavigationHtml('127.0.0.1')).toBe(false)
  })

  it('production hostnames cache the app shell', () => {
    expect(shouldCacheNavigationHtml('mjengoos.example.com')).toBe(true)
    expect(shouldCacheNavigationHtml('192.168.1.20')).toBe(true)
    expect(shouldCacheNavigationHtml('app.mjengo.co.ke')).toBe(true)
  })
})

describe('navigationShellKey — one HTML route, one cache key', () => {
  it("the app shell ('/') caches under the single key '/'", () => {
    expect(navigationShellKey('/')).toBe('/')
  })

  it('anything else is not an app shell (null → not cached)', () => {
    expect(navigationShellKey('/share')).toBeNull()
    expect(navigationShellKey('/offline.html')).toBeNull()
    expect(navigationShellKey('/api/project')).toBeNull()
    expect(navigationShellKey('')).toBeNull()
  })
})

describe('photoLruEvictions — capped /photos/** cache (FE-8)', () => {
  it('within the cap → nothing to delete', () => {
    const urls = Array.from({ length: PHOTO_CACHE_CAP }, (_, i) => `/photos/p${i}.jpg`)
    const lastUsed = new Map(urls.map((u, i) => [u, 1000 + i]))
    expect(photoLruEvictions(urls, lastUsed)).toEqual([])
    expect(photoLruEvictions([], new Map())).toEqual([])
  })

  it('evicts exactly the excess, least-recently-used first', () => {
    const urls = ['/photos/a.jpg', '/photos/b.jpg', '/photos/c.jpg', '/photos/d.jpg']
    const lastUsed = new Map([
      ['/photos/a.jpg', 300], // oldest
      ['/photos/b.jpg', 100],
      ['/photos/c.jpg', 200],
      ['/photos/d.jpg', 400], // newest
    ])
    // cap 2 → 2 evictions: b (100) then c (200); a and d survive.
    expect(photoLruEvictions(urls, lastUsed, 2)).toEqual(['/photos/b.jpg', '/photos/c.jpg'])
    // cap 3 → only the single oldest goes.
    expect(photoLruEvictions(urls, lastUsed, 3)).toEqual(['/photos/b.jpg'])
  })

  it('never-touched entries (lost catalog / SW restart) count as oldest', () => {
    const urls = Array.from({ length: 5 }, (_, i) => `/photos/n${i}.jpg`)
    const lastUsed = new Map([['/photos/n3.jpg', 999]])
    // cap 4 → evict one: the first never-touched entry in key order.
    expect(photoLruEvictions(urls, lastUsed, 4)).toEqual(['/photos/n0.jpg'])
  })

  it('ties keep the cache key order (deterministic)', () => {
    const urls = ['/photos/x.jpg', '/photos/y.jpg', '/photos/z.jpg']
    expect(photoLruEvictions(urls, new Map(), 1)).toEqual(['/photos/x.jpg', '/photos/y.jpg'])
  })

  it('cap 0 degenerates honestly (evict everything, oldest first)', () => {
    const urls = ['/photos/x.jpg', '/photos/y.jpg']
    const lastUsed = new Map([['/photos/y.jpg', 5]])
    expect(photoLruEvictions(urls, lastUsed, 0)).toEqual(['/photos/x.jpg', '/photos/y.jpg'])
  })
})

// ---------------------------------------------- pure gate (offline-boot.ts)

describe('shouldOfflineBoot — the auth-gate short-circuit (FE-1)', () => {
  const base = { authTimedOut: false, online: false, hasData: true }

  it('boots offline when the session fetch failed fast into a false unauthenticated', () => {
    expect(shouldOfflineBoot({ ...base, status: 'unauthenticated' })).toBe(true)
  })

  it('boots offline when the session fetch hangs past the timeout (lie-fi)', () => {
    expect(shouldOfflineBoot({ ...base, status: 'loading', authTimedOut: true })).toBe(true)
  })

  it('never boots without persisted data — nothing honest to show offline', () => {
    expect(shouldOfflineBoot({ ...base, status: 'unauthenticated', hasData: false })).toBe(false)
    expect(shouldOfflineBoot({ ...base, status: 'loading', authTimedOut: true, hasData: false })).toBe(false)
  })

  it('never boots while the gate can still resolve honestly (fresh loading, authenticated)', () => {
    expect(shouldOfflineBoot({ ...base, status: 'loading' })).toBe(false)
    expect(shouldOfflineBoot({ ...base, status: 'authenticated' })).toBe(false)
  })

  it('never boots for a signed-out user on a healthy network (login is the honest gate)', () => {
    expect(shouldOfflineBoot({ ...base, status: 'unauthenticated', online: true })).toBe(false)
  })

  it('the timeout is short — 3–4s, not a minute', () => {
    expect(AUTH_LOADING_TIMEOUT_MS).toBeGreaterThanOrEqual(3000)
    expect(AUTH_LOADING_TIMEOUT_MS).toBeLessThanOrEqual(4000)
  })
})

// ---------------------------------------------- sw.js v3 source pins

describe('public/sw.js v3 — offline app shell wired as designed', () => {
  it('VERSION is bumped (v2 → v3: old caches wiped on activate)', () => {
    expect(SW_SOURCE).toContain("const VERSION = 'mjengoos-2f-3'")
    expect(SW_SOURCE).not.toContain("const VERSION = 'mjengoos-2f-2'")
  })

  it('HTML-shell caching is gated on the dev/prod hostname rule', () => {
    // The honest runtime signal: the SW's own origin hostname.
    expect(SW_SOURCE).toContain("self.location.hostname === 'localhost'")
    expect(SW_SOURCE).toContain("self.location.hostname === '127.0.0.1'")
    // …and the gate actually arms the prod-only behavior.
    expect(SW_SOURCE).toContain('!IS_DEV')
  })

  it("navigations: network-first, cache the '/' shell only, fallback cache → offline.html", () => {
    expect(SW_SOURCE).toContain("request.mode === 'navigate'")
    expect(SW_SOURCE).toContain("url.pathname === '/' ? '/' : null")
    expect(SW_SOURCE).toContain('await cache.put(shellKey, response.clone())')
    expect(SW_SOURCE).toContain('await caches.match(shellKey)')
    // The final fallback is still the precached static card.
    expect(SW_SOURCE).toContain("caches.match('/offline.html')")
  })

  it('/photos/** is cache-first with a version-independent LRU-capped cache (FE-8)', () => {
    expect(SW_SOURCE).toContain("url.pathname.startsWith('/photos/')")
    expect(SW_SOURCE).toContain("const PHOTO_CACHE = 'mjengoos-photos'")
    expect(SW_SOURCE).toContain('const PHOTO_CACHE_CAP = 100')
    expect(SW_SOURCE).toContain('trimPhotoCache(cache)')
    // Photos survive VERSION bumps; the static cache does not.
    expect(SW_SOURCE).toContain('n !== STATIC_CACHE && n !== PHOTO_CACHE')
  })

  it('the LRU catalog is persisted inside the photo cache (survives SW restarts)', () => {
    expect(SW_SOURCE).toContain("const PHOTO_LRU_KEY = '/__mjengoos/photo-lru.json'")
    expect(SW_SOURCE).toContain('touchPhotoLru(request.url)')
    expect(SW_SOURCE).toContain('photoLruEvictions')
  })

  it('still exactly ONE fetch listener (push handlers appended, not added to)', () => {
    expect(SW_SOURCE.match(/self\.addEventListener\('fetch'/g)).toEqual(["self.addEventListener('fetch'"])
  })
})

// ---------------------------------------------- manifest + favicon (FE-9)

describe('manifest.webmanifest identity (FE-9)', () => {
  it('declares id "/" and lang "en"', () => {
    expect(MANIFEST.id).toBe('/')
    expect(MANIFEST.lang).toBe('en')
    expect(MANIFEST.start_url).toBe('/')
  })
})

describe('public/favicon.ico — a valid 32×32 icon (FE-9)', () => {
  it('is a well-formed single-image ICO with a 32×32 32bpp entry', () => {
    expect(FAVICON.length).toBeGreaterThan(0)
    // ICONDIR: reserved 0, type 1 (icon), count 1.
    expect(FAVICON.readUInt16LE(0)).toBe(0)
    expect(FAVICON.readUInt16LE(2)).toBe(1)
    expect(FAVICON.readUInt16LE(4)).toBe(1)
    // Directory entry: 32×32, 32bpp, byte counts add up to the file size.
    expect(FAVICON.readUInt8(6)).toBe(32)
    expect(FAVICON.readUInt8(7)).toBe(32)
    expect(FAVICON.readUInt16LE(6 + 6)).toBe(32)
    const bytesInRes = FAVICON.readUInt32LE(6 + 8)
    const offset = FAVICON.readUInt32LE(6 + 12)
    expect(offset).toBe(22)
    expect(FAVICON.length).toBe(offset + bytesInRes)
    // BITMAPINFOHEADER: 40 bytes, 32px wide, 64px tall (XOR+AND), 32bpp.
    expect(FAVICON.readUInt32LE(offset)).toBe(40)
    expect(FAVICON.readInt32LE(offset + 4)).toBe(32)
    expect(FAVICON.readInt32LE(offset + 8)).toBe(64)
    expect(FAVICON.readUInt16LE(offset + 14)).toBe(32)
  })

  it('paints the brand mark: stone-950 tile with amber hat pixels', () => {
    // Sample center-top (background) and dome center (amber).
    const px = (x: number, y: number) => {
      const i = 22 + 40 + ((31 - y) * 32 + x) * 4 // bottom-up XOR rows
      return { r: FAVICON[i + 2], g: FAVICON[i + 1], b: FAVICON[i] }
    }
    // Transparent rounded corners.
    const px0 = px(0, 0)
    // BGR sample at corner index 0 → alpha byte.
    const alpha = FAVICON[22 + 40 + 3]
    expect(alpha).toBe(0)
    void px0
    // Background stone-950 (#1c1917) and amber-500 (#f59e0b) present.
    const bg = px(4, 4)
    expect(bg.r).toBeLessThan(60)
    const hat = px(16, 16)
    expect(hat.r).toBeGreaterThan(200)
    expect(hat.g).toBeGreaterThan(120)
    expect(hat.b).toBeLessThan(100)
  })
})

// ---------------------------------------------- offline.html (FE-11)

describe('public/offline.html — bilingual EN/SW (FE-11)', () => {
  it('carries both languages with per-section lang attributes', () => {
    expect(OFFLINE_HTML).toContain('You&rsquo;re offline')
    expect(OFFLINE_HTML).toContain('Uko nje ya mtandao')
    expect(OFFLINE_HTML).toContain('lang="en"')
    expect(OFFLINE_HTML).toContain('lang="sw"')
  })

  it('orders the saved UI language first (mjengo-os-settings, no network)', () => {
    expect(OFFLINE_HTML).toContain("localStorage.getItem('mjengo-os-settings')")
    expect(OFFLINE_HTML).toContain('document.documentElement.lang')
    expect(OFFLINE_HTML).toContain('html[lang="sw"] .sw { order: 1; }')
  })

  it('stays self-contained (no external src/href), retry still ≥44px', () => {
    expect(OFFLINE_HTML).not.toMatch(/(src|href)="(https?:)?\/\//)
    expect(OFFLINE_HTML).toContain('min-height: 44px')
  })
})

// ---------------------------------------------- copilot capture attr (FE-11)

describe('copilot photo input — capture="environment" (FE-11)', () => {
  it('the file input asks mobile browsers for the rear camera', () => {
    expect(COPILOT_SRC).toContain('capture="environment"')
  })
})

// ---------------------------------------------- app.tsx i18n wiring (W7 keys)

describe('app.tsx shell strings resolve in both dictionaries', () => {
  const W7_KEYS = [
    'app.deadLink.title',
    'app.deadLink.body',
    'app.offline.banner',
    'app.offline.pending',
    'app.offline.aiOffline',
    'app.unknownRole',
  ] as const

  it('every W7 key exists in en + sw with a non-empty value', () => {
    for (const key of W7_KEYS) {
      expect(typeof enDict[key] === 'string' && enDict[key].trim().length > 0, `en.${key}`).toBe(true)
      expect(typeof swDict[key] === 'string' && swDict[key].trim().length > 0, `sw.${key}`).toBe(true)
    }
  })

  it('every literal t() key app.tsx now uses exists in both dictionaries', () => {
    const literalKeys = [
      ...APP_SRC.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g),
      ...APP_SRC.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g),
    ].map((m) => m[1])
    expect(literalKeys.length).toBeGreaterThanOrEqual(W7_KEYS.length)
    for (const key of new Set(literalKeys)) {
      expect(enDict[key], `en.ts is missing "${key}" (used by app.tsx)`).toBeDefined()
      expect(swDict[key], `sw.ts is missing "${key}" (used by app.tsx)`).toBeDefined()
    }
  })

  it('the offline boot is wired: gate, timeout helper, and banner keys', () => {
    expect(APP_SRC).toContain('shouldOfflineBoot')
    expect(APP_SRC).toContain('AUTH_LOADING_TIMEOUT_MS')
    expect(APP_SRC).toContain("t('app.offline.banner')")
    // The gates actually honor the short-circuit.
    expect(APP_SRC).toContain('if (status === \'loading\' && !offlineBoot)')
    expect(APP_SRC).toContain('!offlineBoot) {\n    return <LoginScreen />')
  })
})
