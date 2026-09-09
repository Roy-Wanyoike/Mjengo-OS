import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { enforceAiRoutePolicy } from '@/backend/lib/rate-limit'
import { safeErrorMessage } from '@/backend/lib/guard'
import { requireFlagOn } from '@/backend/modules/intel/flags'
import { loadAuthenticityInsights, runAuthenticityScreen } from '@/backend/modules/ai/authenticity'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// W6-3 — Evidence Authenticity Screen, on-demand leg (the other leg is the
// post-freeze hook inside createDrawPackForRelease). Wave-6 route convention:
// gate failures keep 401/403/400/429; AI outcome states return 200 with the
// honest body ({ ran, reason, stats, insights }) — an unavailable provider or
// a skipped vision pass is a STATE, not an error.
//
//   POST /api/ai/authenticity-screen  { projectId } → run the screen now
//        (hash backfill + duplicate comparison + vision pass) and return the
//        outcome plus the project's current advisory insight rows.
//   GET  /api/ai/authenticity-screen?projectId=… → read the advisory rows
//        (newest first) — the evidence tab's display path, no SDK contact.
//
// Both legs: session → site-team role allowlist (enforceAiRoutePolicy) →
// 10 req/min/user → requireFlagOn('ai') (admins bypass so they can toggle and
// test; everyone else gets the uniform 403 while the flag is off).

export const POST = async (req: NextRequest): Promise<NextResponse> => {
  const gate = await enforceAiRoutePolicy(req, {
    bucket: 'ai:authenticity-screen',
    fields: [{ name: 'projectId', type: 'string' }],
  })
  if (!gate.ok) return gate.response

  // The single-switch gate: the whole screen (deterministic hash half
  // included) rides the `ai` flag — one switch, per the 8-f design.
  const flagDenied = await requireFlagOn('ai', gate.session)
  if (flagDenied) return flagDenied

  try {
    // projectId optional in the body → the caller's active project, else the
    // first project (the analyze-photo fallback precedent).
    const bodyProjectId = typeof gate.body.projectId === 'string' ? gate.body.projectId : undefined
    const projectId = gate.projectId ?? bodyProjectId
    let resolved = projectId ?? null
    if (!resolved) {
      const first = await db.project.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
      if (!first) return NextResponse.json({ error: 'No project' }, { status: 404 })
      resolved = first.id
    }

    const outcome = await runAuthenticityScreen({ projectId: resolved })
    const insights = await loadAuthenticityInsights(resolved)
    // Honest 200 either way — a failed screen is a state, never a 500, and
    // errorClass is leak-free (the provider contract's hygiene).
    return NextResponse.json({ ok: outcome.ok, outcome, insights })
  } catch (e) {
    console.error('[api/ai/authenticity-screen]', e)
    // Same redaction family as the other /api/ai routes — no raw internals.
    return NextResponse.json({ error: safeErrorMessage(e, 'Authenticity screen failed') }, { status: 500 })
  }
}

export const GET = async (req: NextRequest): Promise<NextResponse> => {
  // Same gate ladder for the read leg (empty GET body passes allowEmptyBody).
  const gate = await enforceAiRoutePolicy(req, {
    bucket: 'ai:authenticity-screen-list',
    fields: [],
    allowEmptyBody: true,
  })
  if (!gate.ok) return gate.response

  const flagDenied = await requireFlagOn('ai', gate.session)
  if (flagDenied) return flagDenied

  try {
    const url = new URL(req.url)
    const projectId = url.searchParams.get('projectId') ?? null
    if (!projectId) {
      return NextResponse.json({ error: 'projectId query parameter is required' }, { status: 400 })
    }
    const exists = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
    if (!exists) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    const insights = await loadAuthenticityInsights(projectId)
    return NextResponse.json({ ok: true, insights })
  } catch (e) {
    console.error('[api/ai/authenticity-screen GET]', e)
    return NextResponse.json({ error: safeErrorMessage(e, 'Could not load authenticity insights') }, { status: 500 })
  }
}
