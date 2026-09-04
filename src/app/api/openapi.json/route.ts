import { NextResponse } from 'next/server'

/**
 * GET /api/openapi.json — the OpenAPI 3.1 description of the /api/v1 REST
 * surface (Doc A §64 API QUALITY — documentation; B5-APIV1). UNAUTHENTICATED
 * by design: it documents no secrets, only shapes.
 *
 * Hand-written but kept truthful field-for-field against the route code —
 * every documented path, parameter, body field, response field and status
 * code is produced by src/backend/api/v1/** (reorg: src/app/api/v1/** are thin shims; this is the SDK-generation seam
 * listed in ARCHITECTURE.md's roadmap). 8 /api/v1 paths = the 8 v1 route
 * files, plus the two wave-3 app-level GETs added by W3-B: /api/audit
 * (admin audit log, spec §44) and /api/reports/budget-variance (QS report).
 *
 * Honest facts baked into the text: simulated payment rails, KES-only money,
 * ledger as source of truth, idempotent replays that never 409, single-instance
 * in-process rate buckets, and the one error shape { error, field? }.
 */

const json = (schema: object) => ({ content: { 'application/json': { schema } } })

// ---- shared schema fragments -------------------------------------------------

const errorSchema = {
  type: 'object',
  description: 'The ONE error shape across /api/v1: { error, field? }. The `ok` flag only appears on success bodies.',
  required: ['error'],
  properties: {
    error: { type: 'string', description: 'Human-readable, honest failure reason (never a stack trace).' },
    field: { type: 'string', description: 'Offending request field for validation errors (400) and cursors.' },
  },
  additionalProperties: false,
}

const rateErrorSchema = {
  type: 'object',
  required: ['error', 'retryAfterSec'],
  properties: {
    error: { const: 'Too many requests' },
    retryAfterSec: { type: 'integer', description: 'Seconds until one token refills.' },
  },
}

const okWalletSummaryItem = {
  type: 'object',
  required: ['id', 'code', 'label', 'ownerType', 'currency', 'status', 'balance'],
  properties: {
    id: { type: 'string', description: 'WalletAccount id (cuid).' },
    code: { type: 'string', description: 'Human wallet code, e.g. W-0001.' },
    label: { type: 'string' },
    ownerType: { type: 'string', enum: ['project', 'organization', 'supplier', 'user'] },
    ownerId: { type: ['string', 'null'] },
    currency: { const: 'KES' },
    status: { type: 'string', enum: ['active', 'frozen', 'closed'] },
    ledgerAccountCode: { type: ['string', 'null'], description: 'Backing ledger account code, e.g. WALLET:W-0001.' },
    balance: { type: 'number', description: 'Derived from ledger entries (credits − debits) — never stored.' },
    createdAt: { type: 'string', format: 'date-time' },
  },
}

const ok = (dataSchema: object) => ({
  type: 'object',
  required: ['ok', 'data'],
  properties: {
    ok: { const: true },
    data: dataSchema,
    replayed: { type: 'boolean', description: 'Present (true) when an Idempotency-Key replayed a stored response.' },
    scope: { type: 'string', description: 'Idempotency scope of the replayed request, e.g. "v1.wallet.deposit".' },
  },
})

const ledgerTxnSchema = {
  type: 'object',
  required: ['id', 'ref', 'description', 'occurredAt', 'status', 'postedBy', 'postedRole', 'entries', 'total'],
  properties: {
    id: { type: 'string', description: 'LedgerTransaction id (cuid) — also the pagination cursor value.' },
    ref: { type: 'string', description: 'Ledger ref, e.g. LX-2026-000001.' },
    description: { type: 'string' },
    occurredAt: { type: 'string', format: 'date-time' },
    status: { type: 'string', enum: ['posted', 'reversed'] },
    postedBy: { type: 'string' },
    postedRole: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['accountCode', 'side', 'amount'],
        properties: {
          accountCode: { type: 'string' },
          side: { type: 'string', enum: ['debit', 'credit'] },
          amount: { type: 'number' },
          memo: { type: ['string', 'null'] },
        },
      },
    },
    total: { type: 'number', description: 'Sum of the debit legs (KES).' },
  },
}

