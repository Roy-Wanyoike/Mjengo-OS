# Mjengo-OS Security Baseline Audit (Phase 0.8)

- **Auditor:** Agent 2-e — Security Baseline Lead (re-audit, read-only static analysis)
- **Date:** 2026-09-16 · **Repo:** Roy-Wanyoike/Mjengo-OS, `main` @ `8b0003a`
- **Scope:** authn, authz, IDOR, share tokens, rate limiting, uploads, webhooks, USSD, secrets/config, headers/CSRF, PII/logging, dependencies
- **Method:** code reading only (no servers, no network, no secret values printed). Evidence = file:line / symbol.
- **Baseline verdict:** substantially hardened above typical for this stack; prior QA fixes (BE-1..BE-12, PRs #101/#112–#117) **verified present**. Two new P1s (CSRF-by-default posture, dev fallback-secret acceptance) and several P2s remain open.

---

## 1. Authentication model — verdict: SOUND in production, conditional bypass in non-production runtimes

**Stack:** next-auth **v4.24.15** credentials-only provider, JWT session strategy, 30-day `maxAge` (`src/backend/lib/auth.ts:135-231`). Passwords: scrypt (16-byte salt, 64-byte key, `timingSafeEqual`, timing-equalizer dummy hash for unknown emails — `auth.ts:52-73,182-195`). Login lockout: **email-primary + (email|ip) trackers, 5 failures / 15 min → 15-min lock, correct passwords rejected during the window** (`rate-limit.ts:216-219,351-400`; wired at `auth.ts:174-195`). Session user carries `role`, `projectId` (client pin), `supplierId` (supplier pin) — all server-stamped at login.

**Boot guard (#74 / BE-2):** `enforceNextAuthSecretAtBoot()` throws at module load of the auth route when `NODE_ENV=production` and `NEXTAUTH_SECRET` is missing or < 32 chars; `next build` phase exempt; dev warns once (`next-auth-guard.ts:76-105`, called `src/app/api/auth/[...nextauth]/route.ts:23`). Production cannot mint sessions on a weak/absent secret — fail closed, correct.

**Dev fallback secret (#94):** `getSessionFromReq` accepts tokens signed by next-auth v4's *internal fallback secret* when no `NEXTAUTH_SECRET`/`AUTH_SECRET` env exists **and** `NODE_ENV !== 'production'` (`guard.ts:15-28`, `nextauth-fallback-secret.ts:96-118`). The mirror derives `sha256(JSON.stringify({...url, ...authOptions}))` from the request host/proto or the hard-coded `http://localhost:3000/api/auth` default. This derivation is **fully deterministic from public repo source** → anyone can mint a JWT with `role: "admin"` and it will verify. Guard rails: empty candidate set whenever any env secret is set or runtime is production. **Risk (SEC-2):** any internet-reachable deployment that does not set `NODE_ENV=production` (staging, preview, docker `dev`, `bun run dev` exposed) runs with a publicly-derivable signing key for *all* guarded APIs. The guard's verification itself is faithful (golden-tested against v4's own `createSecret`), but the feature accepts a forgeable key material by design.

**Cookies:** names unprefixed (`next-auth.session-token`); behind `x-forwarded-proto: https` → `httpOnly; SameSite=None; Secure`, else lax (`auth.ts:92-106`). `SameSite=None` is required for the iframe preview — it also removes the browser's default CSRF shield for every custom state-changing route (see §10 / SEC-1). `x-forwarded-proto` is trusted without a `TRUST_PROXY`-style gate here (forcing `Secure` on plain http only breaks the attacker's own session — low impact).

**Other authn notes:** `warnNextAuthUrlMismatch` (one-shot host-mismatch warning) is diagnostic only. JWT `maxAge` 30 days is long for a money-moving app (no refresh/rotation, no server-side revocation — see SEC-3's neighbour: sign-out does not revoke anything but the client cookie).

## 2. Authorization model — one-liner

**Per-route `withGuard` role allowlists + two server-stamped tenant pins (client→`session.projectId`, supplier→`session.supplierId`) + decision-grade role checks resolved from the session cookie at the service seam (`requireDeciderRole` / `requireMoneyActor`), fail-closed on unknown roles; `src/shared/permissions.ts` is a UX mirror only.**

- Roles (`guard.ts:97-111`): `contractor, client, admin, finance, supervisor, procurement, qs, supplier`. `OWNER_ROLES` = contractor/admin/supervisor/procurement/qs/finance; `FINANCE_ROLES` = finance/admin; `PAYMENT_ROLES` = finance/admin/client; `AI_ROUTE_ROLES` = contractor/admin/supervisor (`rate-limit.ts:544`).
- Enforcement points: `withGuard` (401/403) via `route()`/`publicRoute()` wrappers (`route-kit.ts:284-313`); client pin `clientProjectDenied` + supplier deny/row-pin `supplierProjectDenied`/`supplierSessionId` on **all 14 v1 project-scoped reads** (grep-verified: every file in `src/backend/api/v1/` imports one of them; wallets family uses `roles: FINANCE_ROLES`, payments `PAYMENT_ROLES` + explicit client pin at `payments.ts:59-63`).
- Money gates at the applier seam (both `/api/actions` and `/api/sync` inherit): `escrow.topup` → `requireMoneyActor(MONEY_FINANCE_ROLES)` (`actions/money.ts:99-105`); `milestone.decide` / `variation.decide` → `requireDeciderRole(['client'])` (`money.ts:192-196,289-293`; `modules/wallet/session.ts:76-97` resolves identity from the cookie, never the payload).
- Supplier actions: `SUPPLIER_ACTIONS` allowlist + row pin inside `applyAction` (`modules/supply/supplier-scope.ts:42-105`) — a route-layer bypass cannot skip it.
- Route-level allowlists sampled: `projects.ts:74` create=contractor/admin; `audit.ts:86` admin; `flags.ts:31` admin; `jobs.ts:32` contractor/admin; `upload*.ts` contractor/admin/client; budget-variance (legacy + v1) contractor/admin/supervisor/qs.
- **Design decision to flag (SEC-6):** every "site team" role (incl. lowest-privilege `procurement`, `qs`) may read *any* project's full payload, worker PII (`worker-detail.ts:81-83` idNumber/emergency contacts), escrow and wallets-adjacent data. Correct for a single-contractor org; over-broad if this ever becomes multi-tenant.

## 3. IDOR sweep — verdict: PASS with two fail-open edges

All id-taking routes verified (resolve-then-pin or scoped query):

| Route family | Ownership control | Evidence |
|---|---|---|
| `/api/v1/projects/[id]/**` (workers, attendance, tasks, milestones, escrow, invoices, deliveries, suppliers, parcels, intel, budget-variance) | resolve → `clientProjectDenied` + `supplierProjectDenied` | e.g. `project-detail.ts:52-59`, `project-attendance.ts:57-61`, `project-escrow.ts:55-59` |
| `/api/v1/workers/[id]`, `/tasks/[id]`, `/milestones/[id]` | resolve row → pin to `row.projectId` | `worker-detail.ts:57-67`, `task-detail.ts:53-67`, `milestone-detail.ts:62-66` |
| `/api/v1/invoices/[id]` | client pin + supplier 404-as-miss | `invoice-detail.ts:63-76` |
| `/api/v1/supply/orders/[id]` | client pin + supplier row pin | `supply-order-detail.ts:68-76` |
| `/api/v1/wallets/[id]/**` | `roles: FINANCE_ROLES` (admin/finance only) | `wallet-detail.ts:29`, `wallet-transfer.ts:32`, deposit/withdraw/balance/transactions same |
| `/api/v1/payments` | `PAYMENT_ROLES` + client project pin before money moves | `payments.ts:55-63` |
| `/api/project?share=` | token's project only; `?projectId` mismatch → 404; **no token echo on public path** | `project.ts:150-190` (BE-1/PR #112 verified) |
| `/api/share` | token → single project; POST allowlist of 5 client actions | `share.ts:21-27,83-223` |
| `/api/actions` | session pin for client/supplier; share-token path allowlisted; idempotency replay honors client pin (BE-6) | `actions.ts:126-179` |
| `/api/sync` | client pinned per item; supplier 403 | `sync.ts:543-591` |
| `/api/supplier` | supplier-role only, `sessionSupplierId` scoping | `supplier.ts:175-193` |
| `/api/audit` | admin only | `audit.ts:83-88` |
| `/api/notifications` | client pinned; supplier = served-projects row pin (BE-12/BE-3) | `notifications.ts:124-151,189-215` |
| `/api/search` | supplier 403 before any query; client pinned | `search/route.ts:220-236` |
| `/api/jobs/run` | POST contractor/admin or bearer token; GET client pinned, supplier 403 | `jobs.ts:29-84`, `app/api/jobs/run/route.ts:96-110` |
| `/api/upload/re-sign` | per-row entitlement (project link or delivery-photo link), batch fail-closed | `upload/re-sign/route.ts:121-197` |

**Fail-open edges (SEC-7, P3):** a client-role session with `projectId: null`:
1. `GET /api/project` falls through to `getProjectPayload(null)` → **first project in DB, with its `shareToken` echoed** (`project.ts:167-172` → `mjengo.ts:220-223`); notifications GET correctly 403s the same account (`notifications.ts:190-192`).
2. `POST /api/notifications` skips the pin check when `session.user.projectId` is null (`notifications.ts:125`) → can mark any project's notifications read.

## 4. Share tokens — verdict: binding fixed, generation/expiry weak

- **Binding:** P0 fix verified — the token resolves exactly one project; `?projectId` redirection and first-project fallback are closed (`project.ts:144-172`); public paths never echo token material (`project.ts:179-190`, v1 omits it by doctrine).
- **Entropy:** initial token = **Prisma `@default(cuid())`** (`prisma/schema.prisma:12`, `projects.ts:115` — comment says so) — cuid is collision-resistant, not unguessability-hardened. Regeneration uses `randomBytes(12)` = **96-bit** (`mjengo.ts:1551`). Bearer capability for full project read **plus milestone/variation approval (money)** should be ≥128-bit CSPRNG from creation.
- **Expiry:** none — schema has no `shareTokenExpiresAt`; the 404 copy says "Invalid or expired link" but nothing expires.
- **Revocation:** `share.regenerate` rotates (old token dead) — the only revocation mechanism; no route-level role gate beyond "any non-client/supplier session" (supervisor/qs/procurement can rotate a share link).
- **Power of the token:** `POST /api/share` allowlist (`share.ts:21-27`) → `milestone.decide`, `variation.decide` dispatch with the sessionless decider fallback (`money.ts:192-196`) → releases escrow. Brute-force bound: 30/min per IP (`share.ts:86,182`).

## 5. Rate limiting — verdict: broad and well-keyed; memory-store and XFF caveats documented

- Coverage: essentially every JSON route — share 30/min, project 60, projects list/create 60/10, actions 60, sync 30, notifications 30/60, search 60, audit 60, jobs 10, uploads 10 (photo/doc/presign/confirm/re-sign), v1 reads 120 (`V1_READ_LIMIT`), v1 mutations 30, AI 10 (`respond.ts:86-89`, `rate-limit.ts:547`), USSD 20/min/phone + 40/min/IP for PIN attempts, WhatsApp 20/40.
- Keying: `principalFor` = verified session email (`user:<email>`) else XFF-derived IP else `anon` (`rate-limit.ts:85-94`) — cookie spoofing does not mint buckets.
- Store: in-process memory by default; `RATE_LIMIT_STORE=sqlite` shares one file across processes on a host (issue #33); any init failure degrades to memory with one warning (`rate-limit.ts:301-327`).
- Bypass vectors: (a) **memory store × N processes/instances = limit × N** (documented; SEC-13); (b) XFF seeding defeats IP keying unless `TRUST_PROXY=1` behind exactly one appending proxy (`rate-limit.ts:38-77` — documented, opt-in); (c) `principalFor` verifies with `NEXTAUTH_SECRET` only, while the guard also honors `AUTH_SECRET` (`rate-limit.ts:87` vs `guard.ts:15`) — an `AUTH_SECRET`-only deploy rate-limits by IP (minor inconsistency, SEC-12).

## 6. Uploads — verdict: strong; confirm-flow sniffing gap

- **Presign** (`upload-presign.ts:53-99`): roles contractor/admin/client; zod `strictObject`; contentType limited to PNG/JPEG; `sizeBytes` 1..4 MB (advisory — enforced at confirm); key server-generated `upp-<ts>-<hex>`; **5-minute** presign expiry; 10/min bucket.
- **Confirm** (`upload-confirm.ts:55-143`): key regex pins server-minted shapes only; HEAD via driver verifies existence, ≤4 MB, image content-type. **Gap (SEC-8, P3):** no magic-number sniffing in this flow (bytes never transit the app) — content-type is whatever the client's PUT carried; the route's own comments admit it. The legacy server-mediated path *does* sniff (`upload.ts:139-149,233-243`).
- **Re-sign** (`upload/re-sign/route.ts`): 15-min presigned GETs; per-row entitlement (client pin incl. delivery-photo links; owner roles any reachable row); unknown ids 404; non-entitled id fails the whole batch (no oracle). Presign PUT 5 min, GET re-sign 15 min, `publicUrl` default presign 7 days when no `S3_PUBLIC_BASE`.
- **Local-disk driver:** flat-key regex `SAFE_KEY_RE` + single allowlisted `docs/` prefix — **no path traversal** (`local-disk.ts:22-58`); refuses to be a general file writer.
- **S3 driver / factory:** fail-closed env resolution (all five keys or local disk, one-time partial warning, names only) (`storage/index.ts:86-114`); SigV4 signing in `node:crypto` (`sigv4.ts`); `keyFor` refuses traversal shapes (`s3-compat.ts:97-110`). Public-bucket assumption is explicit (`S3_PUBLIC_BASE` recommended; 7-day URLs otherwise).

## 7. Webhooks — verdict: Daraja exemplary; USSD/WhatsApp fail open by default

- **Daraja secret path** (`app/api/webhooks/daraja/[secret]/route.ts`): segment = first 32 hex of `sha256(DARAJA_WEBHOOK_SECRET)`, timing-safe compare, plain 404 on mismatch, **fail closed when the secret is unset (every segment 404s)**. Optional `DARAJA_ALLOWED_IPS` (IPv4 CIDR + IPv6 exact-literal; zero-valid-entries denies all; unresolvable IP denies; invalid entries warn+ignore) checked before body read (`ip-allowlist.ts`, route `:84-96`). Replay: in-memory Set + durable `IdempotencyRecord` + ledger idempotency key `daraja.callback:<id>`. **Money never moves on the body alone** — `stkpushquery` verification gates the ledger posting. Body cap 64 KB pre-parse. The guessable `/api/webhooks/daraja` path only documents the contract and refuses POST (`route.ts:55-63`).
- **USSD/WhatsApp:** `X-Signature` HMAC-SHA256(hex, raw body) is **optional**; unset = open demo posture. In production the only signal is a **console warning** (`warnIfWebhookSecretUnsetInProduction`, `ussd/route.ts:21`, `whatsapp/route.ts:15`) — the route still accepts unauthenticated writes (SEC-4, P2). This is inconsistent with the `NEXTAUTH_SECRET` boot guard which throws.

## 8. USSD PIN mechanics — verdict: demo posture, honest but fail-open edge

- Lockout: 5 wrong PINs / 15 min → 15-min lock, keyed **per caller-supplied `phoneNumber`** (shared tracker store, `rate-limit.ts:431-490`); correct PIN clears (consecutive semantics). Per-IP 40/min PIN throttle covers phone-number rotation (`ussd/route.ts:276-291`) — but the phone-keyed lockout budget is attacker-refreshable (SEC-9, P3).
- **Phone-tail fallback:** last-4-of-phone resolves a worker when `USSD_WEBHOOK_SECRET` is unset (`ussd/route.ts:151-167`) — a 10^4 keyspace identity for attendance writes *and wage-balance disclosure* (`:342-353`), reachable unauthenticated (see SEC-4). With the secret set, kiosk PIN only.
- Kiosk PIN lookup is **global across workers** (first match, name ASC) — cross-project PIN collisions resolve to the wrong worker (documented "honest limit").
- Session fixation: N/A — requests are stateless; `sessionId` accepted but never persisted (`ussd/route.ts:29-31,260`).

## 9. Secrets & config — verdict: clean; one documented gap

- `.env.example` is near-complete: DATABASE_URL, NEXTAUTH_SECRET (placeholder deliberately too short so unedited copies fail closed), NEXTAUTH_URL/AUTH_TRUST_HOST, NEXT_FLAGS_OFF, TRUST_PROXY, RATE_LIMIT_STORE/PATH, MUTATION_ORIGIN_ALLOWLIST, USSD/WHATSAPP secrets, WEBSITE_ORIGIN, JOBS_RUN_TOKEN + handler timeout, NOTIFY_SMS_WEBHOOK_*, AT_*, VAPID_*, full Daraja suite (incl. ALLOWED_IPS, reconcile timings), full S3 suite.
- **Env-var gaps: 1** — `AUTH_SECRET` is read as an alias (`guard.ts:15`) but undocumented in `.env.example` (only v4-internal). (`VERCEL` is read in `nextauth-fallback-secret.ts:57` but is a platform var; `NEXT_PHASE`/`NODE_ENV` are framework-internal.)
- Hardcoded secrets: none found. `JOBS_RUN_TOKEN` has **no default** — unset = bearer path disabled, fail closed (`jobs-token.ts:12-14`); constant-time compare with length pre-check (`:43-48`); presented-but-invalid token 401s without session fallback (`jobs/run/route.ts:96-110`). `autoReference` uses `Math.random` for a non-security display ref (`money.ts:59-65` — acceptable).
- Prisma query logging is dev-only; production keeps `error`/`warn` (`db.ts:11-15`, issue #77 fix verified).

## 10. Headers / CORS / middleware / CSRF — verdict: the weakest area

- **No `middleware.ts` exists** (glob-verified) — no edge-level gate, no route-level security headers.
- `next.config.ts:45-55`: `X-Content-Type-Options: nosniff` + `Referrer-Policy` on all responses. **No CSP, no HSTS, no Permissions-Policy, no X-Frame-Options/frame-ancestors** (iframe embeddability is a deliberate product decision — clickjacking surface noted in SEC-11).
- CORS: no `Access-Control-Allow-*` anywhere — preflighted `application/json` cross-origin fetches fail (good).
- **CSRF (SEC-1, P1):** next-auth's CSRF covers only the auth routes. Every custom mutating route (`/api/actions`, `/api/sync`, `/api/v1/wallets/:id/transfer|deposit|withdraw`, `/api/v1/payments`, `/api/upload*`, `/api/notifications`, …) is a JSON-parsing route that reads the raw body with `req.text()` and `JSON.parse` **regardless of Content-Type** (`route-kit.ts:194-227`; same pattern in share/ussd/whatsapp/daraja handlers). Combined with `SameSite=None; Secure` session cookies behind the https proxy (`auth.ts:98-100`), a cross-site `fetch(..., {mode:'no-cors', credentials:'include'})` or `<form enctype="text/plain">` carrying a JSON body is a **simple request** — no preflight, cookies ride along, body parses. The mitigation exists (`MUTATION_ORIGIN_ALLOWLIST`, `route-kit.ts:140-152`) but is **unset/permissive by default** ("the sandbox preview embeds the app in a cross-site iframe, so Origin checks must stay off by default"). Net: with default config, any signed-in visitor of an attacker page can be made to dispatch actions/decisions/transfers.
- The marketing site's contact route does have an Origin/Referer gate + honeypot + TRUST_PROXY-aware per-IP limit (`mjengoos-website/app/api/contact/route.ts:7-27`) — that gate exists only there.

## 11. PII & logging — verdict: targeted and honest

- `pii-scrub.ts`: Kenyan phone numbers masked at the two transcript entry boundaries (voice-log ASR output; shared `parseDeliveryTranscript` seam — the LLM prompt itself is scrubbed) (`pii-scrub.ts:48-59`). Names/locations deliberately not masked (documented product decision). Idempotent, boundary-aware regexes pinned by tests.
- Error redaction: `safeErrorMessage`/`isInternalError` strip Prisma/framework internals from client bodies (`guard.ts`, rule extracted to the leaf `error-redaction.ts` in #202 so the error sink consumes the same one); the error sink (#202) applies the same rule to external payloads (internal errors: redacted message, NO stack, client IP never sent); v1 uses `mapServiceError` with the same doctrine; s3-compat errors are secret-free by construction.
- Sensitive fields: `Worker.pin` and `project.shareToken` deliberately omitted from v1 (`worker-detail.ts:23-24`, `project-detail.ts:35-36`); audit API serializes ip/userAgent/requestId to **admin only**; audit-context IP comes from the first XFF value (`actions.ts:52`) — spoofable metadata (SEC-12 note), not a control.
- Health routes expose liveness + coarse counts + version only (`app/api/health/route.ts`, `app/api/route.ts`).

## 12. Dependency red flags (flag, don't fix)

- **next-auth ^4.24.15 on Next ^16.1.1 + React 19** (package.json:84-92): v4 predates Next 15/16; the App-Router handler is shimmed with a cast (`[...nextauth]/route.ts:25-33`). v4 is maintenance-mode upstream; the v5 line is the supported one for this Next generation. Auth core on an unsupported framework pairing = SEC-5 (P2). **2026-09-18 interim protection landed (#173 / ADR 0007):** exact pin `4.24.15`, written migration plan (`docs/adr/0007-nextauth-v5-migration.md`), Dependabot advisory watch (`.github/dependabot.yml`) — the v5 cutover itself is scheduled work, not executed.
- `better-sqlite3 ^12` — native addon, optional sqlite rate-limit store; Bun-runtime incompatible (documented, degrades to memory).
- `prismjs ^1.30.0` (historic ReDoS family — keep pinned/updated), `z-ai-web-dev-sdk` (AI provider), duplicated id libs (`nanoid` + `uuid`), `lodash` present.
- No automated dependency auditing in CI (static observation; no lockfile vulnerability scan available in this environment).

---

## Findings register

| ID | Sev | Title (proposed issue) | Evidence |
|---|---|---|---|
| **SEC-1** | **P1** | CSRF: `SameSite=None` session cookies + Content-Type-agnostic JSON parsing on all mutating routes, Origin allowlist off by default — cross-site money/action dispatch with default config | auth.ts:92-106; route-kit.ts:140-152,194-227; no middleware.ts; next.config.ts:45-55 |
| **SEC-2** | **P1** | Deterministic, publicly-derivable next-auth fallback secret accepted for session verification in any non-`production` runtime without `NEXTAUTH_SECRET` → forgeable admin JWTs (staging/preview/dev exposures) | guard.ts:15-28; nextauth-fallback-secret.ts:83-118; next-auth-guard.ts:59-66 |
| SEC-3 | P2 | Share tokens: initial token is Prisma `cuid()` (not CSPRNG), 96-bit on regenerate, no expiry; token is a money-approval capability (milestone.decide via public link) | schema.prisma:12; projects.ts:115; mjengo.ts:1544-1553; share.ts:21-27; money.ts:192-196 |
| SEC-4 | P2 | USSD/WhatsApp webhooks fail OPEN in production when secrets unset (console warning only) — unauthenticated attendance writes + worker wage-balance disclosure via 4-digit phone-tail PIN | ussd/route.ts:21,151-167,342-353; whatsapp/route.ts:15; webhook-secret-warning.ts |
| SEC-5 | P2 | next-auth v4.24.15 + Next 16/React 19: unsupported pairing for the authentication core (cast-shimmed route handler) — **planned: ADR 0007 + exact-pin 4.24.15 + Dependabot advisory watch landed (#173, 2026-09-18); v5 cutover scheduled per ADR** | package.json:84-92; [...nextauth]/route.ts:25-33; docs/adr/0007-nextauth-v5-migration.md |
| SEC-6 | P2 | Portfolio-wide read for all site-team roles (supervisor/qs/procurement incl.) — no project-membership model; worker PII + escrow readable across all projects | project.ts:157-172; v1/* clientProjectDenied semantics; worker-detail.ts:81-83 |
| SEC-7 | P3 | Client with null projectId: `/api/project` falls back to first project **incl. shareToken echo**; `/api/notifications` POST skips the tenant pin | project.ts:167-172; mjengo.ts:220-223; notifications.ts:125 |
| SEC-8 | P3 | Presign/confirm upload flow lacks magic-number validation — content-type trusted from the client PUT (legacy path sniffs) | upload-confirm.ts:5-15,89-110 |
| SEC-9 | P3 | USSD PIN lockout keyed on caller-supplied phone number — lockout budget refreshable by rotating MSISDNs; per-IP 40/min is the effective bound | rate-limit.ts:444-490; ussd/route.ts:276-291 |
| SEC-10 | P3 | Idempotency-Key records are global, not principal-scoped — replaying a foreign key returns the stored result to owner-role sessions (client pin checked, others trusted) | actions.ts:99-133 |
| SEC-11 | P3 | Minimal security headers: no CSP/HSTS/Permissions-Policy; framable by design (iframe preview posture) retained for production builds | next.config.ts:40-55 |
| SEC-12 | P3 | `AUTH_SECRET` alias read by guard but undocumented in `.env.example`; `principalFor` ignores the alias (IP-keyed limits on AUTH_SECRET-only deploys); audit IP = spoofable first XFF value | guard.ts:15; rate-limit.ts:87; actions.ts:52; .env.example |
| SEC-13 | P3 | Default in-memory rate-limit/lockout store multiplies effective limits per process/instance; sqlite opt-in; XFF trust requires `TRUST_PROXY=1` | rate-limit.ts:38-77,301-327 |

No P0 found: the historical P0 (share-token cross-project read, BE-1) is verified fixed; nothing in this pass reaches "unauthenticated cross-tenant read/write in the supported production configuration".

## Contradictions vs prior QA report (docs/QA-REPORT-2026-09-10.md)

1. **Confirmed fixed as claimed:** BE-1 share binding (project.ts:144-190), BE-2/BE-7 money gates (money.ts + v1 wallets/payments), BE-3/BE-6 supplier scope + replay pin, BE-4/BE-5/BE-8/BE-11/BE-12 body caps, AI policy, search/notifications scoping, db-log gating. The prior fixes are real and test-pinned.
2. **"Closing all of them" is overstated:** the QA finding set never covered CSRF posture (SEC-1), the fallback-secret verification surface introduced by the #94 fix (SEC-2), share-token *generation entropy/expiry* (only *binding* was fixed, SEC-3), or the fail-open webhook default (BE-6 added a warning, not a gate — SEC-4).
3. **BE-9 marked closed** ("USSD PIN brute-force") is only **partially** mitigated: the 5/15-min lockout is keyed to the attacker-supplied phone number, so it defends the demo posture but not a rotating-MSISDN attacker; the phone-tail fallback remains active whenever the secret is unset.
4. Minor: QA cites "no secrets in history" — consistent with this audit's static read (no hardcoded secrets; placeholder `NEXTAUTH_SECRET=change-me` deliberately fails closed).

## Worklog entry (Task 2-e)

- Re-audited Mjengo-OS security baseline read-only (main @ 8b0003a); deliverable: docs/audit/SECURITY_BASELINE.md (this file); no repo code modified.
- Authn: verified scrypt+lockout credentials flow, 30-day JWT sessions, and the #74 production boot guard (NEXTAUTH_SECRET ≥32 chars, throws at auth-route module load; build phase exempt) — sound.
- Traced the #94 dev-fallback path end-to-end: guard accepts v4-internal-fallback-signed tokens whenever no env secret AND NODE_ENV≠production — the derivation is public-source-computable → SEC-2 (P1) for any exposed non-prod runtime.
- Swept all 60+ API routes for guard coverage: every route maps to a route()-wrapped backend handler; enumerated role allowlists, client/supplier pins, finance/payment gates, and the applier-seam role checks (requireDeciderRole/requireMoneyActor/assertSupplierScope).
- IDOR sweep: all v1 [id] routes resolve-then-pin (client) / row-pin (supplier) / FINANCE_ROLES (wallets); two null-projectId fail-open edges found on /api/project (shareToken echo of first project) and notifications POST (SEC-7).
- Share tokens: BE-1 binding fix verified; found initial cuid() generation (not CSPRNG), 96-bit regenerate, no expiry, and the public link's power to approve milestone releases (SEC-3).
- CSRF analysis: SameSite=None cookies + req.text()+JSON.parse regardless of Content-Type + MUTATION_ORIGIN_ALLOWLIST default-off + no middleware → practical cross-site dispatch against all mutating routes (SEC-1, P1).
- Webhooks: Daraja secret-path + IP allowlist + query-API reconciliation + durable dedupe rated strong; USSD/WhatsApp HMAC optional with warn-only production posture (SEC-4); USSD lockout keyed on caller-supplied phone (SEC-9).
- Uploads/storage: presign/confirm/re-sign flows reviewed — key sanitization and local-disk traversal guards solid; noted missing magic-number sniff in the confirm flow (SEC-8) and 5-min/15-min/7-day presign expiry ladder.
- Env audit: cross-checked every `process.env.*` read against .env.example — 1 gap (AUTH_SECRET alias); JOBS_RUN_TOKEN fail-closed posture verified; Prisma query logging dev-only.
- Dependencies: flagged next-auth v4-on-Next-16 as the key supply risk (SEC-5); package.json listed, nothing installed/tested per rules.
- Contradiction summary for the principal: prior QA's "all findings closed" holds for BE-1..BE-12 specifically, but its finding set missed the four highest-impact items of this re-audit (SEC-1..SEC-4).
