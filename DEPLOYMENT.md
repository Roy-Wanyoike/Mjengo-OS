# MjengoOS — Deployment & Operations Guide

Everything a new engineer needs to build, run, verify and deploy MjengoOS.
For the product itself see `README.md`; for module boundaries see
`ARCHITECTURE.md`.

## 1. Architecture (one paragraph)

MjengoOS is a **single Node process**: a Next.js 16 (App Router, Turbopack,
TypeScript strict) application whose UI is one client-rendered page
(`src/app/page.tsx` — login gate, owner app, client "Virtual Site Visit" and
share-link views) talking to guarded API routes under `src/app/api/**`
(NextAuth v4 credentials + JWT session cookies, role guards, rate limits,
idempotency). Persistence is **Prisma 6 + SQLite** (single file at
`DATABASE_URL`) with a 68-model schema, a double-entry ledger and
`_prisma_migrations` bookkeeping. File uploads (site photos, documents) are
written to `public/photos/` and `public/docs/` on local disk. `next build`
emits a **standalone** server (`output: "standalone"` → `.next/standalone/
server.js`) that runs with `node` (or `bun`), so a self-host deployment is
one process + one SQLite file + one uploads directory — no message queue, no
external services. Background jobs run in-process (`POST /api/jobs/run` is
the cron hook — drained on a schedule by a token-authenticated scheduler:
compose sidecar / systemd timer / any cron, §7.3); the AI routes call
z-ai-web-dev-sdk from the backend only.

## 2. Prerequisites

| Tool | Version | Used for |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.1 | package manager (`bun.lock`), running seeds (TS), dev server |
| Node | 20+ | production runtime (standalone server), Prisma CLI |
| Git | any | source |
| Docker (+ compose) | 24+ | optional but recommended self-host path |
| openssl | any | generating `NEXTAUTH_SECRET` |

## 3. Environment variables

Copy `.env.example` → `.env` (gitignored — **never commit real secrets**).

