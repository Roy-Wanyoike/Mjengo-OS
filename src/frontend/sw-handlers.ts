// Service-worker push handler logic (W5-1) — PURE and unit-tested.
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
