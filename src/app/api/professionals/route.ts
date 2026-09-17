import { NextRequest, NextResponse } from 'next/server'
import { withGuard } from '@/backend/core/guard'
import { LIMITS } from '@/backend/core/policy'
import { readJson, unknownAction } from '@/backend/core/http'
import {
  listProfessionals,
  verifyRegistration,
} from '@/backend/domains/professionals/professionals-service'

/**
 * Professionals registry API — thin controller over the professionals
 * service. Open to every signed-in role on purpose: a diaspora client
 * verifying their own lawyer's registration is exactly the protection
 * this feature exists to provide.
 */

export const GET = withGuard(async () => {
  const data = await listProfessionals()
  return NextResponse.json(data)
}, { rateLimit: LIMITS.read, tag: 'api/professionals' })

export const POST = withGuard(async (req: NextRequest, session) => {
  const body = await readJson(req)
  if (String(body.action ?? '') !== 'verify') return unknownAction()
  return NextResponse.json(await verifyRegistration(body, session.user))
}, { rateLimit: LIMITS.search, tag: 'api/professionals' })
