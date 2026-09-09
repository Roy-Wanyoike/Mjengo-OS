import { NextResponse } from 'next/server'
import { FINANCE_ROLES } from '@/backend/lib/guard'
import { route } from '@/backend/lib/route-kit'
import { createWallet, listWallets } from '@/backend/modules/wallet/service'
import { jsonOk, withIdempotency } from '@/backend/modules/wallet/http'
import { getProvider, PROVIDER_METHODS } from '@/backend/modules/wallet/providers'
import { requireFlagOn } from '@/backend/modules/intel/flags'
import { walletCreateBody, walletsListQuery, validateQuery } from './schemas'
import { mapServiceError, pageOf, v1Err, V1_MUTATION_LIMIT, V1_READ_LIMIT } from './respond'

// /api/v1/wallets — src/app/api/v1/wallets/route.ts is the shim.

/**
 * GET /api/v1/wallets — list wallets (optionally ?projectId=) with
 * ledger-derived balances, or the provider-rail surface with ?providers=1.
 * Finance/admin only (spec §38 — internal finance infrastructure; balances
 * are derived from LedgerEntry, never stored).
 *
 * PAGINATION (B5-APIV1): `?limit` (1-200, default 50) + `?cursor` (wallet id
 * of the last item of the previous page). The response keeps today's
 * contract — `{ ok: true, data: <array> }` — and adds top-level
 * `nextCursor` + `hasMore` (the money-tab UI does not call /api/v1; the
 * consumers are API clients, so `data` stays the array rather than a new
 * `items` key, and the default page already covers every wallet seeded
 * today). The wallet set is bounded, so pagination slices the full
 * code-ordered list in the route layer (listWallets stays read-only).
 * The ?providers=1 branch is a static rail introspection list — pagination
 * does not apply there.
 *
 * Feature flag (spec §81, task 9-a): the `wallet` flag gates this whole v1
 * family — OFF → 403 for non-admin sessions (admins bypass; see flags.ts).
 */
export const GET = route(
  {
    scope: 'wallets GET',
    roles: FINANCE_ROLES,
    rateLimit: { bucket: 'v1.wallets.list', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('wallets GET', e, 'Failed to list wallets'),
  },
  async (req, session) => {
    // Feature flag (spec §81, task 9-a) — the uniform wallet gate.
    const flagDenied = await requireFlagOn('wallet', session)
    if (flagDenied) return flagDenied

    const q = validateQuery(req, walletsListQuery)
    if (!q.ok) return q.response
    if (q.data.providers === '1') {
      // Payment-rail seam introspection (spec §40) — every provider honestly
      // reports its integration state (simulated).
      return NextResponse.json({
        ok: true,
        data: PROVIDER_METHODS.map((m) => {
          const p = getProvider(m)
          return { method: m, provider: p.id, label: p.label, integrationNote: p.integrationNote }
        }),
      })
    }
    const wallets = await listWallets(q.data.projectId)
    const p = pageOf(wallets, q.data.limit, q.data.cursor)
    if (!p.ok) return p.response
    return jsonOk(p.page.items, { nextCursor: p.page.nextCursor, hasMore: p.page.hasMore })
  },
)

/**
 * POST /api/v1/wallets — create a wallet via the wallet.create service.
 * Finance/admin only. Idempotency-Key honored. Body (zod-validated, unknown
 * fields rejected — route-kit's schema mode replaces the old validateBody
 * call with identical semantics):
 *   { label?, ownerType?: 'project'|'organization'|'supplier'|'user' (default
 *     'project'), ownerId?, projectId?, currency?: 'KES' }
 *
 * Feature flag (spec §81, task 9-a): gated by `wallet` — OFF → 403 for
 * non-admin sessions (admins bypass; see flags.ts).
 */
export const POST = route(
  {
    scope: 'wallets POST',
    roles: FINANCE_ROLES,
    rateLimit: { bucket: 'v1.wallets.create', limit: V1_MUTATION_LIMIT, windowMs: 60_000 },
    body: { schema: walletCreateBody },
    onError: (e) => mapServiceError('wallets POST', e, 'Failed to create wallet'),
  },
  async (req, session, body) => {
    // Feature flag (spec §81, task 9-a) — the uniform wallet gate.
    const flagDenied = await requireFlagOn('wallet', session)
    if (flagDenied) return flagDenied

    const projectId =
      body.projectId ??
      (body.ownerType === 'project' ? session.user.projectId ?? undefined : undefined)
    // Project wallets need a project (ledger scope); organization / supplier /
    // user wallets are platform-scoped (projectId null) — ownerId is explicit.
    if (!projectId && body.ownerType === 'project') {
      return v1Err(400, 'projectId required for project wallets (body or a project-bound session)', 'projectId')
    }
    return await withIdempotency(req, 'v1.wallet.create', projectId ?? null, () =>
      createWallet(projectId ?? 'platform', body),
    )
  },
)
