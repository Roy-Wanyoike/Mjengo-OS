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
| **Fundis** | **Workforce Trust**: 🟢 verified vs 🟡 reported vs 🟠 exception attendance evidence levels, daily muster roll, exceptions with reasons, append-only override history, **payroll gated on verification** (blocked → review or force), labour summary + 30-day verification-rate ring, kiosk PINs, check-in methods (geofence/USSD/kiosk QR), CSV export |
| **Money** | **MjengoPay escrow** (simulated money, real workflow): wallet top-ups, milestones with **proof-of-work photo gates**, request → client approval → release (moves escrow → ledger), **variation orders** that shift the budget only after client approval |
| **Evidence** | **Bias-Free Ledger** — append-only audit of every action (who/what/when, filterable), anomaly feed with acknowledge, **one-click PDF reports** (jsPDF) |
| **AI Copilot** | Vision photo analysis (phase, PPE, material counts vs invoice), Swahili voice-to-invoice, anomaly scan — per project (site team only) |

**Offline-first:** connectivity toggle simulates the field; actions queue in a local
outbox and sync per-project on reconnect (QA-verified to the shilling).

**Notifications:** bell center (in-app) with WhatsApp-channel delivery log for recaps,
milestone requests, variations and client comments.

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
