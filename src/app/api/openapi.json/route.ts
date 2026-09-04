import { NextResponse } from 'next/server'

/**
 * GET /api/openapi.json — the OpenAPI 3.1 description of the /api/v1 REST
 * surface (Doc A §64 API QUALITY — documentation; B5-APIV1). UNAUTHENTICATED
 * by design: it documents no secrets, only shapes.
 *
 * Hand-written but kept truthful field-for-field against the route code —
 * every documented path, parameter, body field, response field and status
 * code is produced by src/backend/api/v1/** (reorg: src/app/api/v1/** are thin shims; this is the SDK-generation seam
 * listed in ARCHITECTURE.md's roadmap). 14 /api/v1 paths = the 8 v1 wallet/
 * payment route files + the 6 read-only Phase B files (task 10-a: projects
 * list/detail/tasks/deliveries + supply orders list/detail), plus the two
 * wave-3 app-level GETs added by W3-B: /api/audit (admin audit log, spec
 * §44) and /api/reports/budget-variance (QS report).
 *
 * Honest facts baked into the text: simulated-by-default payment rails (Daraja
 * sandbox when env-configured), KES-only money,
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
    'Body { error: "Not permitted for role \\"<role>\\"" } — or, for a client paying another project\'s request, { error: "Not permitted for this project" } ' +
    '— or, while the `wallet` feature flag is OFF, { error: "Feature disabled by feature flag (wallet)…" } for non-admin sessions ' +
    '(admins bypass so they can toggle and test; spec §81).',
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
  required: ['project', 'phases', 'categories', 'phaseAttribution'],
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
        'Three-tier attribution (issue #39): REAL phase cost-codes (Transaction.phaseId) count directly; ' +
        'pre-code rows derive exactly through milestone linkage; the uncoded remainder is the documented ' +
        'budget-share ALLOCATION — Σ phases.spent equals project.spent exactly, and phaseAttribution + ' +
        'per-phase codedSpent state which mode produced each number.',
      items: {
        type: 'object',
        required: ['id', 'name', 'budget', 'spent', 'variance', 'variancePct', 'progressPct', 'txCount', 'codedSpent', 'codedTxnCount', 'topTransactions'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          budget: { type: 'number' },
          spent: { type: 'number' },
          codedSpent: { type: 'number', description: 'Real-code portion of spent (rows carrying this phase\'s Transaction.phaseId cost-code, issue #39); spent − codedSpent is the fallback attribution.' },
          codedTxnCount: { type: 'integer', description: 'Transactions attributed via a real phase cost-code.' },
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
    phaseAttribution: {
      type: 'object',
      required: ['mode', 'codedSpent', 'codedTxnCount', 'milestoneDerivedSpent', 'milestoneDerivedTxnCount', 'estimatedSpent', 'estimatedTxnCount'],
      description:
        'Honest mode statement (issue #39): which attribution produced the per-phase numbers. ' +
        'codedSpent + milestoneDerivedSpent + estimatedSpent == project.spent and the three counts == every transaction.',
      properties: {
        mode: { type: 'string', enum: ['none', 'real', 'mixed', 'estimated'], description: "'none' (no spend) · 'real' (every row carries a phase cost-code) · 'mixed' (part coded, part fallback) · 'estimated' (nothing coded — legacy milestone derivation + budget-share estimate)." },
        codedSpent: { type: 'number', description: 'Σ amounts attributed via a stored Transaction.phaseId (real codes).' },
        codedTxnCount: { type: 'integer' },
        milestoneDerivedSpent: { type: 'number', description: 'Σ amounts of uncoded rows attributed exactly via the legacy PaymentRequest→milestone→phase derivation.' },
        milestoneDerivedTxnCount: { type: 'integer' },
        estimatedSpent: { type: 'number', description: 'Σ amounts of uncoded rows spread by the budget-share estimate.' },
        estimatedTxnCount: { type: 'integer' },
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

// ---- Phase B (task 10-a) schema fragments: projects + supply reads ----

/** Project id path param (cuid). */
const projectIdPathParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 40 },
  description: 'Project id (cuid).',
}