const idempotencyParam = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string', maxLength: 200 },
  description:
    'Money-mutation idempotency (spec §57): the FIRST successful run with a key is stored; ' +
    'repeating the key replays that stored 200 body verbatim (adds top-level replayed: true and ' +
    'scope). The replay happens even if the payload differs — 409 conflicts are NOT produced ' +
    'today (kept from modules/wallet/http.ts withIdempotency). Failed runs are never recorded, ' +
    'so a retry after a 4xx/5xx is always possible.',
}

const walletIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 2, maxLength: 40, pattern: '^[A-Za-z0-9_-]{2,40}$' },
  description: 'Wallet id (cuid) OR human code (e.g. W-0001) — the service resolves both.',
}

const projectIdParam = (where: string) => ({
  name: 'projectId',
  in: 'query',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 40 },
  description: `Scope the lookup to one project (${where}). Absent = unscoped (finance/admin).`,
})

const limitParam = {
  name: 'limit',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  description: 'Page size. 1-200, default 50.',
}

const cursorParam = (of: string) => ({
  name: 'cursor',
  in: 'query',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 40 },
  description: `Keyset cursor — the id of the last item of the previous page (${of}). Pages never overlap; a cursor not present in the list → 400.`,
})

const unauthorizedResponse = {
  description: 'No session cookie (guard: src/backend/lib/guard.ts). Body { error: "Sign in required" }.',
  content: { 'application/json': { schema: errorSchema } },
}
const forbiddenResponse = {
  description:
    'Signed in but the role is not permitted (guard): finance+admin own the wallet routes; payments allow finance/admin/client. ' +
    'Body { error: "Not permitted for role \\"<role>\\"" } — or, for a client paying another project\'s request, { error: "Not permitted for this project" }.',
  content: { 'application/json': { schema: errorSchema } },
}
const rateLimitedResponse = {
  description:
    'Per-principal token bucket (session email, else IP): reads 120/min, money mutations 30/min. ' +
    'Retry-After header (seconds). Single-instance, in-process — honest limitation of the current deployment.',
  headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until one token refills.' } },
  content: { 'application/json': { schema: rateErrorSchema } },
}
const badRequestResponse = {
  description:
    'Validation failure (zod): unknown/missing/ill-typed body field, non-object or unparseable JSON, bad limit/cursor, ' +
    'or an honest business-rule message from the wallet service (e.g. "Insufficient wallet balance: 500 < 1000"). Body { error, field? }.',
  content: { 'application/json': { schema: errorSchema } },
}
const notFoundResponse = {
  description: 'Unknown wallet (or payment request). Body { error: "Wallet not found" | "Wallet belongs to a different project" | "Payment request not found" }.',
  content: { 'application/json': { schema: errorSchema } },
}
const serverErrorResponse = {
  description: 'Unexpected failure — honest generic message; details go to the server logs only (never a stack trace).',
  content: { 'application/json': { schema: errorSchema } },
}

const security = [{ cookieAuth: [] }]

// ---- wave-3 (W3-B) schema fragments: audit log + budget variance report ----

const auditEventSchema = {
  type: 'object',
  description:
    'One append-only audit row (written exclusively by lib/audit logAudit — IMMUTABLE: no update/delete ' +
    'endpoints exist, ever). meta/before/after serialize as parsed JSON when the stored string is valid ' +
    'JSON, else the raw string; null when absent.',
  required: ['id', 'projectId', 'kind', 'actor', 'role', 'summary', 'createdAt'],
  properties: {
    id: { type: 'string', description: 'AuditEvent id (cuid) — the pagination cursor value.' },
    projectId: { type: 'string' },
    kind: {
      type: 'string',
      description: 'e.g. delivery, wage, attendance, milestone, variation, escrow, photo, comment, export, share, auth.',
    },
    actor: { type: 'string', description: 'Who did it (display name).' },
    role: { type: 'string', description: 'contractor, foreman, client, system, ai, finance, supervisor…' },
    summary: { type: 'string', description: 'Human-readable one-liner.' },
    meta: { description: 'JSON extra detail (parsed) or the raw string; null when absent.' },
    entity: { type: ['string', 'null'], description: 'Entity type acted on, e.g. StockMovement.' },
    entityId: { type: ['string', 'null'] },
    before: { description: 'Snapshot before, mutations only (parsed JSON or raw string; null when absent).' },
    after: { description: 'Snapshot after, mutations only (parsed JSON or raw string; null when absent).' },
    ip: { type: ['string', 'null'], description: 'First x-forwarded-for value of the request origin.' },
    userAgent: { type: ['string', 'null'] },
    requestId: { type: ['string', 'null'], description: 'Correlation id (incoming x-request-id or a fresh UUID).' },
    createdAt: { type: 'string', format: 'date-time' },
  },
}

