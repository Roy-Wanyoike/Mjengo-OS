import { NextResponse } from 'next/server'

/**
 * GET /api/openapi.json — the OpenAPI 3.1 description of the /api/v1 REST
 * surface (Doc A §64 API QUALITY — documentation; B5-APIV1). UNAUTHENTICATED
 * by design: it documents no secrets, only shapes.
 *
 * Hand-written but kept truthful field-for-field against the route code —
 * every documented path, parameter, body field, response field and status
 * code is produced by src/app/api/v1/** (this is the SDK-generation seam
 * listed in ARCHITECTURE.md's roadmap). 8 paths = the 8 v1 route files.
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
  description: 'No session cookie (guard: src/lib/guard.ts). Body { error: "Sign in required" }.',
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
      '(ARCHITECTURE.md roadmap). It covers exactly the 8 /api/v1 route paths.',
  },
  servers: [{ url: '/', description: 'Same-origin (the app that rendered this document).' }],
  tags: [
    { name: 'wallets', description: 'Wallet accounts, balances and ledger transactions (finance/admin).' },
    { name: 'payments', description: 'Payment execution for approved payment requests (finance/admin/client).' },
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
  },
}

export async function GET() {
  return NextResponse.json(spec, { headers: { 'Cache-Control': 'public, max-age=60' } })
}