/** PurchaseOrder id OR orderCode path param. */
const orderIdPathParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 2, maxLength: 40, pattern: '^[A-Za-z0-9_-]{2,40}$' },
  description: 'PurchaseOrder id (cuid) OR human orderCode (e.g. PO-2026-000012) — the route resolves both.',
}

/** Exact status filter (per-resource enum). */
const statusParam = (enumValues: string[], of: string) => ({
  name: 'status',
  in: 'query',
  required: false,
  schema: { type: 'string', enum: enumValues },
  description: `Exact ${of} filter. Applies BEFORE pagination — a cursor that falls out of the filtered list → 400.`,
})

const searchParam = {
  name: 'q',
  in: 'query',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 100 },
  description: 'Free-text search on project name/client (contains, ASCII case-insensitive, evaluated in-memory over the list).',
}

const projectsForbiddenResponse = {
  description:
    'Signed in but not permitted: client-role sessions are pinned to their OWN project — a foreign project → ' +
    '{ error: "Not permitted for this project" } (the same pin /api/v1/payments applies). HONEST SCOPE NOTE: no feature ' +
    'flag gates the projects resource — none of the five flags (ai_progress, ai_voice, wallet, marketplace, ' +
    'land_verification) names the projects surface, so gating it by an unrelated flag would be dishonest.',
  content: { 'application/json': { schema: errorSchema } },
}

const supplyForbiddenResponse = {
  description:
    'Not permitted: (a) a client-role session pinned to a foreign project → { error: "Not permitted for this project" }, ' +
    'or (b) the `marketplace` feature flag is OFF → { error: "Feature disabled by feature flag (marketplace)…" } for ' +
    'non-admin sessions (admins bypass so they can toggle and test; spec §81 — the same uniform gate the wallet flag ' +
    'applies to the v1 wallet family, and the webapp mirrors by hiding the Finder tab for non-admins). Body shape { error }.',
  content: { 'application/json': { schema: errorSchema } },
}

const projectNotFoundResponse = {
  description: 'Unknown project. Body { error: "Project not found" }.',
  content: { 'application/json': { schema: errorSchema } },
}

const orderNotFoundResponse = {
  description: 'Unknown purchase order. Body { error: "Order not found" }.',
  content: { 'application/json': { schema: errorSchema } },
}

const projectListItemSchema = {
  type: 'object',
  description:
    'The lightweight roster row — the SAME getProjectsList() derivation the webapp project switcher renders ' +
    '(no new money math in /api/v1).',
  required: [
    'id', 'name', 'client', 'clientType', 'location', 'status', 'startDate', 'targetDate',
    'budgetTotal', 'budgetSpent', 'progressPct', 'dayCount', 'fundisCount', 'unackedAlerts', 'photoCount',
  ],
  properties: {
    id: { type: 'string', description: 'Project id (cuid) — the pagination cursor value.' },
    name: { type: 'string' },
    client: { type: 'string' },
    clientType: { type: 'string', enum: ['diaspora', 'local', 'company'] },
    location: { type: 'string' },
    status: { type: 'string', description: 'active | completed | on_hold (the column is free-form — other values stay visible unfiltered and never match a filter).' },
    startDate: { type: 'string', format: 'date-time' },
    targetDate: { type: 'string', format: 'date-time' },
    budgetTotal: { type: 'number', description: 'Σ Phase.budget — the cost-plan rollup (KES).' },
    budgetSpent: { type: 'number', description: 'Σ Transaction.amount (flat, KES).' },
    progressPct: { type: 'integer', description: 'Budget-weighted phase progress (lib/mjengo overallProgress).' },
    dayCount: { type: 'integer', description: 'Days since startDate (min 1).' },
    fundisCount: { type: 'integer' },
    unackedAlerts: { type: 'integer' },
    photoCount: { type: 'integer' },
  },
}