const budgetVarianceSchema = {
  type: 'object',
  required: ['project', 'phases', 'categories'],
  properties: {
    project: {
      type: 'object',
      required: ['id', 'name', 'budgetTotal', 'spent', 'remaining', 'spentPct', 'progressPct'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        budgetTotal: { type: 'number', description: 'Σ Phase.budget — the same derivation as the app payload (ProjectSummary.budgetTotal). KES.' },
        spent: { type: 'number', description: 'Σ Transaction.amount — the same derivation as ProjectSummary.budgetSpent (flat, KES).' },
        remaining: { type: 'number', description: 'budgetTotal − spent (plain variance view; the finance slice\'s `committed` dimension is deliberately NOT folded in).' },
        spentPct: { type: 'integer', description: 'round(spent / budgetTotal × 100); 0 when budgetTotal is 0.' },
        progressPct: { type: 'integer', description: 'Budget-weighted phase progress (lib/mjengo overallProgress).' },
      },
    },
    phases: {
      type: 'array',
      description:
        'HONEST: the Transaction model has no phaseId, so per-phase spent is milestone-exact where the schema ' +
        'allows it and otherwise a budget-share ALLOCATION across started phases — Σ phases.spent equals ' +
        'project.spent exactly (an allocation, not a measurement, until phase cost-codes land in the schema).',
      items: {
        type: 'object',
        required: ['id', 'name', 'budget', 'spent', 'variance', 'variancePct', 'progressPct', 'txCount', 'topTransactions'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          budget: { type: 'number' },
          spent: { type: 'number' },
          variance: { type: 'number', description: 'budget − spent (positive = under budget).' },
          variancePct: { type: 'integer', description: 'round(variance / budget × 100); 0 when budget is 0.' },
          progressPct: { type: 'integer' },
          txCount: { type: 'integer', description: 'Transactions attributed to this phase.' },
          topTransactions: {
            type: 'array',
            description: 'The 5 largest attributed transactions by amount.',
            items: {
              type: 'object',
              required: ['id', 'note', 'amount', 'date'],
              properties: {
                id: { type: 'string' },
                note: { type: 'string' },
                amount: { type: 'number' },
                date: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
    },
    categories: {
      type: 'array',
      description:
        'HONEST: Transaction has no category field — grouping is by Transaction.type (the one real cost ' +
        'dimension the model carries), not QS work-sections. Ordered by spent DESC.',
      items: {
        type: 'object',
        required: ['key', 'label', 'spent', 'txCount', 'share'],
        properties: {
          key: { type: 'string', description: 'Transaction.type, e.g. material, wage, transport, other.' },
          label: { type: 'string', description: 'Friendly label, e.g. Materials, Wages.' },
          spent: { type: 'number' },
          txCount: { type: 'integer' },
          share: { type: 'integer', description: '% of total spent, rounded.' },
        },
      },
    },
  },
}

const auditRateLimitedResponse = {
  description:
    'Per-principal token bucket: 60 reads/min (session email, else IP). Retry-After header (seconds). ' +
    'Single-instance, in-process — honest limitation of the current deployment.',
  headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until one token refills.' } },
  content: { 'application/json': { schema: rateErrorSchema } },
}

const reportRateLimitedResponse = {
  description:
    'Per-principal token bucket: 30 reads/min (session email, else IP) — the report walks every project ' +
    'transaction, so it is a heavyweight read, not a polling target. Retry-After header (seconds). ' +
    'Single-instance, in-process — honest limitation of the current deployment.',
  headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until one token refills.' } },
  content: { 'application/json': { schema: rateErrorSchema } },
}

// ---- the document ------------------------------------------------------------

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'MjengoOS API v1',
    version: '1.0.0',
    description:
      'REST v1 surface of MjengoOS (spec §38 wallets / §57 payments): wallet accounts, derived balances, ' +
      'double-entry ledger reads, money movement and payment execution.\n\n' +
      '**Honest scope notes** — money is KES-only; the payment provider rails are SIMULATED (each response ' +
      'carries an honest integrationNote; a real Daraja/bank provider plugs into the same seam); balances are ' +
      'always derived from ledger entries, never stored.\n\n' +
      '**Auth** — NextAuth credentials session (HttpOnly, signed JWT cookie `next-auth.session-token`). ' +
      'Wallet routes: finance+admin. Payments: finance, admin, or the project-pinned client. ' +
      'No API keys, no OAuth — cookie session only, same-origin.\n\n' +
      '**Errors** — one shape everywhere: { error: string, field? } (400/401/403/404/422/429/500). ' +
      'The success shape is { ok: true, data, ... }; the `ok` flag never appears on errors.\n\n' +
      '**Idempotency** — send Idempotency-Key on every money mutation; replays return the stored body ' +
      '(replayed: true) and never 409.\n\n' +
      '**Pagination** — limit (1-200, default 50) + id cursor; responses carry nextCursor/hasMore.\n\n' +
      'This document is served unauthenticated at /api/openapi.json and is the SDK-generation seam ' +
      '(ARCHITECTURE.md roadmap). It covers exactly the 8 /api/v1 route paths, plus the two wave-3 ' +
      'app-level GETs: /api/audit (admin audit log, spec §44) and /api/reports/budget-variance (QS report).',
  },
  servers: [{ url: '/', description: 'Same-origin (the app that rendered this document).' }],
  tags: [
    { name: 'wallets', description: 'Wallet accounts, balances and ledger transactions (finance/admin).' },
    { name: 'payments', description: 'Payment execution for approved payment requests (finance/admin/client).' },
    { name: 'audit', description: 'Admin audit-log reads — the append-only event ledger (admin only, spec §44).' },
    { name: 'reports', description: 'QS / cost-plan reports: budget variance per phase and category (contractor, admin, supervisor, qs).' },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'next-auth.session-token',
        description:
          'NextAuth v4 credentials session cookie (HttpOnly, signed with NEXTAUTH_SECRET). Obtain it by signing in ' +
          'through the app login (/api/auth/callback/credentials — CSRF dance required, so scripted clients should ' +
          'drive a browser session). Absent/expired → 401; wrong role → 403.',
      },
    },
    schemas: {
      Error: errorSchema,
      RateError: rateErrorSchema,
      WalletSummary: okWalletSummaryItem,
      WalletDetail: {
        type: 'object',
        required: ['id', 'code', 'label', 'ownerType', 'currency', 'status', 'balance'],
        properties: {
          id: { type: 'string' },
          code: { type: 'string' },
          label: { type: 'string' },
          ownerType: { type: 'string', enum: ['project', 'organization', 'supplier', 'user'] },
          ownerId: { type: ['string', 'null'] },
          currency: { const: 'KES' },
          status: { type: 'string', enum: ['active', 'frozen', 'closed'] },
          ledgerAccountId: { type: ['string', 'null'] },
          balance: { type: 'number', description: 'Derived from ledger entries — never a stored field.' },
        },
      },
      WalletBalance: {
        type: 'object',
        required: ['wallet', 'currency', 'balance', 'derivation'],
        properties: {
          wallet: { type: 'string', description: 'Wallet code.' },
          currency: { const: 'KES' },
          balance: { type: 'number' },
          derivation: { const: 'ledger entries (debits − credits on the backing liability account)' },
        },
      },
      ProviderRail: {
        type: 'object',
        required: ['method', 'provider', 'label', 'integrationNote'],
        properties: {
          method: { type: 'string', description: 'Payment method key, e.g. mpesa.' },
          provider: { type: 'string' },
          label: { type: 'string' },
          integrationNote: { type: 'string', description: 'Honest per-rail integration state (simulated).' },
        },
      },
      WalletTransactionsPage: {
        type: 'object',
        required: ['wallet', 'balance', 'transactions', 'nextCursor', 'hasMore'],
        properties: {
          wallet: {
            type: 'object',
            required: ['code', 'label'],
            properties: {
              code: { type: 'string' },
              label: { type: 'string' },
              ledgerAccount: { type: 'string', description: 'Absent when the wallet has no backing ledger account (empty ledger).' },
            },
          },
          balance: { type: 'number' },
          transactions: { type: 'array', items: ledgerTxnSchema },
          nextCursor: { type: ['string', 'null'], description: 'LedgerTransaction id to pass as ?cursor; null on the last page.' },
          hasMore: { type: 'boolean' },
        },
      },
      WalletCreateResult: {
        type: 'object',
        required: ['id', 'code', 'ledgerAccount', 'balance'],
        properties: {
          id: { type: 'string' },
          code: { type: 'string' },
          ledgerAccount: { type: 'string', description: 'e.g. WALLET:W-0003.' },
          balance: { type: 'number', description: '0 for a fresh wallet.' },
        },
      },
      DepositWithdrawResult: {
        type: 'object',
        required: ['walletCode', 'ledgerRef', 'balance'],
        properties: {
          walletCode: { type: 'string' },
          ledgerRef: { type: 'string', description: 'Ledger transaction ref, e.g. LX-2026-000004.' },
          balance: { type: 'number', description: 'Wallet balance AFTER the move, derived inside the same db transaction.' },
        },
      },
      TransferResult: {
        type: 'object',
        required: ['from', 'to', 'ledgerRef'],
        properties: {
          from: { type: 'string', description: 'Source wallet code.' },
          to: { type: 'string', description: 'Destination wallet code.' },
          ledgerRef: { type: 'string' },
        },
      },
      PaymentResult: {
        type: 'object',
        required: ['id', 'status', 'transactionId', 'ledgerRef', 'providerNote'],
        properties: {
          id: { type: 'string', description: 'PaymentRequest id.' },
          status: { const: 'paid' },
          transactionId: { type: 'string', description: 'Legacy Transaction row id (carries ledgerTxnId + costCode).' },
          ledgerRef: { type: 'string' },
          balance: { type: 'number', description: 'Present for wallet (escrow) payments — escrow balance after spend.' },
          providerNote: { type: 'string', description: 'Honest simulated-rail note.' },
        },
      },
      AuditEvent: auditEventSchema,
      BudgetVarianceReport: budgetVarianceSchema,
    },
  },
  paths: {
    '/api/v1/wallets': {
      get: {
        tags: ['wallets'],
        summary: 'List wallets (paginated) or the provider-rail surface',
        description:
          'Every wallet with its ledger-derived balance, ordered by code. With ?providers=1 returns the payment-rail ' +
          'introspection instead (bounded static list — pagination does not apply there). ' +
          'Backward compatible: `data` stays the array; pagination metadata (nextCursor, hasMore) rides top-level. ' +
          'Rate limit: 120/min per principal.',
        security,
        parameters: [
          projectIdParam('filters to that project\'s wallets plus platform wallets'),
          {
            name: 'providers',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['1'] },
            description: 'Set to "1" to list the payment provider rails instead of wallets.',
          },
          limitParam,
          cursorParam('a WalletAccount id'),
        ],
        responses: {
          200: {
            description: 'ok: true. data = wallet page (or provider rails with ?providers=1).',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    ok({ type: 'array', items: { $ref: '#/components/schemas/WalletSummary' } }),
                    ok({ type: 'array', items: { $ref: '#/components/schemas/ProviderRail' } }),
                  ],
                },
              },
            },
          },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
      post: {
        tags: ['wallets'],
        summary: 'Create a wallet',
        description:
          'Creates a WalletAccount + its backing liability ledger account (code WALLET:W-nnnn). Project wallets need ' +
          'projectId (body or a project-bound session). Idempotency-Key honored. Rate limit: 30/min per principal.',
        security,
        parameters: [idempotencyParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string', minLength: 1, maxLength: 120 },
                  ownerType: { type: 'string', enum: ['project', 'organization', 'supplier', 'user'], default: 'project' },
                  ownerId: { type: 'string', minLength: 1, maxLength: 40, description: 'Explicit owner (organization/supplier/user).' },
                  projectId: { type: 'string', minLength: 1, maxLength: 40, description: 'Required for project wallets.' },
                  currency: { type: 'string', enum: ['KES'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'ok: true, data = WalletCreateResult.', ...json(ok({ $ref: '#/components/schemas/WalletCreateResult' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/wallets/{id}': {
      get: {
        tags: ['wallets'],
        summary: 'Get one wallet (id or code)',
        description: 'Wallet with its ledger-derived balance. Rate limit: 120/min per principal.',
        security,
        parameters: [walletIdParam, projectIdParam('cross-project wallets resolve to 404')],
        responses: {
          200: { description: 'ok: true, data = WalletDetail.', ...json(ok({ $ref: '#/components/schemas/WalletDetail' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/wallets/{id}/balance': {
      get: {
        tags: ['wallets'],
        summary: 'Derived balance of a wallet',
        description: 'The balance computed from the backing account\'s debit/credit entries (never stored). Rate limit: 120/min.',
        security,
        parameters: [walletIdParam, projectIdParam('cross-project wallets resolve to 404')],
        responses: {
          200: { description: 'ok: true, data = WalletBalance.', ...json(ok({ $ref: '#/components/schemas/WalletBalance' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/wallets/{id}/transactions': {
      get: {
        tags: ['wallets'],
        summary: 'Ledger transactions of a wallet (cursor-paginated)',
        description:
          'Double-entry transactions touching the wallet\'s backing account, newest first (occurredAt DESC, id DESC ' +
          'tiebreak), with per-leg entries and debit totals. True keyset pagination: limit (1-200, default 50) + ' +
          'cursor (LedgerTransaction id) — pages never overlap. Default page is 50 (was a hard 100 before v1.1). ' +
          'Rate limit: 120/min per principal.',
        security,
        parameters: [walletIdParam, projectIdParam('cross-project wallets resolve to 404'), limitParam, cursorParam('a LedgerTransaction id of this wallet')],
        responses: {
          200: { description: 'ok: true, data = WalletTransactionsPage.', ...json(ok({ $ref: '#/components/schemas/WalletTransactionsPage' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/wallets/{id}/deposit': {
      post: {
        tags: ['wallets'],
        summary: 'Deposit cash into a wallet',
        description:
          'Debits the cash rail (CASH_MPESA/CASH_BANK), credits WALLET:<code> — one db transaction; the returned balance ' +
          'reflects the deposit. Idempotency-Key honored (failures never recorded). Rate limit: 30/min per principal.',
        security,
        parameters: [walletIdParam, idempotencyParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount'],
                additionalProperties: false,
                properties: {
                  amount: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000, description: 'KES; at most 2 decimal places.' },
                  source: { type: 'string', enum: ['mpesa', 'bank'], default: 'mpesa' },
                  reference: { type: 'string', maxLength: 200, description: 'Unique reference = natural ledger idempotency.' },
                  currency: { type: 'string', enum: ['KES'] },
                  projectId: { type: 'string', minLength: 1, maxLength: 40 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'ok: true, data = DepositWithdrawResult.', ...json(ok({ $ref: '#/components/schemas/DepositWithdrawResult' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/wallets/{id}/transfer': {
      post: {
        tags: ['wallets'],
        summary: 'Transfer between wallets',
        description:
          'Debits the source WALLET account, credits the destination, balance re-checked INSIDE the transaction ' +
          '(overdraft → 400 "Insufficient wallet balance…"). Transferring to the same wallet → 422 (nothing recorded). ' +
          'Idempotency-Key honored. Rate limit: 30/min per principal.',
        security,
        parameters: [walletIdParam, idempotencyParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['toWalletId', 'amount'],
                additionalProperties: false,
                properties: {
                  toWalletId: { type: 'string', minLength: 2, maxLength: 40, pattern: '^[A-Za-z0-9_-]{2,40}$', description: 'Destination wallet id or code.' },
                  amount: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000, description: 'KES; at most 2 decimal places.' },
                  note: { type: 'string', maxLength: 500 },
                  currency: { type: 'string', enum: ['KES'] },
                  projectId: { type: 'string', minLength: 1, maxLength: 40 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'ok: true, data = TransferResult.', ...json(ok({ $ref: '#/components/schemas/TransferResult' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          422: {
            description: 'Structurally valid but nonsensical: source and destination are the same wallet. Body { error, field: "toWalletId" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/wallets/{id}/withdraw': {
      post: {
        tags: ['wallets'],
        summary: 'Withdraw from a wallet to a cash rail',
        description:
          'Debits WALLET:<code>, credits the cash rail; balance re-checked INSIDE the transaction (overdraft → 400). ' +
          'Idempotency-Key honored. Rate limit: 30/min per principal.',
        security,
        parameters: [walletIdParam, idempotencyParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount'],
                additionalProperties: false,
                properties: {
                  amount: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000, description: 'KES; at most 2 decimal places.' },
                  destination: { type: 'string', enum: ['mpesa', 'bank'], default: 'mpesa' },
                  note: { type: 'string', maxLength: 500 },
                  currency: { type: 'string', enum: ['KES'] },
                  projectId: { type: 'string', minLength: 1, maxLength: 40 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'ok: true, data = DepositWithdrawResult.', ...json(ok({ $ref: '#/components/schemas/DepositWithdrawResult' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/payments': {
      post: {
        tags: ['payments'],
        summary: 'Pay an approved payment request',
        description:
          'Pays an APPROVED PaymentRequest through the provider seam (simulated rails) and posts a balanced double-entry ' +
          'ledger transaction (escrow spend for method=wallet). Client-role sessions are pinned to their own project (403). ' +
          'There is no list endpoint on /api/v1/payments — pagination does not apply. Idempotency-Key honored. ' +
          'Rate limit: 30/min per principal.',
        security,
        parameters: [idempotencyParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: 'paymentRequestId or the legacy id alias (both accept cuid or requestCode like PR-2026-000001).',
                additionalProperties: false,
                properties: {
                  paymentRequestId: { type: 'string', minLength: 1, maxLength: 40 },
                  id: { type: 'string', minLength: 1, maxLength: 40 },
                  method: { type: 'string', enum: ['mpesa', 'bank', 'card', 'wallet', 'cash'] },
                  reference: { type: 'string', maxLength: 200 },
                  costCode: { type: 'string', maxLength: 120 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'ok: true, data = PaymentResult.', ...json(ok({ $ref: '#/components/schemas/PaymentResult' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/audit': {
      get: {
        tags: ['audit'],
        summary: 'Audit log with filters (admin-only, cursor-paginated)',
        description:
          'Admin → Audit Logs (spec §44): the read side of the append-only Bias-Free Ledger — every dispatched ' +
          'action writes exactly one AuditEvent (actor, role, summary, entity, ip, userAgent, requestId). ' +
          'Guard: admin ONLY (any other signed-in role → 403; anonymous → 401). IMMUTABLE BY DESIGN — no ' +
          'POST/PUT/PATCH/DELETE handlers exist or may ever be added (users must not be able to erase audit ' +
          'records; lib/audit logAudit is the single append-only writer). ' +
          'Filters: actor (contains), role / projectId / entity / kind (exact), from / to (inclusive ISO range ' +
          'on createdAt; a date-only `to` like 2026-02-14 expands to end-of-day UTC), q (free-text contains on ' +
          'summary). actor/q match ASCII case-insensitively (SQLite LIKE; non-ASCII case folding unsupported). ' +
          'Keyset pagination like /api/v1/wallets: limit (1-200, default 50) + cursor (the AuditEvent id of the ' +
          'last row of the previous page; unknown id → 400), ordered createdAt DESC then id DESC. ' +
          'Rate limit: 60/min per principal.',
        security,
        parameters: [
          { name: 'actor', in: 'query', required: false, schema: { type: 'string', maxLength: 120 }, description: 'Actor name contains (ASCII case-insensitive).' },
          { name: 'role', in: 'query', required: false, schema: { type: 'string', maxLength: 40 }, description: 'Exact role: contractor, client, system, ai, finance, supervisor, foreman…' },
          { name: 'projectId', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 40 }, description: 'Exact project scope.' },
          { name: 'entity', in: 'query', required: false, schema: { type: 'string', maxLength: 60 }, description: 'Exact entity type acted on, e.g. StockMovement.' },
          { name: 'kind', in: 'query', required: false, schema: { type: 'string', maxLength: 40 }, description: 'Exact event kind: delivery, wage, milestone, escrow, share, auth…' },
          { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Inclusive createdAt lower bound (ISO 8601; date-only = midnight UTC).' },
          { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Inclusive createdAt upper bound (ISO 8601; date-only expands to end-of-day UTC).' },
          { name: 'q', in: 'query', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Free-text search in the summary (contains, ASCII case-insensitive).' },
          limitParam,
          cursorParam('an AuditEvent id'),
        ],
        responses: {
          200: {
            description:
              'ok: true. data = AuditEvent page (createdAt DESC, id DESC); nextCursor is null on the last page, ' +
              'else the id to pass as ?cursor. hasMore mirrors nextCursor.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok', 'data', 'nextCursor', 'hasMore'],
                  properties: {
                    ok: { const: true },
                    data: { type: 'array', items: { $ref: '#/components/schemas/AuditEvent' } },
                    nextCursor: { type: ['string', 'null'], description: 'AuditEvent id for the next page; null on the last page.' },
                    hasMore: { type: 'boolean' },
                  },
                },
              },
            },
          },
          400: {
            description: 'Bad limit (must be an integer 1-200), unknown cursor, or unparseable from/to. Body { error }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          401: unauthorizedResponse,
          403: {
            description: 'Signed in but not admin — audit logs are admin-only (spec §44). Body { error: "Not permitted for role \\"<role>\\"" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          429: auditRateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/reports/budget-variance': {
      get: {
        tags: ['reports'],
        summary: 'Budget variance report (QS surface: cost plan vs actuals per phase/category)',
        description:
          'QS surface — "BOQ / Cost Plan / Variations / Actual Cost / Forecast / Budget Variance". ' +
          'Guard: contractor / admin / supervisor / qs (client, finance and procurement are not on this ' +
          'surface → 403; anonymous → 401). projectId query param REQUIRED (no default-project guessing on a ' +
          'report) → 400 when absent; unknown project → 404. ' +
          'project rollup: budgetTotal = Σ Phase.budget and spent = Σ Transaction.amount — the exact ' +
          'derivations the app payload uses (ProjectSummary), so the report can never disagree with the ' +
          'dashboard; remaining = budgetTotal − spent. HONEST per-phase derivation: Transaction has no ' +
          'phaseId — milestone-linked payments are exact, the rest is a budget-share allocation across ' +
          'started phases that preserves Σ phases.spent == project.spent (see the schema notes). ' +
          'categories group by Transaction.type (the model has no category field). ' +
          'Rate limit: 30/min per principal.',
        security,
        parameters: [
          {
            name: 'projectId',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 40 },
            description: 'The project to report on. Required — absent → 400; unknown → 404.',
          },
        ],
        responses: {
          200: {
            description: 'ok: true, data = BudgetVarianceReport.',
            content: {
              'application/json': {
                schema: ok({ $ref: '#/components/schemas/BudgetVarianceReport' }),
              },
            },
          },
          400: {
            description: 'projectId missing. Body { error: "projectId required" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          401: unauthorizedResponse,
          403: {
            description: 'Signed in but the role is not on the QS surface (allowed: contractor, admin, supervisor, qs). Body { error: "Not permitted for role \\"<role>\\"" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          404: {
            description: 'Unknown projectId. Body { error: "Project not found" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          429: reportRateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
  },
}

export async function GET() {
  return NextResponse.json(spec, { headers: { 'Cache-Control': 'public, max-age=60' } })
}
