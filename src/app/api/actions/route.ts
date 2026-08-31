import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { applyAction, getProjectPayload, getProjectsList, type ActionType } from '@/lib/mjengo'
import { CLIENT_ACTIONS } from '@/lib/client-actions'
import { getSessionFromReq, unauthorized, forbidden } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * Owner action endpoint — requires a session.
 *  · client-ROLE sessions may only dispatch CLIENT_ACTIONS (403 otherwise)
 *  · no session + valid shareToken + CLIENT_ACTIONS type is also accepted
 *    (same contract as POST /api/share, actor stamped from the link)
 * Session identity is stamped on the Bias-Free Ledger via __actor/__role.
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

    const session = await getSessionFromReq(req)
    let actorPayload = { ...(payload ?? {}) }

    if (!session) {
      // Share-link fallback: token IS the auth, but only for the client allowlist
      if (!shareToken) return unauthorized()
      const project = await db.project.findUnique({ where: { shareToken } })
      if (!project) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
      if (!CLIENT_ACTIONS.includes(type)) return unauthorized()
      actorPayload = { ...actorPayload, __actor: project.client, __role: 'client' }
    } else if (session.user.role === 'client') {
      if (!CLIENT_ACTIONS.includes(type)) return forbidden(session.user.role)
      actorPayload = { ...actorPayload, __actor: session.user.name, __role: 'client' }
    } else {
      // Site team: stamp the signed-in identity (never overridable by the payload)
      actorPayload = { ...actorPayload, __actor: session.user.name, __role: session.user.role }
    }

    const result = await applyAction(type, actorPayload, projectId)
    // Refresh payload for the project the action targeted (explicit > payload.projectId > first)
    const data = await getProjectPayload(projectId || payload?.projectId || null)
    const projects = await getProjectsList()
    return NextResponse.json({ ok: true, result, data, projects })
  } catch (e) {
    console.error('[api/actions]', e)
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'Action failed' }, { status: 400 })
  }
}
