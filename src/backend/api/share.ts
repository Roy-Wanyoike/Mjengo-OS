import { NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { applyAction, getProjectPayload, type ActionType } from '@/backend/lib/mjengo'
import { publicRoute, safeError, genericError } from '@/backend/lib/route-kit'

// Public "Virtual Site Visit" endpoint — src/app/api/share/route.ts is the shim.
// Diaspora clients arrive via a revocable share token (`/?share=<token>`), no
// auth. GET boots the read-mostly client view; POST is strictly limited to the
// client-decision allowlist.
//
// Rate limit (P3 review item, W3-B): the route stays PUBLIC (the token IS the
// auth) but both verbs now enforce a 30/min per-IP bucket so scripted token
// brute-forcing cannot run at full speed. 30/min is far above what a human
// client view generates. In-process limiter — single-instance honesty note in
// src/backend/lib/rate-limit.ts.
const CLIENT_ALLOWLIST: readonly ActionType[] = [
  'milestone.decide',
  'variation.decide',
  'comment.add',
  'notification.read',
  'notification.readAll',
]

/** GET /api/share?token=... → project payload for the client link. */
export const GET = publicRoute(
  {
    scope: 'api/share GET',
    rateLimit: { bucket: 'share.get', limit: 30, windowMs: 60_000 },
    onError: genericError(500, 'Share link could not be loaded'),
  },
  async (req) => {
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
  },
)

/**
 * POST /api/share { token, type, payload } — client-decision actions only.
 * The actor is always stamped as the project's client (role 'client') so the
 * Bias-Free Ledger records exactly who decided, from a public link.
 */
export const POST = publicRoute(
  {
    scope: 'api/share POST',
    rateLimit: { bucket: 'share.post', limit: 30, windowMs: 60_000 },
    body: { onParseError: 'throw' },
    onError: safeError(400, 'Action failed', { okFalse: true }),
  },
  async (_req, _session, body) => {
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
  },
)
