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
`DATABASE_URL`) with a 39-model schema, a double-entry ledger and
`_prisma_migrations` bookkeeping. File uploads (site photos, documents) are
written to `public/photos/` and `public/docs/` on local disk. `next build`
emits a **standalone** server (`output: "standalone"` → `.next/standalone/
server.js`) that runs with `node` (or `bun`), so a self-host deployment is
one process + one SQLite file + one uploads directory — no message queue, no
external services. Background jobs run in-process (`POST /api/jobs/run` is
the cron hook); the AI routes call z-ai-web-dev-sdk from the backend only.

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
  Baseline: `0_init` (the entire 39-model schema, generated from
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

`docker-compose.yml` (single-node self-host): service `app` on `3000:3000`,
`restart: unless-stopped`, env from `.env` **except** `DATABASE_URL` which is
pinned to the named volume (`file:/app/db/custom.db` → volume `app-db`),
named volume `app-photos` for `POST /api/upload` uploads, and a healthcheck
probing `/api/health` with node's `fetch`.

### 6.4 Seeding a containerized database (honest note)

The seed scripts are bun-run TypeScript files and the production runner image
has **node, not bun**. For a demo/self-host instance with seed data either:

1. bind-mount the DB instead of a named volume and seed from a host checkout:
   `-v ./data:/app/db` + `DATABASE_URL=file:./data/custom.db bun prisma/seed.ts …`;
2. or build a derived image (`FROM mjengoos` + `oven/bun:1` copied in) and run
   the chain in a one-off container.

Production data does not need seeds — users/projects are created via the app.

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

## 8. Updating a deployment

```bash
git pull && docker compose up -d --build   # Docker path — migrations run on boot
# or, bare metal:
git pull && bun install && bunx prisma generate && bun run build \
  && bunx prisma migrate deploy && systemctl restart mjengo
```

CI guarantees the gate before this ever reaches production: lint, strict
typecheck (build fails on TS errors — `ignoreBuildErrors` is gone), a real
`next build`, and a real `docker build` on every PR.
