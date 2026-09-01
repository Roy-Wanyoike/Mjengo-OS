import { NextRequest, NextResponse } from 'next/server'
import { withGuard, FINANCE_ROLES } from '@/lib/guard'
import { walletWithBalance } from '@/modules/wallet/service'
import { jsonErr } from '@/modules/wallet/http'

export const dynamic = 'force-dynamic'

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/wallets/:id — one wallet (id or code) with its ledger-derived
 * balance (spec §38/§39). Finance/admin only.
 */
export const GET = withGuard<Ctx>(async (req, _session, ctx) => {
  try {
    const { id } = await ctx.params
    const projectId = req.nextUrl.searchParams.get('projectId') ?? ''
    const { wallet, balance } = await walletWithBalance(projectId, id)
    return NextResponse.json({
      ok: true,
      data: {
        id: wallet.id,
        code: wallet.code,
        label: wallet.label,
        ownerType: wallet.ownerType,
        ownerId: wallet.ownerId,
        currency: wallet.currency,
        status: wallet.status,
        ledgerAccountId: wallet.ledgerAccountId,
        balance, // derived from ledger entries — never a stored field
      },
    })
  } catch (e) {
    console.error('[api/v1/wallets/:id GET]', e)
    return jsonErr(e instanceof Error ? e.message : 'Wallet not found', 404)
  }
}, { roles: FINANCE_ROLES })
