import { NextRequest, NextResponse } from 'next/server'
import { withGuard, FINANCE_ROLES } from '@/lib/guard'
import { withdrawWallet, walletWithBalance } from '@/modules/wallet/service'
import { jsonErr, withIdempotency } from '@/modules/wallet/http'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/v1/wallets/:id/withdraw — debit the wallet into a cash rail
 * (debit WALLET:<code>, credit CASH_MPESA/CASH_BANK) with the balance
 * re-checked INSIDE the transaction. Finance/admin only. Idempotency-Key
 * honored. Body: { amount, destination?: 'mpesa'|'bank', note?, projectId? }
 */
export const POST = withGuard<Ctx>(async (req, session, ctx) => {
  try {
    const { id } = await ctx.params
    const body = await req.json().catch(() => ({}))
    const projectId =
      typeof body.projectId === 'string' && body.projectId
        ? body.projectId
        : session.user.projectId ?? ''
    const { wallet } = await walletWithBalance(projectId, id)
    const ownerProjectId = wallet.ownerType === 'project' ? wallet.ownerId ?? projectId : projectId
    return await withIdempotency(req, 'v1.wallet.withdraw', ownerProjectId || null, () =>
      withdrawWallet(ownerProjectId, {
        walletId: id,
        amount: Number(body.amount),
        destination: body.destination,
        note: body.note,
        by: session.user.name,
      }),
    )
  } catch (e) {
    console.error('[api/v1/wallets/:id/withdraw POST]', e)
    return jsonErr(e instanceof Error ? e.message : 'Withdrawal failed', 400)
  }
}, { roles: FINANCE_ROLES })
