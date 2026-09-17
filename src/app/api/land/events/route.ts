import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/backend/core/http'
import { ipRateLimited } from '@/backend/core/rate-limit'
import { LIMITS } from '@/backend/core/policy'
import { listParcelEvents } from '@/backend/domains/land/land-service'

/**
 * Parcel registry event history (read-only): signed-in session OR a valid
 * ?share= token. Share links are scoped to their project's parcels — a
 * token for one project can never read another project's events.
 */

export async function GET(req: NextRequest) {
  const limited = ipRateLimited(req, 'api/land/events', LIMITS.share.limit, LIMITS.share.windowMs)
  if (limited) return limited
  try {
    const data = await listParcelEvents(req)
    return NextResponse.json(data)
  } catch (e) {
    return apiErrorResponse(e, 'api/land/events')
  }
}