| Variable | Required | Value / semantics |
|---|---|---|
| `DATABASE_URL` | yes | SQLite file URL. Absolute path recommended in production (`file:/app/db/custom.db` in Docker). Relative paths resolve against the Prisma schema's directory. |
| `NEXTAUTH_SECRET` | yes | Secret for JWT session-cookie encryption — generate with `openssl rand -hex 32` (or `openssl rand -base64 32`), any value ≥ 32 chars. **Rotating it signs every user out.** In production (`NODE_ENV=production`) a missing or short (< 32 chars) secret is a **boot error** on the auth routes (`src/backend/lib/next-auth-guard.ts` fails closed, like `JOBS_RUN_TOKEN`); dev logs a one-time warning and keeps working. |
| `NEXTAUTH_URL` | situational | Public base URL. **Leave UNSET when the app is reached through a reverse proxy / any host-varying gateway** — with `AUTH_TRUST_HOST=1` next-auth v4 derives the origin per request from `x-forwarded-host`/`-proto`, so redirects, callback URLs and cookie origins always match the host the user actually browses. Set it ONLY for a fixed public domain (`https://your-domain.example`). Pinning it to localhost behind a proxy breaks sign-in (PR #7). |
| `AUTH_TRUST_HOST` | behind proxy: yes (`1`) | Makes next-auth v4's `detectOrigin` honor the proxy's forwarded host/proto headers instead of silently pinning every origin to `NEXTAUTH_URL` (or `http://localhost:3000`). Harmless for direct localhost access — keep it set whenever a proxy is involved. |
| `WEBSITE_ORIGIN` | with the marketing site | Rewrite target for `/website/*` — the origin of the `mjengoos-website/` Next.js app. Default `http://127.0.0.1:3001` (the site's own server in local dev); under docker-compose set `http://website:3001` (service DNS — `docker-compose.yml` does this for you). |
| `TRUST_PROXY` | hardening: `1` behind a trusted proxy | When set, the app reads the client IP from the **rightmost** `X-Forwarded-For` value (the one appended by your trusted proxy) instead of the first, client-spoofable value. Leave unset when there is no appending proxy in front. |
| `RATE_LIMIT_STORE` | multi-process: optional | `memory` (default — the historical in-process counters, exact for one process) or `sqlite` — one shared SQLite file per **host** so every process sees the same token buckets and login lockout (issue #33; needs `node` as the standalone runtime and one Docker COPY line, see §9.4). Any init failure logs one warning and stays in-memory. |
| `RATE_LIMIT_SQLITE_PATH` | with `RATE_LIMIT_STORE=sqlite` | Path of the shared store file (default `db/ratelimit.db`, `file:` prefix tolerated). Keep it on the same persistent volume as `DATABASE_URL` — never point it at the Prisma database; it is disposable cache-like state. |
| `MUTATION_ORIGIN_ALLOWLIST` | hardening: optional | When set (comma-separated origin list), JSON mutation requests are rejected unless their `Origin` header matches — CSRF defense-in-depth on top of cookies. |
| `USSD_WEBHOOK_SECRET` | hardening: optional | When set, `/api/ussd` requires a valid HMAC signature derived from this shared secret on every request (authenticated gateway webhooks); unset = the documented demo posture. |
| `WHATSAPP_WEBHOOK_SECRET` | hardening: optional | Same posture for the WhatsApp field line: when set, `POST /api/whatsapp` (contract documented at `GET /api/whatsapp`) must carry `X-Signature: <hex HMAC-SHA256 of the raw body>` — shared-secret auth for the relay (Meta Cloud API bridge or aggregator) that would POST `{ from, text, timestamp }`. Unset = open demo posture (requests are still rate-limited 20/min/phone + 40/min/IP; every reply is footered "MjengoOS sim" — no WhatsApp provider is wired). |
| `JOBS_RUN_TOKEN` | scheduler: optional | Shared secret (`openssl rand -hex 32`) that lets an external scheduler authenticate `POST /api/jobs/run` with `Authorization: Bearer <token>` (no browser session needed — compose `jobs-tick` sidecar, systemd timer, any cron). Same value must reach the app and the scheduler. **Unset = the bearer path is fully disabled** (fail closed — the endpoint then answers only to contractor/admin sessions, exactly as before). See §7.3. |
| `JOBS_HANDLER_TIMEOUT_MS` | jobs: optional | Per-handler timeout for ONE background-job invocation during a `POST /api/jobs/run` drain — default `30000` (30 s: generous for the TTS/AI handlers, far below the route's own duration budget, so one hung handler fails its own `JobRecord` row instead of stalling the whole drain). Read at drain time, not import time — a change applies to the next drain without a restart. Invalid, zero or unset values fall back to the default (never 0 — a zero cap would fail every handler instantly). A handler that exceeds the cap is marked `failed` **terminally** (no retry — it already hung a full window and would re-hang; re-enqueue after investigating). |
| `NOTIFY_SMS_WEBHOOK_URL` / `_TOKEN` | notifications: optional | The SMS webhook relay: when the URL is set, notify calls that pass `opts.sms` additionally POST JSON `{ to, text, metadata }` to it (the optional token rides as a bearer header). Credentials stay in YOUR gateway — nothing SMS-related lives in this app. Rows honestly record `sent`/`failed` + delivery detail. |
| `AT_API_KEY` + `AT_USERNAME` (+ `AT_SENDER_ID`, `AT_ENV`) | notifications: alternative to the webhook | Direct **Africa's Talking** provider: with both values set (a partial pair is ignored, fail-closed) and no webhook URL configured, notify calls AT's REST v1 messaging endpoint directly and records the real `messageId` as `providerRef`. The API key can send and bill SMS on your AT account — keep the env file uncommitted and narrowly readable. `AT_ENV=sandbox` targets AT's sandbox host for wiring tests without billing. **Webhook wins if both are configured; with neither, nothing external is called** (rows stay `logged`). |
| `DARAJA_RECONCILE_AFTER_MIN` / `_INTERVAL_MIN` / `_MAX_AGE_MIN` | Daraja sweep: optional | Tuning for the `wallet.reconcile` job (pending STK-intent reconciliation, §7.3): probe intents once they are `AFTER` minutes old (default 2), re-probe every `INTERVAL` minutes (default 5, matching the scheduler tick), stop probing past `MAX_AGE` minutes (default 60 — the intent stays PENDING, never an invented failure/credit). Invalid values warn and fall back to defaults; all-unset = defaults, and with no Daraja env no intents exist so the sweep does nothing. |
| `DARAJA_ALLOWED_IPS` | Daraja webhook: optional | Comma-separated IPv4 CIDRs (and/or bare IPs), e.g. `196.201.214.0/24` — when set, the STK callback route rejects requests whose resolved client IP (x-forwarded-for per `TRUST_PROXY`) matches no entry with 403 **before the body is parsed**; unresolvable IPs are rejected too (fail closed). Unset = the documented posture (unguessable secret path + query-API reconciliation). IPv6 = exact-literal match only (no IPv6 CIDR). Invalid entries are logged and ignored, but a set value with zero valid entries denies **all** traffic. Only sound behind a proxy you control that forwards `x-forwarded-for` (`TRUST_PROXY=1`). |
| `S3_ENDPOINT` + 4 more | object storage: optional | The five `S3_*` values (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) switch photo uploads from local disk to an S3/R2/MinIO-compatible bucket (presigned client-direct uploads become available). **All five or nothing** — a partial set fail-closes to local disk with one logged warning. Optional `S3_PUBLIC_BASE` = stable public/CDN URL base. See §9. |
| `PORT` / `HOSTNAME` | standalone runtime | `3000` / `0.0.0.0` defaults (set by the Docker image; `HOSTNAME=0.0.0.0` binds all interfaces). |

Cookie policy is switched per request in `src/backend/lib/auth.ts`
(`buildAuthOptions`): https (proxied) traffic gets `SameSite=None; Secure`,
direct localhost keeps next-auth's `lax` defaults.

Full per-variable commentary lives in `.env.example` (each block is written
to be copy-paste-safe). **Web push (Wave 5, shipped):** the optional VAPID
pair (`VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY`, optional `VAPID_SUBJECT`)
enables push sends through the same env-gated, fail-closed pattern — unset,
subscriptions store intent and sends stay `logged`.

**The Wave-6 AI surface (no env vars — flag + config file):** the `ai`
feature flag **ships dark** (DEFAULT OFF in `FLAG_DEFAULTS`, seeded
disabled); an admin opts in through the header flags popover, and
`NEXT_FLAGS_OFF` can only force it off. Live AI additionally needs a
`.z-ai-config` JSON file (`{ baseUrl, apiKey }`) readable by the process —
the SDK looks in the working directory, the home directory, or `/etc`
(`src/backend/modules/ai/provider.ts` documents the resolution). There are
**no AI env vars by design**. Flag on + no config file → every surface
answers the honest "AI unavailable" state (no fake output, no error storm);
flag off → the SDK is never contacted. Every SDK call is capped at **20 s**
(raised from 8 s after production measurement — multi-photo vision carries
~1–2 MB of base64 and measured 6–8 s alone), and errors are leak-free
(HTTP status or error class only — never URLs, keys or bodies).

## 4. Local development quickstart

```bash
git clone https://github.com/Roy-Wanyoike/Mjengo-OS.git mjengo
cd mjengo
bun install                       # uses bun.lock

cp .env.example .env
# edit .env:
#   DATABASE_URL=file:../db/custom.db   (repo-relative; db/ is gitignored)
#   NEXTAUTH_SECRET=$(openssl rand -hex 32)     # or: openssl rand -base64 32
#   (≥ 32 chars. In production a missing/short secret is a BOOT ERROR —
#    see §3 NEXTAUTH_SECRET and src/backend/lib/next-auth-guard.ts; dev
#    logs a one-time warning instead.)

bunx prisma generate              # generate the Prisma client
bunx prisma migrate deploy        # apply prisma/migrations/ (see §4.1)
bun run dev                       # → http://localhost:3000
```

The database ships **empty** — seed the demo data next.

### 4.1 Migrations vs `db push`

- **`bunx prisma migrate deploy`** — the production path. Applies
  `prisma/migrations/` in order and records them in `_prisma_migrations`.
  Baseline: `0_init` (the foundation schema, generated from
  `prisma/schema.prisma`); then nine **additive-only** migrations:
  `1_mjengo_score` (W3-3 trust score), `2_draw_pack` (W4-1 evidence
  bundles), `3_push_subscription` (W5-1 web push), `4_supplier_user_link`
  (W5-3 — one `ALTER TABLE ADD COLUMN`), the Wave-6 AI tables
  `5_ai_review_note` / `6_photo_hash` / `7_ai_insight` / `8_trust_digest`,
  and `9_schema_reconcile` (issue #73 — the drift reconciliation, below).
  68 models today; every migration is `CREATE TABLE` / `ALTER TABLE ADD
  COLUMN` / `CREATE INDEX` — zero data migration, safe, never drops data.
- **Drift status: RESOLVED (issue #73, migration `9_schema_reconcile`).**
  Waves 2–6 let `schema.prisma` drift ahead of the migration history (five
  pieces landed via `db push` and were never captured as SQL), so a fresh
  `migrate deploy` used to boot a database missing `Task.version`,
  `Attendance.version`, `Transaction.phaseId`, `Notification.deliveryDetail`
  and the whole `DeliveryPhoto` table. `9_schema_reconcile` adds exactly
  those pieces additively, so **migrations and `schema.prisma` now agree:
  `bunx prisma migrate diff --from-migrations prisma/migrations
  --to-schema-datamodel prisma/schema.prisma --script` is empty**, and a
  fresh `migrate deploy` + the full §4.2 seed chain runs clean (verified on
  a throwaway `file:/tmp/fresh.db`). The historical dev database was
  baselined with `bunx prisma migrate resolve --applied 0_init …
  9_schema_reconcile` (it was already `db push`-synced to the same shape —
  verified with `migrate diff --from-url` — so the SQL was *not* re-executed
  against it; `migrate status` reports up to date). Docker/production boots
  (`prisma migrate deploy` in the image CMD) are migration-managed end to
  end — `db push` is no longer needed to reconcile anything for deploys.
- **`bunx prisma db push`** (or `bun run db:push`) — the prototyping path
  for LOCAL schema experimentation: pushes `schema.prisma` straight to the
  DB, ignoring migrations. It still works after the baseline — push does
  not read `_prisma_migrations` — but **once a real deployment exists,
  change the schema only via new migrations** (`bunx prisma migrate dev
  --name x` locally, commit the generated SQL, `migrate deploy` in
  production) so the migrate-managed path never drifts again.
- **`Transaction.phaseId` (issue #39, phase cost-codes)** is an additive
  schema change delivered by `9_schema_reconcile`: a nullable column + FK to
  `Phase` (`SetNull` on phase delete), zero data migration. Legacy rows and
  non-phase spend (wages, unattributed expenses) legitimately stay `null` —
  the budget-variance report then attributes them by its documented
  budget-share estimate, while money posted through seams that KNOW the
  phase (milestone releases, milestone payment requests, payer-attributed
  `invoice.pay`) carries a real code and counts directly. The report's
  `phaseAttribution.mode` (`real` / `mixed` / `estimated`) states which mode
  produced the numbers. Money math is untouched (amounts, ledger
  double-entry, balances — this is attribution only).
- Seeding does NOT run automatically in any path; run it explicitly (§4.2).

### 4.2 Seed chain (exact order)

Seed scripts are TypeScript run directly with bun. Order matters —
`prisma/seed.ts` creates the base rows everything else references:

```bash
bun prisma/seed.ts                   # base: 3 demo projects, phases, tasks,
                                     #   workers, attendance, materials,
                                     #   deliveries, transactions, photos,
                                     #   alerts, recaps + (inline, in order)
                                     #   professionals → land → supply →
                                     #   invoices → intel
bun prisma/seed-extras/users.ts      # 8 demo login accounts (wipes ONLY User)
bun prisma/seed-extras/tasks.ts      # task v2: priorities, assignees,
                                     #   blockers, overdue escalation case
bun prisma/seed-extras/domain.ts     # worker depth, delivery driver leg,
                                     #   project team roster (idempotent)
bun prisma/seed-extras/evidence.ts   # zones, photo comments, notifications,
                                     #   audit events
bun prisma/seed-extras/money.ts      # escrow, milestones, variation orders,
                                     #   double-entry ledger history, payment
                                     #   requests (wipes only money models)
bun prisma/seed-extras/trust.ts      # fundi attendance trust history + PINs
```

Every extras script is standalone-runnable for partial re-seeds; each wipes
only the models it owns (never the base seed). For a **from-scratch reset**:
`rm db/custom.db && bunx prisma migrate deploy && <full chain above>`.
Demo logins are listed in `README.md` (contractor/client/admin/finance …).

## 5. Testing & verification

Local gates (identical to CI):

```bash
bun run lint            # eslint .          → 0 errors
bunx tsc --noEmit       # strict typecheck  → 0 errors
```

Auth smoke test with curl (cookie jar):

```bash
JAR=/tmp/mjengo-jar.txt; rm -f $JAR
CSRF=$(curl -s -c $JAR http://localhost:3000/api/auth/csrf | python3 -c "import json,sys;print(json.load(sys.stdin)['csrfToken'])")
curl -s -b $JAR -c $JAR -X POST http://localhost:3000/api/auth/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "csrfToken=$CSRF&email=contractor@mjengo.os&password=mjengo2026&json=true" -o /dev/null -w "login: %{http_code}\n"
curl -s -b $JAR http://localhost:3000/api/projects -o /dev/null -w "guarded: %{http_code}\n"  # 200 with session
curl -s http://localhost:3000/api/projects -o /dev/null -w "anon: %{http_code}\n"            # 401 without
```

Browser smoke: open `http://localhost:3000/`, sign in with a demo account,
check the Overview tab renders KPIs and `/api/health` shows `db: "up"`.

**What CI runs on every push to `main` and every PR** (`.github/workflows/`):

| Workflow | Job | Steps |
|---|---|---|
| `ci.yml` | `quality` | checkout → setup-bun → `bun install --frozen-lockfile` → `bun run lint` → `bunx tsc --noEmit` |
| `test.yml` | `test` (Vitest unit suite) | checkout → setup-bun → `bun install --frozen-lockfile` → `bun run test` (`vitest run` — 1,700 tests / 69 files at the time of the 2026-09-10 audit-fix wave; no database or secrets required) |
| `ci.yml` | `build` | checkout → setup-bun → `bun install --frozen-lockfile` → `bunx prisma generate` → `bun run build` (standalone) with `DATABASE_URL=file:ci.db` + dummy `NEXTAUTH_SECRET` — the build must never need real secrets |
| `docker.yml` | `docker-build` | `docker build -t mjengoos-ci .` on a GitHub runner — **real verification of the Dockerfile** (the dev sandbox has no docker CLI). No registry push. |
| `docker.yml` | `website-build` | `docker build -t mjengoos-website-ci ./mjengoos-website` — same posture, real verification of the marketing-site image. No registry push. |

PR runs cancel automatically when new commits land (`concurrency` guard).

## 6. Docker

### 6.1 What the image is

`Dockerfile` = two Debian-bookworm stages:

- **builder** — `node:20-slim` + the bun binary copied from `oven/bun:1`:
  `bun install --frozen-lockfile`, `bunx prisma generate`,
  `NEXTAUTH_SECRET=dummy DATABASE_URL=file:build.db bun run build`
  (the repo's build script already places `.next/static` + `public/` inside
  `.next/standalone/`).
- **runner** — `node:20-slim`, non-root `node` user, `PORT=3000`,
  `HOSTNAME=0.0.0.0`, EXPOSE 3000. Ships `.next/standalone`, the Prisma CLI
  + engine binaries + generated client, `prisma/schema.prisma` and
  `prisma/migrations/`. **On start it runs `prisma migrate deploy` (offline —
  everything needed is inside the image) and then `node server.js`.**
  Skipping migrations for one run: `docker run … mjengoos node server.js`.

`.dockerignore` keeps the context secrets-free (`.env*`, `db/`, logs, agent
artifacts, sibling projects are excluded — env reaches the image only via
`docker run`/compose at runtime, never from the build context).

The marketing website has its own image, built the same way — §6.5.

### 6.2 Build & run

```bash
docker build -t mjengoos .
docker run -d --name mjengoos -p 3000:3000 \
  -e DATABASE_URL="file:/app/db/custom.db" \
  -e NEXTAUTH_SECRET="$(openssl rand -hex 32)" \
  -v mjengoos-db:/app/db \
  -v mjengoos-photos:/app/public/photos \
  mjengoos
curl http://localhost:3000/api/health   # {"ok":true,"db":"up",...}
```

### 6.3 docker compose (recommended)

```bash
cp .env.example .env     # set NEXTAUTH_SECRET (+ NEXTAUTH_URL only if fixed domain)
docker compose up -d --build
```

`docker-compose.yml` (single-node self-host, **three services**):

- **`app`** — the webapp on `3000:3000`, `restart: unless-stopped`, env from
  `.env` **except** `DATABASE_URL` which is pinned to the named volume
  (`file:/app/db/custom.db` → volume `app-db`), plus
  `WEBSITE_ORIGIN=http://website:3001` so the `/website/*` rewrite resolves
  the website service on the compose network. Named volume `app-photos` for
  `POST /api/upload` uploads; healthcheck probing `/api/health` with node's
  `fetch`.
- **`website`** — the marketing site (`./mjengoos-website`), built in
  integrated mode by default, `restart: unless-stopped`, **internal port
  3001 only** (not published — it is reached through the app's rewrite),
  named volume `website-data` for contact-form submissions, healthcheck
  probing `/website` with node's `fetch`.
- **`jobs-tick`** — a busybox sidecar (no app code) that POSTs
  `http://app:3000/api/jobs/run` every 5 minutes with
  `Authorization: Bearer $JOBS_RUN_TOKEN`, draining the background-job
  queue on a schedule. Enabled by setting `JOBS_RUN_TOKEN` in `.env`
  (unset → the app fails the bearer calls closed and every tick logs a
  401); `docker compose logs jobs-tick` is its health signal. Full
  contract: §7.3.

After `up -d --build`: the product is at `http://localhost:3000` and the
marketing site at `http://localhost:3000/website` — one origin, the site's
"Sign in" lands on the app's login screen. To publish the site's own origin
as well, add a compose override file with `ports: ["3001:3001"]`.

#### Retrieving contact-form leads (issue #110 / audit WD-8)

The website's contact and demo-request forms (`POST /api/contact`, proxied
at `/website/api/contact` in integrated mode) persist every submission to a
JSON file on disk and contact **no third party** — no email, webhook or
notification is ever sent, so reading that file is the only retrieval path
(an operator who forgets it loses leads silently). Where it lives and how
to read it:

- **Local dev / standalone site** — `mjengoos-website/data/submissions.json`
  (relative to the site process's working directory; gitignored runtime
  PII). Pretty-print it with
  `python3 -m json.tool mjengoos-website/data/submissions.json`.
- **docker compose** — the file lives inside the `website` service container
  on the `website-data` volume (`/app/data/submissions.json`):

  ```bash
  docker compose exec website cat /app/data/submissions.json
  # keep a copy outside the volume:
  docker compose exec website cat /app/data/submissions.json > leads.json
  ```

- **Retention cap — read it regularly:** the store keeps only the **500 most
  recent** submissions; every write past 500 drops the oldest entry, and
  there is no rotation or archive file, so dropped leads are gone for good.
  Retrieve on a cadence, especially during onboarding bursts.

Each entry is the validated form payload —
`{ id, ts, source, name, email, phone?, organization?, role?, country?,
projectType?, message? }` — plaintext PII on disk; handle it accordingly
(the file is gitignored, and the site's `.dockerignore` keeps `data/` out
of images).

### 6.4 Seeding a containerized database (honest note)

The seed scripts are bun-run TypeScript files and the production runner image
has **node, not bun**. For a demo/self-host instance with seed data either:

1. bind-mount the DB instead of a named volume and seed from a host checkout:
   `-v ./data:/app/db` + `DATABASE_URL=file:./data/custom.db bun prisma/seed.ts …`;
2. or build a derived image (`FROM mjengoos` + `oven/bun:1` copied in) and run
   the chain in a one-off container.

Production data does not need seeds — users/projects are created via the app.

### 6.5 The marketing-website image

`mjengoos-website/Dockerfile` mirrors the root Dockerfile's conventions for
the marketing site (an independent Next.js app: no Prisma, no auth, no
database, so there is nothing to migrate and no build-time secret to dummy
out):

- **deps** — `node:20-slim` + the bun binary from `oven/bun:1`:
  `bun install --frozen-lockfile` against the site's own `package.json` /
  `bun.lock`.
- **builder** — `next build` under Node with the three `NEXT_PUBLIC_*` vars
  supplied as **build ARGs** (Next.js inlines them at build time — switching
  serving modes is a rebuild, not a re-run; defaults = integrated mode,
  `NEXT_PUBLIC_BASE_PATH=/website` + `NEXT_PUBLIC_APP_URL=/` + an empty
  `NEXT_PUBLIC_SITE_URL`, whose SEO/sitemap origin then falls back to the
  dev default — set it for any indexed deployment, §6.6).
- **runner** — `node:20-slim`, non-root `node` user, **standalone output**
  (`output: "standalone"` in `mjengoos-website/next.config.ts`, mirroring the
  root app): ships `.next/standalone` + `.next/static` + `public/` only —
  not the ~600 MB `node_modules` tree — with `PORT=3001`, EXPOSE 3001,
  `CMD ["node", "server.js"]`. `/app/data` is created writable for the
  contact-form API.

The site's `.dockerignore` keeps its context clean: `.env*`,
`node_modules`, `.next`, `data/` and logs never enter an image.

Build & run (standalone container, no compose):

```bash
docker build -t mjengoos-website ./mjengoos-website
docker run -d --name mjengoos-website -p 3001:3001 mjengoos-website
curl http://localhost:3001/website     # 200 (default integrated basePath)
```

For a standalone-domain image instead (§6.6):

```bash
docker build -t mjengoos-website ./mjengoos-website \
  --build-arg NEXT_PUBLIC_BASE_PATH= \
  --build-arg NEXT_PUBLIC_APP_URL=https://app.yourdomain.example \
  --build-arg NEXT_PUBLIC_SITE_URL=https://yourdomain.example
docker run -d --name mjengoos-website -p 3001:3001 mjengoos-website
curl http://localhost:3001/            # 200, site served at /
```

### 6.6 Marketing site deployment modes

The site supports two modes, chosen at **build time** (the `NEXT_PUBLIC_*`
vars are inlined by `next build`):

| Mode | Build values | Layout |
|---|---|---|
| **Integrated** (default) | `NEXT_PUBLIC_BASE_PATH=/website`, `NEXT_PUBLIC_APP_URL=/` | One origin: the webapp proxies `/website/*` to the site (its `next.config.ts` rewrite → `WEBSITE_ORIGIN`). "Sign in" goes to the app's login screen at `/` — same origin, same cookie domain. This is what compose runs. |
| **Standalone** | `NEXT_PUBLIC_BASE_PATH` empty, `NEXT_PUBLIC_APP_URL=https://app.yourdomain.example` | Own domain: serve port 3001 behind nginx/Caddy/CDN (e.g. `https://mjengoos.example.com`); "Sign in" jumps to the app's public origin; set `NEXT_PUBLIC_SITE_URL` (site `.env.example`) for SEO metadata / sitemap. |

In integrated mode the site's server must be reachable **from the app
process** at `WEBSITE_ORIGIN` — `http://127.0.0.1:3001` locally,
`http://website:3001` under compose. In standalone mode nothing proxies:
`WEBSITE_ORIGIN` is irrelevant and the site is fronted like any web origin.

## 7. Production self-host (without Docker)

```bash
bun install
bunx prisma generate
DATABASE_URL=file:/srv/mjengo/custom.db NEXTAUTH_SECRET=… bun run build
# start (repo script; runs the standalone server):
NODE_ENV=production DATABASE_URL=file:/srv/mjengo/custom.db NEXTAUTH_SECRET=… \
  bun run start            # = NODE_ENV=production bun .next/standalone/server.js
# or with node only:
DATABASE_URL=… NEXTAUTH_SECRET=… node .next/standalone/server.js
```

Run it under systemd/PM2/supervisor with `PORT`/`HOSTNAME=0.0.0.0` env, and
apply schema changes with `bunx prisma migrate deploy` (or
`node node_modules/prisma/build/index.js migrate deploy` on a node-only host)
**before** restarting the server.

### 7.1 Reverse proxy (the PR #7 lesson)

When MjengoOS sits behind nginx/Caddy/traefik, sign-in breaks unless the
proxy forwards the original host and scheme. PR #7
(`fix(auth): sign-in through the https preview gateway`) fixed exactly this:

1. next-auth v4's `detectOrigin` ignores `x-forwarded-*` unless
   `AUTH_TRUST_HOST` (or VERCEL) is set — unset, every origin silently
   degrades to `http://localhost:3000` and proxied sign-ins redirect/validate
   against the wrong host.
2. `NEXTAUTH_URL` must NOT be pinned to an internal host; leave it unset
   (origin derived per request) unless you serve one fixed public domain.
3. Cookies are policy-switched per request (`src/backend/lib/auth.ts`):
   https-proxied traffic needs `SameSite=None; Secure`, which the app sets
   automatically when the request arrives as https.

Minimum nginx proxy config:

```nginx
server {
  listen 443 ssl;
  server_name mjengo.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

### 7.2 Health, backups, secrets

- **Health:** `GET /api/health` → `{"ok":true,"db":"up","dbLatencyMs":…,
  "jobs":{…},"counts":{…}}`. Wire uptime monitoring to it (the compose
  healthcheck already does).
- **SQLite backup:** the DB is a single file. Either stop the app and copy
  the file, or use the online backup API (no stop needed):
  `sqlite3 /srv/mjengo/custom.db ".backup '/srv/backups/mjengo-$(date +%F).db'"`
  — both produce a consistent snapshot; schedule it daily and keep the
  uploads volume in the same backup (photos are evidence).
- **Rate-limit store file (`db/ratelimit.db`, only when
  `RATE_LIMIT_STORE=sqlite`):** NOT part of backups — it is cache-like
  counter state (WAL sidecar files included); deleting it while the app is
  stopped simply resets everyone's limits and lockouts.
- **Secrets:** generate `NEXTAUTH_SECRET` with `openssl rand -hex 32`; store
  it in your secret manager / `.env` on the host (never in git, never in the
  image). Changing it invalidates all sessions (users just sign in again).
  Do not expose the SQLite file or `db/` via the proxy.

### 7.3 Background jobs scheduler

Background jobs (anomaly scan, weekly digest, ledger reconciliation,
overdue check — `src/backend/modules/jobs/service.ts`) are drained by
`POST /api/jobs/run`. Nothing inside the app schedules that call — the
drain is deliberately an HTTP endpoint so any scheduler can own the
cadence. Pick **one** of the wirings below; they all just POST the
endpoint on an interval.

**The token.** A scheduler cannot hold a NextAuth session, so the
endpoint accepts a machine credential *in addition to* the
contractor/admin session (both paths stay live; the session path is
byte-identical to the pre-token behavior):

```bash
curl -X POST https://your-host.example/api/jobs/run \
  -H "Authorization: Bearer $JOBS_RUN_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

`JOBS_RUN_TOKEN` is a shared secret generated with
`openssl rand -hex 32`; the same value must reach the app **and** the
scheduler. **Unset = the bearer path is disabled entirely** — no default
token, no fallback: the endpoint then answers only to contractor/admin
sessions, exactly as before. A presented-but-invalid token gets
`401 {"error":"Invalid jobs token"}` (the secret itself is never echoed
back).

**Option A — docker compose sidecar (`jobs-tick`).** The compose stack
ships a busybox sidecar that POSTs `http://app:3000/api/jobs/run` over
the compose network (no proxy, no TLS needed) every 5 minutes. Enable it
by setting `JOBS_RUN_TOKEN` in `.env`: the app reads it via `env_file`,
the sidecar via compose interpolation — one file feeds both sides.
`docker compose up -d`, then watch it with
`docker compose logs jobs-tick`: a tick logs only failures (successful
drains are silent, like a cron); what actually ran is visible in the
Intel "Background jobs" card or via `GET /api/jobs/run`. Without the
token the sidecar still runs but every tick fails closed with a logged
401 — its startup banner explains the fix. Cadence: 5 minutes
(`sleep 300`), 50× under the endpoint's 10/min rate limit.

**Option B — systemd timer (bare-metal self-host).** `deploy/systemd/`
ships the pair `mjengo-jobs.service` + `mjengo-jobs.timer` (plus
`mjengo-jobs.env.example`):

```bash
install -D -m 0644 deploy/systemd/mjengo-jobs.service /etc/systemd/system/
install -D -m 0644 deploy/systemd/mjengo-jobs.timer   /etc/systemd/system/
install -D -m 0600 deploy/systemd/mjengo-jobs.env.example /etc/mjengo/jobs.env
# edit /etc/mjengo/jobs.env (URL + JOBS_RUN_TOKEN), then:
systemctl daemon-reload && systemctl enable --now mjengo-jobs.timer
```

`OnCalendar=*:0/5` fires on the 5-minute grid (same cadence as the
compose sidecar) with `Persistent=true` — a host that was down fires one
catch-up drain on the next boot, which is safe (see idempotency below).
`curl -fsS` turns a 401/5xx into a failed unit: `journalctl -u
mjengo-jobs.service` shows both the failure and each drain's
`{ok, ran, results}` reply. The secret lives only in the root-only
`/etc/mjengo/jobs.env` (chmod 600), never in the tracked unit files.

**Option C — any external cron.** Anything that can POST with a header
works: a host crontab, cron-job.org, a GitHub Actions scheduled
workflow, a k8s CronJob:

```bash
*/5 * * * * curl -fsS -X POST https://your-host.example/api/jobs/run \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{}'
```

**Vercel Cron caveat:** it only issues GET requests (its `CRON_SECRET`
can add a bearer header, but the method is fixed) while the drain is
POST-only by design — on Vercel you would need a thin GET wrapper route
(not shipped) or an external POST-capable scheduler.

**Security model.**

- The token is a shared secret that grants, for this one endpoint, what
  a contractor/admin session grants there: enqueueing and draining jobs.
  It grants **no read access** — `GET /api/jobs/run` stays session-only.
  Treat it like a password: 64-hex random, no default, never in git (it
  lives in `.env`/process env and the scheduler's config only).
- Comparison is constant-time (`crypto.timingSafeEqual` over
  length-matched buffers — `src/backend/lib/jobs-token.ts`). Comparing
  lengths first leaks the token's *length* (not its content) to a timing
  observer: the standard trade-off of that approach.
- The endpoint stays rate-limited: valid bearer calls pass through the
  same 10 runs/min bucket as session calls (for token calls the bucket
  key is the caller's IP-derived principal — the compose sidecar's
  direct internal call carries no cookie and no `x-forwarded-for`, so it
  lands in the shared `anon` bucket; 1 tick / 5 min leaves 50× headroom).
  Invalid tokens 401 before the bucket, exactly as session 401s always
  did.
- Repeated/overlapping ticks are safe — jobs are idempotent from the
  scheduler's perspective (`src/backend/modules/jobs/service.ts`): a
  drain only picks `queued`/`retrying` rows whose `runAt` is due;
  `done`/`failed` rows are never re-run; a failed handler retries with
  exponential backoff (2 → 8 → 30 min) and lands terminally `failed`
  after 3 attempts, keeping `lastError` on the row (the row itself is
  the dead letter). A missed or duplicated tick costs queue latency,
  never double work — modulo the narrow find-then-update race covered by
  service.ts's "single drain process" honesty note, which the 5-minute
  cadence (with 90–150 s call timeouts) makes practically unreachable.
  Note the scheduler also drives *retries*: without it, a `retrying` row
  waits for the next manual drain.
- **Rotation:** generate a new value → put it in the app's env and
  restart the app (`docker compose up -d` recreates app + sidecar; for
  systemd, edit `/etc/mjengo/jobs.env` and restart the app unit) → the
  next tick uses it. A few 401s during the swap are harmless — rows wait
  in the queue. Rotate on suspected leak or staff turnover; there is no
  automatic expiry (add a calendar reminder, or wrap the token in your
  secret manager's rotation if you use one).

**Daraja pending-intent reconciliation (`wallet.reconcile`).** The drain
also carries the M-Pesa STK safety net (issue #34): an STK initiation
whose Safaricom callback never arrives would leave the payment intent
pending forever, so every pending initiation seeds a `wallet.reconcile`
job row (due at `DARAJA_RECONCILE_AFTER_MIN`, default 2 min) and each
sweep re-probes unsettled intents every `DARAJA_RECONCILE_INTERVAL_MIN`
(default 5) until they settle or pass `DARAJA_RECONCILE_MAX_AGE_MIN`
(default 60). The sweep re-drives the **same callback processor** the
real webhook uses — it never posts money through a second path: the
query API (`stkpushquery`) is still the gate, the dedupe is still
`CheckoutRequestID` + the durable `daraja.callback:<id>` record + the
ledger idempotency key, so a sweep racing a late callback is always a
no-op on the losing side. Unmapped query results keep the intent
pending (never a credit); past max-age the intent stays pending and the
payment request stays approved for a re-initiation. With the whole
Daraja block unset, no intents exist and the sweep seeds nothing — the
default deployment is unchanged. Watch it in the jobs card or
`GET /api/jobs/run` (result JSON: scanned / probed / credited /
unverified / followUpAt). The webhook route itself accepts an optional
source-IP allowlist (`DARAJA_ALLOWED_IPS`, see §3) checked before the
body is parsed — the unguessable path + query-API reconciliation remain
the always-on integrity model.

## 8. Updating a deployment

```bash
git pull && docker compose up -d --build   # Docker path — rebuilds BOTH images
                                           # (app + website); migrations run on boot
# or, bare metal:
git pull && bun install && bunx prisma generate && bun run build \
  && bunx prisma migrate deploy && systemctl restart mjengo
```

CI guarantees the gate before this ever reaches production: lint, strict
typecheck (build fails on TS errors — `ignoreBuildErrors` is gone), a real
`next build`, and a real `docker build` on every PR.

## 9. Object storage (S3 / R2 / MinIO)

Photo evidence (site photos, delivery photos) used to live on the app
server's local disk — fine for one box, broken the moment you run more than
one instance behind a load balancer (instance A's `public/photos` is
invisible to instance B). The upload module has a **storage driver
seam** (`src/backend/lib/storage/`) with two drivers, and since the driver
**read/re-sign seam** landed, BOTH transport directions go through it:
uploads (photos AND documents), extraction reads, and presigned-GET
re-signing:

| Driver | Selected when | Files land | Public URL | Presigned flow |
|---|---|---|---|---|
| `local-disk` (default) | any of the five required `S3_*` values is unset/blank | `public/photos/<key>` + `public/docs/<key>` on the app server | `/photos/<key>` and `/docs/<key>` (served by Next) | no — honest 409 from `/api/upload/presign` and `/api/upload/re-sign` |
| `s3-compat` | **all five** set: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `s3://<bucket>/<key>` (path-style; documents under `docs/`) | `S3_PUBLIC_BASE/<bucket>/<key>` when set; otherwise a presigned GET (7-day SigV4 maximum — see below) | yes |

Fail-closed: a **partial** env set is treated as unset — one server warning
naming the missing keys (names only, never values), local-disk behavior.
`S3_ENDPOINT` examples: `https://s3.eu-central-1.amazonaws.com` (AWS),
`https://<account>.r2.cloudflarestorage.com` (R2, region `auto`),
`http://minio.internal:9000` (MinIO). SigV4 is implemented with
`node:crypto` — no new dependencies.

### 9.1 The two upload paths

**Server-mediated (unchanged, works on every driver):** the client POSTs the
photo to `/api/upload` as it always did; the route validates caps + magic
numbers and writes through `getStorageDriver().put()`. With local-disk this
is byte-identical to every prior release (same key shape `upp-*`, same
`/photos/<key>` URL, same response contract). With the S3 driver the bytes
land in the bucket and the response URL is the driver's public URL.

**Presigned client-direct (new, S3 driver only):** the photo never detours
through the app server — no ~5.4 MB base64 envelope per 4 MB photo:

```
client                    app                         object storage
  │                        │                                │
  │ POST /api/upload/presign                                │
  │  { contentType,        │ mints server-generated key     │
  │    sizeBytes,          │  upp-<ts>-<hex>.<ext>          │
  │    category }          │ + SigV4 presigned PUT (5 min)  │
  │◄───────────────────────┤ { uploadUrl, key, expiresSec,  │
  │                        │   headers: {Content-Type} }    │
  │                                                        │
  │ PUT uploadUrl (bytes, Content-Type) ──────────────────►│ object stored
  │                                                        │
  │ POST /api/upload/confirm                               │
  │  { key, category }     │ HEADs the object via the      │
  │                        │ driver: exists? ≤ 4 MB?       │
  │                        │ image content-type?           │
  │                        │ → creates the Attachment row  │
  │◄───────────────────────┤ { ok, attachment: { id,       │
  │                        │   storageKey, fileName,       │
  │                        │   category, reviewStatus } }  │
```

`/api/upload/presign` answers **409** on the local-disk driver with an
honest error ("server-mediated upload only") instead of pretending.
`/api/upload/confirm` verifies before it records: existence, the 4 MB cap,
and the image `Content-Type` (whatever the client's PUT carried — the
presign response told it exactly which header to send). The Attachment row
is created at `reviewStatus: 'pending'`, exactly like every other upload
path (humans review; AI never auto-approves).

**Document uploads are driver-mediated too (the former scope cut, closed):**
`POST /api/upload { mode: 'document' }` passes the active driver into the
documents service — local-disk writes the exact historical `public/docs/`
layout (`docs/<name>` key, row `storageKey` `/docs/<name>`, byte-identical
behavior), an S3-backed deployment PUTs the document into the bucket under
`docs/` and records the driver's public URL. Extraction
(`/api/ai/extract-document`) reads the bytes back through the same seam
(the driver's `read`), so documents stored in the bucket extract exactly
like local ones — including rows whose recorded URL is an expired presigned
GET: the driver resolves the recorded key and mints a fresh short-lived URL
for the read.

### 9.2 The presigned-URL expiry tradeoff (choose per deployment)

`Attachment.storageKey` is the URL the frontend renders. With
`S3_PUBLIC_BASE` set it is **stable forever** — set it whenever the bucket
(or a CDN in front of it) is publicly readable. Without it, the driver's
public URLs are **presigned GETs that expire after 7 days** (the SigV4
maximum): rows recorded today stop resolving next week. That is an
operational choice, not a bug to code around — and it now has a
**mitigation**:

**`POST /api/upload/re-sign`** (session-guarded like the other upload
routes, project-scoped): body `{ attachmentIds: string[] }` (1–50 cuid
ids) → the route checks the caller can SEE each attachment the same way
the photo replay path (`/api/project` → supply slice) does — client-role
sessions are pinned to their own project (own rows and delivery-linked
rows only; anything else is a fail-closed 403, and one bad id blocks the
whole batch), owner roles mirror `/api/project`'s any-project posture —
then resolves each row's recorded `storageKey` back to a driver key and
mints a **fresh presigned GET (15 minutes)**:

```json
{ "ok": true, "expiresSec": 900, "urls": [{ "attachmentId": "…", "url": "https://…?X-Amz-Expires=900…" }] }
```

Honest failures instead of pretending: 409 on the local-disk driver (its
public URLs never expire — there is nothing to re-sign), 404 naming
unknown ids, 409 when a row's `storageKey` was written by a different
storage backend (the local→S3 migration case — re-upload those files).
The recorded `storageKey` is NEVER rewritten: Attachment rows are
append-only evidence, the re-sign is transport-only, and the re-signed URL
is deliberately short-lived because it is a bearer capability (a render
window, not another week). With `S3_PUBLIC_BASE` set you do not need this
endpoint at all — it still answers (the driver can presign either way), it
is just pointless.

**Known follow-up (honest scope):** the frontend does not call this endpoint
yet — components render `storageKey` as-is, so a private-bucket deployment
still needs the UI wiring (render-time re-sign for stale URLs) to fully
benefit; the API seam itself is complete and pinned by tests.

### 9.3 Self-host local path (nothing to do)

Single-box self-hosts keep the default: leave the whole `S3_*` block unset.
Uploads write `public/photos/` exactly as before; in a **frozen production
build** `public/` is snapshotted at build time, so runtime-written photos
still need a persistent volume for that directory (the historical caveat —
unchanged, and one more reason multi-instance deploys should switch to the
S3 driver).

### 9.4 Multi-instance note

Running >1 app instance? Set the five `S3_*` values so file storage stops
being the thing that breaks: every instance PUTs to and reads from the same
bucket, and the client-direct presigned flow removes the upload bandwidth
from the app tier entirely.

The rate limiter and login lockout now have a real **single-host** answer
(W3-b, issue #33) instead of an honest TODO: set

```bash
RATE_LIMIT_STORE=sqlite
# optional, default shown; keep it next to custom.db on the same volume
RATE_LIMIT_SQLITE_PATH=db/ratelimit.db
```

and every process on that host shares ONE SQLite store (WAL journal,
busy-timeout, `BEGIN IMMEDIATE` around every read-modify-write): a bucket
exhausted on instance A is exhausted on instance B, and the 5-strike login
lockout trips no matter which process served the failures. The semantics
are the same the in-memory default pins in tests — same key formats, same
continuous token-bucket refill, same lockout lifecycle.

Honest requirements and limits of that path:

- **Runtime must be node** — the store is `better-sqlite3`, a native addon
  the Bun runtime **crashes** on (verified on Bun 1.3.x). The Docker CMD
  (`node server.js`) is fine; the loader detects Bun and falls back to
  memory with one warning instead of crashing.
- **Docker: one COPY line** (not added in this wave — the Dockerfile is
  outside the feature's file ownership; the module is loaded dynamically
  and therefore invisible to the bundler's standalone tracing):
  `COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3`
  in the runner stage. Without it the app still boots — it logs one
  fallback warning and stays in-memory. `bun install` in the builder
  downloads the platform prebuild (prebuild-install; node:20-slim has no
  compile toolchain, so a GitHub-releases-blocking proxy needs a mirrored
  artifact).
- **Same host only.** One shared file on one filesystem — put it on the
  same volume as `DATABASE_URL` (default `db/ratelimit.db` → `/app/db/`
  in Docker). Do **not** point it at the Prisma database; the file is
  disposable (delete while stopped = reset all limits/lockouts) and is
  deliberately excluded from backups.
- **Fail-safe posture:** any init failure (module missing, unwritable
  path, bad value) logs ONE warning and degrades to the in-memory default
  — rate limiting never prevents boot. Runtime store failure fails OPEN
  with a warning (an unavailable optional store must not wedge every
  request behind 429s).

**Multiple hosts** (a real load-balanced cluster, ≥2 machines): a shared
SQLite file does not cross machines — that still needs the Redis
implementation of the same store seams (`INCR`+`TTL`, or a Lua token
bucket for the exact continuous-refill semantics), deliberately not built:
no Redis dependency exists in this repo. Until then, an N-host deployment
honestly means per-host shared state, not global state.

### 9.5 Honest scope notes

- **Document extraction on PDFs** reads the text layer **server-side**
  (`src/backend/lib/pdf-text.ts`, zero-dependency best-effort parser:
  FlateDecode content streams, Tj/TJ text operators, object-stream page
  trees) — no client `ocrTextHint` is required anymore; a supplied hint
  still wins. Honest limits: it is NOT OCR — scanned/image-only PDFs
  (empty text layer) and encrypted PDFs return the same explicit 400 the
  route has always returned for unusable PDFs (upload an image or supply
  a hint); CID/Type0 fonts are decoded best-effort. The extraction stays
  draft-only (Attachment extraction fields, human review gate) and is
  capped like a hint (8 MB in, 100 k chars out).
- **Document uploads** are driver-mediated (see §9.1): the local-disk layout
  is byte-identical to the historical `public/docs/` write, S3-backed
  deploys store documents in the bucket under `docs/`, and extraction reads
  back through the driver seam (which is what unlocked this — extraction
  needed a read seam, not just a put seam). The land module's parcel documents
  (`/documents/<projectId>/<name>` storage keys on `ParcelDocument` rows)
  are a separate, older path and are deliberately untouched.
- A row whose recorded `storageKey` was minted by a DIFFERENT driver than
  the active one (local→S3 migration) honestly fails: re-sign answers 409,
  extraction reports the stored file as missing. The fix is operational —
  re-upload the affected files — not a guessed key.
- The frontend wiring for `/api/upload/re-sign` (render-time re-sign of
  stale private-bucket URLs) is the documented follow-up (§9.2); the API
  seam itself is complete.
- The legacy `/api/upload` data-URL photo path creates **no Attachment row**
  (historical contract — its URL is consumed by the AI photo flow); the
  presigned flow is the one that records rows (that is the point of
  `confirm`).
- `confirm` is **not idempotent**: Attachment rows are append-only evidence
  (same posture as the rest of the app); confirming one key twice records
  two rows pointing at the same object.
