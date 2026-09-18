# Integration / Infrastructure / Docs Baseline — Re-audit (Task 2-g)

- **Date:** 2026-09-16 · **Repo:** Roy-Wanyoike/Mjengo-OS, `main` @ `8b0003a` (clean tree)
- **Auditor:** 2-g — Infrastructure/Integration/Docs Baseline Lead
- **Method:** READ-ONLY research. Every claim below carries file/line evidence. No network calls to providers, no installs/builds.
- **Legend (integration matrix):** AVAILABLE (env/flag shape exists) → CONFIGURED (creds present) → IMPLEMENTED (real code path) → TESTED (unit suite pins) → BLOCKED (external dependency absent). A provider can be IMPLEMENTED+TESTED but not CONFIGURED by design (honest-seam posture).

---

## 1. Docker / Compose / systemd

### 1.1 Root Dockerfile — GOOD, production-grade for a single-node self-host

`Dockerfile` (all line refs to this file):

| Aspect | Verdict | Evidence |
|---|---|---|
| Multi-stage | ✅ 3 stages: `oven/bun:1` (binary donor) → `node:20-slim` builder → `node:20-slim` runner | L32–57 |
| Standalone output | ✅ `COPY .next/standalone`, tracing includes for Prisma (`next.config.ts:19–25` belt-and-braces `COPY` L74–76) | L65–76 |
| Non-root | ✅ `USER node`; writable dirs pre-created (`/app/db`, `public/photos`, `public/docs`) with chown | L86–89 |
| Migrations on boot | ✅ `prisma migrate deploy` runs offline (CLI + engines + migrations COPYied; no network), then `exec node server.js`; override documented | L79–94 |
| Build-time secrets | ✅ Dummy `NEXTAUTH_SECRET` + `file:build.db` at build only — "building must never require real secrets" (verified same pattern in CI) | L52–55 |
| Healthcheck | ⚠️ None IN the image (compose-level `healthcheck` exists; plain `docker run` / k8s users get none) → **INF-2** | — |
| Image size risks | Acceptable: slim base + standalone (~not the 600MB node_modules tree, per DEPLOYMENT.md §6.5). Costs: full `prisma`+`@prisma`+`.prisma` trees COPYied (~100–200MB), `sharp` native binary in trace. No size number produced (no builds allowed in audit) | L74–76 |
| Pinning | ⚠️ Tag-pinned only (`node:20-slim`, `oven/bun:1` float within major); no digests → **INF-3** | L32–34 |
| Context hygiene | ✅ `.dockerignore` excludes `.env*`, `db`, logs, `.z-ai-config`, `mjengoos-website`, `tests`, `docs` | `.dockerignore` |

### 1.2 Website Dockerfile (`mjengoos-website/Dockerfile`)

Mirrors root conventions: bun→node multi-stage, standalone, non-root `node`, `/app/data` writable for the contact-form API, build-time `NEXT_PUBLIC_*` ARGs (integrated `/website` basePath default; standalone override documented), no secrets at build. Same INF-2 (no in-image HEALTHCHECK) and INF-3 (tag pinning) apply.

### 1.3 docker-compose.yml — SOLID

