import { NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { route, safeError } from '@/backend/lib/route-kit'
import { markRead } from '@/backend/modules/notify/service'

// Notification-center route — src/app/api/notifications/route.ts is the shim.
//
// WHY a dedicated route (and not a registered domain action): marking a
// notification read is a CLIENT-SIDE CONVENIENCE — it changes read-state for
// the person reading, not any domain state (no ledger-worthy business event:
// nothing was decided, moved or recorded about the project). The action
// registry in lib/mjengo.ts is the domain-mutation path and stays untouched;
// the legacy `notification.read` / `notification.readAll` evidence actions
// remain available for share-token clients (they are on the client allowlist
// and route through /api/share). Signed-in users of every role use this route.
//
// POST { projectId, ids?: string[] | 'all' } → sets read=true and readAt (only
// where still null, preserving the first-read timestamp), strictly scoped to
// the project. Client-role sessions may only touch their own project.
//
// GET (Doc A §42, backend wave) → the project's notifications with OPTIONAL
// pagination/filter params — the default (no params) is the same newest-first
// list the UI already consumes:
//   ?limit=50      page size (1-200, default 50)
//   ?before=<iso>  keyset cursor — rows strictly older than this createdAt
//   ?kind=<kind>   exact kind filter
//   ?unread=true   only unread rows
// Client-role sessions are pinned to their own project (param ignored).
// The response also carries the session user's notification `prefs` (Doc A
// §42 user control) — parsed from User.notificationPrefs, or {} when unset.
//
// PUT { prefs } (Doc A §42) → per-kind in-app preferences for the SESSION
// user: { kind: { inApp: boolean } }, max 20 kinds, unknown kinds rejected
// with the allowed list (the open NotificationKind set — append-only). Stored
// JSON-stringified on User.notificationPrefs. HONEST: only the in-app channel
// exists today, so these prefs are recorded but not yet gating delivery —
// they are the seam the §42 channel work will read.
//
// Error-path note (W-BACKEND): the old catches returned raw e.message, which
// leaked Prisma internals on this route unlike every other S-SEC route —
// they now go through safeErrorMessage (same statuses, same fallback copy).

/** Allowed pref kinds — mirrors NotificationKind in modules/notify/types.ts (open set, append-only; keep in sync). */
const PREF_KINDS: readonly string[] = [
  'recap', 'milestone', 'variation', 'anomaly', 'comment', 'attendance',
  'share', 'system',
  'approval.requested', 'approval.decided', 'quote.received', 'order.sent', 'order.confirmed',
  'delivery.dispatched', 'delivery.discrepancy', 'invoice.submitted', 'invoice.paid',
  'price.alert', 'digest.weekly', 'risk.flagged',
  'project.delayed', 'attendance.absent', 'budget.alert', 'ledger.reconciled',
]

const MAX_PREF_KINDS = 20

/** Parse User.notificationPrefs → a kind→{inApp} map, or {} (never throws). */
function parsePrefs(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Validate a prefs payload: plain object, ≤ MAX_PREF_KINDS kinds, every kind
 * known, every value { inApp?: boolean } (no other subfields today).
 * Returns the error string or null when valid.
 */
function validatePrefs(prefs: unknown): string | null {
  if (prefs === null || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return 'prefs must be a JSON object of kind → { inApp: boolean }'
  }
  const entries = Object.entries(prefs as Record<string, unknown>)
  if (entries.length > MAX_PREF_KINDS) {
    return `Too many kinds (${entries.length}, max ${MAX_PREF_KINDS})`
  }
  const allowed = new Set(PREF_KINDS)
  for (const [kind, value] of entries) {
    if (!allowed.has(kind)) {
      return `Unknown notification kind "${kind}" — allowed: ${PREF_KINDS.slice().sort().join(', ')}`
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return `prefs["${kind}"] must be an object like { inApp: boolean }`
    }
    for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
      if (sub !== 'inApp') {
        return `prefs["${kind}"] has unknown field "${sub}" — only inApp is supported today`
      }
      if (typeof subValue !== 'boolean') {
        return `prefs["${kind}"].inApp must be a boolean`
      }
    }
  }
  return null
}

export const POST = route(
  {
    scope: 'api/notifications POST',
    // Rate limit (S-SEC): 30 mutations/min per principal, the v1 mutation posture.
    rateLimit: { bucket: 'notifications.post', limit: 30, windowMs: 60_000 },
    body: { onParseError: 'throw' },
    onError: safeError(400, 'Failed to mark notifications read'),
  },
  async (_req, session, body) => {
    const parsed = body as { projectId?: unknown; ids?: unknown }
    const projectId = typeof parsed.projectId === 'string' ? parsed.projectId.trim() : ''
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })

    const project = await db.project.findUnique({ where: { id: projectId } })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // Client-role sessions see exactly their own project — never another one's rows.
    if (session.user.role === 'client' && session.user.projectId && session.user.projectId !== projectId) {
      return NextResponse.json({ error: 'Not permitted for this project' }, { status: 403 })
    }

    let ids: string[] | 'all'
    if (parsed.ids === 'all' || parsed.ids === undefined) {
      ids = 'all'
    } else if (Array.isArray(parsed.ids) && parsed.ids.length > 0 && parsed.ids.every((id) => typeof id === 'string')) {
      if (parsed.ids.length > 200) return NextResponse.json({ error: 'Too many ids (max 200)' }, { status: 400 })
      ids = parsed.ids as string[]
    } else {
      return NextResponse.json({ error: "ids must be 'all' or an array of notification ids" }, { status: 400 })
    }

    const { updated } = await markRead(projectId, ids)
    return NextResponse.json({ ok: true, updated })
  },
)

