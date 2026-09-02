# MjengoOS — Construction Site OS 🇰🇪

AI-era construction management for Kenyan building sites. Bridge between messy offline
sites and a clean digital dashboard: photo-verified progress, Swahili voice-to-invoice
logging, milestone escrow backed by a **double-entry ledger**, fundi attendance with
trust levels, procurement with delivery-verified inventory, and offline-first sync.

**Philosophy:** *Don't just record what people say happened — record the evidence
around what happened.* Reported vs verified, everywhere. The ledger never lies;
AI never approves; payments are idempotent; closing stock is always derived.

[![CI](https://github.com/Roy-Wanyoike/Mjengo-OS/actions/workflows/ci.yml/badge.svg)](https://github.com/Roy-Wanyoike/Mjengo-OS/actions/workflows/ci.yml)
[![Docker](https://github.com/Roy-Wanyoike/Mjengo-OS/actions/workflows/docker.yml/badge.svg)](https://github.com/Roy-Wanyoike/Mjengo-OS/actions/workflows/docker.yml)

Seeded with **three demo projects** (active bungalow, early-stage duplex, completed
renovation) so every feature is explorable immediately.

## Sign in

The app opens with a login gate (demo credentials, one-tap fill on the login screen):

| User | Password | Role |
|---|---|---|
| contractor@mjengo.os | mjengo2026 | Contractor — full owner app |
| client@mjengo.os | mjengo2026 | Client — read-only "Virtual Site Visit" + decisions on their project |
| admin@mjengo.os | admin2026 | Admin — owner app + feature-flag controls |
| finance@mjengo.os | mjengo2026 | Finance — payment-request approvals, wallet ops, /api/v1 |

Diaspora clients with a **share link** (`/?share=<token>`) need **no account at all** —
the token is the auth. Owner APIs are guarded server-side (401/403); client roles and
share tokens can only run an explicit allowlist of actions (approve milestones/
variations/payment requests, decide client-band material requests, pay invoices,
comment on photos, read notifications).

## Authentication & reverse proxy

Sign-in must work from **both** access paths: direct `http://localhost:3000`
and the sandbox preview gateway (an https reverse proxy that preserves the
original `Host` and sets `X-Forwarded-Proto`). The `.env.example` template
documents the three settings that make this work:

| Variable | Value | Why |
|---|---|---|
| `NEXTAUTH_SECRET` | required, stable | Signs/encrypts JWT session cookies. Rotating it signs everyone out. |
| `AUTH_TRUST_HOST` | `1` | next-auth v4's `detectOrigin` otherwise ignores proxy headers and pins every origin to `NEXTAUTH_URL` (or silently to `http://localhost:3000`), which breaks sign-in through any proxy. |
| `NEXTAUTH_URL` | **unset** | The origin is derived per-request from `x-forwarded-host`/`-proto`, so redirects, callback URLs and cookie origins always target the host the user actually browses. Only set it when self-hosting on a fixed public domain. |

Cookies are policy-switched per request in `src/backend/lib/auth.ts` (`buildAuthOptions`):
`https` (proxied) traffic gets `SameSite=None; Secure` — the only combination
browsers send inside cross-site iframes, which is how the preview panel embeds
the app — while direct localhost dev keeps next-auth's `lax` defaults. A
runtime warning fires if `NEXTAUTH_URL` ever fights the real request host.

## Features

**Multi-project workspace** — switch projects from the header, create via wizard
(Bungalow / Maisonette / Duplex / Blank templates), **global search** across projects,
parcels, workers, suppliers, catalog items, requests, invoices and transactions
(`/` focuses; results jump to the right tab).

| Tab | What it does |
|---|---|
| **Overview** | KPIs, budget burn-down vs plan, **Project Health score** (6 transparent dimensions — progress/budget/schedule/procurement/issues/evidence — with grades and a "how this is computed" breakdown), digital-twin time-lapse, interactive site map, alerts, daily recap, **report exports** (Daily/Weekly/Financial/Procurement CSV + Weekly PDF from live data), photo evidence with contextual comment threads |
| **Site Plan** | Phases → tasks, progress sliders, add phase, delete task |
| **Materials** | Inventory, delivery log (voice or manual), consumption ledger, **Site Store** — append-only stock-movement ledger (opening/received/consumed/transferred/returned/damaged/adjusted) with derived closing stock, damaged/transfer tiles and a record-movement dialog; CSV export |
| **Finder** | **Procurement network, closed loop**: BOQ entity (versioned lines → approve → generate material request) → requests w/ approval-rules engine (role bands, auto-approve within limit, chained client+finance over 250K) → RFQ + **multi-line quotes with validity dates + terms** → landed-cost comparison (product + delivery + transport + fees; Best overall vs cheapest unit) → PO lifecycle → delivery verification (per-line counts, rejected qty, damage notes, GPS, photos — ordered 50 / received 48 = discrepancy for review) → **Site Store inventory movements posted automatically** → supplier invoices w/ client decision queue → **3-way match** (PO↔invoice↔delivery) → payments. Supplier directory with phone/email/operating hours/stock-as-of timestamps, category/brand/specification badges, **saved-supplier shortlist**, price-history chips, and a **schematic supplier/parcel map**. Catalog covers all material families (cement, steel, timber, plumbing, electrical, paint, tiles, sand, ballast, blocks, tools, equipment, finishes) |
| **Fundis** | **Workforce Trust**: 🟢 verified vs 🟡 reported vs 🟠 exception attendance evidence levels, daily muster roll, exceptions with reasons, append-only override history, payroll gated on verification, labour summary + verification-rate ring, kiosk PINs, check-in methods (app/USSD/kiosk QR), CSV export |
| **Money** | **MjengoPay escrow on a double-entry ledger** (simulated money, real workflow): wallet top-ups **post balanced ledger entries** (CASH ↔ ESCROW), milestones with proof-of-work photo gates → release posts ESCROW→EXPENSE, variation orders, **Payment Requests** (create → client/finance approval → payment recorded on the ledger with idempotency), **double-entry ledger card** (balanced debit/credit view, derived escrow balance vs projection consistency chip), reversals (history is never edited or deleted), cost codes, **PaymentProvider abstraction** (simulated provider behind a real seam) |
| **Land** | **Physical ground truth**: parcels + title-deed documents (transcriptions), registry-search requests w/ deterministic consistency check (CONSISTENT/MISMATCH), review gate, parcel timelines, **Property Passport** (print) — honest: searches are recorded, not registry-confirmed. Plus the professionals directory (licence chips, verification ladder from recorded credential checks, parcel assignments) |
| **Evidence** | **Bias-Free Ledger** — append-only audit of every action with actor, **IP, user-agent, request id and entity context**, filterable, anomaly feed, one-click PDF reports |
| **Intel** | Deterministic intelligence: 5 risk rules (weighted score), weekly digest, regional price trends, supplier reliability from actual transaction history, procurement cover suggestions, **Background Jobs** (anomaly scan, weekly digest, reconciliation, overdue check — queued JobRecords runnable on demand; a cron would call `POST /api/jobs/run` in production) |
| **AI Copilot** | Vision photo analysis (phase, PPE, material counts) with a **working upload pipeline** (fresh photos persist → analyze → apply to ledger end-to-end), Swahili voice-to-invoice, anomaly scan — gated by the `ai_progress` feature flag |
| **USSD** | `*384#` **muster-line simulation** — feature-phone flow (menu → PIN → present/absent) dispatching real attendance records; offline path shows the device-queue state |

**Offline-first:** real connectivity detection (`navigator.onLine` + event listeners —
reconnect auto-drains the outbox), plus a manual toggle that simulates field
connectivity. Actions queue in a local outbox; **server-side sync dedupes by outbox
id** so a lost HTTP response can never double-post money. **Data Saver** mode
downscales photo uploads (max 1024px JPEG). **PWA:** installable manifest + service
worker — `/api/*` is never cached (network-only: no stale money or evidence, ever).

**Notifications:** full bell center (kind filters, mark-read, per-project scope) with
honest delivery state (`deliveryStatus: logged` — in-app rows are real, external
channels are clearly not wired). Triggers include approvals, orders, deliveries,
discrepancies, invoices, payments, milestones, risk, prices, overdue tasks, anomalies
and budget alerts, raised both inline and via the **background-job handlers**.

**Platform internals:** domain-event bus (`DomainEvent` rows + in-process
subscribers), JobRecord queue, FeatureFlag table (admin popover, env override),
IdempotencyRecord dedupe on critical routes, `/api/v1/wallets` REST surface
(balance/transactions/deposit/withdraw/transfer, guarded + idempotent), 39-model
Prisma schema, and per-domain module boundaries (`src/backend/modules/{supply,
inventory, wallet, ledger, invoices, intel, notify, land, professionals, events,
jobs}`).

## Run it on your laptop

Prerequisites: [Bun](https://bun.sh) (recommended) or Node 20+.

```bash
bun install

# .env (relative DB path + any random secret for auth)
echo 'DATABASE_URL=file:../db/custom.db' > .env
echo "NEXTAUTH_SECRET=$(openssl rand -hex 24)" >> .env

bunx prisma generate
bun run dev            # → http://localhost:3000
```

The repo ships without a database; seed pristine demo data (order matters —
`seed.ts` creates the base rows the extras reference):

```bash
bunx prisma db push --accept-data-loss   # or: bunx prisma migrate deploy
bun prisma/seed.ts                       # 3 projects, crew, ledger, photos + land/supply/invoices/intel
bun prisma/seed-extras/users.ts          # the 7 login accounts incl. finance
bun prisma/seed-extras/tasks.ts          # task priorities, blockers, escalation case
bun prisma/seed-extras/domain.ts         # worker depth, delivery driver leg, team roster
bun prisma/seed-extras/evidence.ts       # zones, comments, notifications, audit
bun prisma/seed-extras/money.ts          # escrow, milestones, ledger history, payment requests
bun prisma/seed-extras/trust.ts          # attendance trust history + PINs
```

Every extras script wipes only its own models, so partial re-seeds are safe.

## Deployment

CI ([ci.yml](.github/workflows/ci.yml)) runs lint + strict typecheck + a real
`next build` on every push/PR; a second workflow
([docker.yml](.github/workflows/docker.yml)) builds the Docker image. Full
guide — env vars, seed chain, Docker, self-host, reverse proxy, backups — in
[DEPLOYMENT.md](./DEPLOYMENT.md). Quick start with Docker:

```bash
cp .env.example .env        # set NEXTAUTH_SECRET (openssl rand -hex 32)
docker compose up -d --build  # → http://localhost:3000 (migrations run on boot)
```

## Notes on the AI routes

`/api/ai/*` (analyze-photo, voice-log, parse-text, anomaly-scan, recap) call
`z-ai-web-dev-sdk` **from the backend only** and require a signed-in session. Outside
the original Z.ai sandbox they need your own AI credentials — everything else runs
fully local.

## Honesty notes (deliberate)

- Payment rails are **simulated** (labeled in the UI). The ledger, approval workflow,
  idempotency and reversal mechanics are real; provider integrations (Daraja, bank
  sandboxes) plug into the PaymentProvider seam when licensing allows.
- Notification channels beyond in-app are **delivery-log stubs** — rows say
  `deliveryStatus: logged`, nothing pretends to have sent an SMS/WhatsApp.
- Land verification records evidence; it never claims government confirmation.
- Supplier verification is a platform ladder, never conflated with state licensing.

## Project structure

```
.github/workflows/         # ci.yml (lint + typecheck + build), docker.yml (image build)
Dockerfile + .dockerignore # production image: bun builder → node:20-slim runner,
docker-compose.yml         #   prisma migrate deploy on boot, standalone server
DEPLOYMENT.md              # build / run / test / deploy guide (env, seeds, backups)
prisma/schema.prisma        # 39 models — incl. LedgerAccount/Transaction/Entry,
                            # IdempotencyRecord, WalletAccount, PaymentRequest,
                            # InventoryItem/StockMovement, Boq/BoqLine, QuoteLine,
                            # SavedSupplier, Attachment, DomainEvent, JobRecord,
                            # FeatureFlag, ProjectHealth, AuditEvent (ctx fields)
prisma/migrations/          # SQL migrations (baseline 0_init) — the deploy path
prisma/seed.ts + seed-extras/   # base + users/tasks/domain/evidence/money/trust
src/app/                    # Next.js App Router (framework-fixed, never moves)
  page.tsx                  # the app (single route; login gate + share-link mode)
  layout.tsx                # shell: fonts, Toaster, session + i18n providers
  api/                      # auth, projects, project, actions (idempotency +
                            # audit ctx), sync (outbox dedupe), share, upload,
                            # search, flags, notifications, jobs/run, audit,
                            # reports/budget-variance, health, ussd,
                            # v1/wallets* + 5 guarded AI routes
src/backend/                # SERVER-ONLY (never imported by client components)
  lib/                      # mjengo (payload + dispatcher), auth, guard,
                            # audit (Bias-Free Ledger), rate-limit, db, ai
  actions/                  # trust/money/evidence/land/professionals/supply/
                            # invoices/inventory/wallet action modules
  modules/                  # domain modules: supply, inventory, wallet, ledger,
                            # invoices, intel (health/flags), notify, land,
                            # professionals, events, documents, jobs, reports
src/frontend/               # WEB UI (client-facing)
  ui/                       # shadcn/ui primitives (uikit)
  mjengo/                   # app shell + tabs + domain sections (finder/land/
                            # intel/money), uikit/, cmdk/, nav/, map-view,
                            # report-utils, dialogs
  auth/                     # login screen + session provider
  i18n/                     # en/sw dictionaries + provider + locale store
  hooks/                    # use-mjengo (payload facade + offline outbox),
                            # use-toast, use-mobile
  lib/                      # utils (cn), format (KES / EAT dates)
src/mobile/                 # MOBILE SHELL — phone-first experience
  nav/mobile-bottom-nav.tsx # <768px bottom bar (≤5 tabs + More sheet +
                            # camera quick-action)
src/shared/                 # ISOMORPHIC contracts (server + client)
  permissions.ts            # role → tab matrix (client mirror of guard.ts)
  client-actions.ts         # CLIENT_ACTIONS allowlist (routes + store share it)
public/photos|audio/        # demo site photos + Swahili voice notes
mjengoos-website/          # MARKETING WEBSITE (independent Next.js app, :3001)
```

**The four surfaces:** the **marketing website** is proxied through the web
app at **`/website`** (its dev server runs on port 3001 — `bun run site:dev`;
`next.config.ts` rewrites `/website/*` → `127.0.0.1:3001`, so one origin
serves the whole product); the **web app** (`src/app` + `src/frontend`, port
3000) is the default route; its APIs and domain logic live in `src/backend/`;
phones get the mobile shell (`src/mobile/`). The website's **Sign in**
lands on the web app's login screen at `/` (where the demo accounts above
log in), and the login screen links back to `/website`.
