import { NextRequest, NextResponse } from 'next/server'
import { withGuard } from '@/backend/core/guard'
import { SITE_ROLES, LIMITS } from '@/backend/core/policy'
import { fieldStr, readJson, unknownAction } from '@/backend/core/http'
import { generateIntelDigest, getIntelData, recomputeRiskAssessment, updateSignal } from '@/backend/domains/intel/intel-service'

/**
 * Site Intelligence API — thin controller over the intel service.
 * Site-team only (the Intel tab is hidden from clients; the API agrees).
 * POST recompute/digest are owner/admin actions — SITE_ROLES already excludes
 * the client role, so a client POST is rejected 403 by the guard.
 */

export const GET = withGuard(async (req: NextRequest) => {
  const data = await getIntelData(new URL(req.url).searchParams.get('projectId') ?? '')
  return NextResponse.json(data)
}, { roles: SITE_ROLES, rateLimit: LIMITS.read, tag: 'api/intel' })

export const POST = withGuard(async (req: NextRequest, session) => {
  const body = await readJson(req)
  const action = String(body.action ?? '')
  if (action === 'signal.ack' || action === 'signal.resolve') {
    return NextResponse.json(await updateSignal(body, session.user))
  }
  if (action === 'recompute') {
    const projectId = fieldStr(body.projectId, 'projectId required')
    return NextResponse.json(await recomputeRiskAssessment(projectId, session.user))
  }
  if (action === 'digest') {
    const projectId = fieldStr(body.projectId, 'projectId required')
    return NextResponse.json(await generateIntelDigest(projectId, session.user))
  }
  return unknownAction()
}, { roles: SITE_ROLES, rateLimit: LIMITS.write, tag: 'api/intel' })
