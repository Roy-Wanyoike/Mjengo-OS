# Mock / Demo / Placeholder Sweep + Test Baseline (Task 2-f, Phase 0.10 + 0.11 static half)

- Date: 2026-09-16 · Agent: 2-f (Mock/Demo/Placeholder & Test Baseline Lead)
- Repo: /home/z/mjengo-os (main @ 8b0003a) · Method: STATIC ONLY (read-only, no tests executed)
- Scope: src/**, mjengoos-website/**, prisma/**, supabase/**, deploy/**, Docker/compose, tests/unit/** (inventory), docs/** (cross-check only)
- Verdict up front: **the honest-seam pattern is real and consistent. Zero category-(e) "accidental fake data in production paths" hits were found.** All simulation is deliberate, labeled, and (where it matters) env-gated fail-closed. Findings below are hardening opportunities (MD-*) and test-baseline gaps (TEST-*), not dishonesty.

---

## 1. Hit-count summary (whole repo, case-insensitive, ripgrep)

| Term | Total hits | tests/unit | src (app code) | mjengoos-website | prisma / supabase | docs / config / lockfile |
|---|---|---|---|---|---|---|
| `TODO` | 1 | 0 | 0 | 0 | 0 | 1 (DEPLOYMENT.md:753 — quotes the "honest TODO" wording) |
| `FIXME\|HACK\|XXX` | 10 | 0 | 10 | 0 | 0 | bun.lock: 3 (hashes) |
| `mock` | 730 | ~630 (fixtures, legit) | 1 (wallet/service.ts:51 comment "mock-friendly") | ~24 ("dashboard-mockup" component, demo copy) | 0 | ~75 (docs/backlog/wave6/QA plan notes) |
| `dummy\|sample\|demo\|fake` | 501 | ~150 | ~110 (comments: "never a fake 0", "demo posture", DEMO_ACCOUNTS, audio `sampleRate`) | ~40 (marketing demo copy, clearly labeled) | ~15 (seed headers) | ~130 (docs) |
| `placeholder` | 188 | 5 | ~150 (HTML `placeholder=` input attrs — benign UI) | ~10 | 0 | ~5 |
| `coming soon\|not implemented` | 2 | 0 | 1 (rate-limit.ts:30 — "Redis implementation … (not built)" doc note) | 0 | 0 | 1 (adr/0001:38 — mobile scope decision) |
| `stub\|stubbed` | 158 | ~152 | 3 (comments referencing test stubs / back-compat contract) | 0 | 1 (schema.prisma comment) | 2 |
| `hardcoded\|hard-coded\|temporary` | 20 | 7 | 10 (all comments describing what was FIXED — "was hardcoded 'finance'", BE-7) | 0 | 0 | 3 |
| `localhost\|127.0.0.1\|example.com` | 377 | ~290 (fetch mocks, temp dirs) | 7 (comments + VAPID default + next-auth fallback doc) | ~10 (dev site URL, SEO doc) | 0 | ~70 (.env.example, DEPLOYMENT.md, docker-compose, systemd) |
| `mockData\|seedData` | 0 | — | — | — | — | — |
| `simulat*` | 178 | ~60 | ~75 (honesty labels) | ~6 (about/pricing honesty copy) | 2 (seed comments) | ~35 |

Notes:
- All 10 `FIXME|HACK|XXX` matches are **false positives**: phone-number mask comments `+2547XXXXXXXX` (notify/channels.ts:43,73; invoices/service.ts:16; pii-scrub.ts:8–10), an input `placeholder="+254 7XX XXX XXX"` (worker-dialogs.tsx:136), and bun.lock hashes. **There is not a single real TODO/FIXME/HACK marker in application code.**
- `prisma/seed*.ts` (11 files) are intentional demo seeds, documented in README §"Demo accounts (seed data)" and DEPLOYMENT.md §4.1–4.2 ("Seeding does NOT run automatically in any path"; "Production data does not need seeds").
- `supabase/migrations/*.sql`: no demo data (single benign `'seed'` enum value, 0001_schema.sql:916).

## 2. Classification results

### (a) Legitimate test fixtures — the bulk
~630 `mock` + ~150 `demo/sample` + ~152 `stub` hits in tests/unit are vi.mock harnesses (in-memory Prisma stubs, `it.each` fixtures, `DUMMY_HASH`-style test seeds). Correct usage.

### (b) Local dev config
- `.env.example` (324 lines): fully commented template; `NEXTAUTH_SECRET=change-me` deliberately too short so an unedited copy fails closed at boot (next-auth-boot-guard). No real secrets.
- `docker-compose.yml`, `deploy/systemd/mjengo-jobs.env.example` (JOBS_RUN_TOKEN empty = fail closed), website `.env.example`, Dockerfiles. All clean.

### (c) Documentation / marketing examples
- mjengoos-website marketing copy ("demo", "mockup", illustrative directory entries — directory-preview.tsx:52 explicitly says "illustrative examples, not live listings"; about/page.tsx:256 says "*384# line runs as a simulator"). Honest.
- docs/** (blueprint, backlog, wave6, QA report) reference simulations by design.

### (d) Intentional honest seams (labeled + env-gated) — see §3 table. ~9 distinct seams.

### (e) ACCIDENTAL production behavior — **NONE FOUND**
Specifically checked and cleared:
- **Hardcoded dashboard stats / fake counters**: none. Intel engine (intel/engine.ts:4 "No fake AI mystique"), score (intel/score.ts:14,349 "never a fake 0 or 100"), drawpack (drawpack/service.ts:27,218), land (land/service.ts:82 "honest, not a fake 'consistent'"), ai/authenticity.ts:491,688 ("no fake row", "no fake insight") all compute from DB rows and return explicit null when data is insufficient.
- **Simulated payment success**: SimulatedProvider returns `simulated: true` on EVERY result and the string "recorded, no real money moved" (providers.ts:89–94); UI mirrors it (i18n en.ts:1116–1119 "M-Pesa (simulated)"; pay-invoice-dialog.tsx:185; money.pr.simulatedNote en.ts:1115). Daraja STK is honestly `pending`, never instant success (daraja.ts:334–339).
- **Simulated AI responses**: none. ZaiProvider returns null (unavailable) or `{ok:false}` — never canned text (ai/provider.ts:482–516 "never fake an analysis"); resolveAiProvider is flag-gated OFF by default (intel/flags.ts:154).
- **Static arrays as live data**: none in src app code (only marketing website sections, category c).
- **Math.random in src/backend** (5 hits): 4 are cosmetic reference-suffix generators (invoices/service.ts:58, land/service.ts:307, actions/money.ts:63, providers.ts:61 `SIM-` refs) — the actual capability secret uses crypto-strong randomness (mjengo.ts:1550). See MD-4.

### (f) Incomplete implementations / accepted limitations (honest, labeled) → findings MD-5…MD-8 below.

## 3. Honest-seam inventory (the pattern works)

| # | Seam | Location | Label | Env gate | Fail mode |
|---|---|---|---|---|---|
| 1 | Payment provider abstraction | src/backend/modules/wallet/providers.ts:1–14 (HONESTY LABEL header), 57–118 (SimulatedProvider), 120–152 (EscrowWalletProvider) | `simulated: true` on every ProviderResult + integrationNote strings | getProvider() picks Daraja only when full DARAJA_* set present | fail-closed to simulated rail |
| 2 | Daraja sandbox | src/backend/modules/wallet/daraja.ts:1–41 (HONESTY LABEL), 92–114 (darajaConfigFromEnv) | "SANDBOX … NOT a licensed integration" in label + note | DARAJA_ENV + 6 secrets; callback must be https | null → simulated rail; unmapped ResultCode never = success (daraja.ts:381–383) |
| 3 | Daraja reconcile job | wallet/daraja-reconcile.ts (env-tuned, seeded only when Daraja env present) | job result JSON w/ samples[] | DARAJA_RECONCILE_*_MIN | no env → seeds nothing |
| 4 | USSD gateway route | src/app/api/ussd/route.ts:49–66,91 ("— MjengoOS sim" footer on EVERY reply; GET = contract doc) | "no real aggregator is wired" | USSD_WEBHOOK_SECRET (optional HMAC; unset = open demo posture + ONE loud production warning via webhook-secret-warning.ts) | documented fail-open + warning |
| 5 | USSD in-app simulator | src/frontend/mjengo/ussd-tab.tsx:3–23 ("SIMULATION (M-8)"), 437–438, 587 | title/i18n "USSD Muster Line — SIMULATION" (en.ts:357) | n/a (client demo; dispatches REAL actions) | labeled |
| 6 | WhatsApp field line | src/app/api/whatsapp/route.ts:54–79 (sim footer, contract doc); whatsapp-panel.tsx:3–23 | "SIMULATION (W4-3)"; wa.honesty string en.ts:419 | WHATSAPP_WEBHOOK_SECRET (same pattern) | fail-open + warning |
| 7 | SMS/push channels | src/backend/modules/notify/channels.ts:1–31 (honest-by-construction header), 357–371 (getSmsProvider), 463–469 (getPushProvider) | no provider → row stays 'logged', never fakes 'sent' | NOTIFY_SMS_WEBHOOK_URL / AT_API_KEY+AT_USERNAME / VAPID pair (partial sets → null) | fail-closed |
| 8 | AI provider | src/backend/modules/ai/provider.ts:1–56 (seam rules), 544–546 (resolveAiProvider) | "AI unavailable" state, leak-free errors, 20s cap | flags.ai (DEFAULT OFF, intel/flags.ts:154) + .z-ai-config file (no env) | null → features render "off" |
| 9 | Legacy AI routes | src/backend/lib/ai.ts + /api/ai/* | 20s caps, honest 500s | ai_progress / ai_voice flags | flag-off → 403 uniform |
| 10 | Object storage | src/backend/lib/storage/* (local-disk default; S3 five-env fail-closed) | capability reporting "honest, no pretending" (storage-local-disk.test.ts:89) | S3_ENDPOINT+4 others | partial set → warning + local disk |
| 11 | Website contact form | mjengoos-website/app/api/contact/route.ts:26 ("Still no third-party service is contacted") | persists locally, capped 500 | — | honest 500 |

**Honest-seam count: 11 (wallet rails ×2–3, USSD ×2, WhatsApp, SMS ×2 flavors, push, AI ×2, storage, contact).** All labeled; the money/auth-critical ones are env-gated fail-closed. The two field-channel routes (USSD/WhatsApp) are fail-OPEN by documented design when their secrets are unset — with a one-time production boot warning (BE-6, issue #76). See MD-5.

## 4. Findings

| ID | Severity | Finding | Evidence | Why it matters | Proposed issue title |
|---|---|---|---|---|---|
| MD-1 | **Medium** | Demo-account quick-fill panel ships unconditionally in the login screen (8 accounts incl. `admin@mjengo.os`/`admin2026`, `finance@…`), and the demo seed creates those known passwords | src/frontend/auth/login-screen.tsx:21–30 (hardcoded creds in client bundle), 159–202 (always-rendered panel); prisma/seed-extras/users.ts:46+; README "Demo accounts (seed data)" | If an operator runs the documented seed chain against a production DB, the login page itself advertises working admin/finance credentials. Mitigations exist (DEPLOYMENT.md §4.1 "Seeding does NOT run automatically", §6.4 "Production data does not need seeds") but nothing technical prevents or warns on `seed` in NODE_ENV=production | "Gate the demo login quick-fill behind an env flag and warn/refuse demo seeds when NODE_ENV=production" |
| MD-2 | Low | VAPID subject defaults to `mailto:admin@localhost` in production sends | notify/channels.ts:146,467; .env.example:216–218 (documented) | Push services get a dead abuse-contact for any deploy that forgets VAPID_SUBJECT | "Nudge/warn when VAPID pair is set but VAPID_SUBJECT is the localhost default" |
| MD-3 | Low | Marketing contact form stores PII in plaintext `data/submissions.json` on the website host | mjengoos-website/app/api/contact/route.ts:213–229 (capped at 500, gitignored, documented) | No encryption/retention/expiry; acceptable for launch but a privacy debt | "Contact submissions: define retention + consider encrypting or forwarding to email" |
| MD-4 | Low | Cosmetic reference IDs use `Math.random` | invoices/service.ts:58 (`MPESA-XXXXXXXX` style), land/service.ts:307 (`CS/YYYY/NNNNNN`), actions/money.ts:63; providers.ts:61 is intentional (SIM- refs) | Non-crypto randomness in user-visible refs; collision/unpredictability standards. Share tokens are already crypto-random (mjengo.ts:1550) — this is polish only | "Use crypto randomness for user-facing reference suffixes" |
| MD-5 | Info (accepted risk) | USSD + WhatsApp POST routes accept unauthenticated writes when webhook secrets unset (demo posture), only a boot warning in production | api/ussd/route.ts:49–66; api/whatsapp/route.ts:54–72; webhook-secret-warning.ts | Documented gateway-trust model; attendance writes are limited but real. Prior QA accepted this — re-confirm with owner | "Decide: refuse unauthenticated USSD/WhatsApp POSTs in production unless DEMO_OPEN_GATEWAYS=1" |
| MD-6 | Low | Supplier catalog is "minimal working, demo editing" — network-global rows, no per-supplier ownership of catalog edits | supply/service.ts:37, 249; supply/policy.ts:16,106 | Any procurement-capable role can edit any supplier's network-global row; honest label, thin governance | "Supplier catalog edits: ownership/verification model (currently demo editing)" |
| MD-7 | Info | Multi-host rate limiting not built (in-memory or single-host sqlite only) | rate-limit.ts:30; DEPLOYMENT.md:753; .env.example:74–76 | Documented; matters only for scaled-out deploys | "Redis-backed rate-limit store seam (documented gap)" |
| MD-8 | Info | No VAT/tax modeling — invoice lines are zero-tax; UI labels seeded demo data | invoice-detail-dialog.tsx117 ("demo data — tax line is zero"); schema has no tax fields | Honest label today; a real invoicing milestone later | "Tax/VAT modeling for invoices (currently zero-tax, labeled)" |

**Category (e) count: 0. Category (f) count: 8 (MD-1…MD-8), of which 5 are Info/Low, 1 Medium (MD-1), 2 Low.**

## 5. Test baseline (static inventory)

### 5.1 Configuration
- `vitest.config.mts`: environment **node**; include `tests/**/*.test.ts`; `fileParallelism: false` (one fork, conservative for 4GB CI box); alias `@ → ./src`. **No setupFiles. No coverage config, no coverage provider installed** (package.json has no `@vitest/coverage-*`).
- package.json: `"test": "vitest run"`. **No Playwright/Cypress/Webdriver anywhere in the repo** (no config, no devDependency, no script). All "browser-verified" claims in QA-REPORT-2026-09-10 were manual (screenshots under docs/screenshots/).
- Static count: **71 test files, 1,716 `it(`/`test(` call sites**; ~95 additional cases come from `it.each`/loop expansion at runtime → the prior claim of **1,811 tests across 71 files is consistent** with static reading (orchestrator to confirm by execution).

### 5.2 Do tests test real logic?
Sampled 5 representative files (ledger, v1-wallets, ussd-route, supplier-role, rate-limit-store):
- **Idiom = in-memory Map-based Prisma stubs (`vi.mock('@/backend/lib/db')`) with the REAL domain/service/route code on top.** e.g. ledger.test.ts:19–89 stubs ledgerAccount/ledgerTransaction/$transaction and exercises the real posting/reversal/idempotency core; ussd-route.test.ts keeps applyAction, rate-limit and audit REAL (only db swapped); v1-wallets keeps route-kit, respond, wallet/http idempotency REAL.
- **NOT DB-backed**: only 1 of 71 files touches a real database engine — rate-limit-store.test.ts (better-sqlite3, real file). No test constructs PrismaClient against a temp SQLite DB; Prisma query semantics, FK constraints and transaction isolation are therefore never exercised (see TEST-2/TEST-3).
  → **Superseded 2026-09-19 (issue #184)**: `tests/helpers/db.ts` now constructs a real PrismaClient per test file on a temp-file SQLite database migrated by the real `prisma migrate deploy` (00→15), and the five `*-realdb.test.ts` critical-path suites run the real services against it. This historical finding stands for the 71 files audited at the time; the stub idiom itself is unchanged and intentional for pure-logic coverage.
- External network is always mocked (fetch/SDK/web-push), with timeout races pinned via fake timers. Good discipline overall.

### 5.3 Inventory by domain (71 files, 1-line purpose)

**Wallet / payments / ledger (11 files, ~285 tests)**
| File | Purpose |
|---|---|
| ledger.test.ts (22) | Double-entry invariants: balance validation, posting, reversal-as-new-entry, derived balances |
| v1-wallets.test.ts (67) | /api/v1 wallet family: role scoping, keyset pagination, deposits/withdrawals/transfers, idempotency, flag gate |
| v1-payments.test.ts (16) | POST /api/v1/payments: PAYMENT_ROLES, resolve-first pin, zod, Idempotency-Key, flag gate |
| wallet-idempotency.test.ts (11) | Natural idempotency keys for withdraw/transfer; payload-fingerprint 409 on key reuse |
| wallet-role-gates.test.ts (14) | Money-role allowlists; real-actor attribution; per-item sync gate; take-capped scans |
| mpesa-daraja.test.ts (51) | Daraja provider: env fail-close, OAuth cache/refresh, STK pending, ResultCode maps, callback dedupe, webhook routes |
| daraja-reconcile.test.ts (17) | Reconcile sweep settles pending intents like the callback; dedupe both directions; env tuning |
| daraja-ip-allowlist.test.ts (18) | Pure IPv4/CIDR matching + webhook DARAJA_ALLOWED_IPS gate |
| v1-milestones.test.ts (24) | Release ladder list/detail, escrow derived balance, rate limit, OpenAPI paths |
| three-way.test.ts (20) | 3-way match (qty/price discrepancies, missing-data honesty, 2-way mode) + ledger consistency |
| notify-channels.test.ts (55) | SMS webhook/AT/VAPID provider resolution fail-closed; honest send outcomes; push payload contract |

**Supply / procurement / invoices (8 files, ~200 tests)**
| File | Purpose |
|---|---|
| v1-supply.test.ts (34) | Supply order list/detail, delivery verification records, marketplace flag gate, OpenAPI |
| supplier-role.test.ts (82) | Supplier portal scoping: allowlist, session pin, row pin, closed buyer surfaces, seeded demo journey, migration additive |
| v1-invoices.test.ts (23) | Invoice lifecycle list/detail + 3-way verdict, rate limit, OpenAPI Phase C |
| delivery-photos.test.ts (11) | Delivery evidence: link-on-verify, discrepancy counts, replay, idempotent re-link, fail-closed validation |
| v1-suppliers-parcels.test.ts (16) | Supplier catalog summary + parcel verification ladder summary reads |
| notifications-supplier-scope.test.ts (6) | POST /api/notifications supplier scoping (BE-12) |
| search-rate-limit.test.ts (6) | GET /api/search standard limiter (BE-11) |
| three-way (see wallet group) | — |

**v1 API surface / projects / workforce (7 files, ~160 tests)**
| File | Purpose |
|---|---|
| v1-projects.test.ts (37) | Projects list/detail/tasks: role scoping, cursor pagination, zod, OpenAPI Phase B |
| v1-workers.test.ts (18) | Worker roster rollup + attendance summary reads |
| v1-attendance-tasks.test.ts (17) | Attendance keyset pagination + task detail joins |
| v1-intel-budget.test.ts (15) | Intel digest + budget-variance v1 mirror, OpenAPI Phase D |
| reports-phase-codes.test.ts (24) | Phase cost-code attribution + stamped posting loop (issue #39) |
| reports-budget-variance.test.ts (23) | Budget variance derivations: rollup, allocation, per-phase rows, categories, CSV discrepancy evidence |
| professionals-directory.test.ts (28) | Verification ladder, upsert/update state moves, credential checks, assignments, deny-by-default matrix |

**AI (7 files, ~205 tests)**
| File | Purpose |
|---|---|
| ai-provider.test.ts (46) | ZaiProvider: flag resolution, singleton, chat/vision/transcribe/speak, TTS chunk/WAV helpers |
| ai-authenticity.test.ts (56) | Evidence authenticity screen: gating, demo AC (same photo two milestones), no fake insights, append-only, migrations additive |
| ai-draw-review.test.ts (34) | Draw review action: flag/role gates, leak-free failures, note rows, non-influence, migration additive |
| ai-trust-digest.test.ts (32) | Trust digest: deterministic text, zero model figures, append-only, share GET gate, i18n parity |
| ai-legacy-timeout.test.ts (11) | Legacy lib/ai.ts 20s caps + singleton + hung-ASR 500 |
| extract-document-pdf.test.ts (8) | /api/ai/extract-document PDF path w/o ocrTextHint; honest failures |
| perceptual-hash.test.ts (25) | 64-bit dHash determinism, variants/distinct scenes, honest null |

**Security / auth / rate limiting (12 files, ~190 tests)**
| File | Purpose |
|---|---|
| guard.test.ts (21) | Role registry, capability projections, supplier pin, internal-error hygiene |
| permissions.test.ts (22) | Tab/role permission matrix, fail-closed unknown roles, client narrower than contractor |
| rate-limit.test.ts (33) | Token bucket, login lockout, USSD PIN lockout, AI route body caps |
| rate-limit-store.test.ts (35) | sqlite store cross-process sharing (issue #33), env wiring, init honesty, fail-open |
| next-auth-boot-guard.test.ts (11) | Production NEXTAUTH_SECRET boot guard (missing/short/build-exempt) |
| nextauth-fallback-secret.test.ts (13) | Byte-identical v4.24 fallback mirror, gating, real token verify (#94) |
| share-token-binding.test.ts (9) | Share token binds to exactly one project (BE-1) + route contract |
| pii-scrub.test.ts (23) | Phone masking shapes, non-PII preserved, transcripts, idempotency |
| pii-scrub-wiring.test.ts (9) | ASR boundary + parse seam + persistence chain scrubbed |
| webhook-secret-warning.test.ts (6) | BE-6 one-time production warning semantics |
| jobs-token.test.ts (16) | Bearer parsing, constant-time compare, route verdict |
| jobs-run-route.test.ts (7) | POST /api/jobs/run auth selection |

**Sync / offline / frontend contracts (8 files, ~140 tests)**
| File | Purpose |
|---|---|
| sync-flag-gate.test.ts (23) | action-flag-gate single definition + per-item /api/sync gating + share body cap |
| outbox-versions.test.ts (15) | Entity versioning; deterministic two-client task conflict; attendance versioning |
| client-actions.test.ts (15) | CLIENT_ACTIONS allowlist completeness; no owner-mutation leaks; idempotency pins |
| actions-sync-body-cap.test.ts (6) | 1MB/2MB raw-body caps on /api/actions and /api/sync |
| frontend-robustness.test.ts (7) | Stale-response discard, real server errors surfaced, fail-while-online queues |
| frontend-a11y.test.ts (24) | Error boundaries, contrast classes, 44px targets, tablist pattern, aria labels |
| sw-offline-shell.test.ts (31) | SW cache rules, offline boot gate, manifest/icon/offline.html, capture attr |
| push-routes.test.ts (38) | Push subscribe/unsubscribe routes, payload parse, click routing, sw.js wiring |

**Feature flags / storage / platform (10 files, ~200 tests)**
| File | Purpose |
|---|---|
| flags-gating.test.ts (61) | Flags registry, requireFlagOn uniform gate, every flag family on actions/sync/v1 |
| storage-factory.test.ts (12) | Driver env matrix fail-closed + cache seam |
| storage-local-disk.test.ts (28) | Local disk driver: writes, URLs, capabilities, stat, docs tree, read passthrough |
| storage-s3-compat.test.ts (27) | S3-compatible driver: URLs, presign, put, stat, fail-closed construction |
| storage-sigv4.test.ts (20) | SigV4 golden GET/PUT signatures, failure modes |
| storage-presign-routes.test.ts (21) | presign/confirm/legacy upload routes through the adapter |
| storage-resign-routes.test.ts (20) | re-sign route: gates, fresh presigned GETs, entitlement, rate limit |
| storage-document-read.test.ts (17) | mode=document writes + extractDocument driver read seam (#37) |
| supabase-design.test.ts (33) | Supabase SQL design: schema completeness, RLS coverage, money typing, FK indexes, append-only |
| jobs-handler-timeout.test.ts (5) | Per-handler drain timeout (BE-7) |

**Domain modules / i18n / misc (8 files, ~180 tests)**
| File | Purpose |
|---|---|
| mjengo-score.test.ts (39) | MjengoScore determinism, component formulas, aggregation, append-only history, migration additive |
| draw-pack.test.ts (39) | DrawPack determinism/canonical hash, one immutable pack per release, share gate, i18n |
| land-parcel-title-search.test.ts (36) | Title search ladder: create/update/status, deterministic transcription match, role matrix |
| i18n.test.ts (29) | en/sw key parity, placeholder parity, field-surface coverage, no raw literals |
| ussd-route.test.ts (29) | USSD grammar, body cap, HMAC, PIN throttle/lockout, fallback policy, sim footer |
| whatsapp-route.test.ts (30) | WhatsApp grammar, identity-by-phone, allowlist, HMAC, rate limits, audit context |
| pdf-text.test.ts (19) | PDF text extraction operators, compression, honest failures, caps |
| db-log-gating.test.ts (5) | PrismaClient log levels (BE-8) |

### 5.4 Coverage-gap analysis (critical domains)

| Domain | Status | Evidence / gap |
|---|---|---|
| Procurement chain end-to-end (RFQ→quote→PO→delivery→consumption) | **THIN** | Pieces tested in isolation (v1-supply reads, delivery-photos evidence, supplier-role authz, three-way match) but NO single test walks request→quote→order→delivery→invoice→ledger with discrepancies; quotes-card.tsx:349 admits "no live supplier rail" (simulated supplier responses in UI) |
| Receiving / inspection state machine | **THIN** | delivery-photos covers link-on-verify + discrepancy counts; no test of receive→inspect→variance decision flow states |
| Consumption / stock reconciliation | **NO TESTS** | src/backend/modules/inventory/{service,repository}.ts have ZERO test files; Consumption model exists (seed wipes it) — untested logic. 2026-09-19: superseded for the reconciliation half — #194 lands tests/unit/inventory-reconciliation.test.ts (22, stub) + tests/unit/inventory-reconciliation-realdb.test.ts (7, real engine); the movement half was already covered by inventory-atomicity/inventory-realdb (#119/#184). 2026-09-18: superseded for the consumption-model half — #186 lands tests/unit/inventory-consumption.test.ts (24, stub) + tests/unit/inventory-consumption-realdb.test.ts (10, real engine): the `consumption.create` applier (validation, project scoping, audit entry, append-only replay), the materials-rollup invariant (received − consumed = on-site, stock value, spend views) and the two-ledger non-interference vs the StockMovement log. 2026-09-21: superseded for the READ/aggregation half too — #195 lands tests/unit/inventory-slices.test.ts (7, stub: per-type sums, transferred netting out−in, closing formula, latest-cost stockValue, newest-first movement flattening, project scoping) and the whole BOQ surface in tests/unit/inventory-boq.test.ts (27, stub) + tests/unit/inventory-boq-realdb.test.ts (4, real engine) — the module's public surface is now fully pinned |
| Offline conflict resolution | OK-ish | outbox-versions.test.ts:279 (two-client task conflict), :350 (attendance) — only 2 conflict shapes; no multi-item batch partial-failure ordering, no LWW-vs-version policy doc tests |
| Payment retry / timeout flows | PARTIAL | mpesa-daraja (pending semantics, 401 refresh), daraja-reconcile (sweep, dedupe) — but no test of reconcile loop stop conditions under repeated timeouts, no wallet-level retry-after-pending-integration test |
| Share-token expiry / revocation | **THIN** | share-token-binding tests binding only; no test found for token expiry/rotation/revocation lifecycle (share.ts) |
| Rate-limit concurrency | PARTIAL | Single-process bucket math + sqlite cross-process store tested; no true concurrent-request race test, no multi-host (documented MD-7) |
| Migration tests | **WEAK** | Additivity asserted by READING migration SQL text (mjengo-score:825, ai-draw-review:911, ai-authenticity:1208, supplier-role:1433); no `prisma migrate` run against a real DB in tests; supabase-design parses SQL as text |
| E2E browser tests | **NONE** | No Playwright/Cypress config or deps anywhere; QA-report "browser-verified" = manual screenshots only |
| Frontend rendering tests | NONE | All "frontend" tests are string/grep contracts on source files; no jsdom/RTL rendering, no user-flow simulation |

## 6. Contradictions vs prior QA claims

1. "71 files / 1,811 tests passing" — **consistent** with static reading (71 files; 1,716 it() sites + it.each/loop expansions ≈ 1,811). Execution pending (orchestrator).
2. "Honest seams pattern for external integrations (PaymentProvider, NOTIFY_SMS_WEBHOOK_URL, USSD_WEBHOOK_SECRET); simulated rails clearly labeled" — **VERIFIED and stronger than claimed** (11 seams, incl. WhatsApp, AT direct, VAPID push, AI provider, storage; every label + fail-closed gate checked at source).
3. QA-REPORT "browser-verified golden paths in both English and Kiswahili" — **manual only**; there is no automated browser test to repeat it. Not a lie, but not a regression net.
4. No claim in prior QA that tests were DB-backed — confirmed they are NOT (stub-based); anyone assuming Prisma-level coverage would be wrong (TEST-3).

## 7. Test findings

| ID | Severity | Finding | Action |
|---|---|---|---|
| TEST-1 | **High** | Zero E2E/browser tests (no Playwright/Cypress anywhere) | Add Playwright + a login→project→money→share golden path in EN+SW |
| TEST-2 | **High** | Migration correctness never executed against a real DB (SQL read as text only) | CI job: `prisma migrate deploy` on temp SQLite + `prisma migrate diff` vs schema; same for supabase SQL on temp Postgres if feasible. 2026-09-19: the in-suite half landed via #184 — the harness applies the real `prisma migrate deploy` to a fresh temp SQLite per test file and pins the trigger/index state; the CI job itself still waits on #98 |
| TEST-3 | **Medium** | 70/71 test files stub Prisma with in-memory Maps; Prisma query semantics/FKs/transactions untested | Add a small DB-backed integration layer (temp SQLite via PrismaClient) for ledger/wallet/inventory invariants. 2026-09-19: LANDED via #184 — tests/helpers/db.ts + ledger/wallet/supply-chain/inventory/attendance real-DB suites (31 tests); stub suites retained by design |
| TEST-4 | **Medium** | No coverage tooling (no provider, no thresholds) | Install @vitest/coverage-v8; set floor thresholds; publish in CI |
| TEST-5 | **Medium** | inventory module (consumption/stock reconciliation) has no tests | New tests/unit/inventory.test.ts. 2026-09-19: movement half landed via #119/#184 (inventory-atomicity stub + inventory-realdb real engine), reconciliation half via #194. 2026-09-18: consumption-model half LANDED via #186 — inventory-consumption.test.ts (24, stub: applier validation/scoping/audit/append-only + source pins) + inventory-consumption-realdb.test.ts (10, real engine: posting, FK, rollup invariant + spend views, over-consumption clamp vs movement-ledger refusal, cross-project isolation). 2026-09-21: the residual (slice-loader aggregation + the ENTIRE BOQ surface — loadBoqSlice, createBoq versioning, upsertBoqLine, deleteBoqLine, approveBoq approve-once, boqToRequest selection/lineage/MR- sequence, saveSupplier/unsaveSupplier) landed via #195 — inventory-slices.test.ts (7, stub) + inventory-boq.test.ts (27, stub) + inventory-boq-realdb.test.ts (4, real engine). Residual CLOSED; audit also surfaced two new filed issues: #285 (BoqLine.estUnitPrice unit drift, twin of #282) and #286 (upsertBoqLine cross-project line update). 2026-09-21: #285 RESOLVED — writers converted to integer cents at the boundary (payload stays KSh), fail-on-purpose pins flipped to the correct units, no migration needed (seed already wrote cents; demo DBs reseed) — see PENDING_WORK TEST-10b; #286 remains open |
| TEST-6 | **Medium** | No procurement chain end-to-end test (incl. discrepancy → 3-way → ledger) | New integration test walking RFQ→quote→PO→delivery(discrepancy)→invoice→pay. 2026-09-19: LANDED via #184 — tests/unit/supply-chain-realdb.test.ts walks the full chain on the real engine incl. the short-delivery discrepancy, the 3-way verdict, the acknowledgeMismatch gate and the escrow-funded ledger posting |
| TEST-7 | Low | Share-token expiry/revocation lifecycle untested | Extend share-token-binding.test.ts |
| TEST-8 | Low | vitest.config has no setupFiles; frontend tests are grep-contracts, no rendering | Optional jsdom + RTL for the 3 riskiest dialogs |
| TEST-9 | Info | fileParallelism:false is slow-but-safe; fine for 4GB CI box | Keep |

---

## Worklog entry (Task 2-f)

- Swept the full repo for 17 mock/demo/placeholder marker terms (TODO/FIXME/HACK/XXX/mock/dummy/sample/demo/fake/placeholder/coming soon/not implemented/stub/temporary/hardcoded/localhost/example.com/mockData): ~2,300 raw hits, ~85% in tests/docs/lockfile; all 10 FIXME/HACK/XXX matches are phone-mask false positives (`+2547XXXXXXXX`), zero real markers in app code.
- Classified every src/ hit: **0 accidental production fakes** — no hardcoded dashboard stats, no fake counters, no simulated payment success (SimulatedProvider labels `simulated:true` + "no real money moved" on every result), no canned AI responses (provider returns null/`{ok:false}`, flag default OFF).
- Verified the honest-seam pattern end-to-end at source: 11 seams (providers.ts, daraja.ts, daraja-reconcile, ussd route+tab, whatsapp route+panel, notify channels SMS/AT/VAPID, AI provider + legacy, storage factory, website contact) — all labeled, money/auth seams env-gated fail-closed; USSD/WhatsApp are fail-open-by-design with a production boot warning (re-flagged as MD-5 accepted risk).
- Raised 8 MD findings (0×cat-e, 8×cat-f): MD-1 Medium (unconditional demo-login quick-fill + seedable known admin passwords, mitigated only by docs), MD-2 VAPID localhost default, MD-3 plaintext contact PII, MD-4 Math.random refs, MD-5 open gateways, MD-6 demo-grade supplier editing, MD-7 no multi-host rate limiting, MD-8 zero-VAT invoices — each with file:line and a proposed issue title.
- Built the static test inventory: 71 files / 1,716 it() sites grouped into 12 domains with per-file 1-line purposes; prior QA's "1,811 tests" is consistent with it.each/loop expansion (execution verification left to orchestrator).
- Sampled 5 test files (ledger, v1-wallets, ussd-route, supplier-role, rate-limit-store): idiom = real domain logic over in-memory Prisma stubs; only rate-limit-store uses a real (better-sqlite3) DB → flagged TEST-3.
- Checked vitest.config.mts (node env, no setupFiles, no coverage) and package.json (no Playwright/Cypress) → TEST-1 E2E gap, TEST-4 coverage-tooling gap.
- Coverage-gap analysis: NO tests for inventory/consumption reconciliation; THIN for procurement E2E, receiving/inspection, share-token expiry; migration "tests" only read SQL text; offline-conflict and payment-retry flows partially covered.
- Contradiction check vs prior QA: test counts and honest-seam claims hold up; "browser-verified" claims were manual-only (no automated E2E exists) — recommend the orchestrator treat browser regression as unproven.
- Deliverable written to docs/audit/MOCK_DEMO_BASELINE.md (this file); no repo files modified, no tests executed.
