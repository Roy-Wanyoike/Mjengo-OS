import { NextRequest, NextResponse } from 'next/server'
import { withGuard } from '@/backend/core/guard'
import { SITE_ROLES, LIMITS } from '@/backend/core/policy'
import { readJson, unknownAction } from '@/backend/core/http'
import {
  listSupplyData,
  createOrder,
  markDelivered,
  verifyDelivery,
} from '@/backend/domains/supply/supply-service'

/**
 * Supply chain trust API — thin controller over the supply service.
 * Site-team only (the Supply tab is hidden from clients; the API agrees).
 */

export const GET = withGuard(async (req: NextRequest) => {
  const data = await listSupplyData(new URL(req.url).searchParams.get('projectId'))
  return NextResponse.json(data)
}, { roles: SITE_ROLES, rateLimit: LIMITS.read, tag: 'api/suppliers' })

export const POST = withGuard(async (req: NextRequest, session) => {
  const body = await readJson(req)
  switch (String(body.action ?? '')) {
    case 'order.create':
      return NextResponse.json(await createOrder(body, session.user))
    case 'order.deliver':
      return NextResponse.json(await markDelivered(body, session.user))
    case 'order.verify':
      return NextResponse.json(await verifyDelivery(body, session.user))
    default:
      return unknownAction()
  }
}, { roles: SITE_ROLES, rateLimit: LIMITS.write, tag: 'api/suppliers' })