export const GET = route(
  {
    scope: 'api/notifications GET',
    // Rate limit (S-SEC): 60 reads/min per principal — the payload+prefs fan-out
    // is not a polling target.
    rateLimit: { bucket: 'notifications.get', limit: 60, windowMs: 60_000 },
    onError: safeError(500, 'Could not list notifications'),
  },
  async (req, session) => {
    const sp = req.nextUrl.searchParams

    // Project scoping — same rules as POST: client sessions are pinned to
    // their own project; everyone else may pass ?projectId= (default: first).
    let projectId: string | null = sp.get('projectId')?.trim() || null
    if (session.user.role === 'client') {
      if (!session.user.projectId) {
        return NextResponse.json({ error: 'Client account has no project assigned' }, { status: 403 })
      }
      projectId = session.user.projectId
    } else if (projectId) {
      const exists = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
      if (!exists) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    } else {
      const first = await db.project.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
      projectId = first?.id ?? null
    }

    // Pagination / filters — all optional; no params = the default list.
    const limitRaw = sp.get('limit')
    let limit = 50
    if (limitRaw !== null) {
      const n = Number(limitRaw)
      if (!Number.isInteger(n) || n < 1 || n > 200) {
        return NextResponse.json({ error: 'limit must be an integer 1-200' }, { status: 400 })
      }
      limit = n
    }
    const beforeRaw = sp.get('before')
    let before: Date | undefined
    if (beforeRaw !== null) {
      const d = new Date(beforeRaw)
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'before must be an ISO timestamp' }, { status: 400 })
      }
      before = d
    }
    const kind = sp.get('kind')?.trim() || undefined
    const unread = sp.get('unread') === 'true'

    const notifications = await db.notification.findMany({
      where: {
        ...(projectId ? { projectId } : {}),
        ...(before ? { createdAt: { lt: before } } : {}),
        ...(kind ? { kind } : {}),
        ...(unread ? { read: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { notificationPrefs: true },
    })
    return NextResponse.json({ ok: true, notifications, prefs: parsePrefs(user?.notificationPrefs) })
  },
)

export const PUT = route(
  {
    scope: 'api/notifications PUT',
    // Rate limit (S-SEC): 30 mutations/min per principal, the v1 mutation posture.
    rateLimit: { bucket: 'notifications.put', limit: 30, windowMs: 60_000 },
    body: { onParseError: 'reject' }, // the historical inner catch: 'Invalid JSON body'
    onError: safeError(400, 'Could not save preferences'),
  },
  async (_req, session, body) => {
    const parsed = body as { prefs?: unknown }
    if (parsed.prefs === undefined) {
      return NextResponse.json({ error: 'prefs required — { kind: { inApp: boolean } }' }, { status: 400 })
    }
    const invalid = validatePrefs(parsed.prefs)
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

    const prefs = parsed.prefs as Record<string, { inApp?: boolean }>
    await db.user.update({
      where: { id: session.user.id },
      data: { notificationPrefs: JSON.stringify(prefs) },
    })
    return NextResponse.json({ ok: true, prefs })
  },
)
