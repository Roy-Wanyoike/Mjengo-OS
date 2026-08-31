# MjengoOS — Construction Site OS 🇰🇪

AI-era construction management for Kenyan building sites. Bridge between messy offline
sites and a clean digital dashboard: photo-verified progress, Swahili voice-to-invoice
logging, M-Pesa-style money tracking, fundi attendance with trust levels, milestone
escrow, and offline-first sync.

**Philosophy:** *Don't just record what people say happened — record the evidence
around what happened.* Reported vs verified, everywhere.

Seeded with **three demo projects** (active bungalow, early-stage duplex, completed
renovation) so every feature is explorable immediately.

## Sign in

The app opens with a login gate (demo credentials, one-tap fill on the login screen):

| User | Password | Role |
|---|---|---|
| contractor@mjengo.os | mjengo2026 | Contractor — full owner app |
| client@mjengo.os | mjengo2026 | Client — read-only "Virtual Site Visit" of their project |
| admin@mjengo.os | admin2026 | Admin |

Diaspora clients with a **share link** (`/?share=<token>`) need **no account at all** —
the token is the auth. Owner APIs are guarded server-side (401/403); client roles and
share tokens can only run an explicit allowlist of actions (approve milestones/
variations, comment on photos, read notifications).

## Features

**Multi-project workspace** — switch projects from the header, create via wizard
(Bungalow / Maisonette / Duplex / Blank templates), welcome screen for empty accounts.

| Tab | What it does |
|---|---|
| **Overview** | KPIs, budget burn-down vs plan, phases, **Digital-twin time-lapse** (scrub Day 1 → today), **interactive site map** (clickable zones → photos), alerts, daily recap (also queued as WhatsApp-style notification), photo evidence with **contextual comment threads** |
| **Site Plan** | Phases → tasks, progress sliders, add phase, delete task |
| **Materials** | Inventory, delivery log (voice or manual), consumption ledger, add material, CSV export |
| **Finder** | **Procurement network**: Find Materials Near This Site (landed-cost engine — product + delivery + transport, weighted ranking: Best overall vs cheapest unit), purchase requests w/ **approval-rules engine** (role bands, auto-approve within limit, server-side role checks), quotes comparison, PO lifecycle w/ delivery verification (per-line counts, GPS — ordered 50 / received 48 = flagged for review), procurement dashboard (required/purchased/committed/remaining + BOQ-lite), supplier invoices w/ **client decision queue**, **3-way match** (PO↔invoice↔delivery — mismatches warn before payment, humans decide), payments → Transaction ledger, printable invoices |
| **Fundis** | **Workforce Trust**: 🟢 verified vs 🟡 reported vs 🟠 exception attendance evidence levels, daily muster roll, exceptions with reasons, append-only override history, **payroll gated on verification** (blocked → review or force), labour summary + 30-day verification-rate ring, kiosk PINs, check-in methods (geofence/USSD/kiosk QR), CSV export |
| **Money** | **MjengoPay escrow** (simulated money, real workflow): wallet top-ups, milestones with **proof-of-work photo gates**, request → client approval → release (moves escrow → ledger), **variation orders** that shift the budget only after client approval |
| **Land** | **Physical ground truth**: parcels + title-deed documents (transcriptions), registry-search requests w/ **deterministic consistency check** (CONSISTENT/MISMATCH), review gate, parcel timelines, **Property Passport** (print) — honest: searches are recorded, not registry-confirmed. Plus the **professionals directory** (LSK/EBK/BORAQS licence chips, 7-step verification ladder from recorded credential checks — never registry claims, parcel assignments) |
| **Evidence** | **Bias-Free Ledger** — append-only audit of every action (who/what/when, filterable), anomaly feed with acknowledge, **one-click PDF reports** (jsPDF) |
| **Intel** | **Deterministic intelligence**: 5 risk rules (budget/schedule/procurement/prices/attendance → weighted score), weekly digest, regional price trends (sparklines, 30d deltas, manual recording), **supplier reliability from actual transaction history** (no anonymous ratings), procurement cover suggestions |
| **AI Copilot** | Vision photo analysis (phase, PPE, material counts vs invoice), Swahili voice-to-invoice, anomaly scan — per project (site team only) |
| **USSD** | `*384#` **muster-line simulation** — feature-phone flow (menu → PIN → present/absent) dispatching real attendance records; offline path shows the device-queue state |

**Offline-first:** connectivity toggle simulates the field; actions queue in a local
outbox and sync per-project on reconnect (QA-verified to the shilling). **PWA:**
installable manifest + service worker — `/api/*` is never cached (network-only:
no stale money or evidence, ever).

**Notifications:** full bell center (kind filters, mark-read, per-project scope) for
approvals, orders, deliveries, discrepancies, invoices, risk and milestones.

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

The repo ships with a seeded SQLite DB. To reset to pristine demo data:

```bash
bunx prisma db push --accept-data-loss
bun prisma/seed.ts                          # 3 projects, crew, ledger, photos
bun prisma/seed-extras/trust.ts             # attendance trust history + PINs
bun prisma/seed-extras/money.ts             # escrow, milestones, variations
bun prisma/seed-extras/evidence.ts          # zones, comments, notifications, audit
bun prisma/seed-extras/users.ts             # login accounts
```

## Notes on the AI routes

`/api/ai/*` (analyze-photo, voice-log, parse-text, anomaly-scan, recap) call
`z-ai-web-dev-sdk` **from the backend only** and require a signed-in session. Outside
the original Z.ai sandbox they need your own AI credentials — everything else runs
fully local.

## Project structure

```
prisma/schema.prisma        # 20 models incl. AuditEvent, EscrowWallet, Milestone,
                            # VariationOrder, PhotoComment, SiteZone, Notification, User
prisma/seed.ts + seed-extras/   # base + trust/money/evidence/users demo data
src/app/page.tsx            # the app (single route; login gate + share-link mode)
src/components/mjengo/      # tabs + trust/money/evidence widgets, share & wizard
                            # dialogs, timelapse, site map, comments, notifications
src/components/auth/        # login screen + session provider
src/app/api/                # auth, projects, project, actions, sync, share (public),
                            # upload + 5 guarded AI routes
src/lib/actions/            # trust.ts / money.ts / evidence.ts action modules
src/lib/mjengo.ts           # payload builder + dispatcher (delegates + auto-audits)
src/lib/audit.ts            # Bias-Free Ledger logging + summaries
src/hooks/use-mjengo.ts     # multi-project store + offline outbox + client allowlist
public/photos|audio/        # demo site photos + Swahili voice notes
```
