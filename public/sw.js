/**
 * MjengoOS service worker (v2 — offline shell).
 *
 * Replaces the former kill-switch worker. Strategy:
 *   - /api/**        → network-only. NEVER cached, NEVER served from cache.
 *   - HTML navigations → network-first; when the network fails, the precached
 *     offline.html shell is served instead (successful HTML responses are NOT
 *     cached — no stale-shell trap between dev recompiles).
 *   - Immutable static assets (icons, photos, manifest, offline shell) →
 *     cache-first (same-origin, 200 responses only).
 *   - /_next/static/** → network-first with cache fallback — dev chunk URLs
 *     are stable-named but recompiled, so cache-first would serve stale code.
 *   - Non-GET and HMR paths → untouched, straight to the network.
 */

const VERSION = 'mjengoos-2f-2'
const STATIC_CACHE = `mjengoos-static-${VERSION}`

const PRECACHE_URLS = [
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

// ---------------- install ----------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE)
      // addAll is atomic for this small, guaranteed-static set.
      await cache.addAll(PRECACHE_URLS)
      await self.skipWaiting()
    })(),
  )
})

// ---------------- activate ----------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Keep only the current version's cache. This also wipes every legacy
      // cache name from the earlier PWA era (kill-switch leftovers, old
      // versions) so nothing stale can ever be served.
      const names = await caches.keys()
      await Promise.all(
        names.filter((n) => n !== STATIC_CACHE).map((n) => caches.delete(n)),
      )
      await self.clients.claim()
    })(),
  )
})

// ---------------- fetch ----------------

self.addEventListener('fetch', (event) => {
  const request = event.request

  // HONESTY RULE: /api/* is NEVER cached and never served from cache.
  // Money, attendance, evidence and audit data must always come from the
  // network — a stale payroll or muster served offline would be a lie.
  // Pass straight through, no respondWith.
  if (new URL(request.url).pathname.startsWith('/api/')) return

  // Non-GET: never intercepted (POST/PATCH mutations must hit the network).
  if (request.method !== 'GET') return

  // Dev-server HMR & websocket plumbing: intercepting these breaks the dev
  // server's hot reload. Leave them to the network.
  const url = new URL(request.url)
  if (
    url.pathname.startsWith('/_next/webpack-hmr') ||
    url.pathname.includes('sockjs') ||
    url.protocol === 'ws:' ||
    url.protocol === 'wss:'
  ) return

  // Only same-origin requests are ours to manage.
  if (url.origin !== self.location.origin) return

  // HTML navigations: network-first → offline shell fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // Deliberately NOT cached on success: dev recompiles and auth-gated
          // server HTML must never go stale in a cache.
          return await fetch(request)
        } catch {
          const shell = await caches.match('/offline.html')
          return (
            shell ||
            new Response('Offline', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            })
          )
        }
      })(),
    )
    return
  }

  // Immutable, never-recompiled assets: cache-first (icons, photos, manifest,
  // offline shell, static logo). /_next/static/** is deliberately NOT here —
  // in dev, Turbopack serves chunks from STABLE filenames whose content
  // changes on every recompile; caching those cache-first would serve stale
  // code after any edit (verified live: an edited component kept running the
  // pre-edit chunk after reload). Chunks therefore go network-first below.
  const isImmutableAsset =
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/photos/') ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/offline.html' ||
    url.pathname === '/logo.svg'

  if (isImmutableAsset) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request)
        if (cached) return cached
        try {
          const response = await fetch(request)
          if (response.ok) {
            const cache = await caches.open(STATIC_CACHE)
            cache.put(request, response.clone())
          }
          return response
        } catch {
          return new Response('', { status: 504 })
        }
      })(),
    )
    return
  }

  // Next.js build output (/_next/static/**): network-first with cache
  // fallback. In dev the URLs are stable but content changes on recompile,
  // so the network answer always wins; in prod the chunks are
  // content-hashed/immutable and the browser HTTP cache keeps this cheap.
  // The SW copy is only served when the network is genuinely unreachable.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request)
          if (response.ok) {
            const cache = await caches.open(STATIC_CACHE)
            cache.put(request, response.clone())
          }
          return response
        } catch {
          const cached = await caches.match(request)
          return (
            cached ||
            new Response('', { status: 504 })
          )
        }
      })(),
    )
    return
  }

  // Everything else (RSC payloads, /_next/image, data fetches): network,
  // untouched.
})
