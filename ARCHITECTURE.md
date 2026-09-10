# MjengoOS — Architecture

MjengoOS is a Construction Site Operating System for Kenya and the wider African market:
offline-first, evidence-driven, financially honest, AI-assisted.

This repo is the **application workspace**: a Next.js 16 + TypeScript monolith
(App Router, React 19, Tailwind 4, shadcn/ui, Prisma/SQLite) that implements the full
product domain. It runs as a single deployable web app + PWA.

---

## Current architecture (this repo)

```text
Next.js 16 (App Router, RSC shell + client app)
  ├── app/           src/app/** — pages + /api HTTP routes (framework-fixed):
  │                  guarded app routes + the ussd/whatsapp field-line webhooks
  │                  + the /api/v1 REST surface (27 OpenAPI-documented paths,
  │                  29 incl. /api/audit + /api/reports/budget-variance —
  │                  contract served at /api/openapi.json)
  ├── frontend/      src/frontend/** — web UI: mjengo/ (tab surfaces, role-aware),
  │                  ui/ (shadcn primitives), auth/, i18n/, hooks/
  │                  (use-mjengo.ts: zustand + persisted offline outbox)
  ├── mobile/        src/mobile/nav/** — phone-first shell (bottom nav ≤5 tabs,
  │                  More sheet, camera quick-action); rest is responsive-shared
  ├── shared/        src/shared/** — isomorphic contracts (permissions role
  │                  matrix, CLIENT_ACTIONS allowlist)
  └── backend/       src/backend/** — server-only: lib/ (guard, auth, audit,
                    rate-limit, db, ai, mjengo payload+dispatcher) +
                    actions/ + modules/** — each module = service + policy + types
        ├── ledger    double-entry accounts/transactions/entries (source of truth)
        ├── wallet    escrow, payment requests, provider seam (SimulatedProvider
        │            default; Daraja sandbox activates from env, reconcile sweep)
        ├── supply    requests → approvals → quotes → POs → deliveries → site store
        ├── inventory append-only stock movements, derived closing stock
        ├── invoices  lifecycle, 3-way match (PO ↔ invoice ↔ delivery)
        ├── drawpack  evidence draw packs — immutable, SHA-256-stamped proof
        │            bundles frozen at milestone release, served via the share
        │            link (one pack per release, DB-enforced unique)
        ├── land      parcels, documents, registry search, property passport
        ├── professionals verified directory + credential checks
        ├── intel     risk engine, MjengoScore trust score (evidence-derived,
        │            append-only history), digest, price intelligence
        ├── ai        the Wave-6 advisory AI layer (see "The AI seam" below):
        │            provider.ts (ZaiProvider + resolveAiProvider — chat /
        │            vision / transcribe / speak, 20s per-call cap, leak-free
        │            errors, never throws) + draw-review.ts, authenticity.ts,
        │            trust-digest.ts (the three feature engines)
        ├── notify    in-app notifications (deliveryStatus honesty) + SMS
        │            providers behind one seam (webhook relay or direct
        │            Africa's Talking — env-gated, fail-closed, pick one)
        ├── events    domain event bus (in-process, durable rows)
        └── jobs      background job queue (JobRecord) with guarded run endpoint
```

**Field channels:** the USSD (`*384#` sim) and WhatsApp webhooks are public,
rate-limited, optionally HMAC-signed routes that dispatch through the *same*
`applyAction` appliers the app uses — with an action allowlist as the grammar
(attendance + photo comments only; zero wallet/land/supply types, so the
feature-flag family gate is never needed). Worker identity is the phone
number; replies are footered "MjengoOS sim". **Supplier role seam (Wave 5,
shipped):** the marketplace's supply side gets its own scoped role and
surface (catalog, quotes, orders, delivery confirmation), pinned to one
supplier — the same fail-closed pattern the client role uses.

**MjengoScore discipline:** computed only by the explicit `score.recompute`
action, from six evidence-derived components (evidence-backed releases,
verified attendance, budget pace, variation discipline, delivery
accuracy, invoice disputes) — append-only history, `RULE_VERSION` stamped,
null (not a fake 0) when the evidence is too thin. The score gates nothing
and approves nothing.

