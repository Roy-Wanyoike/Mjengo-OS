# src/backend/ — server-only code

**Never imported by client components by value.** Only `import type` from
client code is allowed (type imports are erased at compile time — e.g. the
frontend tabs use `import type { ProjectPayload } from '@/backend/lib/mjengo'`).

```
src/backend/
  lib/        # server libraries: mjengo (payload + dispatcher), auth, guard,
              # audit, rate-limit, db (Prisma), ai (provider seam)
  actions/    # server action modules (thin routing over module services)
  modules/    # domain modules (fat services, policy, repositories, types)
```

The HTTP surface itself is `src/app/api/**` — framework-fixed by the Next.js
App Router and therefore not part of this folder; every route imports from
here. See the route list below.

## lib/ — server libraries

| File | Role |
|---|---|
| `lib/mjengo.ts` | The read-model **payload builder** + the **action dispatcher** (`applyAction`). Delegates every action to `actions/*`, auto-audits every mutation, derives summary/progress/finance slices the frontend renders. |
| `lib/guard.ts` | `withGuard` route wrapper — session resolution, per-route role allowlists, uniform 401/403 bodies. **The enforcement point.** |
| `lib/auth.ts` | NextAuth v4 options (credentials + demo accounts, session callbacks, policy-switched cookies). |
| `lib/audit.ts` | Bias-Free Ledger logging — every action writes an `AuditEvent` (actor, role, entity, ip, userAgent, requestId, before/after). Audit rows are append-only; the read API is GET-only. |
| `lib/rate-limit.ts` | Token-bucket per principal (session email else IP) + `enforceAiRoutePolicy` for the AI routes. |
| `lib/db.ts` | Prisma client singleton (SQLite at `db/custom.db`). |
| `lib/ai.ts` | AI provider seam (z-ai SDK today): vision messages, JSON extraction, transcripts parsing, project digest, recap. Results always labeled with confidence and applied by humans, never auto-written. |

## actions/ — server action modules

`actions/{trust, money, evidence, land, professionals, supply, invoices,
inventory, wallet, intel}.ts` — thin, uniform modules: validate the action
payload, call the owning domain module, return typed results. "Thin actions,
fat services" — all rules live in `modules/`. `lib/mjengo.ts` is the only
importer; each module declares its action list + `apply…Action` handler which
together make up the full `ActionType` universe.

## modules/ — domain modules

Each module = `service.ts` (+ `policy.ts`, `repository.ts`, `types.ts`, …),
mapped 1:1 to a future extracted service (see ARCHITECTURE.md):

- **ledger** — double-entry `LedgerAccount/Transaction/Entry`; the source of
  truth. Invariants: every posting is balanced (Σ debits == Σ credits),
  mutations are idempotent, reversals are explicit contra-postings — balances
  are always derived, never stored-and-trusted.
- **wallet** — escrow + payment requests + `PaymentProvider` seam
  (`providers.ts`, SimulatedProvider today); atomic milestone release.
- **supply** — requests → approvals → quotes → POs → deliveries → site store.
- **inventory** — append-only `StockMovement` rows, derived closing stock.
- **invoices** — lifecycle + 3-way match (PO ↔ invoice ↔ delivery) +
  decision-grade session resolution (`session.ts`).
- **land** — parcels, documents, registry search, property passport.
- **professionals** — verified directory + credential checks.
- **intel** — risk engine, project health, digest, price intelligence, flags.
- **notify** — in-app notifications with honest `deliveryStatus` logging.
- **events** — domain event bus (durable `DomainEvent` rows, in-process).
- **documents** — document-intel extraction types/services.
- **jobs** — background job queue (`JobRecord`) with retry/backoff and the
  guarded `POST /api/jobs/run` trigger.
- **reports** — QS budget-variance report (milestone-exact + honest
  budget-share allocation; Σ per-phase spent == project spent exactly).

## API surface (framework-fixed: `src/app/api/**`)

`auth/[...nextauth]`, `projects`, `project`, `actions` (idempotent dispatch +
audit context), `sync` (outbox drain), `share`, `upload`, `search`, `flags`,
`notifications`, `audit` (admin-only, GET-only), `reports/budget-variance`,
`jobs/run`, `health`, `ussd`, `ai/{parse-text, analyze-photo, voice-log,
extract-document, recap, anomaly-scan}`, `v1/{wallets, payments, respond,
schemas, openapi.json}`. Contract details live in `/api/openapi.json`.