- **Services:** `app` (3000 published), `website` (internal `expose: 3001`, reached via the app's `/website/*` rewrite, `WEBSITE_ORIGIN=http://website:3001`), `jobs-tick` (busybox 1.37 sidecar draining `POST /api/jobs/run` every 300s) — L27–153.
- **Restart:** `unless-stopped` on all three (L32, L84, L123).
- **Env wiring:** `.env` via `env_file` + **fail-closed interpolation** `NEXTAUTH_SECRET: "${NEXTAUTH_SECRET:?…}"` aborts `compose up` when unset (L45); `DATABASE_URL` overridden to the `app-db` named volume (L39).
- **Volumes:** `app-db` (SQLite), `app-photos`, `website-data` (contact submissions) — backups called out in comments (L58).
- **Healthchecks:** node-fetch probes on `/api/health` and `/website`, 30s/5s/3-retries (L61–71, L92–104).
- **`bun run seed` on boot? NO** — the app CMD is strictly `migrate deploy && node server.js` (Dockerfile L94); seeding a containerized DB is a documented manual step (DEPLOYMENT.md §6.4: bind-mount or derived image). **Demo data cannot leak into prod boots.** ✅
- **jobs-tick:** no healthcheck *by design* (the loop's failure log is the liveness — documented L117–119); without `JOBS_RUN_TOKEN` it still runs but every tick 401s fail-closed with an explanatory banner (L133–137).

### 1.4 deploy/systemd — CORRECT, one least-privilege gap

- `mjengo-jobs.timer`: `OnCalendar=*:0/5` (5-min grid, matches sidecar cadence, 50× under the endpoint's 10/min bucket), `Persistent=true` (one safe catch-up drain), `AccuracySec=30s`, `WantedBy=timers.target` — L9–24.
- `mjengo-jobs.service`: `Type=oneshot`, `EnvironmentFile=/etc/mjengo/jobs.env` (root-only 0600, secret never in the tracked unit), `TimeoutStartSec=180` vs the route's 120s `maxDuration`, `curl -fsS --max-time 150` so a 401/5xx lands in the journal (fail-closed) — L33–51. Install instructions in-header (L16–26).
- `mjengo-jobs.env.example`: documents rotation procedure and same-value-on-both-sides requirement — L1–19.
- ⚠️ **No `User=`/`DynamicUser=` — the oneshot runs as root** → **INF-1** (Low/Medium; it only curls localhost, but least privilege says otherwise).
- **What a drain actually does:** `runDueJobs(10)` over 8 job types — `anomaly_scan`, `digest.weekly`, `digest.trust`, `recap.daily`, `reconciliation`, `overdue.check`, `budget.check`, `wallet.reconcile` (`src/backend/modules/jobs/handlers.ts:584–603`); queued+due-retrying rows only, never re-runs done/failed; backoff 2→8→30min, terminal after 3 attempts, per-handler 30s timeout (env `JOBS_HANDLER_TIMEOUT_MS`, read at drain time — `modules/jobs/service.ts:65–107`).

**Docker/compose/systemd verdict: production-credible for the documented single-node posture.** Gaps are polish (INF-1/2/3), not correctness.

---

## 2. CI (.github/workflows/*)

Three workflows, all push-to-`main` + all PRs, PR auto-cancel via `concurrency`:

| Workflow | Jobs | Notes |
|---|---|---|
| `ci.yml` | `quality` (lint + `tsc --noEmit` for app **and** website, informational `bun audit` continue-on-error) + `build` (real `next build` standalone w/ dummy `DATABASE_URL`/`NEXTAUTH_SECRET`) | L21–81; mirrors the Docker build exactly |
| `test.yml` | `test` (`bun run test` = `vitest run`, 10-min timeout) | L18–34 |
| `docker.yml` | `docker-build` (root image) + `website-build` — **build-only, no run/smoke test, no registry push** | L16–35 |

- **Tooling:** `oven-sh/setup-bun@v2` (bun's own caching), `actions/checkout@v4`; no explicit `actions/cache` (acceptable), no Node matrix (Node appears only in Docker).
- **Would they pass if unblocked?** Plausibly yes — but **unverifiable from this sandbox** (GitHub API rate-limited, `gh` absent). Local evidence: QA-REPORT-2026-09-10 §3 claims lint 0 / tsc 0 / 1,811 tests passing; my static count is **1,716 `it/test` calls across 71 files + 14 `it.each`/`describe.each` tables** (each expands at runtime), consistent with that claim.
- **Billing-lock claim (issue #98):** consistently disclosed in README.md:436–437 & 489–494 ("no run has ever gone green"), CONTRIBUTING.md:63–66, QA-REPORT §3. Internally consistent; cannot be independently confirmed from here. The claim is honest in its framing (workflows fire; jobs are rejected by the account lock).

**CI verdict: workflow definitions are correct and complete for the repo's needs; the *effective* gate today is local-only, which is a real production-launch risk (INF-4).**

---

## 3. Integration status matrix

| # | Integration | AVAILABLE | CONFIGURED | IMPLEMENTED | TESTED | Env gate / unset behavior | Simulation labeled? | Evidence |
|---|---|---|---|---|---|---|---|---|
| 1 | **M-Pesa Daraja (wallet)** | ✅ | ❌ by design (no creds in repo) | ✅ STK push / stkpushquery / reversal, OAuth cache+401-refresh, derived unguessable webhook path, IP allowlist, reconcile sweep | ✅ `mpesa-daraja`, `daraja-reconcile`, `daraja-ip-allowlist`, `wallet-idempotency` tests | 7 vars ALL required (`DARAJA_CONSUMER_KEY/SECRET/SHORTCODE/PASSKEY/CALLBACK_BASE(https!)/WEBHOOK_SECRET`); partial → `null` → **SimulatedProvider (fail-closed)**; reversal creds separate, unset → honest 'failed' | ✅ `simulated:true` in sandbox; `integrationNote` says "NOT a licensed integration" even in production mode; unmapped ResultCode never succeeds (fail-closed on money) | `modules/wallet/daraja.ts:92–114,222–231`; `providers.ts` seam; webhook `api/webhooks/daraja/[secret]/route.ts:57–85` |
| 2 | **Africa's Talking SMS** | ✅ | ❌ (env only) | ✅ REST v1 form-urlencoded + apiKey header, messageId→providerRef | ✅ `notify-channels.test.ts` (incl. sandbox-host case) | `AT_API_KEY`+`AT_USERNAME` BOTH (partial pair ignored); **webhook wins if both configured**; neither → rows stay `logged`, zero external calls | ✅ `AT_ENV=sandbox` host switch for billing-free wiring tests | `modules/notify/channels.ts:269–371` |
| 3 | **SMS webhook gateway (generic)** | ✅ | ❌ (env only) | ✅ JSON POST `{to,text,metadata}`, optional bearer, 8s cap, leak-free errors | ✅ `notify-channels.test.ts` | `NOTIFY_SMS_WEBHOOK_URL`(+`_TOKEN`); unset → `logged` | n/a (real relay) | `channels.ts:200–262,357–371` |
| 4 | **WhatsApp field line** | ⚠️ seam only | ❌ | ✅ *inbound contract*: keyword grammar (PRESENT/ABSENT/HALF/BALANCE/HELP/free-text→photo comment), allowlist = 3 action types, HMAC option, 20/min/phone + 40/min/IP, 64KB cap, real `applyAction` writes | ✅ `whatsapp-route.test.ts` | `WHATSAPP_WEBHOOK_SECRET` optional; unset = open demo posture + ONE loud prod warning (BE-6) | ✅ every reply footered "— MjengoOS sim"; **no outbound provider wired** (documented at `GET /api/whatsapp`) | `api/whatsapp/route.ts:15,79,190–207,338–396` |
| 5 | **Web push (VAPID)** | ✅ | ❌ (env only) | ✅ web-push lib, per-subscription vapidDetails, 24h TTL, 404/410→`gone:true` pruning | ✅ `push-routes.test.ts`, `notify-channels.test.ts` | `VAPID_PUBLIC_KEY`+`VAPID_PRIVATE_KEY` both (partial → null); unset → subscriptions still stored, sends stay `logged`, `GET /api/push/subscribe` reports `configured:false` | ✅ honest "not configured" UI states | `channels.ts:399–483`; `api/push/subscribe/route.ts` |
| 6 | **AI provider (z-ai-web-dev-sdk)** | ✅ (flag+file) | ❌ (`.z-ai-config` file, **no env by design**) | ✅ two seams: legacy `lib/ai.ts` (Copilot: llm/vision/asr, 20s race, PII-scrubbed prompts) + `modules/ai/provider.ts` (chat/vision/transcribe/speak+WAV merge, never-throws, leak-free) | ✅ `ai-provider`, `ai-legacy-timeout`, `ai-trust-digest`, `ai-draw-review`, `ai-authenticity` tests | `ai` feature flag DEFAULT OFF + config file; flag on w/o config → `null` = "AI unavailable" (nothing faked) | ✅ advisory-only, confidence-labeled, no model-authored figures stored | `lib/ai.ts:20–74`; `modules/ai/provider.ts:16–59,544–546` |
| 7 | **Object storage (S3/R2/MinIO)** | ✅ | ❌ (env only) | ✅ SigV4 presign via node:crypto (no new deps), s3-compat driver, local-disk default, re-sign seam | ✅ 7 storage test files (`sigv4`, `s3-compat`, `factory`, `local-disk`, `presign-routes`, `document-read`, `resign-routes`) | ALL 5 `S3_*` required; partial → local-disk + ONE warning naming missing keys; `S3_PUBLIC_BASE` unset → 7-day presigned GET URLs (documented tradeoff) | ✅ honest defaults | `lib/storage/index.ts:55–114` |
| 8 | **USSD gateway (*384#)** | ⚠️ seam only | ❌ | ✅ stateless aggregator contract parser, kiosk-PIN resolution, PIN lockout (5/15min), rate limits, HMAC option, real attendance rows | ✅ `ussd-route.test.ts` | `USSD_WEBHOOK_SECRET` optional; unset = demo posture + prod warning; **secret set drops the phone-tail PIN fallback** (hardening) | ✅ "MjengoOS sim" footer; no telco wired | `api/ussd/route.ts:15–90,160,217` |
| 9 | **Email** | ❌ | ❌ | ❌ **not implemented** — no nodemailer/SMTP/Resend/Sendgrid anywhere (grep hits were `QuoteLine` false positives) | ❌ | — | listed as a *future* ChannelProvider | `channels.ts:9–10` ("WhatsApp and email are future providers") |

**Matrix verdict:** the repo's signature "honest seam" discipline is real and consistently enforced: every integration fails **closed** (or degrades to an honestly-labeled `logged`/simulated state) when env is absent, partial pairs never half-activate, and simulations are labeled in-band (footers, `simulated:true`, `configured:false`). Two channels (WhatsApp, USSD) are *inbound* contracts with zero outbound provider; email does not exist.

---

## 4. Environment variable audit

### 4.1 Coverage: essentially complete

All 42 documented vars in `.env.example` (root) map 1:1 to code reads:

- **Auth/app:** `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `AUTH_TRUST_HOST` (read at `nextauth-fallback-secret.ts:56–59`), `NEXT_FLAGS_OFF` (`intel/flags.ts:188`), `WEBSITE_ORIGIN` (`next.config.ts:8`), `TRUST_PROXY` (`rate-limit.ts:73`)
- **Hardening/stores:** `RATE_LIMIT_STORE` (`rate-limit.ts:302`), `RATE_LIMIT_SQLITE_PATH` (`rate-limit-sqlite.ts:146`), `MUTATION_ORIGIN_ALLOWLIST` (`route-kit.ts:141`, daraja webhook route:57), `USSD_WEBHOOK_SECRET`, `WHATSAPP_WEBHOOK_SECRET`
- **Jobs:** `JOBS_RUN_TOKEN` (`api/jobs/run/route.ts:97`), `JOBS_HANDLER_TIMEOUT_MS` (`jobs/service.ts:85`)
- **Notify:** `NOTIFY_SMS_WEBHOOK_URL/_TOKEN`, `AT_API_KEY/_USERNAME/_SENDER_ID/_ENV`, `VAPID_PUBLIC_KEY/_PRIVATE_KEY/_SUBJECT` (`channels.ts:357–483`)
- **Daraja:** `DARAJA_ENV/_CONSUMER_KEY/_CONSUMER_SECRET/_SHORTCODE/_PASSKEY/_CALLBACK_BASE/_WEBHOOK_SECRET/_INITIATOR_NAME/_SECURITY_CREDENTIAL/_ALLOWED_IPS` + 3 `DARAJA_RECONCILE_*` (`daraja.ts:92–113`, `daraja-reconcile.ts:104–106`, webhook route:57–85)
- **Storage:** `S3_ENDPOINT/_REGION/_BUCKET/_ACCESS_KEY_ID/_SECRET_ACCESS_KEY/_PUBLIC_BASE` (`storage/index.ts:70–75`)

DEPLOYMENT.md §3 documents the same set plus `PORT`/`HOSTNAME`. Website `.env.example` covers its 5 vars.

### 4.2 Gaps found

| Finding | Detail |
|---|---|
| **ENV-1 (Low)** | `AUTH_SECRET` is read as a fallback in `guard.ts:15` (`NEXTAUTH_SECRET ?? AUTH_SECRET`) and `nextauth-fallback-secret.ts:99`, but is **undocumented** in `.env.example`/DEPLOYMENT.md. An operator setting only `AUTH_SECRET` gets a split-brain state (guard satisfied, next-auth config not). Either document it or drop the fallback. |
| ENV-2 (Info) | Platform-injected vars correctly not documented: `NODE_ENV`, `NEXT_PHASE` (`next-auth-guard.ts:86`), `VERCEL` (`nextauth-fallback-secret.ts:57`), `NEXT_TELEMETRY_DISABLED` (Dockerfile/CI). |

### 4.3 Secrets classification (17 secret-class vars)

`NEXTAUTH_SECRET`, `JOBS_RUN_TOKEN`, `USSD_WEBHOOK_SECRET`, `WHATSAPP_WEBHOOK_SECRET`, `NOTIFY_SMS_WEBHOOK_TOKEN`, `AT_API_KEY`, `VAPID_PRIVATE_KEY`, `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, `DARAJA_PASSKEY`, `DARAJA_WEBHOOK_SECRET`, `DARAJA_SECURITY_CREDENTIAL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (+ website has none at runtime). Non-secrets by design: `DARAJA_SHORTCODE/CALLBACK_BASE/INITIATOR_NAME/ALLOWED_IPS/RECONCILE_*`, `AT_USERNAME/SENDER_ID/ENV`, `VAPID_PUBLIC_KEY/SUBJECT`, `S3_ENDPOINT/REGION/BUCKET/PUBLIC_BASE`, `DATABASE_URL` (path), the rest are toggles. The `.env.example` placeholder `NEXTAUTH_SECRET=change-me` is deliberately too short to pass the prod boot guard — good fail-closed touch (`.env.example:9–17`).

---

## 5. Observability — honest gap assessment

| Dimension | State | Evidence |
|---|---|---|
| Health endpoint | **GOOD** — real `SELECT 1` DB roundtrip, `dbLatencyMs`, job-queue counts (queued/retrying/failed), coarse entity counts, uptime, version; 503 + honest detail when DB down; no auth by design (probes); consumed by compose healthchecks | `api/health/route.ts:21–63` |
| Audit trail | **GOOD (domain-level)** — `AuditEvent` rows carry actor/role/ip/userAgent/**requestId**/entity/before/after via `AsyncLocalStorage` (`withAuditContext`), never throws | `lib/audit.ts:24–80` |
| Structured logging | **WEAK** — plain `console.error/warn` with scope tags (route-kit `scope`, `[api/whatsapp POST]`); no JSON logs, **no correlation IDs on log lines** (requestId lives only in audit rows), no request access log | `route-kit.ts:88–103`, `whatsapp/route.ts:325` |
| Metrics | **NONE** — no Prometheus exporter (honestly stated in the health route header) | `api/health/route.ts:16–19` |
| Tracing | **NONE** — no OpenTelemetry (grep-verified; the only "otel" hits are `QuoteLine`) |
| Error tracking | **NONE** — no Sentry/equivalent; failures surface via `JobRecord.lastError`, `Notification.deliveryDetail`, journal/logs only |
| Dead letters | OK-for-scale — failed JobRecord rows *are* the DLQ (queryable, keep `lastError`) | `jobs/service.ts:12–15` |

**Verdict:** the health probe and the audit ledger are above-average for a project this size, but the ops surface is thin: an operator debugging production has console text-logs and SQLite rows, no aggregation, no alerting, no metrics. The code *documents* these gaps honestly everywhere it matters. For a single-node self-host this is survivable; for "customer onboarding at scale" it is a real gap (see §8).

---

## 6. Docs accuracy

| Doc | Verdict | Drift items |
|---|---|---|
| README.md | **Accurate + honest** | (a) Badge "1,500+ tests" is conservative-true (1,716 static + `.each` expansions); body text "1,700 tests / 69 files" vs **actual 71 files** — stale count (DOC-1). (b) "27 OpenAPI-documented paths" — **verified exact** (27 `route.ts` under `api/v1`). (c) Quickstart would work on a fresh clone **except** a possible `db/` mkdir gap (see INF-9, unverified). (d) Billing-lock disclosure is exemplary (L488–494). |
| ARCHITECTURE.md | Accurate | Module tree omits the **`documents`** module (`modules/documents/service.ts` exists and is load-bearing for the storage read seam) — DOC-3/INF-8. Otherwise every listed module, seam and honesty rule matches code. |
| DEPLOYMENT.md | **Comprehensive** (833 lines: env table, migrations-vs-push, seed chain, Docker, systemd, storage, multi-instance) | Backup procedure exists (§7.2, sqlite `.backup`) but **no restore runbook** and no automated backup artifact — DOC-4/INF-7. |
| SECURITY.md | Substantive | Real policy: supported versions, advisory path, 72h ack, scope incl./excl., demo-creds-not-a-leak note, verifiable hardening list. No drift found. |
| CONTRIBUTING.md | Accurate | Branch/commit/PR rules, gates, wave/worktree method; billing-lock caveat repeated. Test-count text (1,700/69) shares DOC-1 staleness. |
| docs/RELEASE-NOTES.md | Accurate | v0.1 → **v0.2.5** matches `package.json` version `0.2.5` exactly. |
| ADRs 0001–0003 | Proper | All carry explicit Status (Accepted; 0002 "design phase — no runtime cutover"). ADR-0002 internal count drift: context says "61 models across 10 domain slices" while its own related-links and README say 68 — DOC-2. |
| PRODUCT-BLUEPRINT.md | Properly labeled | Header block: "design targets, not shipped surface… README wins" — exactly the right posture. |
| GITHUB-HANDOFF.md | Properly superseded | Banner marks it a historical snapshot with pointers to live truth. |
| QA-REPORT-2026-09-10.md | Consistent with repo | Claims 1,811 tests/71 files (plausible per §2 count), READY WITH APPROVED RISKS verdict, issue #98 disclosed. |

**Docs verdict: unusually truthful documentation set.** Drift is limited to stale test/file counts and one missing module in the architecture tree.

---

## 7. Repository hygiene — CLEAN

- `.gitignore`: sane and actively maintained (db/, `.env*` w/ `!/.env.example`, `.z-ai-config`, worklog/agent artifacts, `/public/photos/upp-*` uploads, `mjengoos-website/data/submissions.json`, with a comment documenting a past footgun fix — `.gitignore:60–105`).
- **No `.env` committed** — `git ls-files` shows only the three `.env.example` templates (root, website, systemd). No secrets in tree; QA report asserts none in history.
- LICENSE: MIT present (`LICENSE:1–3`).
- No build artifacts tracked (no `.next/`, `node_modules/`).
- Large files: worst offender 728KB demo WAV; repo total 28MB — fine. ImgBot already contributes image optimization.
- `docs/screenshots/` (17 PNGs, ~4MB) tracked intentionally as README evidence.

---

## 8. Production-launch gaps (what a real launch still needs)

1. **CI has never executed** (billing lock, issue #98) — restore billing or mirror gates to a free runner; until then every merge's green light is a local claim (INF-4).
2. **No staging environment** — only local dev and the single prod node; no place to rehearse migrations/deploys.
3. **No automated backups** — manual `sqlite3 .backup` procedure only; no cron/systemd unit/script, no restore runbook, no backup verification (INF-7/DOC-4) — **landed via #199** (deploy/backup/ + §7.2 restore runbook; one full-stack drill on real hardware still owed by the operator).
4. **No uptime monitoring/alerting** — `/api/health` exists and is compose-probed, but nothing external watches it or pages anyone.
5. **No error tracking or alerting** — no Sentry-class sink; failed jobs/notifications only visible if someone looks.
6. **No log aggregation / structured logs** — console text only; no correlation IDs on log lines (OBS-2).
7. **No metrics/tracing** — no Prometheus/OTel (OBS-3); fine for one node, blocking for SLAs.
8. **Single-node SQLite** — ADR-0002 (Supabase/Postgres) is design-only, not cut over; single-instance rate limiting documented.
9. **No reverse-proxy/TLS config shipped** — nginx lessons documented in DEPLOYMENT §7.1, but no committed config (Caddyfile is gitignored).
10. **Scheduler needs manual enablement** — `JOBS_RUN_TOKEN` + sidecar/systemd install are opt-in steps; nothing verifies the queue is actually draining in prod.
11. **No image publishing pipeline** — images are built-on-host only; no registry, no image scanning/trivy, no digest pinning (INF-3).

---

## 9. Findings register

| ID | Severity | Finding | Proposed issue title |
|---|---|---|---|
| INF-1 | Medium | systemd `mjengo-jobs.service` runs as root (no `User=`/`DynamicUser=`); principle-of-least-privilege gap on a unit that only curls localhost | "systemd jobs unit: drop root (DynamicUser=yes or dedicated user)" |
| INF-2 | Low | No `HEALTHCHECK` in either Dockerfile; only compose defines probes — plain `docker run`/k8s get none | "Add HEALTHCHECK to app + website Dockerfiles (compose-only today)" |
| INF-3 | Low | Base images tag-pinned (`node:20-slim`, `oven/bun:1`) not digest-pinned; supply-chain drift possible | "Pin Docker base images by digest for reproducible builds" |
| INF-4 | Medium | CI has never run (billing lock #98): all gates locally-verified; docker.yml builds but never runs/smoke-tests an image; no registry/artifact publishing | "Restore CI execution (billing) + add container smoke test to docker.yml" |
| INF-5 | Low | `api/jobs/run/route.ts` re-declares the POST handler verbatim from `api/jobs.ts` (documented debt; dual-copy edit hazard) | "Deduplicate the jobs/run POST handler (export raw handler from api/jobs.ts)" |
| INF-6 | Info | compose `jobs-tick` has no healthcheck — documented-by-design (loop logs are liveness); acceptable, recorded for completeness | — (no issue; document only) |
| INF-7 | Medium | No automated backup/restore: DEPLOYMENT §7.2 is a manual procedure; nothing schedules, verifies, or rehearses restores — **landed 2026-09-18 via #199** (deploy/backup/ script + systemd timer, drilled; DEPLOYMENT §7.2.1 install + §7.2.2 restore runbook) | "Ship automated SQLite backup (systemd timer/cron) + restore runbook" — done (#199) |
| INF-8 | Low | ARCHITECTURE.md module map omits `modules/documents` (load-bearing for the storage read/re-sign seam) | "ARCHITECTURE.md: add the documents module to the module tree" |
| INF-9 | Low | Fresh-clone quickstart risk: `DATABASE_URL=file:../db/custom.db` but `db/` is gitignored and absent in a fresh clone; Prisma does not create parent directories → `migrate deploy` may error "unable to open database file". **Unverified in this sandbox (no installs allowed)** — verify and add `mkdir -p db` if real | "Quickstart: ensure db/ exists before prisma migrate deploy (fresh-clone check)" |
| OBS-1 | Medium | No error tracking (Sentry-class); prod failures visible only in console/journal/JobRecord rows | "Add error tracking sink (opt-in env) for API + job failures" |
| OBS-2 | Medium | Unstructured console logs; no correlation IDs on log lines (requestId only in audit rows); no request access log | "Structured JSON logging + request-ID log correlation" |
| OBS-3 | Low | No metrics endpoint / tracing (honestly documented); needed before any SLA claim | "Optional /metrics endpoint (Prometheus text format)" |
| OBS-4 | Good | `/api/health` does a real DB roundtrip + queue counts + 503-on-down — better than a bare 200; no action | — |
| OBS-5 | Info | Health endpoint exposes coarse counts (projects/workers/notifications) unauthenticated — deliberate, documented, low risk; recorded for the record | — |
| DOC-1 | Low | README/CONTRIBUTING test-count text stale: "1,700 tests / 69 files" vs actual 71 files (badge "1,500+" still conservative-true) | "Refresh test/file counts in README + CONTRIBUTING (71 files)" |
| DOC-2 | Low | ADR-0002 says "61 models" in context while its related-links + README say 68 — internal drift | "ADR-0002: reconcile the 61-vs-68 model count" |
| DOC-3 | Low | (= INF-8) ARCHITECTURE module map gap | (same issue as INF-8) |
| DOC-4 | Low | DEPLOYMENT.md has backup but no restore procedure — **landed via #199** (§7.2.2) | (fold into INF-7 issue) |
| ENV-1 | Low | `AUTH_SECRET` fallback read in code but undocumented — split-brain risk if operator sets only it | "Document (or remove) the AUTH_SECRET fallback in guard.ts" |

**Positives worth preserving (no action):** fail-closed env gating on every integration; demo data never auto-seeds in containers; compose refuses to start without `NEXTAUTH_SECRET`; `.env.example` placeholder deliberately fails the boot guard; honest in-band simulation labels; verifiable claims (27 v1 paths exact; package.json 0.2.5 == release notes).

---

## Worklog entry (Task 2-g)

- Audited Dockerfile (root + website), docker-compose, deploy/systemd pair: multi-stage/standalone/non-root/migrate-on-boot all verified in code; compose fail-closes on missing `NEXTAUTH_SECRET` and does **not** seed on boot (CMD = migrate+serve only; DEPLOYMENT §6.4 documents manual seeding).
- Verified systemd timer/service correctness (5-min grid, Persistent, curl -f fail-closed, 0600 env file) and what a drain actually runs (8 job types, ≤10/call, backoff 2→8→30min, 30s handler cap) — flagged root-execution of the unit (INF-1).
- CI: 3 workflows (lint+tsc both apps, vitest, dual docker build) with correct triggers/concurrency; billing-lock claim (#98) is consistently disclosed but unverifiable from the sandbox; noted build-only docker job (no smoke test) and never-green CI (INF-4).
- Built the 9-row integration matrix (Daraja/AT/webhook SMS/WhatsApp/web-push/AI/S3/USSD/email) with env gates and unset behaviors: every seam fails closed or degrades to honestly-labeled `logged`/simulated; email is the one absent channel; WhatsApp+USSD are inbound-only sims.
- Env audit: all 42 documented vars map to code reads; only `AUTH_SECRET` fallback is undocumented (ENV-1); classified 14+ secret-class vars; website env complete.
- Observability: health endpoint does a real DB check + queue counts (GOOD); audit ledger has requestId/ip via AsyncLocalStorage (GOOD); but no structured logs/correlation on log lines, no metrics, no tracing, no error tracking (OBS-1/2/3).
- Docs accuracy: README/ARCHITECTURE/DEPLOYMENT/SECURITY/CONTRIBUTING/RELEASE-NOTES/ADRs/blueprint all substance-checked — verdict "unusually truthful"; drift limited to stale test counts (DOC-1), ADR-0002 61-vs-68 models (DOC-2), missing documents module in the tree (DOC-3), no restore runbook (DOC-4).
- Hygiene: no `.env` tracked (only templates), LICENSE MIT, no build artifacts, worst file 728KB, 28MB repo — clean.
- Production-gap shortlist: CI execution, staging env, automated backups+restore, uptime/error alerting, structured logs, Supabase cutover (design-only), shipped proxy/TLS config, scheduler enablement verification, image publishing pipeline.
- Wrote this baseline to `docs/audit/INTEGRATION_BASELINE.md` (19 findings: INF-1…9, OBS-1…5, DOC-1…4, ENV-1, with severities and proposed issue titles). No other files touched; worklog.md not modified.
