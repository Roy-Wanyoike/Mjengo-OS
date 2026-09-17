import { NextRequest, NextResponse } from 'next/server'
import { withGuard } from '@/backend/core/guard'
import { SITE_ROLES, LIMITS } from '@/backend/core/policy'
import { apiErrorResponse, readJson, unknownAction } from '@/backend/core/http'
import { ipRateLimited } from '@/backend/core/rate-limit'
import { addParcelDocument, getParcelPassport, listLandData, searchTitle } from '@/backend/domains/land/land-service'

/**
 * LandVerify API — thin controller over the land service.
 *
 * Access: reads serve signed-in users AND zero-login share links (rate
 * limited per IP — share tokens are secrets worth brute-force guarding).
 * Registry searches + document uploads (POST) are site-team actions;
 * clients see results, the site team runs the searches and holds the docs.
 */

export async function GET(req: NextRequest) {
  const limited = ipRateLimited(req, 'api/land', LIMITS.share.limit, LIMITS.share.windowMs)
  if (limited) return limited
  try {
    // ?passport=1&parcelId=… — consolidated Property Passport read
    const url = new URL(req.url)
    if (url.searchParams.get('passport') === '1') {
      return NextResponse.json(await getParcelPassport(req))
    }
    const data = await listLandData(req)
    return NextResponse.json(data)
  } catch (e) {
    return apiErrorResponse(e, 'api/land')
  }
}

export const POST = withGuard(async (req: NextRequest, session) => {
  const body = await readJson(req)
  const action = String(body.action ?? '')
  if (action === 'title.search') return NextResponse.json(await searchTitle(body, session.user))
  if (action === 'document.add') return NextResponse.json(await addParcelDocument(body, session.user))
  return unknownAction()
}, { roles: SITE_ROLES, rateLimit: LIMITS.search, tag: 'api/land' })
