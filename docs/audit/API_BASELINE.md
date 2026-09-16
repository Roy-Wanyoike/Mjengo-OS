# API Baseline Audit — Mjengo-OS (Phase 0.6, Task 2-a)

- **Date**: 2026-09-16 · **Auditor**: 2-a (Backend/API Baseline Lead) · **Repo**: `/home/z/mjengo-os` @ `8b0003a` (main)
- **Method**: full read of every `src/app/api/**/route.ts` (60 files), every `src/backend/api/**` handler, shared route infrastructure (`route-kit.ts`, `guard.ts`, `rate-limit.ts`), all `src/backend/modules/*`, the OpenAPI document source, and a frontend `fetch` cross-reference. **Read-only audit — no code was modified, no tests/builds were run.**
- **Prior QA report** (`docs/QA-REPORT-2026-09-10.md`) was treated as a claim set to verify, not a source of truth.

---

## 1. Summary

| Family | Route paths | Method-endpoints | Notes |
|---|---|---|---|
| Legacy app (`/api/*` non-v1, non-AI, non-webhook) | 22 | 31 | actions, audit, auth, flags, health (×2), jobs/run, notifications, project(s), push (×2), reports/budget-variance, search, share, supplier, sync, upload (×4), openapi.json, api-root |
| AI (`/api/ai/*`) | 7 | 9 | voice-log, parse-text, analyze-photo, authenticity-screen (GET+POST), recap, anomaly-scan, extract-document (POST+PUT) |
| v1 (`/api/v1/**`) | 27 | 28 | 22 GET-only reads; `wallets` GET+POST; payments/deposit/transfer/withdraw POST |
| Webhooks (`/api/webhooks/daraja*`) | 2 | 3 | docs route (GET+POST-refuse) + `[secret]` callback |
| USSD (`/api/ussd`) | 1 | 2 | GET contract + POST aggregator |
| WhatsApp (`/api/whatsapp`) | 1 | 2 | GET contract + POST relay |
| **Total** | **60** | **75** | All 60 route files are thin shims or inline handlers over `src/backend/api/**` |

