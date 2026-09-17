# MjengoOS — Architecture Roadmap

**Status:** working document · **Audience:** engineering
**Purpose:** reconcile the target architecture (modular monolith → Go core,
PostgreSQL, wallet-as-infrastructure) with what exists in this repository
today, and define the phased path between the two.

---

## 1. Where we stand today (honest inventory)

The application is a **Next.js modular monolith** — which is the correct
starting shape (see §2). Current reality:

| Layer | Today | Target (this doc) |
|---|---|---|
| Frontend | Next.js 16 App Router, single-page app at `/`, 9 role-gated tabs, Zustand store | Same, plus `features/` domain organization |
| API | Next.js route handlers under `src/app/api/**` (actions, ai, auth, project, projects, share, sync) | `/api/v1/**` with versioning + uniform guard chain |
| Services | `src/lib/mjengo.ts` (domain logic), `src/lib/actions/*` (action handlers), `src/lib/guard.ts` (authN/authZ), `src/lib/audit.ts` (append-only ledger) | `modules/<domain>/{service,policy,repository}` structure |
| DB | Prisma + SQLite (`db/custom.db`), 20 models | PostgreSQL with domain-organized schema |
| Offline | Client outbox → `POST /api/sync` (per-item results) | Outbox + conflict metadata (§7) |
| Photos | Base64 dataUrl → `/api/upload` → `public/photos` | Presigned uploads → object storage (§6) |
| Jobs | In-request (AI calls block the request) | Queue + workers (§5) |
| Events | Direct service calls | Internal domain events (§4) |
| Wallet | `EscrowWallet.balance` + `Transaction` ledger alongside | Balance **derived** from the ledger (§8) |
| Marketing | `mjengoos-website/` — isolated Next.js app, port 3001 | Same (already matches the two-app model) |

**What is already right** (and should not be churned):

- *Modular monolith first* — exactly as recommended. One deployable, no
  premature microservices.
- *Thin controllers, logic in services* — route handlers stay ≤60 lines; all
  domain logic lives in `src/lib` (the future `modules/`).
- *A real guard chain* — every owner API passes through
  `withGuard` → session → role allowlist → handler; client-role sessions are
  pinned to their project on the sensitive surfaces (`/api/actions` via
  `CLIENT_ACTIONS`, `/api/sync` and `/api/projects` via server-side scoping).
  "Never trust the frontend" is already the house rule.
- *Append-only audit ledger* — `AuditEvent` records actor/role/summary/meta
  for every mutation. This is the seed of the event architecture.
- *The frontend never touches the database* — all writes go through
  `/api/actions` + `/api/sync` with actor stamping (`__actor`/`__role`).
- *Marketing site as a separate app* — `mjengoos-website/` is fully isolated
  (own package.json/config/port, no shared database, no auth).

---

## 2. Structural evolution: boundaries now, services later

The endgame structure (Go modules / extracted services) is agreed. The
pragmatic path is to **build the boundaries inside the current monolith
first**, so extraction later is a move, not a rewrite.

### Phase A — domain modules inside Next.js (next 1–2 weeks of refactoring)

```text
src/modules/            ← replaces the flat src/lib surface (re-exports keep
                          old import paths working during the transition)
  projects/             service · policy · repository · types
  money/                (escrow, milestones, variations, transactions)
  workers/              (attendance, payroll math)
  materials/            (catalog, deliveries, consumption)
  evidence/             (photos, comments, zones, recaps)
  share/                (share tokens, client allowlist)
  ai/                   provider abstraction + analysis services
  audit/                (existing ledger, unchanged)
  identity/             (NextAuth wiring, role model)
```

Rules that make this more than a file move:

1. **Each module owns its Prisma models** — no cross-module raw `db.*` calls;
   access goes through the owning module's repository.
2. **Each module exports a service interface only** — controllers and other
   modules never import its internals.
3. **Policies live in the module** (`project.policy.ts`) next to the logic
   they guard.
4. `src/app/api/**` controllers shrink to: parse → guard → call service →
   respond (they already nearly do).

### Phase B — API v1 + uniform middleware

```text
/api/v1/projects … /api/v1/wallet …
Request → authN → tenant/project resolution → authZ (policy) →
validate (zod) → rate limit → service
```

The current guard chain already implements this order — Phase B formalizes
it per-module and adds versioning. The Next.js routes stay the transport;
nothing about the frontend changes.