const taskSummarySchema = {
  type: 'object',
  description: 'One task of the project (Task management v2 fields included — priority, assignment, blockers, verification).',
  required: [
    'id', 'phaseId', 'phaseName', 'title', 'status', 'progress', 'priority', 'dueDate', 'assignedToId',
    'blockedById', 'blockedReason', 'verifiedAt', 'verifiedByName', 'version', 'createdAt', 'updatedAt',
  ],
  properties: {
    id: { type: 'string', description: 'Task id (cuid) — the pagination cursor value.' },
    phaseId: { type: 'string' },
    phaseName: { type: ['string', 'null'] },
    title: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] },
    progress: { type: 'integer', description: '0-100.' },
    priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
    dueDate: { type: ['string', 'null'], format: 'date-time' },
    assignedToId: { type: ['string', 'null'], description: 'Worker id when assigned.' },
    blockedById: { type: ['string', 'null'], description: 'Task id of the blocker when blocked.' },
    blockedReason: { type: ['string', 'null'] },
    verifiedAt: { type: ['string', 'null'], format: 'date-time', description: 'When the completed work was verified.' },
    verifiedByName: { type: ['string', 'null'] },
    version: { type: 'integer', description: 'Offline-sync entity version — bumped by every applier that mutates the row.' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

const projectDetailSchema = {
  type: 'object',
  description:
    'One project + its honest summary. Every number is an EXISTING aggregation: ProjectSummary (getProjectPayload) ' +
    'and procurementTotals (the pure module the Finder dashboard consumes, wired identically) — no new money math. ' +
    'HONEST OMISSION: project.shareToken is deliberately NOT exposed (a bearer capability for share links, not a data field).',
  required: ['project', 'progressPct', 'dayCount', 'daysRemaining', 'budget', 'procurement', 'tasks', 'phases'],
  properties: {
    project: {
      type: 'object',
      required: ['id', 'name', 'client', 'clientType', 'location', 'status', 'budget', 'startDate', 'targetDate', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        client: { type: 'string' },
        clientType: { type: 'string', enum: ['diaspora', 'local', 'company'] },
        location: { type: 'string' },
        status: { type: 'string', description: 'active | completed | on_hold (free-form column).' },
        budget: { type: 'number', description: 'The contract budget field (Project.budget); the cost-plan rollup is budget.total below.' },
        startDate: { type: 'string', format: 'date-time' },
        targetDate: { type: 'string', format: 'date-time' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    progressPct: { type: 'integer', description: 'Budget-weighted phase progress.' },
    dayCount: { type: 'integer' },
    daysRemaining: { type: 'integer' },
    budget: {
      type: 'object',
      required: ['total', 'spent', 'spentPct', 'plannedSpendPct', 'spendVsPlanDeltaPct'],
      properties: {
        total: { type: 'number', description: 'Σ Phase.budget (KES).' },
        spent: { type: 'number', description: 'Σ Transaction.amount (KES, flat).' },
        spentPct: { type: 'integer' },
        plannedSpendPct: { type: 'integer', description: 'Linear plan by elapsed days.' },
        spendVsPlanDeltaPct: { type: 'integer', description: 'spend minus plan as % of budget (positive = over plan).' },
      },
    },
    procurement: {
      type: 'object',
      description: 'The Finder §20 dashboard tile math over the project supply slice (same numbers as the webapp tiles).',
      required: ['required', 'purchased', 'committed', 'remaining', 'pendingRequests', 'pendingApprovals', 'ordersInTransit', 'discrepancies'],
      properties: {
        required: { type: 'number', description: 'Σ estimates of submitted/approved/converted requests (KES).' },
        purchased: { type: 'number', description: 'Σ totals of delivered/closed orders (KES).' },
        committed: { type: 'number', description: 'Σ totals of sent/confirmed/delivering orders (KES) — the budget-vs-committed dimension.' },
        remaining: { type: 'number', description: 'required − purchased, floored at 0.' },
        pendingRequests: { type: 'integer' },
        pendingApprovals: { type: 'integer' },
        ordersInTransit: { type: 'integer' },
        discrepancies: { type: 'integer', description: 'Deliveries whose status is "discrepancy".' },
      },
    },
    tasks: {
      type: 'object',
      required: ['total', 'pending', 'inProgress', 'done', 'blocked'],
      properties: {
        total: { type: 'integer' },
        pending: { type: 'integer' },
        inProgress: { type: 'integer' },
        done: { type: 'integer' },
        blocked: { type: 'integer' },
      },
    },
    phases: { type: 'integer', description: 'Phase count.' },
  },
}

const deliveryVerificationSchema = {
  type: 'object',
  description:
    'One delivery-verification record (OrderDelivery) against a purchase order. HONEST SCOPE: evidence photos are ' +
    'referenced by ATTACHMENT ID ONLY — /api/v1 serves no photo bytes and no storage URLs; fetch the bytes through ' +
    'the app\'s own storage seam, not this API.',
  required: [
    'id', 'orderId', 'orderCode', 'status', 'dispatchedAt', 'receivedAt', 'receivedBy', 'note',
    'driverName', 'driverPhone', 'vehicleReg', 'etaAt', 'departedAt', 'arrivedAt', 'gpsLat', 'gpsLng',
    'photoCount', 'photos', 'lines', 'shortLines', 'createdAt',
  ],
  properties: {
    id: { type: 'string', description: 'OrderDelivery id (cuid) — the pagination cursor value.' },
    orderId: { type: 'string' },
    orderCode: { type: 'string', description: 'The owning purchase order code, e.g. PO-2026-000012.' },
    status: { type: 'string', enum: ['dispatched', 'in_transit', 'arrived', 'received', 'discrepancy'] },
    dispatchedAt: { type: ['string', 'null'], format: 'date-time' },
    receivedAt: { type: ['string', 'null'], format: 'date-time', description: 'When the site team confirmed receipt (ground truth).' },
    receivedBy: { type: ['string', 'null'] },
    note: { type: ['string', 'null'], description: 'Receive-time note; receiveDelivery writes an honest auto-summary when lines come up short.' },
    driverName: { type: ['string', 'null'] },
    driverPhone: { type: ['string', 'null'] },
    vehicleReg: { type: ['string', 'null'] },
    etaAt: { type: ['string', 'null'], format: 'date-time' },
    departedAt: { type: ['string', 'null'], format: 'date-time' },
    arrivedAt: { type: ['string', 'null'], format: 'date-time' },
    gpsLat: { type: ['number', 'null'] },
    gpsLng: { type: ['number', 'null'] },
    photoCount: { type: 'integer', description: 'Denormalized mirror of the linked DeliveryPhoto rows — recomputed by receiveDelivery, never client-supplied.' },
    photos: {
      type: 'array',
      description: 'Evidence-photo refs — attachment IDS ONLY (no bytes/URLs in v1).',
      items: {
        type: 'object',
        required: ['attachmentId', 'deliveryLineId', 'attachedBy', 'createdAt'],
        properties: {
          attachmentId: { type: 'string', description: '/api/upload Attachment id — the id IS the reference; v1 does not serve the photo.' },
          deliveryLineId: { type: ['string', 'null'], description: 'Line-scoped evidence (the discrepancy record) or null = whole-delivery evidence.' },
          attachedBy: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    lines: {
      type: 'array',
      description: 'Per-line physical counts: ordered vs received vs rejected (spec §34).',
      items: {
        type: 'object',
        required: ['id', 'orderLineId', 'name', 'unit', 'qtyOrdered', 'qtyReceived', 'qtyRejected', 'condition', 'damageNote', 'short'],
        properties: {
          id: { type: 'string' },
          orderLineId: { type: 'string' },
          name: { type: ['string', 'null'], description: 'PO line material name (joined in-memory).' },
          unit: { type: ['string', 'null'] },
          qtyOrdered: { type: 'number' },
          qtyReceived: { type: 'number' },
          qtyRejected: { type: 'number', description: 'Explicitly rejected on inspection.' },
          condition: { type: 'string', enum: ['ok', 'damaged', 'partial'] },
          damageNote: { type: ['string', 'null'] },
          short: { type: 'boolean', description: 'qtyReceived < qtyOrdered — receiveDelivery\'s exact short-line predicate (the same check that sets the delivery status to "discrepancy").' },
        },
      },
    },
    shortLines: { type: 'integer', description: 'Count of lines received short of the ordered quantity.' },
    createdAt: { type: 'string', format: 'date-time' },
  },
}

const supplyOrderSummarySchema = {
  type: 'object',
  description: 'One purchase order summary (the list item; the detail head adds lines + delivery records).',
  required: [
    'id', 'orderCode', 'status', 'supplierId', 'supplierName', 'requestCode', 'subtotal', 'deliveryFee', 'total',
    'paymentSource', 'createdByRole', 'note', 'deliveryCount', 'createdAt', 'updatedAt',
  ],
  properties: {
    id: { type: 'string', description: 'PurchaseOrder id (cuid) — the pagination cursor value.' },
    orderCode: { type: 'string', description: 'Human order code, e.g. PO-2026-000012.' },
    status: { type: 'string', enum: ['draft', 'pending_approval', 'approved', 'sent', 'confirmed', 'delivering', 'delivered', 'closed', 'cancelled'] },
    supplierId: { type: 'string' },
    supplierName: { type: 'string', description: 'Supplier.businessName (joined).' },
    requestCode: { type: ['string', 'null'], description: 'The originating material request code, when the order came from one.' },
    subtotal: { type: 'number', description: 'KES.' },
    deliveryFee: { type: 'number', description: 'KES.' },
    total: { type: 'number', description: 'Landed total, KES.' },
    paymentSource: { type: 'string', enum: ['client', 'contractor', 'project_wallet', 'finance'] },
    createdByRole: { type: 'string', description: 'Role that placed the order.' },
    note: { type: ['string', 'null'] },
    deliveryCount: { type: 'integer', description: 'OrderDelivery records against this order.' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

const supplyOrderDetailSchema = {
  type: 'object',
  description:
    'One purchase order with its lines and delivery-verification records. Read via a route-layer include ' +
    '(the supply module\'s public read is the whole-project slice — there is no single-order service read; the ' +
    'wallet-transactions precedent).',
  required: [
    'id', 'orderCode', 'status', 'supplierId', 'supplierName', 'requestCode', 'subtotal', 'deliveryFee', 'total',
    'paymentSource', 'createdByRole', 'note', 'deliveryCount', 'createdAt', 'updatedAt', 'lines', 'deliveries',
  ],
  properties: {
    ...supplyOrderSummarySchema.properties,
    lines: {
      type: 'array',
      description: 'The ordered lines (paperwork side of the 3-way match).',
      items: {
        type: 'object',
        required: ['id', 'name', 'unit', 'qty', 'unitPrice', 'lineTotal'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          unit: { type: 'string' },
          qty: { type: 'number' },
          unitPrice: { type: 'number', description: 'KES.' },
          lineTotal: { type: 'number', description: 'KES.' },
        },
      },
    },
    deliveries: {
      type: 'array',
      description: 'Delivery-verification records (physical ground truth), newest first.',
      items: { $ref: '#/components/schemas/DeliveryVerification' },
    },
  },
}

/** 200 shape of every Phase B list endpoint (the /api/audit page style). */
const listOkResponse = (items: object, cursorOf: string) => ({
  description: `ok: true. data = the current page; nextCursor is null on the last page, else the ${cursorOf} to pass as ?cursor. hasMore mirrors nextCursor.`,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['ok', 'data', 'nextCursor', 'hasMore'],
        properties: {
          ok: { const: true },
          data: { type: 'array', items },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
      },
    },
  },
})

/** 400 for the Phase B GET family (query validation, not body). */
const readBadRequestResponse = {
  description:
    'Validation failure (zod strictObject on the QUERY): unknown key (listed by name — typo protection), ' +
    'bad limit/cursor, ill-typed status/q, or a missing required param (projectId on /api/v1/supply/orders). ' +
    'Body { error, field? }.',
  content: { 'application/json': { schema: errorSchema } },
}

// ---- the document ------------------------------------------------------------

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'MjengoOS API v1',
    version: '1.0.0',
    description:
      'REST v1 surface of MjengoOS: wallet accounts, derived balances, double-entry ledger reads, money movement ' +
      'and payment execution (spec §38 wallets / §57 payments), plus the Phase B READ-ONLY projects + supply ' +
      'resources (project roster, honest summaries, task lists, purchase orders and delivery verification).\n\n' +
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
      '(ARCHITECTURE.md roadmap). It covers exactly the 14 /api/v1 route paths — the wallet + payment surface plus ' +
      'the Phase B READ-ONLY projects + supply resources (projects list/detail/tasks/deliveries, supply orders ' +
      'list/detail — no mutations outside the money family) — and the two wave-3 app-level GETs: /api/audit ' +
      '(admin audit log, spec §44) and /api/reports/budget-variance (QS report).',
  },
  servers: [{ url: '/', description: 'Same-origin (the app that rendered this document).' }],
  tags: [
    { name: 'wallets', description: 'Wallet accounts, balances and ledger transactions (finance/admin).' },
    { name: 'payments', description: 'Payment execution for approved payment requests (finance/admin/client).' },
    { name: 'projects', description: 'Read-only project roster, honest summaries and task lists (any signed-in role; client-role sessions pinned to their own project).' },
    { name: 'supply', description: 'Read-only procurement reads: purchase orders and delivery verification (any signed-in role, client pinned; gated by the marketplace flag for non-admins).' },
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
          integrationNote: { type: 'string', description: 'Honest per-rail integration state (simulated by default; Daraja sandbox when env-configured).' },
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
          providerNote: { type: 'string', description: 'Honest rail note (simulated by default; Daraja sandbox when env-configured).' },
        },
      },
      AuditEvent: auditEventSchema,
      BudgetVarianceReport: budgetVarianceSchema,
      ProjectListItem: projectListItemSchema,
      ProjectDetail: projectDetailSchema,
      TaskSummary: taskSummarySchema,
      DeliveryVerification: deliveryVerificationSchema,
      SupplyOrderSummary: supplyOrderSummarySchema,
      SupplyOrderDetail: supplyOrderDetailSchema,
    },
  },
  paths: {
    '/api/v1/wallets': {
      get: {
        tags: ['wallets'],
        operationId: 'listWallets',
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
        operationId: 'createWallet',
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
        operationId: 'getWallet',
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
        operationId: 'getWalletBalance',
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
        operationId: 'listWalletTransactions',
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
        operationId: 'depositWallet',
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
        operationId: 'transferWallet',
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
        operationId: 'withdrawWallet',
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
        operationId: 'payPaymentRequest',
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
    '/api/v1/projects': {
      get: {
        tags: ['projects'],
        operationId: 'listProjects',
        summary: 'List projects (role-scoped, cursor-paginated)',
        description:
          'The lightweight project roster — the same getProjectsList() rows the webapp project switcher renders ' +
          '(budgetTotal = Σ Phase.budget, budgetSpent = Σ Transaction.amount, progressPct = budget-weighted phase ' +
          'progress; no new money math in /api/v1). GUARD: any signed-in session; a CLIENT-role session sees exactly ' +
          'its own project (a client with no pinned project sees an empty list — never the portfolio), every other ' +
          'role sees the whole portfolio — the webapp /api/projects guard, mirrored. No feature flag gates this ' +
          'resource (none of the five flags names it). ?q= searches name/client (contains, ASCII case-insensitive, ' +
          'in-memory); ?status= filters to one of the documented values (the column is free-form — undocumented ' +
          'values stay visible unfiltered). Filters apply BEFORE pagination — a cursor that falls out of the filtered ' +
          'list → 400. Ordered createdAt ASC (the service order). Rate limit: 120/min per principal.',
        security,
        parameters: [
          searchParam,
          statusParam(['active', 'completed', 'on_hold'], 'project status'),
          limitParam,
          cursorParam('a project id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/ProjectListItem' }, 'project id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: projectsForbiddenResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}': {
      get: {
        tags: ['projects'],
        operationId: 'getProject',
        summary: 'One project with its honest summary',
        description:
          'Project core + honest summary: progressPct, dayCount/daysRemaining, the budget view (total = Σ Phase.budget, ' +
          'spent = Σ Transaction.amount, plan deltas), the procurement view (committed = Σ totals of ' +
          'sent/confirmed/delivering orders — the budget-vs-committed dimension) and task counts by status. Every ' +
          'figure is an EXISTING aggregation: ProjectSummary from getProjectPayload (the webapp main read) plus the ' +
          'pure procurementTotals module wired exactly like the Finder dashboard tiles — zero new money math. HONEST ' +
          'OMISSION: shareToken is never exposed (it is a bearer capability for share links, not a data field). ' +
          'GUARD: any signed-in role; client-role sessions pinned to their own project (resolve-first, pin-second — ' +
          'a foreign id → 403); unknown id → 404. Heavyweight read (the full payload aggregation). No feature flag ' +
          'gates this resource. Rate limit: 120/min per principal.',
        security,
        parameters: [projectIdPathParam],
        responses: {
          200: { description: 'ok: true, data = ProjectDetail.', ...json(ok({ $ref: '#/components/schemas/ProjectDetail' })) },
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: projectsForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/tasks': {
      get: {
        tags: ['projects'],
        operationId: 'listProjectTasks',
        summary: 'Task list of a project (cursor-paginated)',
        description:
          'Every task of the project with its phase, priority, assignment, blocker and verification fields. Data comes ' +
          'from getProjectPayload\'s phases read (phases order ASC, tasks createdAt ASC — the same query the webapp ' +
          'payload runs); the page is ordered (createdAt ASC, id ASC) for a deterministic keyset. ?status= ' +
          '(pending|in_progress|done|blocked) filters BEFORE pagination — a cursor that falls out of the filtered ' +
          'list → 400. GUARD: any signed-in role; client-role sessions pinned to their own project (foreign → 403); ' +
          'unknown project → 404. No feature flag gates this resource. Rate limit: 120/min per principal.',
        security,
        parameters: [
          projectIdPathParam,
          statusParam(['pending', 'in_progress', 'done', 'blocked'], 'task status'),
          limitParam,
          cursorParam('a task id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/TaskSummary' }, 'task id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: projectsForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/deliveries': {
      get: {
        tags: ['supply'],
        operationId: 'listProjectDeliveries',
        summary: 'Delivery verification records of a project (cursor-paginated)',
        description:
          'Every OrderDelivery against every purchase order of the project — the supply loop\'s physical ground ' +
          'truth: status (dispatched → in_transit → arrived → received | discrepancy), the §26 driver leg, per-line ' +
          'ordered vs received vs rejected counts with inspection condition, and discrepancy flags (shortLines = ' +
          'receiveDelivery\'s exact short-line predicate). EVIDENCE PHOTOS are referenced by ATTACHMENT ID ONLY — ' +
          'no photo bytes and no storage URLs are served by /api/v1; fetch them through the app\'s own storage seam. ' +
          'FEATURE FLAG (spec §81): gated by `marketplace` — OFF → 403 for non-admin sessions (admins bypass), the ' +
          'same uniform gate the v1 wallet family applies for `wallet`. GUARD: any signed-in role; client-role ' +
          'sessions pinned to their own project (foreign → 403); unknown project → 404. ?status= filters BEFORE ' +
          'pagination (a cursor that falls out → 400). Ordered (createdAt DESC, id DESC). Rate limit: 120/min per ' +
          'principal.',
        security,
        parameters: [
          projectIdPathParam,
          statusParam(['dispatched', 'in_transit', 'arrived', 'received', 'discrepancy'], 'delivery status'),
          limitParam,
          cursorParam('a delivery id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/DeliveryVerification' }, 'delivery id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: supplyForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/supply/orders': {
      get: {
        tags: ['supply'],
        operationId: 'listSupplyOrders',
        summary: 'Purchase orders of one project (cursor-paginated)',
        description:
          'The purchase orders of ONE project — loadSupplySlice(projectId), the supply module\'s public read (the ' +
          'exact procurement network the webapp Finder tab renders), projected to order summaries with supplier name, ' +
          'landed totals and delivery counts. FEATURE FLAG (spec §81): gated by `marketplace` — OFF → 403 for ' +
          'non-admin sessions (admins bypass). GUARD: any signed-in role; client-role sessions pinned to their own ' +
          'project (a foreign projectId → 403, the v1 payments precedent). projectId is REQUIRED — the Finder surface ' +
          'is project-scoped (absent → 400; unknown → 404 — no default-project guessing, mirroring the ' +
          'budget-variance report). ?status= filters to one of the nine PurchaseOrder statuses BEFORE pagination (a ' +
          'cursor that falls out → 400). Ordered (createdAt DESC, id DESC). Rate limit: 120/min per principal.',
        security,
        parameters: [
          {
            name: 'projectId',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 40 },
            description: 'The project whose orders to list. Required — absent → 400; unknown → 404.',
          },
          statusParam(
            ['draft', 'pending_approval', 'approved', 'sent', 'confirmed', 'delivering', 'delivered', 'closed', 'cancelled'],
            'purchase-order status',
          ),
          limitParam,
          cursorParam('a purchase-order id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/SupplyOrderSummary' }, 'purchase-order id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: supplyForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/supply/orders/{id}': {
      get: {
        tags: ['supply'],
        operationId: 'getSupplyOrder',
        summary: 'One purchase order with lines and delivery records',
        description:
          'One purchase order (id OR orderCode) with its ordered lines (the paperwork side of the 3-way match) and its ' +
          'delivery-verification records (per-line counts, inspection condition, photo refs as attachment ids only). ' +
          'Read via a route-layer include — the supply module\'s public read is the whole-project slice and no ' +
          'single-order service read exists (the wallet-transactions precedent; the module stays untouched). ' +
          'FEATURE FLAG (spec §81): gated by `marketplace` — OFF → 403 for non-admin sessions (admins bypass). ' +
          'GUARD: resolve-first, pin-second (the v1 payments precedent) — the order resolves by id or orderCode, then ' +
          'a client-role session must be pinned to the order\'s own project (else 403). Unknown order → 404. ' +
          'Pagination does not apply (one object). Rate limit: 120/min per principal.',
        security,
        parameters: [orderIdPathParam],
        responses: {
          200: { description: 'ok: true, data = SupplyOrderDetail.', ...json(ok({ $ref: '#/components/schemas/SupplyOrderDetail' })) },
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: supplyForbiddenResponse,
          404: orderNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/audit': {
      get: {
        tags: ['audit'],
        operationId: 'listAuditEvents',
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
        operationId: 'getBudgetVarianceReport',
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
