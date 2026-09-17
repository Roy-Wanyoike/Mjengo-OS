import { NextRequest, NextResponse } from 'next/server'
import { withGuard } from '@/backend/core/guard'
import { LIMITS } from '@/backend/core/policy'
import { readJson, unknownAction } from '@/backend/core/http'
import {
  listInvoices,
  createInvoice,
  updateDraft,
  submitInvoice,
  decideInvoice,
  markPaid,
} from '@/backend/domains/finance/invoice-service'

/**
 * Invoice API — thin controller over the finance service.
 *
 * Any signed-in role may GET (the service scopes clients to their own
 * project and hides draft/rejected internals) and any signed-in role may
 * POST, but the service enforces the lifecycle matrix per action:
 *   create / updateDraft / submit / markPaid → contractor + admin
 *   decide                                 → client + admin
 */

export const GET = withGuard(async (req: NextRequest, session) => {
  const data = await listInvoices(session.user, new URL(req.url).searchParams.get('projectId'))
  return NextResponse.json(data)
}, { rateLimit: LIMITS.read, tag: 'api/invoices' })

export const POST = withGuard(async (req: NextRequest, session) => {
  const body = await readJson(req)
  switch (String(body.action ?? '')) {
    case 'create':
      return NextResponse.json(await createInvoice(body, session.user))
    case 'updateDraft':
      return NextResponse.json(await updateDraft(body, session.user))
    case 'submit':
      return NextResponse.json(await submitInvoice(body, session.user))
    case 'decide':
      return NextResponse.json(await decideInvoice(body, session.user))
    case 'markPaid':
      return NextResponse.json(await markPaid(body, session.user))
    default:
      return unknownAction()
  }
}, { rateLimit: LIMITS.write, tag: 'api/invoices' })
