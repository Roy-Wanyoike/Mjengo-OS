import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { applyAction, getProjectPayload, getProjectsList, type ActionType } from '@/lib/mjengo'
import { CLIENT_ACTIONS } from '@/lib/client-actions'
import { getSessionFromReq, unauthorized, forbidden } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * Owner action endpoint — requires a session.
 *  · client-ROLE sessions may only dispatch CLIENT_ACTIONS (403 otherwise) and
 *    are PINNED to their own project — a body projectId is ignored (tenant
 *    isolation, mirrors /api/sync)
 *  · no session + valid shareToken + CLIENT_ACTIONS type is also accepted
 *    (same contract as POST /api/share, actor stamped from the link)
 * Session identity is stamped on the Bias-Free Ledger via __actor/__role.
 *
 * Idempotency (spec §57): an optional `Idempotency-Key` header is persisted in
 * IdempotencyRecord (key, scope = action type, responseBody) — a repeated key
 * REPLAYS the stored response instead of re-applying the money movement.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { type, payload, projectId, shareToken } = body as {
      type: ActionType
      payload?: any
      projectId?: string
      shareToken?: string
    }
    if (!type) return NextResponse.json({ error: 'type required' }, { status: 400 })

    const idempotencyKey = req.headers.get('idempotency-key')?.trim() || null
    if (idempotencyKey) {
      const existing = await db.idempotencyRecord.findUnique({ where: { key: idempotencyKey } })
      if (existing) {
        // Replay the original result — never re-apply a money movement. The
        // refreshed payload keeps the response contract identical for callers.
        let replayed: any = null
        try {
          replayed = JSON.parse(existing.responseBody ?? 'null')
        } catch {
          replayed = null
        }
        const data = await getProjectPayload(existing.projectId ?? null)
        const projects = await getProjectsList()
        return NextResponse.json({ ok: true, result: replayed, replayed: true, scope: existing.scope, data, projects })
      }
    }

    const session = await getSessionFromReq(req)
    let actorPayload = { ...(payload ?? {}) }
    // Tenant pin: a client-role session ALWAYS acts on its own project — the
    // body projectId is ignored (and never leaks another project's payload).
    let targetProjectId = projectId

    if (!session) {
      // Share-link fallback: token IS the auth, but only for the client allowlist
      if (!shareToken) return unauthorized()
      const project = await db.project.findUnique({ where: { shareToken } })
      if (!project) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
      if (!CLIENT_ACTIONS.includes(type)) return unauthorized()
      actorPayload = { ...actorPayload, __actor: project.client, __role: 'client' }
      targetProjectId = project.id
    } else if (session.user.role === 'client') {
      if (!CLIENT_ACTIONS.includes(type)) return forbidden(session.user.role)
      if (!session.user.projectId) {
        return NextResponse.json({ ok: false, error: 'Client account has no project assigned' }, { status: 403 })
      }
      // Pinned: body projectId is deliberately ignored for client sessions.
      targetProjectId = session.user.projectId
      actorPayload = { ...actorPayload, __actor: session.user.name, __role: 'client' }
    } else {
      // Site team: stamp the signed-in identity (never overridable by the payload)
      actorPayload = { ...actorPayload, __actor: session.user.name, __role: session.user.role }
    }

    const result = await applyAction(type, actorPayload, targetProjectId)

    // Persist the idempotency record AFTER a successful apply (spec §57).
    if (idempotencyKey) {
      try {
        await db.idempotencyRecord.create({
          data: {
            key: idempotencyKey,
            scope: String(type),
            projectId: typeof targetProjectId === 'string' ? targetProjectId : null,
            responseBody: JSON.stringify(result ?? null),
          },
        })
      } catch {
        // Unique collision = a concurrent duplicate already recorded — the
        // original result stands, this response matches it.
      }
    }

    // Refresh payload for the project the action targeted (explicit > payload.projectId > first)
    const refreshProjectId = session?.user.role === 'client' ? session.user.projectId : targetProjectId || payload?.projectId || null
    const data = await getProjectPayload(refreshProjectId)
    const projects = await getProjectsList()
    return NextResponse.json({ ok: true, result, data, projects })
  } catch (e) {
    console.error('[api/actions]', e)
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'Action failed' }, { status: 400 })
  }
}