---

## 3. PostgreSQL

Agreed as the destination. Sequencing:

1. **Now:** keep SQLite in dev/sandbox (zero-ops, fast resets). Prisma keeps
   the port cheap.
2. **Migration trigger — any of:** first multi-user deployment, first
   concurrent-write pain (SQLite locks the whole DB on writes), background
   jobs running long transactions, or the marketplace/supplier features
   needing real concurrency.
3. **Migration shape:** `DATABASE_URL` swap + `prisma migrate` baseline from
   the SQLite schema + adding the FK indexes the demo scale never needed
   (Attendance.workerId/projectId, Transaction.projectId,
   ParcelEvent.parcelId when land returns — see §9).
4. Schemas per domain (identity/project/finance/…) arrive with the Phase A
   module split — one schema per module, same ownership rules.

---

## 4. Internal domain events

The audit ledger already records every mutation — extend it into a first-class
event bus inside the monolith:

```text
applyAction('delivery.verify', …)
  → money.service.commitDelivery()
  → events.emit('material.delivered', {projectId, materialId, qty})
      → notifications.enqueue(...)      // in-process today, queue later
      → ai.scheduleAnomalyCheck(...)
      → audit.record(...)               // already happens
```

Implementation order: (1) typed in-process emitter (`EventEmitter` with
async handlers + error isolation), (2) handlers for the notification + AI
follow-ups that today happen inline, (3) when jobs arrive (§5), the same
events feed the queue. **No Kafka/Redis streams until a real second consumer
exists.**

---

## 5. Background jobs

Today AI analysis (photo/voice/anomaly) runs inside the request — acceptable
at demo scale (1–10s), wrong at product scale. Plan:

- **Step 1 (cheap):** `/api/ai/*` routes return `202 + jobId` for heavy calls;
  a single in-process worker loop drains a DB-backed job table. Survives dev
  restarts, needs no infra.
- **Step 2:** BullMQ-on-Redis when there is a second process to run it.
- Job families: photo analysis, voice transcription, anomaly detection,
  recap generation, notification fan-out, (later) reconciliation.

---

## 6. Photos & documents: object storage

The current `/api/upload` (base64 dataUrl → `public/photos`) is the known
wrong long-term shape. Target flow (per the blueprint):

```text
client → POST /api/v1/uploads (request presigned URL)
       → S3-compatible store (minio self-hosted to start)
       → PUT photo
       → POST /api/v1/photos {storageKey, projectId, …}
       → background: thumbnail + AI analysis
       → evidence record
```

Keep `ParcelDocument`/`SitePhoto` metadata in Postgres, bytes in object
storage; `storageKey` + version columns. Migrate existing seeded photos as
one batch job.

---

## 7. Offline: outbox + conflict metadata

The current outbox (queued actions with per-item sync results) gets the
conflict-resolution metadata before the mobile client is real:

```text
OutboxItem {
  id, deviceId, userId, createdAt, updatedAt,
  operation, entity, entityId, version,
  payload, syncStatus: PENDING | SYNCED | REJECTED
}
```

Server side: `/api/v1/sync` accepts the envelope, validates each item
against the entity's current `version`, and returns per-item
`SYNCED | REJECTED(reason)` — exactly the per-item contract it already has,
plus versions. Idempotency keys on money mutations (already naturally
idempotent via the ledger; make it explicit).

---

## 8. Wallet & ledger — the architecture decision that matters most

Agreed: **the ledger is the source of financial truth; balances are
projections.** Concrete changes to the current models:

1. `EscrowWallet.balance` becomes a **cached projection**, recomputed from
   `Transaction` on read (or maintained transactionally with a consistency
   check). Never the source.
2. Money mutations become **append-only ledger entries** with: actor,
   role, method (mpesa/cash/bank), reference, related entity
   (milestone/invoice/delivery), and the `before → after` effect.
3. Approvals stay **human-gated** (the UI already requires evidence +
   confirmation dialogs; the server enforces state transitions).
4. Extraction path: the wallet module's service/repository boundary is the
   future `wallet-sdk` — the same interface that other applications
   (chama management, marketplace escrow) would consume. Build it as a
   module with an explicit API from day one; extract when a second consumer
   exists.
5. Payment providers: provider abstraction with webhook endpoints
   (`/api/v1/webhooks/payments`) recording state transitions into the
   ledger — reconciliation compares provider statements to ledger entries.

