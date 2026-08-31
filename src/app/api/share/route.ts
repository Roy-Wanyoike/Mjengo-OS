import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { applyAction, getProjectPayload, type ActionType } from '@/lib/mjengo'

export const dynamic = 'force-dynamic'

/**
 * Public "Virtual Site Visit" endpoint — diaspora clients arrive via a
 * revocable share token (`/?share=<token>`), no auth. GET boots the read-mostly
 * client view; POST is strictly limited to the client-decision allowlist.
 */
const CLIENT_ALLOWLIST: readonly ActionType[] = [
  'milestone.decide',
  'variation.decide',
  'comment.add',
  'notification.read',
  'notification.readAll',
]

/** GET /api/share?token=... → project payload for the client link. */
export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token')
    if (!token) {
      return NextResponse.json({ error: 'Share token required' }, { status: 400 })
    }
    const project = await db.project.findUnique({ where: { shareToken: token } })
    if (!project) {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
    }
    const data = await getProjectPayload(project.id)
    if (!data) {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
    }
    return NextResponse.json({
      ok: true,
      data,
      project: {
        name: project.name,
        client: project.client,
        location: project.location,
        status: project.status,
      },
    })
  } catch (e) {
    console.error('[api/share GET]', e)
    return NextResponse.json({ error: 'Share link could not be loaded' }, { status: 500 })
  }
}

/**
 * POST /api/share { token, type, payload } — client-decision actions only.
 * The actor is always stamped as the project's client (role 'client') so the
 * Bias-Free Ledger records exactly who decided, from a public link.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { token, type, payload } = body as { token?: string; type?: ActionType; payload?: any }
    if (!token) return NextResponse.json({ error: 'Share token required' }, { status: 400 })
    if (!type) return NextResponse.json({ error: 'type required' }, { status: 400 })
    if (!CLIENT_ALLOWLIST.includes(type)) {
      return NextResponse.json({ error: 'Not permitted from a client link' }, { status: 403 })
    }
    const project = await db.project.findUnique({ where: { shareToken: token } })
    if (!project) {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
    }
    // Actor identity comes from the link itself — clients can never impersonate the site team
    const clientPayload = { ...(payload ?? {}), __actor: project.client, __role: 'client' }
    const result = await applyAction(type, clientPayload, project.id)
    const data = await getProjectPayload(project.id)
    return NextResponse.json({ ok: true, result, data })
  } catch (e) {
    console.error('[api/share POST]', e)
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'Action failed' }, { status: 400 })
  }
}
