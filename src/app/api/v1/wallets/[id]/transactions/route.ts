import { NextRequest, NextResponse } from 'next/server'
import { withGuard, FINANCE_ROLES } from '@/lib/guard'
import { walletLedgerTransactions } from '@/modules/wallet/service'
import { jsonErr } from '@/modules/wallet/http'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/wallets/:id/transactions — the double-entry ledger transactions
 * that touch this wallet's backing account (spec §38), newest first, with the
 * per-transaction debit/credit legs and totals. Finance/admin only.
 */
export const GET = withGuard<Ctx>(async (req, _session, ctx) => {
  try {
    const { id } = await ctx.params
    const projectId = req.nextUrl.searchParams.get('projectId') ?? ''
    const result = await walletLedgerTransactions(projectId, id)
    return NextResponse.json({ ok: true, data: result })
  } catch (e) {
    console.error('[api/v1/wallets/:id/transactions GET]', e)
    return jsonErr(e instanceof Error ? e.message : 'Wallet transactions failed', 400)
  }
}, { roles: FINANCE_ROLES })
