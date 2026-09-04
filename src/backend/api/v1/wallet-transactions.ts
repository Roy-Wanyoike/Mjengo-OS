import { FINANCE_ROLES } from '@/backend/lib/guard'
import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { walletWithBalance } from '@/backend/modules/wallet/service'
import { jsonOk } from '@/backend/modules/wallet/http'
import { transactionsQuery, validateQuery, walletRef } from './schemas'
import { mapServiceError, v1Err, V1_READ_LIMIT } from './respond'

// /api/v1/wallets/:id/transactions — src/app/api/v1/wallets/[id]/transactions/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/wallets/:id/transactions — the double-entry ledger transactions
 * that touch this wallet's backing account (spec §38), newest first, with the
 * per-transaction debit/credit legs and totals. Finance/admin only.
 *
 * TRUE CURSOR PAGINATION (B5-APIV1 — this is the unbounded list):
 *   ?limit  (1-200, default 50)   page size
 *   ?cursor (LedgerTransaction id) position after the last item of the
 *           previous page — keyset on (occurredAt DESC, id DESC), so pages
 *           never overlap and are stable under inserts at the head.
 * The response keeps today's shape — `{ ok: true, data: { wallet, balance,
 * transactions } }` — and adds `nextCursor` + `hasMore` inside `data` (the
 * array key stays `transactions` rather than a new `items` key: the money-tab
 * UI does not call /api/v1; consumers are API clients).
 *
 * Route-layer implementation (modules/wallet/service.ts is read-only for this
 * agent): wallet + derived balance come from walletWithBalance (service), the
 * transaction page is read here with the same filters/mapping the service
 * used. Two honest deviations from the old service read: default page is 50
 * (was a hard take:100) and ordering gained a deterministic `id DESC`
 * tiebreak for txns sharing one timestamp.
 */
export const GET = route(
  {
    scope: 'wallets/:id/transactions GET',
    roles: FINANCE_ROLES,
    rateLimit: { bucket: 'v1.wallet.transactions', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('wallets/:id/transactions GET', e, 'Wallet transactions failed'),
  },
  async (req, _session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = walletRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, transactionsQuery)
    if (!q.ok) return q.response

    const { wallet, balance } = await walletWithBalance(q.data.projectId ?? '', id)
    const account = wallet.ledgerAccountId
      ? await db.ledgerAccount.findUnique({ where: { id: wallet.ledgerAccountId } })
      : null
    if (!account) {
      // Same as the service's no-account branch, plus the pagination keys.
      return jsonOk({
        wallet: { code: wallet.code, label: wallet.label },
        balance,
        transactions: [],
        nextCursor: null,
        hasMore: false,
      })
    }

    // Cursor → keyset boundary (occurredAt, id). A cursor that is not a
    // transaction of THIS wallet's account → 400 (stale or foreign cursor).
    let boundary: { occurredAt: Date; id: string } | null = null
    if (q.data.cursor) {
      const cursorTxn = await db.ledgerTransaction.findUnique({ where: { id: q.data.cursor } })
      const touchesAccount = cursorTxn
        ? await db.ledgerEntry.findFirst({
            where: { txnId: cursorTxn.id, accountId: account.id },
            select: { id: true },
          })
        : null
      if (!touchesAccount) {
        return v1Err(
          400,
          'Unknown cursor — it must be the id of a transaction in this wallet ledger',
          'cursor',
        )
      }
      boundary = { occurredAt: cursorTxn!.occurredAt, id: cursorTxn!.id }
    }

    const rows = await db.ledgerTransaction.findMany({
      where: {
        entries: { some: { accountId: account.id } },
        ...(boundary
          ? {
              OR: [
                { occurredAt: { lt: boundary.occurredAt } },
                { occurredAt: boundary.occurredAt, id: { lt: boundary.id } },
              ],
            }
          : {}),
      },
      include: { entries: { include: { account: true } } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: q.data.limit + 1, // one extra row reveals hasMore without a count
    })

    const hasMore = rows.length > q.data.limit
    const txns = rows.slice(0, q.data.limit)
    const nextCursor = hasMore ? txns[txns.length - 1].id : null

    return jsonOk({
      wallet: { code: wallet.code, label: wallet.label, ledgerAccount: account.code },
      balance,
      transactions: txns.map((t) => ({
        id: t.id,
        ref: t.ref,
        description: t.description,
        occurredAt: t.occurredAt.toISOString(),
        status: t.status,
        postedBy: t.postedBy,
        postedRole: t.postedRole,
        entries: t.entries.map((e) => ({
          accountCode: e.account.code,
          side: e.side,
          amount: e.amount,
          memo: e.memo,
        })),
        total: t.entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0),
      })),
      nextCursor,
      hasMore,
    })
  },
)