**The AI seam (Wave 6, `src/backend/modules/ai/`).** Two AI surfaces exist
and they are deliberately separate: the older **Copilot routes**
(`/api/ai/recap`, `analyze-photo`, …) call `src/backend/lib/ai.ts` behind the
`ai_progress`/`ai_voice` flags, while the Wave-6 **advisory layer** codes
against one strict contract:

```text
flags (admin popover, `ai` key DEFAULT OFF)
   └─ resolveAiProvider(flags)            provider.ts
        flags.ai !== true → null          ("AI features are off" — SDK never contacted)
        flags.ai === true  → ZaiProvider  (z-ai-web-dev-sdk, lazy singleton,
                                           .z-ai-config file — NO env vars;
                                           20s cap per call, leak-free errors,
                                           never throws; ZAI.create() failing
                                           → null = honest "AI unavailable")
             chat(messages) / vision(prompt, imageDataUrls)
             / transcribe(audioDataUrl) / speak(text, {voice, speed})
                 │  AiTextResult | AiAudioResult:  {ok:true,…} | {ok:false,error} | null
                 ▼
   draw-review.ts   authenticity.ts   trust-digest.ts
   (vision+chat     (dHash dup +      (deterministic EN/SW
    cross-check      vision phase      row-composed text;
    over frozen      pass over         TTS only speaks it)
    draw packs)      evidence) 
                 │
                 ▼  append-only rows: AiReviewNote · PhotoHash/AiInsight · TrustDigest
                    (human-decision columns present, never written in Wave 6)
```

The data flows: **draw review** resolves a released milestone's frozen
`DrawPack`, renders its evidence photos to data URLs through the storage
driver `read()` seam (capped at 6 photos), runs one vision pass plus one chat
cross-check (pack context + live invoice 3-way verdicts + phase budgets),
redacts every model-emitted figure, and appends an `AiReviewNote` (verdict
consistent/advisory/escalate, confidence, findings, deterministic
`inputsHash`) — served read-only through the existing share token. **The
authenticity screen** backfills `PhotoHash` rows (64-bit dHash via sharp,
Hamming distance ≤ 6 = duplicate candidate) across the project's photo
history *and prior packs' frozen sets*, adds a capped vision pass for phase
consistency and render tells, and appends source-labeled `AiInsight` rows
(`dhash` = rule, `vision` = model) from a never-fails post-freeze hook inside
`createDrawPackForRelease` — the pack and the release always stand. **The
trust digest** composes the weekly EN/SW text from rows (releases + ledger
refs, progress, MjengoScore delta, AI-flag counts, attendance), appends a
`TrustDigest` row per language, and renders the voice note on demand (one
`speak()` per language, honest per-language audio status — a TTS failure
never degrades the text). Entry points: the `ai.drawReview` /
`ai.trustDigest` actions (`src/backend/actions/ai.ts` — flag-family-gated on
`/api/actions` and per-item on `/api/sync`), `POST/GET
/api/ai/authenticity-screen`, the weekly `digest.trust` job, and the share
GET legs (`drawPack` + `trustDigest=latest[&audio=1]`). No action, score or
ledger path reads any AI row — the non-influence property is grep-pinned in
tests (`tests/unit/ai-*.test.ts`, 5 files).

**Rules that are non-negotiable in this codebase:**

1. **Ledger is the source of truth.** Balances are derived from balanced double-entry
   postings; legacy transaction rows are decorated with `ledgerTxnId`, never trusted alone.
2. **Frontend never touches the DB.** All mutations go through guarded API routes with
   role allowlists; every action writes an audit event (actor, entity, ip, requestId).
3. **No fake features.** Simulated rails (payments, SMS, USSD, AI confidence) are labeled
   honestly at the seam and in the UI. Verification ladders never claim government
   certification.
4. **Offline-first.** Mutations queue in a persisted outbox, sync is idempotent
   (`Idempotency-Key` + outbox dedupe), reconnection auto-drains.
