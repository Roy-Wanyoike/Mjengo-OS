import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { withGuard } from '@/lib/guard'
import { markRead } from '@/modules/notify/service'

export const dynamic = 'force-dynamic'

/**
 * Notification-center mark-read endpoint.
 *
 * WHY a dedicated route (and not a registered domain action): marking a
 * notification read is a CLIENT-SIDE CONVENIENCE — it changes read-state for
 * the person reading, not any domain state (no ledger-worthy business event:
 * nothing was decided, moved or recorded about the project). The action
 * registry in lib/mjengo.ts is the domain-mutation path and stays untouched;
 * the legacy `notification.read` / `notification.readAll` evidence actions
 * remain available for share-token clients (they are on the client allowlist
 * and route through /api/share). Signed-in users of every role use this route.
 *
 * POST { projectId, ids?: string[] | 'all' } → sets read=true and readAt (only
 * where still null, preserving the first-read timestamp), strictly scoped to
 * the project. Client-role sessions may only touch their own project.
 */
export const POST = withGuard(async (req, session) => {
  try {
    const body = (await req.json()) as { projectId?: unknown; ids?: unknown }
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })

    const project = await db.project.findUnique({ where: { id: projectId } })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // Client-role sessions see exactly their own project — never another one's rows.
    if (session.user.role === 'client' && session.user.projectId && session.user.projectId !== projectId) {
      return NextResponse.json({ error: 'Not permitted for this project' }, { status: 403 })
    }

    let ids: string[] | 'all'
    if (body.ids === 'all' || body.ids === undefined) {
      ids = 'all'
    } else if (Array.isArray(body.ids) && body.ids.length > 0 && body.ids.every((id) => typeof id === 'string')) {
      if (body.ids.length > 200) return NextResponse.json({ error: 'Too many ids (max 200)' }, { status: 400 })
      ids = body.ids as string[]
    } else {
      return NextResponse.json({ error: "ids must be 'all' or an array of notification ids" }, { status: 400 })
    }

    const { updated } = await markRead(projectId, ids)
    return NextResponse.json({ ok: true, updated })
  } catch (e) {
    console.error('[api/notifications POST]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to mark notifications read' }, { status: 400 })
  }
})
