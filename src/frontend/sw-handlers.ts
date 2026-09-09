// Service-worker handler logic (W5-1 + W7 PWA offline) — PURE and unit-tested.
//
// public/sw.js is a plain static script (no bundler step — its offline
// behavior is load-bearing and deliberately hand-rolled), so it cannot
// import this module directly. Instead it wires the SAME logic inline, and
// these exported pure functions are the canonical, tested statement of the
// contract:
//   · the PAYLOAD the server sends (buildWebPushPayload in
//     src/backend/modules/notify/channels.ts — { title, body, projectId,
//     kind }) is what parsePushPayload accepts (tests round-trip both sides);
//   · the CLICK deep-link is /?projectId=<id> (the app boots straight into
//     that project), built ONLY from projectId — the server never guesses
//     app routing;
//   · a notificationclick never navigates off-origin: the target comes from
//     notification.data.url, which this module always builds as a
//     same-origin relative path.
//
// tests/unit/push-routes.test.ts pins all of this plus the sw.js source
// wiring (readFileSync assertions), so the inline copy cannot drift silently.

/** The normalized payload one push carries (all fields the sw uses). */
export interface PushNotificationPayload {
  title: string
  body: string
  projectId: string | null
  kind: string | null
}

/**
 * Parse whatever the push message carried into a payload, or null when it is
 * not the server's shape (the sw then shows a generic notification instead
 * of crashing the handler). Accepts the already-parsed JSON object (the
 * sw's event.data.json()) or a JSON string (event.data.text()).
 */
export function parsePushPayload(data: unknown): PushNotificationPayload | null {
  let parsed: unknown = data
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  // title is the one required field; body/projectId/kind are optional but
  // must be strings when present.
  if (typeof obj.title !== 'string' || !obj.title.trim()) return null
  if (obj.body !== undefined && typeof obj.body !== 'string') return null
  if (obj.projectId !== undefined && typeof obj.projectId !== 'string') return null
  if (obj.kind !== undefined && typeof obj.kind !== 'string') return null
  return {
    title: obj.title,
    body: typeof obj.body === 'string' ? obj.body : '',
    projectId: typeof obj.projectId === 'string' && obj.projectId ? obj.projectId : null,
    kind: typeof obj.kind === 'string' && obj.kind ? obj.kind : null,
  }
}

/**
 * The deep-link for a payload's project: /?projectId=<encoded id> — the app
 * boots that project directly. No project → the app root. The id is
 * encodeURIComponent'd so an id containing separators cannot smuggle extra
 * query params or fragments.
 */
export function deepLinkFor(projectId: string | null): string {
  if (!projectId) return '/'
  return `/?projectId=${encodeURIComponent(projectId)}`
}

/**
 * showNotification options for a payload: body, icons from the precached
 * PWA icons, a per-project tag (a second push for the same project REPLACES
 * the previous notification instead of stacking), and data.url — the
 * same-origin deep-link notificationclick opens.
 */
export function notificationOptionsFor(payload: PushNotificationPayload): {
  body: string
  icon: string
  badge: string
  tag: string
  data: { url: string }
} {
  return {
    body: payload.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.projectId ? `mjengoos-${payload.projectId}` : 'mjengoos',
    data: { url: deepLinkFor(payload.projectId) },
  }
}

/**
 * The URL a notificationclick navigates to: notification.data.url when it is
 * a safe SAME-ORIGIN relative path (starts with '/', not '//'), else the app
 * root. The origin is passed in (self.location.origin in the sw) — a payload
 * can never steer the click to a foreign site.
 */
export function clickTargetUrl(data: unknown, origin: string): string {
  let url = '/'
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const raw = (data as Record<string, unknown>).url
    if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) url = raw
  }
  return `${origin.replace(/\/$/, '')}${url}`
}

// ------------- W7 PWA offline (issue #78 / audit FE-1 + FE-8) --------------
//
// The v3 service-worker additions (offline app shell + photo LRU) follow the
// same contract as the push handlers above: public/sw.js is a STATIC script
// with no bundler step, so it cannot import this module — it mirrors the SAME
// logic inline, and these pure functions are the canonical, unit-tested
// statement (tests/unit/sw-offline-shell.test.ts pins both the helpers and
// the sw.js source wiring by reading the file, exactly like push-routes).

/** Hostnames `next dev` serves the SW from — production deployments never do. */
export const DEV_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1']

/**
 * Should this origin's service worker cache and serve cached HTML for
 * document navigations? PRODUCTION: yes — the last-good app shell is what an
 * offline RELOAD boots (issue #78/FE-1; data + outbox live client-side in
 * localStorage, so the shell is all the network owes us). DEV: never — the
 * dev server recompiles the same URL into different HTML on every edit;
 * caching it would serve a stale dev shell (the v2 no-stale-shell rule).
 * Honest mechanism: sw.js is ONE static file registered by both dev and prod
 * (layout.tsx), with no build step, so the SW's own origin hostname is the
 * only reliable runtime signal.
 */
export function shouldCacheNavigationHtml(hostname: string): boolean {
  return !DEV_HOSTNAMES.includes(hostname)
}

/**
 * The cache key a navigation's HTML is stored under: the APP serves exactly
 * one HTML route — the client-side app at '/' (query strings such as
 * ?share= / ?projectId= are read by the booted client; the server HTML is
 * identical), so every app-shell navigation caches AND serves under the
 * single key '/'. Any other path → null: not an app shell, not cached. (The
 * proxied marketing site at /website and /offline.html itself stay on the v2
 * rule: network-first with the offline.html fallback, never cached.)
 */
export function navigationShellKey(pathname: string): string | null {
  return pathname === '/' ? '/' : null
}

/** LRU cap for /photos/** cache entries (issue #78/FE-8: quota pressure). */
export const PHOTO_CACHE_CAP = 100

/**
 * Which cached photo URLs to delete when the set exceeds `cap` (issue #78 /
 * FE-8): least-recently-used first. A URL absent from `lastUsed` (never
 * served from the cache since the catalog was recorded, or the LRU catalog
 * was lost with a SW restart) counts as OLDEST; ties keep the cache's own key
 * order, so the result is deterministic. Returns the eviction list in delete
 * order — empty when the set is within the cap.
 */
export function photoLruEvictions(
  urls: readonly string[],
  lastUsed: ReadonlyMap<string, number>,
  cap: number = PHOTO_CACHE_CAP,
): string[] {
  const excess = urls.length - cap
  if (excess <= 0) return []
  return urls
    .map((url, i) => ({ url, i, at: lastUsed.get(url) ?? 0 }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .slice(0, excess)
    .map((e) => e.url)
}