5. **Every claim carries evidence** (photos, GPS, timestamps, approval rows, ledger refs).

---

## Production target architecture (migration roadmap)

The monolith is deliberately structured so each `src/backend/modules/*` domain maps 1:1 to a
future extracted service. When scale or reliability requirements demand it, migrate in
this order — each step is independently valuable:

| Capability | Target technology | Trigger to migrate |
|---|---|---|
| Web clients | Next.js 16 + React 19 (keep) + Expo/React Native field app | Field crews need native camera/GPS/push beyond PWA |
| API contract | REST + OpenAPI 3.1 generated from `/api/v1` | External integrators / SDK consumers appear |
| Core backend | Java 25 LTS + Spring Boot modular monolith (modules mirror `src/backend/modules/*`) | Team grows beyond TypeScript; or need for Spring's transactional tooling |
| Database | PostgreSQL 18 + PostGIS | Multi-tenant scale, real geospatial queries ("cement within 15km of site") |
| Durable workflows | Temporal (approvals, payments, delivery, document processing) | Long-running sagas need crash-resume guarantees beyond JobRecord |
| Event streaming | NATS JetStream | Service extraction requires durable cross-service events |
| Cache/coordination | Redis | Multi-instance deploys, distributed rate limiting |
| Object storage | S3-compatible / Cloudflare R2 (no egress fees) | Media volume outgrows local disk (`/public/photos`) |
| Identity | Keycloak (OIDC, orgs, MFA) | Enterprise SSO / multi-org requirements |
| Search | OpenSearch | Full-text + faceted search over projects/suppliers/documents |
| Observability | OpenTelemetry → Prometheus + Loki + Tempo + Grafana | Production SLAs require tracing across the request path |
| Deployment | Docker → Kubernetes + Helm + Terraform + Argo CD | HA / zero-downtime requirements |
| Analytics | ClickHouse + Parquet on object storage | High-volume event analytics |

**AI layer:** provider-agnostic by design, in two seams. The Copilot
features (vision progress estimates, anomaly scans, voice parsing, recaps,
document extraction) call `src/backend/lib/ai.ts` → z-ai SDK; the Wave-6
advisory layer (draw review, authenticity screen, trust digest) calls the
strict `modules/ai/` seam above — flag-gated, failure-honest, append-only.
Providers can be swapped without touching domain logic. AI results are
always labeled with verdict/confidence/source and require human application
— AI never writes official records directly, and no model-authored figure
is ever stored.

**Payments:** `PaymentProvider` abstraction (`src/backend/modules/wallet/providers.ts`).
`SimulatedProvider` is the default; a Safaricom **Daraja sandbox** provider
activates from env behind the same seam (STK push/query/reversal shapes,
webhook with unguessable derived path + reconciliation sweep for missed
callbacks) — an honest sandbox, not a licensed rail. Card rails plug in the
same way; idempotent replay keys are already enforced.

**SMS:** one `ChannelProvider` seam, two providers — a generic webhook relay
(`NOTIFY_SMS_WEBHOOK_URL`, credentials stay in your gateway) or direct
Africa's Talking (`AT_API_KEY` + `AT_USERNAME`). Both env-gated and
fail-closed; with neither set, nothing external is called and rows honestly
stay `logged`. **Web push (Wave 5, shipped):** VAPID-gated push through the
same notify seam, honest `logged` default.

---

## Sandbox constraints (why some things are "simulated")

This workspace runs a single Next.js instance with SQLite and no external credentials.
Therefore: payment rails (Daraja **sandbox** when configured), the USSD/WhatsApp field
lines (simulated, one POST-contract away from a real relay), web push (VAPID-gated,
`logged` default), government registry APIs and — until an admin flips the `ai` flag
and a `.z-ai-config` file exists — the Wave-6 AI layer are **honestly off/unavailable**
behind real seams, while SMS has a **real** Africa's Talking option that activates from
env. No secret ever ships in the repo.
See README for the full honesty map.
