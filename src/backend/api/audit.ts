import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { route, genericError } from '@/backend/lib/route-kit'
import type { AuditEvent } from '@prisma/client'

// Admin audit-log read API (spec §44 "Admin → Audit Logs" with filters).
// src/app/api/audit/route.ts is the shim.
//
// IMMUTABILITY — READ-ONLY BY DESIGN. This module deliberately exposes ONLY a
// GET handler. No POST/PUT/PATCH/DELETE handler may ever be added here: the
// spec is explicit that users should never be able to erase or rewrite audit
// records — the ONLY writer is lib/audit.ts logAudit() (append-only), called
// from the action/seed code paths. Audit events are facts, not resources.
//
// GET /api/audit?actor=&role=&projectId=&entity=&kind=&from=&to=&q=&limit=&cursor=
//   · Guard: admin role only (route { roles: ['admin'] }) → 401/403.
//   · Rate limit: 60/min per principal (bucket 'audit.list') — AFTER the admin
//     guard: 401/403 first, then 429 — anonymous brute-force never burns
//     tokens and admins get clear auth errors.
//   · Filters:
//       actor     — contains match on the actor name
//       role      — exact (contractor, client, system, ai, finance, …)
//       projectId — exact
//       entity    — exact entity type (e.g. StockMovement)
//       kind      — exact (delivery, wage, milestone, escrow, …)
//       from / to — ISO date range on createdAt (inclusive; a date-only `to`
//                   like 2026-02-14 expands to end-of-day UTC so a calendar
//                   date includes that day's events — classic footgun)
//       q         — free-text contains on the summary
//     Honest SQLite note: Prisma `contains` compiles to LIKE, which SQLite
//     evaluates ASCII-CASE-INSENSITIVELY by default (pragma off) — actor/q
//     therefore match ASCII case-insensitively; non-ASCII case folding is not
//     supported by SQLite LIKE and is an honest limitation.
//   · Pagination: keyset — limit (1-200, default 50) + cursor (the AuditEvent
//     id of the last item of the previous page), like v1 wallets pagination.
//     Ordering is createdAt DESC, id DESC (tiebreak). An unknown cursor id →
//     400 (stale or wrong). nextCursor is null on the last page.
//   · Response: { ok: true, data: <AuditEvent[]>, nextCursor, hasMore } where
//     every row serializes ALL model fields; the JSON-string columns
//     (meta/before/after) come back PARSED when they contain valid JSON, else
//     as the raw string (never fabricated, never silently dropped).

/** Parse a JSON-string column honestly: valid JSON → parsed value, else raw. */
function parseMaybeJson(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Full AuditEvent serialization — every model field, ISO timestamps. */
function serializeAuditEvent(e: AuditEvent) {
  return {
    id: e.id,
    projectId: e.projectId,
    kind: e.kind,
    actor: e.actor,
    role: e.role,
    summary: e.summary,
    meta: parseMaybeJson(e.meta),
    entity: e.entity,
    entityId: e.entityId,
    before: parseMaybeJson(e.before),
    after: parseMaybeJson(e.after),
    ip: e.ip,
    userAgent: e.userAgent,
    requestId: e.requestId,
    createdAt: e.createdAt.toISOString(),
  }
}

/** ISO or date-only string → Date; date-only gets midnight / end-of-day UTC. */
function parseBoundary(raw: string, endOfDay: boolean): Date | null {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
  const d = new Date(raw.trim())
  if (Number.isNaN(d.getTime())) return null
  if (dateOnly) d.setUTCHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0)
  return d
}

export const GET = route(
  {
    scope: 'api/audit GET',
    roles: ['admin'],
    rateLimit: { bucket: 'audit.list', limit: 60, windowMs: 60_000 },
    onError: genericError(500, 'Failed to list audit events'),
  },
  async (req: NextRequest) => {
    const sp = req.nextUrl.searchParams
    const err = (error: string) => NextResponse.json({ error }, { status: 400 })

    // ---- filters (empty string = filter absent) ----
    const actor = sp.get('actor')?.trim() || undefined
    const role = sp.get('role')?.trim() || undefined
    const projectId = sp.get('projectId')?.trim() || undefined
    const entity = sp.get('entity')?.trim() || undefined
    const kind = sp.get('kind')?.trim() || undefined
    const q = sp.get('q')?.trim() || undefined
    const fromRaw = sp.get('from')?.trim() || undefined
    const toRaw = sp.get('to')?.trim() || undefined

    const createdAt: { gte?: Date; lte?: Date } = {}
    if (fromRaw) {
      const from = parseBoundary(fromRaw, false)
      if (!from) return err(`Invalid from date: "${fromRaw}" — use ISO 8601`)
      createdAt.gte = from
    }
    if (toRaw) {
      const to = parseBoundary(toRaw, true)
      if (!to) return err(`Invalid to date: "${toRaw}" — use ISO 8601`)
      createdAt.lte = to
    }

    // ---- pagination ----
    const limitRaw = sp.get('limit')?.trim() ?? ''
    let limit = 50
    if (limitRaw) {
      limit = Number(limitRaw)
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return err('limit must be an integer between 1 and 200')
      }
    }
    const cursor = sp.get('cursor')?.trim() || undefined

    // Keyset boundary: the cursor row's (createdAt, id) pair. Unknown id →
    // 400 (honest: stale or wrong — mirrors v1 wallets' cursor behavior).
    let boundary: { createdAt: Date; id: string } | null = null
    if (cursor) {
      const cursorRow = await db.auditEvent.findUnique({ where: { id: cursor } })
      if (!cursorRow) return err('Unknown cursor — it must be the id of an audit event')
      boundary = { createdAt: cursorRow.createdAt, id: cursorRow.id }
    }

    // ---- query: createdAt DESC, id DESC, keyset after the boundary row ----
    const rows = await db.auditEvent.findMany({
      where: {
        ...(actor ? { actor: { contains: actor } } : {}),
        ...(role ? { role } : {}),
        ...(projectId ? { projectId } : {}),
        ...(entity ? { entity } : {}),
        ...(kind ? { kind } : {}),
        ...(q ? { summary: { contains: q } } : {}),
        ...(createdAt.gte || createdAt.lte ? { createdAt } : {}),
        ...(boundary
          ? {
              OR: [
                { createdAt: { lt: boundary.createdAt } },
                { createdAt: boundary.createdAt, id: { lt: boundary.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // one extra row → hasMore without a second count query
    })

    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const nextCursor = hasMore ? page[page.length - 1]?.id ?? null : null

    return NextResponse.json({
      ok: true,
      data: page.map(serializeAuditEvent),
      nextCursor,
      hasMore,
    })
  },
)
