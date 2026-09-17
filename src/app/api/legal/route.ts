import { NextRequest, NextResponse } from 'next/server'
import { withGuard } from '@/backend/core/guard'
import { LIMITS } from '@/backend/core/policy'
import { apiErrorResponse, readJson, unknownAction } from '@/backend/core/http'
import { ipRateLimited } from '@/backend/core/rate-limit'
import { listReviews, requestReview } from '@/backend/domains/land/legal-service'

/**
 * Legal review API — thin controller over the legal service.
 * GET serves signed-in users AND share links (reviews for accessible
 * parcels only); POST requires a session and stamps the requester from it.
 */

export async function GET(req: NextRequest) {
  const limited = ipRateLimited(req, 'api/legal', LIMITS.share.limit, LIMITS.share.windowMs)
  if (limited) return limited
  try {
    const data = await listReviews(req)
    return NextResponse.json(data)
  } catch (e) {
    return apiErrorResponse(e, 'api/legal')
  }
}

export const POST = withGuard(async (req: NextRequest, session) => {
  const body = await readJson(req)
  if (String(body.action ?? '') !== 'request') return unknownAction()
  return NextResponse.json(await requestReview(body, session.user))
}, { rateLimit: LIMITS.write, tag: 'api/legal' })
