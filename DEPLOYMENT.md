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
`DATABASE_URL`) with a 61-model schema, a double-entry ledger and
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
| `NEXTAUTH_SECRET` | yes | 64-hex secret for JWT session-cookie encryption (`openssl rand -hex 32`). **Rotating it signs every user out.** |
| `NEXTAUTH_URL` | situational | Public base URL. **Leave UNSET when the app is reached through a reverse proxy / any host-varying gateway** — with `AUTH_TRUST_HOST=1` next-auth v4 derives the origin per request from `x-forwarded-host`/`-proto`, so redirects, callback URLs and cookie origins always match the host the user actually browses. Set it ONLY for a fixed public domain (`https://your-domain.example`). Pinning it to localhost behind a proxy breaks sign-in (PR #7). |
| `AUTH_TRUST_HOST` | behind proxy: yes (`1`) | Makes next-auth v4's `detectOrigin` honor the proxy's forwarded host/proto headers instead of silently pinning every origin to `NEXTAUTH_URL` (or `http://localhost:3000`). Harmless for direct localhost access — keep it set whenever a proxy is involved. |
| `WEBSITE_ORIGIN` | with the marketing site | Rewrite target for `/website/*` — the origin of the `mjengoos-website/` Next.js app. Default `http://127.0.0.1:3001` (the site's own server in local dev); under docker-compose set `http://website:3001` (service DNS — `docker-compose.yml` does this for you). |
| `TRUST_PROXY` | hardening: `1` behind a trusted proxy | When set, the app reads the client IP from the **rightmost** `X-Forwarded-For` value (the one appended by your trusted proxy) instead of the first, client-spoofable value. Leave unset when there is no appending proxy in front. |
| `MUTATION_ORIGIN_ALLOWLIST` | hardening: optional | When set (comma-separated origin list), JSON mutation requests are rejected unless their `Origin` header matches — CSRF defense-in-depth on top of cookies. |
| `USSD_WEBHOOK_SECRET` | hardening: optional | When set, `/api/ussd` requires a valid HMAC signature derived from this shared secret on every request (authenticated gateway webhooks); unset = the documented demo posture. |
| `JOBS_RUN_TOKEN` | scheduler: optional | Shared secret (`openssl rand -hex 32`) that lets an external scheduler authenticate `POST /api/jobs/run` with `Authorization: Bearer <token>` (no browser session needed — compose `jobs-tick` sidecar, systemd timer, any cron). Same value must reach the app and the scheduler. **Unset = the bearer path is fully disabled** (fail closed — the endpoint then answers only to contractor/admin sessions, exactly as before). See §7.3. |
| `S3_ENDPOINT` + 4 more | object storage: optional | The five `S3_*` values (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) switch photo uploads from local disk to an S3/R2/MinIO-compatible bucket (presigned client-direct uploads become available). **All five or nothing** — a partial set fail-closes to local disk with one logged warning. Optional `S3_PUBLIC_BASE` = stable public/CDN URL base. See §9. |
| `PORT` / `HOSTNAME` | standalone runtime | `3000` / `0.0.0.0` defaults (set by the Docker image; `HOSTNAME=0.0.0.0` binds all interfaces). |

Cookie policy is switched per request in `src/backend/lib/auth.ts`
(`buildAuthOptions`): https (proxied) traffic gets `SameSite=None; Secure`,
direct localhost keeps next-auth's `lax` defaults.

## 4. Local development quickstart

```bash
git clone https://github.com/Roy-Wanyoike/Mjengo-OS.git mjengo
cd mjengo
bun install                       # uses bun.lock

cp .env.example .env
# edit .env:
#   DATABASE_URL=file:../db/custom.db   (repo-relative; db/ is gitignored)
#   NEXTAUTH_SECRET=$(openssl rand -hex 32)

bunx prisma generate              # generate the Prisma client
bunx prisma migrate deploy        # apply prisma/migrations/ (see §4.1)
bun run dev                       # → http://localhost:3000
```

The database ships **empty** — seed the demo data next.

### 4.1 Migrations vs `db push`

- **`bunx prisma migrate deploy`** — the production path. Applies
  `prisma/migrations/` in order and records them in `_prisma_migrations`.
  Baseline: `0_init` (the entire 61-model schema, generated from
  `prisma/schema.prisma`). Safe, additive, never drops data.
- **`bunx prisma db push`** (or `bun run db:push`) — the prototyping path
  used while the schema is still moving: pushes `schema.prisma` straight to
  the DB, ignoring migrations. It still works after the baseline — push does
  not read `_prisma_migrations` — but **once a real deployment exists, change
  the schema only via new migrations** (`bunx prisma migrate dev --name x`
  locally, commit the generated SQL, `migrate deploy` in production).
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
bun prisma/seed-extras/users.ts      # 7 demo login accounts (wipes ONLY User)
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
- **builder** — `next build` under Node with the two `NEXT_PUBLIC_*` vars
  supplied as **build ARGs** (Next.js inlines them at build time — switching
  serving modes is a rebuild, not a re-run; defaults = integrated mode,
  `NEXT_PUBLIC_BASE_PATH=/website` + `NEXT_PUBLIC_APP_URL=/`).
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
  --build-arg NEXT_PUBLIC_APP_URL=https://app.yourdomain.example
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
invisible to instance B). The upload module now has a **storage driver
seam** (`src/backend/lib/storage/`) with two drivers:

| Driver | Selected when | Files land | Public URL | Presigned flow |
|---|---|---|---|---|
| `local-disk` (default) | any of the five required `S3_*` values is unset/blank | `public/photos/<key>` on the app server | `/photos/<key>` (served by Next) | no — honest 409 from `/api/upload/presign` |
| `s3-compat` | **all five** set: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `s3://<bucket>/<key>` (path-style) | `S3_PUBLIC_BASE/<bucket>/<key>` when set; otherwise a presigned GET (7-day SigV4 maximum — see below) | yes |

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

### 9.2 The presigned-URL expiry tradeoff (choose per deployment)

`Attachment.storageKey` is the URL the frontend renders. With
`S3_PUBLIC_BASE` set it is **stable forever** — set it whenever the bucket
(or a CDN in front of it) is publicly readable. Without it, the driver's
public URLs are **presigned GETs that expire after 7 days** (the SigV4
maximum): rows recorded today stop resolving next week. That is an
operational choice, not a bug to code around — but if you must run a fully
private bucket, know that a replay-time re-signing seam (resolve
`storageKey` → fresh presigned URL per render) is the documented follow-up,
deliberately not built in this wave.

### 9.3 Self-host local path (nothing to do)

Single-box self-hosts keep the default: leave the whole `S3_*` block unset.
Uploads write `public/photos/` exactly as before; in a **frozen production
build** `public/` is snapshotted at build time, so runtime-written photos
still need a persistent volume for that directory (the historical caveat —
unchanged, and one more reason multi-instance deploys should switch to the
S3 driver).

### 9.4 Multi-instance note

Running >1 app instance? Set the five `S3_*` values. The in-process rate
limiter and login lockout still need their own shared store (see
`src/backend/lib/rate-limit.ts` header), but file storage stops being the
thing that breaks: every instance PUTs to and reads from the same bucket,
and the client-direct presigned flow removes the upload bandwidth from the
app tier entirely.

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
- **Document uploads** (`mode: 'document'`, `public/docs/`) are still
  local-disk writes inside the documents service — deliberately not yet
  driver-mediated, because document extraction READS the bytes back
  (`extractDocument`); moving it needs a driver read seam, not just a put
  seam. Parked follow-up.
- The legacy `/api/upload` data-URL photo path creates **no Attachment row**
  (historical contract — its URL is consumed by the AI photo flow); the
  presigned flow is the one that records rows (that is the point of
  `confirm`).
- `confirm` is **not idempotent**: Attachment rows are append-only evidence
  (same posture as the rest of the app); confirming one key twice records
  two rows pointing at the same object.