- **OpenAPI** (`src/app/api/openapi.json/route.ts`): **29 documented paths** (27 `/api/v1/**` + `/api/audit` + `/api/reports/budget-variance`). **All 29 exist with exactly the documented methods — zero documented-but-missing, zero v1 implemented-but-undocumented.** The remaining 31 paths are intentionally undocumented (the doc's description scopes it to "exactly the 27 /api/v1 route paths … plus the two wave-3 app-level GETs", route.ts:1499-1505). ARCHITECTURE.md:18-20 states the same count (29) — consistent.
- **Shared infrastructure**: every standard JSON route runs through `route()`/`publicRoute()` in `src/backend/lib/route-kit.ts` (origin gate → session guard → per-principal token-bucket rate limit → raw-body cap → zod/manual validation → redacting error path). Deliberate exceptions, each documented at route-kit.ts:30-34: next-auth (own CSRF), `/api/health` + `/api` (public probes), `/api/ussd` (text contract), the 7 `/api/ai/*` routes (shared `enforceAiRoutePolicy` in rate-limit.ts:617-716).
- **Auth model**: next-auth v4 credentials session (JWT cookie, decoded per request in `guard.ts:10-40` with the #94 dev-fallback handling); role allowlists via `withGuard`/`roles` option; tenant pins for `client` (own projectId) and `supplier` (own supplierId) enforced per route. Special auths: share token (bearer capability, `/api/share`, `/api/project?share=`, `/api/actions` shareToken path), `JOBS_RUN_TOKEN` bearer (jobs/run), `DARAJA_WEBHOOK_SECRET` path segment (timing-safe), `USSD_WEBHOOK_SECRET`/`WHATSAPP_WEBHOOK_SECRET` optional HMAC signatures.
- **Overall verdict**: the API surface is **real, coherent and unusually well-documented**, with honest "simulated" labels on external-provider seams (M-Pesa rails, USSD/WhatsApp gateways, AI provider). No silently-fake endpoints were found. Issues found are listed in §5 — mostly P2/P3 hardening/efficiency items, plus deliberately-open demo-posture surfaces.

---

## 2. Full endpoint inventory

Legend — Auth: `session` (any signed-in role unless noted), `session+roles[…]`, `public`, `token` (share token), `bearer` (JOBS_RUN_TOKEN), `secret-path`/`HMAC` (webhook). RL = rate limit (per principal / phone / IP). Body cap = raw-body cap before parse. Validation: `zod` (strictObject), `manual` (inline checks), `policy-gate` (enforceAiRoutePolicy field/type allowlist). DB = touches Prisma. Idem = Idempotency-Key handling.

### 2.1 Legacy app family

| Path | Method(s) | Handler (src/backend/api/* unless noted) | Auth | RL | Body cap | Validation | DB | Idem | Audit log |
|---|---|---|---|---|---|---|---|---|---|
| `/api` | GET | inline (`src/app/api/route.ts:8`) | public | — | — | — | read ($queryRaw) | — | — |
| `/api/health` | GET | inline (`src/app/api/health/route.ts:21`) | public | — | — | — | read (groupBy/counts) | — | — |
| `/api/openapi.json` | GET | inline (route.ts:2724) | public (by design) | — | — | — | no | — | — |
| `/api/actions` | POST | `actions.ts:59` | session OR share token (CLIENT_ACTIONS only); client/supplier pins; action-family flag gate | 60/min | 1 MB | manual (`type` required; payload typed by appliers) | read+write | yes (`Idempotency-Key`/`x-idempotency-key`, replay + 409-pin BE-6) | yes (withAuditContext → logAudit, 1 row/action) |
| `/api/audit` | GET | `audit.ts:83` | session+roles[admin] | 60/min | — | manual (query params, keyset cursor) | read only (immutable by design) | — | reads AuditEvent |
| `/api/auth/[...nextauth]` | GET, POST | `src/backend/lib/auth.ts` via inline wrapper (route.ts:25) | public (credentials flow; login lockout 5/15min in lib/auth.ts) | next-auth internal | — | next-auth | read+write (User, session JWT) | — | login attempts logged |
| `/api/flags` | GET, POST | `flags.ts:17,28` | GET: admin+contractor; POST: admin | POST 10/min | — | manual (key/enabled) | read+write (FeatureFlag) | — | no (flag toggles not audited) |
| `/api/jobs/run` | GET, POST | `jobs.ts:65,29` + bearer variant inline (`src/app/api/jobs/run/route.ts:96`) | GET: session (supplier 403); POST: contractor/admin OR `JOBS_RUN_TOKEN` bearer (constant-time) | 10/min | — (tolerate-invalid) | manual (type/projectId; project existence 400) | read+write (JobRecord) | — (jobs dedupe via status) | via handlers |
| `/api/notifications` | GET, POST, PUT | `notifications.ts:108,168,283` | session; client pinned; supplier row-pinned to served projects (BE-3/BE-12) | GET 60/min, POST/PUT 30/min | PUT: reject-mode | manual (ids≤200; prefs≤20 kinds) | read+write | — | no |
| `/api/project` | GET | `project.ts:129` | session OR `?share=` token; supplier 403; share bound to one project (BE-1) | 60/min | — | manual (share/projectId) | read (full payload + timeline) | — | — |
| `/api/projects` | GET, POST | `projects.ts:35,71` | GET: session (client→own, supplier→[]); POST: contractor/admin | GET 60/min, POST 10/min | — | manual (name≤200, budget>0, dates) | read+write (Project+Phases) | — | no create audit (shareToken returned) |
| `/api/push/subscribe` | GET, POST | `push.ts:63,82` | session (any role) | GET 30/min, POST 10/min | 1 MB | zod (PushSubscription strict) | read (VAPID) / write (PushSubscription upsert) | — | no |
| `/api/push/unsubscribe` | POST | `push.ts:115` (exported as POST) | session | 10/min | 1 MB | zod | write (deleteMany, session-scoped) | — | no |
| `/api/reports/budget-variance` | GET | `budget-variance.ts:35` | session+roles[contractor,admin,supervisor,qs] | 30/min | — | manual (projectId required) | read | — | — |
| `/api/search` | GET | inline (`src/app/api/search/route.ts:209`) | session; supplier 403 (BE-3); client pinned | 60/min (BE-11) | — | manual (q≤100, LIKE-wildcards stripped) | read (10 tables × ≤300 rows) | — | — |
| `/api/share` | GET, POST | `share.ts:83,179` | public (token IS auth) | 30/min | 64 KB (POST) | zod (strictObject token/type/payload) | read+write (POST → applyAction) | — | applyAction path logs |
| `/api/supplier` | GET | `supplier.ts:175` | session+role[supplier] only; supplierId pinned | 60/min | — | — | read (supplier-scoped) | — | — |
| `/api/sync` | POST | `sync.ts:520` | session; supplier 403; client pinned | 30/min | 2 MB | manual (actions[] required); per-item flag gate + version checks | read+write | yes (sync:project:itemId + payload fingerprints) | via applyAction |
| `/api/upload` | POST | `upload.ts:87` | session+roles[contractor,admin,client]; doc mode further OWNER_ROLES | per-mode 10/min | 12 MB | manual (dataUrl/doc fields, magic-number sniff) | write (photo bytes via storage driver; Attachment) | — | Attachment provenance |
| `/api/upload/confirm` | POST | `upload-confirm.ts:55` | session+roles[contractor,admin,client] | 10/min | 64 KB | zod (key regex, category) | write (Attachment) — **non-idempotent by design** | — | — |
| `/api/upload/presign` | POST | `upload-presign.ts:53` | session+roles[contractor,admin,client] | 10/min | 64 KB | zod | none when local-disk (409) | — | — |
| `/api/upload/re-sign` | POST | inline (`src/app/api/upload/re-sign/route.ts:71`) | session+roles[contractor,admin,client]; client entitlement pin | 10/min | 8 KB | zod (ids 1..50) | read | — | — |

### 2.2 AI family (all via `enforceAiRoutePolicy`: session → roles[contractor,admin,supervisor] → 10/min → body cap → field allowlist → projectId existence)

| Path | Method(s) | Implementation | Extra gates | Body cap | DB | Notes |
|---|---|---|---|---|---|---|
| `/api/ai/voice-log` | POST | `src/backend/lib/ai.ts` (transcribeAudio→parseDeliveryTranscript) + PII scrub | flag `ai_voice` | 13 MB (12 MB audio domain cap) | read (digest) | ASR 20s cap; phone numbers scrubbed |
| `/api/ai/parse-text` | POST | same parser, typed notes | none (deliberate) | 128 KB | read | scrub re-applied on parse seam |
| `/api/ai/analyze-photo` | POST | `lib/ai.ts` visionMessage + optional `photo.apply` action | flag `ai_progress` | 6 MB | read+write (apply) | local file read for `url` (path sanitized) |
| `/api/ai/authenticity-screen` | GET, POST | `modules/ai/authenticity.ts` | flag `ai` | 128 KB | read+write (insights) | outcome states are 200s, not 500s |
| `/api/ai/recap` | POST | `modules/jobs/handlers.ts` runDailyRecap | allowEmptyBody | 128 KB | write (Recap + event) | shared with `recap.daily` job |
| `/api/ai/anomaly-scan` | POST | `modules/jobs/handlers.ts` runAnomalyScan | allowEmptyBody | 128 KB | write (Alerts + event) | shared with `anomaly_scan` job |
| `/api/ai/extract-document` | POST, PUT | `modules/documents/service.ts` | none | 128 KB (hint ≤100 KB) | write (Attachment extraction / review) | `simulated:false` label; PUT = human review gate, logs AuditEvent |

### 2.3 v1 family (all: route-kit, zod `schemas.ts`, `mapServiceError`, keyset pagination via `pageOfKind`, V1_READ_LIMIT 120/min or V1_MUTATION_LIMIT 30/min)

| Path | Method(s) | Handler (`src/backend/api/v1/*`) | Role scoping | Flag gate | Pagination |
|---|---|---|---|---|---|
| `/api/v1/projects` | GET | `projects.ts` | client→own project, supplier→[] | none | limit+cursor |
| `/api/v1/projects/{id}` | GET | `project-detail.ts` | client pin 403; supplier uniform 403 | none | n/a |
| `/api/v1/projects/{id}/tasks` | GET | `project-tasks.ts` | same | none | yes |
| `/api/v1/projects/{id}/deliveries` | GET | `project-deliveries.ts` | client pin; supplier row-pin | `marketplace` | yes |
| `/api/v1/projects/{id}/milestones` | GET | `project-milestones.ts` | same | none (documented boundary) | yes |
| `/api/v1/projects/{id}/invoices` | GET | `project-invoices.ts` | client pin; supplier row-pin | none (own module) | yes |
| `/api/v1/projects/{id}/escrow` | GET | `project-escrow.ts` | same | none | n/a (derived ledger balance) |
| `/api/v1/projects/{id}/workers` | GET | `project-workers.ts` | same | none | yes |
| `/api/v1/projects/{id}/attendance` | GET | `project-attendance.ts` | same | none | yes |
| `/api/v1/projects/{id}/suppliers` | GET | `project-suppliers.ts` | client pin; supplier row-pin | `marketplace` | yes |
| `/api/v1/projects/{id}/parcels` | GET | `project-parcels.ts` | client pin; supplier 403 | `land_verification` | yes |
| `/api/v1/projects/{id}/intel` | GET | `project-intel.ts` | same | none | n/a (digest) |
| `/api/v1/projects/{id}/budget-variance` | GET | `project-budget-variance.ts` | same | none | n/a (report) |
| `/api/v1/tasks/{id}` | GET | `task-detail.ts` | project-resolved pin | none | n/a |
| `/api/v1/milestones/{id}` | GET | `milestone-detail.ts` | same | none | n/a |
| `/api/v1/workers/{id}` | GET | `worker-detail.ts` | same | none | n/a |
| `/api/v1/invoices/{id}` | GET | `invoice-detail.ts` | supplier row-pin (404-indistinguishable) | none | n/a |
| `/api/v1/supply/orders` | GET | `supply-orders.ts` | client pin; supplier row-pin | `marketplace` | yes |
| `/api/v1/supply/orders/{id}` | GET | `supply-order-detail.ts` | supplier row-pin | `marketplace` | n/a |
| `/api/v1/wallets` | GET, POST | `wallets.ts` | FINANCE_ROLES (finance/admin) | `wallet` | yes (+`?providers=1` introspection) |
| `/api/v1/wallets/{id}` | GET | `wallet-detail.ts` | FINANCE_ROLES | `wallet` | n/a |
| `/api/v1/wallets/{id}/balance` | GET | `wallet-balance.ts` | FINANCE_ROLES | `wallet` | n/a (ledger-derived) |
| `/api/v1/wallets/{id}/transactions` | GET | `wallet-transactions.ts` | FINANCE_ROLES | `wallet` | yes |
| `/api/v1/wallets/{id}/deposit` | POST | `wallet-deposit.ts` | FINANCE_ROLES | `wallet` | Idempotency-Key + payload fingerprint (409) |
| `/api/v1/wallets/{id}/transfer` | POST | `wallet-transfer.ts` | FINANCE_ROLES | `wallet` | idem + same-wallet 422 |
| `/api/v1/wallets/{id}/withdraw` | POST | `wallet-withdraw.ts` | FINANCE_ROLES | `wallet` | idem |
| `/api/v1/payments` | POST | `payments.ts` | PAYMENT_ROLES (finance/admin/client); client tenant pin after resolve | `wallet` | idem |

### 2.4 Webhooks / USSD / WhatsApp

| Path | Method(s) | Implementation | Auth | RL | Body cap | DB |
|---|---|---|---|---|---|---|
| `/api/webhooks/daraja` | GET, POST | inline docs route | public | — | — | no (POST refuses 400, never money) |
| `/api/webhooks/daraja/[secret]` | POST | `modules/wallet/daraja-callback.ts` | unguessable path (sha256 secret, timing-safe) + optional IP allowlist + Origin gate | — | 64 KB | read+write (idempotent ledger posting; query-API reconciliation before credit) |
| `/api/ussd` | GET, POST | inline (`src/app/api/ussd/route.ts`) | optional `X-Signature` HMAC (`USSD_WEBHOOK_SECRET`); PIN = worker identity | 20/min/phone + 40/min/IP on PIN attempts + 5-strikes/15-min line lockout | 64 KB | read+write (applyAction attendance) |
| `/api/whatsapp` | GET, POST | inline (`src/app/api/whatsapp/route.ts`) | optional `X-Signature` HMAC (`WHATSAPP_WEBHOOK_SECRET`); phone = identity | 20/min/phone + 40/min/IP | 64 KB | read+write (attendance/comment allowlist only) |

---

## 3. OpenAPI contract cross-check

- Documented paths: **29** (`src/app/api/openapi.json/route.ts` lines 1655-2667). Implemented v1 routes: **27** — 1:1 match on path and method (`GET` everywhere except `payments`, `wallets`(POST), `wallets/{id}/{deposit,transfer,withdraw}`(POST)). `/api/audit` and `/api/reports/budget-variance` documented and implemented with matching GET semantics.
- **Documented-but-missing: 0. Implemented-v1-but-undocumented: 0.**
- Undocumented-by-design (31 paths): the whole legacy/AI/upload/push/webhook surface. The doc's `info.description` says this explicitly ("It covers exactly the 27 /api/v1 route paths … and the two wave-3 app-level GETs"). Self-documenting substitutes exist for several (`GET /api/ussd`, `GET /api/whatsapp`, `GET /api/webhooks/daraja` return machine-readable contracts; `src/backend/README.md:72-73` lists the module map).
- Document honesty: simulated rails, KES-only money, cookie-only auth, idempotency 409 semantics, and single-instance rate buckets are all stated in `info.description` (route.ts:1483-1497).

## 4. Module completeness (src/backend/modules/*)

| Module | Files/LOC | Assessment | Evidence |
|---|---|---|---|
| `events` | 2 files / 278 | **WORKING** (real, minimal by design) | `service.ts:1-14` — durable DomainEvent rows, in-process synchronous bus, no broker/retries (documented), NOTIFY_POLICY map drives in-app rows |
| `reports` | 1 / 328 | **WORKING** | `service.ts` header — reuses mjengo.ts derivations; 3-tier phase attribution with explicit `phaseAttribution` mode |
| `inventory` | 3 / 394 | **WORKING** | atomic upsert + StockMovement append, closing-qty result contract (`service.ts:1-21`) |
| `intel` | 8 / 2,036 | **WORKING** | MjengoScore (null-not-fake), risk/health/flags/digest; flag enforcement map `flags.ts:23-110`; 30s cache documented |
| `ai` | 5 / 2,878 | **WORKING (provider-gated)** | `provider.ts:1-56` — ZAI SDK singleton, 20s cap, leak-free errors, config-file (no env) honesty; authenticity/draw-review/trust-digest are real logic over the seam |
| `notify` | 5 / 1,051 | **WORKING** | 3 real channel providers (webhook SMS, Africa's Talking REST, web push); unconfigured → rows stay `logged` (fail-closed, `channels.ts:12-15`) |
| `ledger` | 1 / 228 | **WORKING** | double-entry engine, balanced legs in one `$transaction`, immutable history, reversals-only corrections (`service.ts:1-5`) |
| `invoices` | 5 / 1,166 | **WORKING** | pure 3-way match shared client/server ("one algorithm, one source of truth", `three-way.ts:1-7`); 581-line service |
| `wallet` | 10 / 2,731 | **WORKING with simulated rails (labeled)** | `providers.ts:6-14` HONESTY LABEL; Daraja sandbox real-shaped behind env; `simulated: true` on every default rail result |
| `documents` | 2 / 623 | **WORKING** | upload/extraction/review lifecycle, magic-number sniffing, PDF text-layer extraction; `simulated:false` on real model calls (`service.ts:369,383`) |
| `professionals` | 4 / 601 | **WORKING (record-keeping, honest)** | credential checks + 0-6 ladder; "honest record states", no licensing claims (`service.ts:5-7`) |
| `land` | 4 / 580 | **WORKING (record-keeping, honest)** | parcels/title-search ladder; "registry result … does not confirm anything", verification ≠ government certification (`service.ts:358,394`) |
| `supply` | 8 / 2,342 | **WORKING** | full RFQ→quote→order→delivery loop with per-line ground truth; supplier confirm step labeled "(simulated)" for demo supplier personas (`service.ts:858`) |
| `jobs` | 2 / 849 | **WORKING** | JobRecord queue, retry/timeout (30s), 8 handler cores shared with AI routes (`handlers.ts:1-27`) |
| `drawpack` | 1 / 490 | **WORKING** | immutable hash-stamped evidence packs; write-once, no update/delete; failure-never-money rules (`service.ts:1-20`) |

**Stub/TODO sweep**: `rg -i "TODO|FIXME|XXX:|HACK:|not implemented|stub|placeholder"` over `src/backend` returns **4 hits, all benign comment references** (back-compat contract naming, test-stub row types, and a "REDIS-READY SEAM … deliberately not implemented" note at rate-limit.ts:108). **No silent stubs were found**; every simulated behavior carries an explicit label (`simulated: true`, "MjengoOS sim" footers, integrationNote strings).

---

## 5. Findings

| ID | Severity | Finding | Evidence | Proposed issue title |
|---|---|---|---|---|
| API-1 | **P2** | USSD + WhatsApp webhooks accept **unauthenticated writes** (real attendance rows via applyAction) when their optional `*_WEBHOOK_SECRET` envs are unset; USSD phone-tail PIN fallback also stays active until the secret is set. Mitigations exist (prod startup warning `webhook-secret-warning.ts`, per-phone/IP buckets, PIN lockout) but the open posture is the default deployment state. | `src/app/api/ussd/route.ts:49-67,151-167`; `src/app/api/whatsapp/route.ts:54-76` | "Fail closed (or require explicit opt-in) for USSD/WhatsApp webhook write posture in production" |
| API-2 | **P2** | `/api/ai/extract-document` (POST + PUT review gate) has **no frontend consumer** and is absent from the OpenAPI doc — an orphaned, tested API surface; the document-review decision flow has no UI. | grep `extract-document` in `src/frontend` → 0 hits; openapi.json paths list; only `tests/unit/extract-document-pdf.test.ts` exercises it | "Wire or document the document-intelligence API (extract-document) consumer surface" |
| API-3 | **P2** | v1 project-scoped list routes call `getProjectPayload(id)` — a **full ~15-table aggregation** — then filter/slice one small collection in memory. `/api/v1/projects/{id}/tasks` etc. pay the whole-payload cost per page. Acknowledged in code ("heavyweight read … rate limit 120/min") but is O(payload) per page, not O(page). | `v1/project-tasks.ts:41`, `v1/project-workers.ts:55`, `v1/project-parcels.ts:64`, `v1/project-milestones.ts:52`, `v1/project-detail.ts:52` | "v1 project-subresource reads should query the subresource directly instead of the full payload" |
| API-4 | **P2** | Several core reads are **unbounded Prisma queries** paginated only in memory: `db.project.findMany` (no take) in `getProjectsList`; milestones/variations/siteZones/photoComments in `getProjectPayload`; `db.attendance.findMany` (no take) in v1 attendance route; `loadSupplySlice` loads all orders+deliveries. Safe at current scale (SQLite, bounded demo data, documented "bounded in practice") but no DB-level limit exists. | `lib/mjengo.ts:164-172,236-243`; `v1/project-attendance.ts:64`; `v1/supply-orders.ts:72` | "Add take limits / keyset pushdown to portfolio and subresource reads" |
| API-5 | **P2** | Share-link surface grants **decision authority from a bearer token**: `POST /api/actions` with `shareToken` can dispatch `milestone.decide`, `variation.decide` (money-relevant client decisions), plus comments/notification reads. Token is unguessable cuid and revocable, and BE-1 binding was verified, but there is no expiry, no rate differential beyond 30/min, and no secondary confirmation for money-ladder decisions. | `src/backend/api/actions.ts:140-147`; `share.ts:21-27` allowlist | "Consider expiry / confirmation step for share-token milestone & variation decisions" |
| API-6 | P3 | `/api/notifications` GET for **non-client, non-supplier roles defaults to the FIRST project in the DB** when no `?projectId` — a cross-project default read (owner roles are trusted portfolio-wide, so not a tenant breach, but surprising). | `notifications.ts:227-233` ("portfolio default (first project)") | "Drop the first-project default on /api/notifications GET" |
| API-7 | P3 | Rate limiting and login/PIN lockout are **in-process by default** (`MemoryRateLimitStore`); multi-instance deployments silently get `limit × instances`. Opt-in SQLite store exists (`RATE_LIMIT_STORE=sqlite`, issue #33) and the limitation is documented everywhere. | `rate-limit.ts:16-27,301-317` | "Default rate-limit store should warn loudly under multi-instance deployment signals (e.g. docker-compose replicas)" |
| API-8 | P3 | `/api/upload/confirm` is **non-idempotent by design** — confirming the same key twice creates two Attachment rows pointing at one object; the dedupe seam "would need a schema index (out of scope)". | `upload-confirm.ts:24-28` | "Add a unique index on Attachment upload key (or dedupe) for confirm flow" |
| API-9 | P3 | `POST /api/jobs/run` bearer path **duplicates the session POST handler body verbatim** (a documented wave-ownership workaround) — a drift risk flagged in the code itself. | `src/app/api/jobs/run/route.ts:23-27,54-81` vs `src/backend/api/jobs.ts:40-62` | "De-duplicate the jobs/run POST handler (export raw handler from jobs.ts)" |
| API-10 | P3 | `/api/actions` is a single mega-endpoint (~90 action types) with a **loose payload contract** — `payload` is `any`, validated only inside domain appliers; no zod at the route. Documented legacy tradeoff (BE-5 caps size), but per-action request schemas live nowhere machine-readable. | `actions.ts:59-82` | "Publish an action-type/payload schema map (or zod registry) for /api/actions" |
| API-11 | P3 | `POST /api/projects` create does **not write an AuditEvent** (the action registry does, but this direct route bypasses `applyAction`), unlike every other mutation surface; project creation is only visible via the payload. | `projects.ts:71-146` (no withAuditContext/logAudit) | "Audit-log project creation on POST /api/projects" |
| API-12 | P3 | `/api/search` is an in-memory LIKE scan of ≤300 recent rows per table — rows older than the window are "honestly missed"; fine now, but search quality/scale ceiling is structural. | `src/app/api/search/route.ts:49-56` | "Move global search to indexed SQL LIKE / FTS when data grows" |
| API-13 | P3 | `GET /api/health` publicly exposes coarse DB counts (projects/workers/notifications) and package version. Documented ("coarse counts"), low risk, worth noting for customer-facing deployments. | `src/app/api/health/route.ts:7-20` | "Consider gating detailed /api/health fields behind an internal header" |
| API-14 | P3 | OpenAPI covers only v1 + 2 app GETs; the AI, upload, push, sync and actions surfaces — the ones the webapp itself uses — have no machine-readable contract (only prose GET-contracts on the gateway routes). | openapi.json:1499-1505 | "Extend OpenAPI (or a second doc) to the legacy app surface" |

**No P0 findings.** The P0-class historical issues (BE-1 share binding, BE-2 finance gates, BE-3 supplier scopes, BE-4/5 caps) were independently re-verified as present and correct in code (see §7).

---

## 6. Frontend consumer cross-reference

Frontend calls found (`rg "['\"\`]/api/" src/frontend`), all resolving to implemented routes with matching methods:

- Consumed & matched: `/api/actions` (money-tab, fundis-tab, supplier-portal, trust-digest-section, use-mjengo), `/api/audit`, `/api/ai/{authenticity-screen,analyze-photo,voice-log,parse-text,anomaly-scan,recap}`, `/api/notifications`, `/api/push/{subscribe,unsubscribe}`, `/api/share` (+`drawPack`/`trustDigest` branches), `/api/jobs/run`, `/api/search`, `/api/flags`, `/api/supplier`, `/api/whatsapp`, `/api/health`, `/api/reports/budget-variance`, `/api/upload` (legacy dataUrl + document mode), `/api/projects`, `/api/project`, `/api/sync`. `/api/auth/[...nextauth]` is consumed implicitly by `next-auth/react` `signIn`/`signOut` (login-screen.tsx:56, header.tsx:108).
- **Orphaned endpoints (implemented, no `src/frontend` consumer)**:
  - `/api/v1/**` (all 27) — **by design**: "the money-tab UI does not call /api/v1" (`v1/wallets.ts:21-23`); the v1 family exists for API clients/SDK and is exercised by ~12 `tests/unit/v1-*.test.ts` files.
  - `/api/upload/presign`, `/api/upload/confirm`, `/api/upload/re-sign` — S3-driver-only deployment surface (409 on local-disk); webapp uses the server-mediated `/api/upload`. Tested in `storage-{presign,resign}-routes.test.ts`.
  - `/api/ai/extract-document` (POST+PUT) — see API-2.
  - `/api/ussd` — external aggregator contract; the in-app USSD tab is an honest simulation that dispatches through the store (`ussd-tab.tsx:3-23`), not through this route.
  - `/api` (root), `/api/openapi.json`, `/api/webhooks/daraja*` — infra/external surfaces, consumers by definition external.
- **Frontend calls with no backend**: none found — every literal `/api/...` string in `src/frontend` and `src/shared` matches an implemented route.

## 7. Verification vs the prior QA report (2026-09-10)

Claims independently **confirmed in code**:
- BE-1 share-token binding + no token echo: `project.ts:143-163,176-190` (share path pinned, cross-project probe → 404, shareToken stripped on public path). ✔
- BE-2/BE-7 finance gates + real actors: `FINANCE_ROLES`/`PAYMENT_ROLES` on all v1 money routes; `session.user.name` stamped as `by`/`paidBy`. ✔
- BE-3/BE-6 supplier scoping + client replay pin: `notifications.ts:139-151,194-226`; `search` route 403; `jobs.ts:71`; actions replay pin `actions.ts:126-128`. ✔
- BE-4/BE-5/BE-8 body caps & throttles: 64 KB–13 MB caps on every body-reading route (route-kit `maxBytes`, AI gate caps, webhook caps); `projects.list` 60/min. ✔
- BE-9 USSD PIN lockout: `ussd/route.ts:289-307` + `rate-limit.ts` createUssdPinLockout. ✔
- 71 test files: `ls tests/unit | wc -l` = **71**. ✔ (Test *pass* count 1,811 not re-runnable in this read-only audit.)
- Honesty labels on simulated rails/website claims: confirmed pervasive (`providers.ts`, `daraja.ts`, USSD/WhatsApp "MjengoOS sim" footers).

**No contradictions found.** Nuances this audit adds beyond the QA report: findings API-1…API-14 above (the QA report's "remaining risks" cover #40/#43 external gateways but not the in-repo P2/P3 items like the extract-document orphan, the v1 payload-cost pattern, or the unbounded core reads); and the QA report's "READY" verdict is accurate **relative to the documented single-operator/simulated-rails posture** — the simulated payment rails, unwired USSD/WhatsApp/AT providers, and config-file-based AI provider remain the honest-open gaps between this codebase and a money-moving production system.

---

## Worklog entry (Task 2-a)

- Audited all 60 `src/app/api/**/route.ts` files (75 method-endpoints) + every `src/backend/api/**` handler; every route is a thin shim or documented inline handler — no dead or rogue route files.
- OpenAPI (`/api/openapi.json`) documents exactly 29 paths (27 v1 + audit + budget-variance); 1:1 match with implemented v1 routes and methods — zero contract drift; legacy/AI/upload surfaces intentionally undocumented.
- Verified shared route infra (route-kit, guard, rate-limit): session guards, per-principal token buckets, raw-body caps, zod/manual validation and redacting error paths are applied consistently; deliberate exceptions are documented.
- Special surfaces audited: next-auth (boot secret guard + login lockout), jobs/run (session OR constant-time bearer token), Daraja secret-path webhook (timing-safe segment, IP allowlist, query-API reconciliation, durable idempotency), USSD/WhatsApp (HMAC-optional gateway-trust posture with PIN lockout), share token (BE-1 binding re-verified), upload family (magic-number sniffing, presign/confirm/re-sign with honest 409s).
- v1 family is complete and consistent: FINANCE/PAYMENT role gates, client/supplier tenant pins, feature-flag gates (wallet/marketplace/land_verification with documented boundaries), keyset pagination, Idempotency-Key with payload-fingerprint 409s.
- Module completeness: all 15 `src/backend/modules/*` contain real business logic; only 4 benign "stub/placeholder" comment hits repo-wide; every simulated seam (payment rails, gateways, AI provider) is explicitly labeled — nothing silently fake.
- Findings: 0×P0, 5×P2 (API-1 open webhook write posture; API-2 orphaned extract-document API; API-3 v1 full-payload-per-page cost; API-4 unbounded core reads; API-5 share-token decision authority), 9×P3 (defaults, idempotency gap on confirm, jobs/run handler duplication, actions payload registry, create-project audit gap, search ceiling, health exposure, OpenAPI scope).
- Frontend cross-reference: all frontend `/api/...` calls resolve; orphaned endpoints are external-by-design surfaces (v1, presign family, ussd, webhooks) except `/api/ai/extract-document` (true orphan — flagged).
- Prior QA report claims re-verified against code: BE-1..BE-9 fixes, supplier scopes, body caps, PIN lockout, 71 test files — all confirmed; no contradictions, only the additional P2/P3 items above and the standing simulated-rails posture.
- Deliverable: `docs/audit/API_BASELINE.md` (this file); no repo code modified.