**Not a bank, holds no deposits** — this is a product-truth statement as
well as an architecture statement: we record money movement, we never
custody it. Regulatory posture changes only with explicit legal work.

---

## 9. Domain gaps to rebuild (recorded after the environment rollback)

An environment restore rolled the repository back to the Wave-6 feature set.
The following domains were built, verified, and lost — they are documented in
the worklog history and must be rebuilt on the Phase A module skeleton:

| Domain | What existed | Rebuild priority |
|---|---|---|
| Land & property | LandParcel/ParcelDocument/TitleSearch/Surveyor/LegalReview models, parcel history timeline, Property Passport, document transcription-vs-registry consistency check | **P1** — core differentiator |
| Professionals | 16-model directory, licence verification records, per-parcel assignments | P1 (pairs with land) |
| Supply & procurement | Suppliers, supply orders (quote→delivery→verify), benchmark price comparisons | P1 |
| Intel | RiskAssessment recompute engine (5 deterministic rules), weekly IntelDigest generator | P2 |
| Invoices | Draft→submitted→approved→paid lifecycle, client decision queue, paid-reference ledger entries | P1 (money) |
| Notifications | Notification center, 9 kinds, per-project scoping, share-link transport | P2 |
| PWA | manifest + service worker (network-only /api honesty rule), offline banner | P3 |
| USSD simulation | Full state machine (menu → PIN → attendance) | P3 |

Rebuild order = module structure order: land/, professionals/, supply/,
invoices/ land in the new `src/modules/` layout from day one, so the loss
becomes the forcing function for the architecture upgrade.

---

## 10. The Go question

**Endgame: agreed.** A Go core service owning sync, wallet, and integrations
is the right long-term shape for exactly the reasons given (concurrency for
sync storms, financial-infrastructure discipline, operational simplicity).

**Sequencing discipline:**

- Do **not** rewrite working Next.js domain logic into Go now. The product is
  mid-feature-build; a rewrite freezes features for weeks and buys no user
  value today.
- The Phase A module boundaries are precisely what makes a later Go
  extraction a **port** (service interface in, Go implementation out, API
  unchanged) instead of a rewrite.
- Extraction order when the time comes (signals in parentheses):
  1. **Sync service** (when field clients multiply and sync QPS matters)
  2. **Wallet/ledger** (when the second consumer or provider webhooks arrive)
  3. **Integrations hub** (payments/SMS/WhatsApp fan-out)
- Python stays where ML genuinely benefits (none today — the AI layer is
  API-based and stays behind the provider abstraction).
- Rust: not now, not for this product's bottlenecks.

---

## 11. Decision register

| # | Decision | Status |
|---|---|---|
| D1 | Project is the central business object; Property the underlying asset | **Adopted** (schema already reflects it) |
| D2 | Wallet/ledger is independent financial infrastructure | **Adopted as direction**; ledger-derived balances enforced in §8 |
| D3 | Modular monolith now, extraction later | **Adopted** — Phase A boundaries |
| D4 | PostgreSQL as production DB | **Adopted** — migration trigger defined (§3) |
| D5 | Go for sync/wallet/integrations core | **Deferred with extraction signals defined** (§10) |
| D6 | Events before queues; queues before brokers | **Adopted** (§4/§5) |
| D7 | Object storage for photos/documents | **Adopted** — after P1 domain rebuild (§6) |
| D8 | API versioning `/api/v1` | **Adopted** — lands with Phase B |
| D9 | Kubernetes/Kafka/Temporal | **Rejected for now** — no workload justifies the ops cost |
| D10 | One codebase, two apps (product + marketing) | **Already true** (`mjengoos-website/`) |

---

## 12. Execution order

```text
NOW      Phase A modules + rebuild P1 domains (land, professionals,
         supply, invoices) INTO the module layout  ← the rollback loss
         becomes the architecture forcing function
NEXT     §8 wallet ledger-derived balances + §4 events for
         notifications/AI + Phase B /api/v1
THEN     Postgres migration (§3) + jobs table (§5) + presigned
         uploads (§6)
LATER    Outbox conflict metadata (§7) with the real mobile client;
         Go extraction when §10 signals fire
```

Each step ships independently, keeps the product running, and preserves the
one hard rule the codebase already follows: **the frontend never touches the
database; the ledger never lies; every claim carries its evidence.**
