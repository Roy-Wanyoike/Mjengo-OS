# MjengoOS — Test Baseline (TEST_BASELINE)

> **What this is.** The standalone, living test baseline: the suite's
> measured shape, its families, the gate commands, and the honest
> covered/not-covered posture. Created for **issue #190** by extracting
> §5 of `MOCK_DEMO_BASELINE.md` (the dated 2026-09-16 static inventory —
> 71 files, never DB-backed, no E2E) and keeping it current; that section
> stays where it was as the historical record, this file is the canonical
> home going forward.
>
> **Counts convention (DOC-1, issue #187):** living docs quote the suite
> size only with a date stamp. **143 files / 3,159 tests — counts as of
> 2026-09-27 @ `main` `b035c74`, measured by execution** (`bun run test`,
> all passing, ~130 s on the dev box; this PR adds no tests). Re-run
> vitest for the current number — every wave adds tests.

---

## 1. The suite today (measured, not quoted)

| Fact | Value |
|---|---|
| Command | `bun run test` → `vitest run` |
| Result at `b035c74` | **143 files / 3,159 tests — 0 failed, 0 skipped** |
| Duration | ~130 s (single fork, `fileParallelism: false` — deliberate, 4 GB CI box) |
| Config | `vitest.config.mts`: node env, include `tests/**/*.test.ts`, alias `@ → ./src` (+ `@/lib/site → mjengoos-website/lib/site`), `RATE_LIMIT_STORE=memory` hermetic override, console filters for the #204 access lines / #202 sink warning |
| Environment needed | none — no DB, no secrets, no network; critical-path suites build a throwaway real SQLite file (§2b) |
| Finance gate | `bun run test:finance` → **27 files / 629 tests** (same tree, scoped include; ~55 s) |

Suite growth (files / tests, at the dates stamped):
71 / 1,811 (2026-09-16 audit) → 89 / 2,113 (end of mission wave) →
110 / 2,528 (2026-09-18) → 142 / 3,140 (2026-09-26 stamp, undercounted —
see note) → **143 / 3,159 (2026-09-27, measured)**.

> Note: the 2026-09-26 stamps in README/CONTRIBUTING/DEPLOYMENT said
> "142 files / 3,140 tests" but main measured 143 / 3,159 the same week
> (wave 28's two PRs each added a file; the last stamp counted only one).
> This file's numbers are the measured ones; the living-doc stamps are
> refreshed in the same PR that introduced this baseline.

## 2. Suite families

**(a) Stub-idiom unit suites** — the default idiom: REAL domain/service/
route logic over in-memory Prisma stubs (`vi.mock('@/backend/lib/db')`),
external network always mocked, fake timers for timeout races. Chosen
deliberately for pure-logic coverage; not a bug (the original TEST-3
finding was superseded, not "fixed away" — the stubs stay).

**(b) Real-engine suites (`*-realdb.test.ts`)** — 14 files / 100 tests on
the #184 harness (`tests/helpers/db.ts`): a real `PrismaClient` per test
file on a temp-file SQLite database migrated by the REAL
`prisma migrate deploy` (00→19), then the real services run against it.
Critical paths only: ledger, wallet, supply-chain walk, inventory
(movements/consumption/reconciliation/BOQ), attendance, quote update,
upload confirm, search pushdown, idempotency scope, FK pragma,
status ladders.

**(c) Fence & meta gates** — tests whose subject is the repo's own
invariants, so drift fails CI rather than a review:

| Fence | What it pins | Origin |
|---|---|---|
| `tests/unit/action-schemas.test.ts` (59) | The action schema registry: exhaustiveness (total action count pinned), STRICT_ACTION_TYPES exactly the money families, strict-contract parity with `parseMoneyCents` | #161 / API-10 |
| `tests/unit/openapi-cross-check.test.ts` (4) | documented ⇒ implemented per method; v1 implemented ⇒ documented; exact app-read set | #165 / API-14, ADR 0008 |
| `tests/unit/compose-log-rotation.test.ts` (9) | json-file `max-size`/`max-file` on EVERY compose service | #214 |
| `tests/finance/gate.test.ts` (6) | The finance gate's own file list: exists, sorted, duplicate-free; every money-NAMED new file consciously gated or judged out; config wiring = intended set | #215 |

**(d) Playwright E2E** — `tests/e2e/*.spec.ts` (7 persona golden paths:
admin, client, contractor, finance, procurement, supervisor, supplier) on
a RUNNING dev server + seeded DB (`bun run seed`). **Not part of
`bun run test`** (vitest includes `*.test.ts` only); run via
`bun run test:e2e`. Origin: #182 / TEST-1.

**(e) The finance gate** — `bun run test:finance`
(`vitest.financial.config.ts`): the 26 money-invariant unit/realdb suites
+ the fence test = **27 files / 629 tests**, measured green at `b035c74`.
The explicit, commented file list lives in `tests/finance/gate-files.ts`
(one-line edit to add a suite; the fence fails loudly if a money-named
file is not consciously added or judged out).

## 3. Inventory by domain (143 files, measured per-file counts)

Test counts are the executed counts (it.each/loop expansions included).

**Money core, ledger & reconciliation — 9 files / 142 tests**

| File | Tests | Purpose |
|---|---|---|
| money-core.test.ts | 25 | Integer-cents money core: parse/format/multiply (#122) |
| money-bounds.test.ts | 8 | Server-side money-amount bounds (QA-found #241: a KSh ~1e12 top-up persisted) |
| ledger.test.ts | 23 | Double-entry invariants: balance validation, posting, reversal-as-new-entry, derived balances |
| ledger-realdb.test.ts | 10 | The posting core against a real migrated SQLite (#184) |
| ledger-sql-sum.test.ts | 5 | SQL SUM aggregation equivalence on every balance path (#144, DB-6 half) |
| escrow-reversal.test.ts | 7 | Escrow-spend reversals restore the EscrowWallet projection (#213) |
| three-way.test.ts | 20 | 3-way match engine: qty/price discrepancies, missing-data honesty, 2-way mode |
| reconciliation-job.test.ts | 20 | Scheduled reconciliation + escrow projection drift alarm (#212) |
| v1-milestones.test.ts | 24 | Release ladder list/detail, escrow derived balance, rate limit, OpenAPI paths |

**Wallet, payments & Daraja — 12 files / 274 tests**

| File | Tests | Purpose |
|---|---|---|
| v1-wallets.test.ts | 72 | /api/v1 wallet family: role scoping, keyset pagination, deposits/withdrawals/transfers, idempotency, flag gate |
| v1-payments.test.ts | 19 | POST /api/v1/payments: PAYMENT_ROLES, resolve-first pin, zod, Idempotency-Key, flag gate |
| wallet-idempotency.test.ts | 14 | Natural idempotency keys for withdraw/transfer; payload-fingerprint 409 on key reuse |
| wallet-realdb.test.ts | 8 | Wallet idempotency + balances on the real engine (#184) |
| wallet-role-gates.test.ts | 18 | Money-role allowlists; real-actor attribution; per-item sync gate; take-capped scans |
| wallet-posture-banner.test.ts | 14 | The persistent, dismissible money-posture banner (#123, FE-2 half) |
| v1-money-audit.test.ts | 11 | v1 money mutations write audit events (DB-4) |
| money-actions-audit.test.ts | 15 | Decision actions capture their decision payload in the audit trail (#218) |
| mpesa-daraja.test.ts | 57 | Daraja provider: env fail-close, OAuth cache/refresh, STK pending, ResultCode maps, callback dedupe, webhook routes |
| daraja-reconcile.test.ts | 17 | Reconcile sweep settles pending intents like the callback; dedupe both directions; env tuning |
| daraja-ip-allowlist.test.ts | 19 | Pure IPv4/CIDR matching + webhook DARAJA_ALLOWED_IPS gate |
| daraja-lifecycle.test.ts | 10 | The STK payment lifecycle as one continuous story (#211) |

**Supply chain, procurement & invoices — 10 files / 236 tests**

| File | Tests | Purpose |
|---|---|---|
| v1-supply.test.ts | 34 | Supply order list/detail, delivery verification records, marketplace flag gate, OpenAPI |
| supplier-role.test.ts | 93 | Supplier portal scoping: allowlist, session pin, row pin, closed buyer surfaces, seeded demo journey, migration additive; /api/notifications scoping pins |
| v1-invoices.test.ts | 23 | Invoice lifecycle list/detail + 3-way verdict, rate limit, OpenAPI Phase C |
| delivery-photos.test.ts | 36 | Delivery evidence: link-on-verify, discrepancy counts, replay, idempotent re-link, fail-closed validation |
| v1-suppliers-parcels.test.ts | 16 | Supplier catalog summary + parcel verification ladder summary reads |
| supply-chain-realdb.test.ts | 7 | The full RFQ→quote→PO→delivery(discrepancy)→invoice→escrow-funded ledger walk on the real engine (#184, TEST-6) |
| quote-atomicity.test.ts | 8 | updateQuote line-rewrite atomicity — stub failure-injection half (#147) |
| quote-update-realdb.test.ts | 5 | updateQuote atomicity — real-engine half (#147) |
| notifications-supplier-scope.test.ts | 6 | POST /api/notifications supplier scoping (BE-12) |
| search-rate-limit.test.ts | 7 | GET /api/search standard limiter (BE-11) |

**Inventory & stock — 10 files / 199 tests**

| File | Tests | Purpose |
|---|---|---|
| inventory-atomicity.test.ts | 71 | Movement/consume/transfer/adjust atomicity + derived closing stock (DB-2) |
| inventory-realdb.test.ts | 5 | Site Store movements under real constraints (#184) |
| inventory-consumption.test.ts | 24 | `consumption.create` applier: validation, scoping, audit, append-only (#186) |
| inventory-consumption-realdb.test.ts | 10 | Consumption posting + the received − consumed = on-site rollup on the real engine (#186) |
| inventory-reconciliation.test.ts | 22 | count → variance → count-linked adjustment loop (#194) |
| inventory-reconciliation-realdb.test.ts | 8 | Reconciliation under real constraints (#194) |
| inventory-slices.test.ts | 12 | loadInventorySlice aggregation: per-type sums, transfer netting, closing formula, latest-cost stockValue (#195) |
| inventory-boq.test.ts | 32 | BOQ lifecycle + supplier shortlist: loadBoqSlice, createBoq versioning, upsert/delete lines, approve-once, boqToRequest lineage (#195) |
| inventory-boq-realdb.test.ts | 5 | BOQ service functions on the real engine (#195) |
| inventory-lowstock.test.ts | 10 | Honest low-stock crossings + the notifyLowStockCrossing seam (#207) |

**v1 reads, projects & workforce — 11 files / 246 tests**

| File | Tests | Purpose |
|---|---|---|
| v1-projects.test.ts | 42 | Projects list/detail/tasks: role scoping, cursor pagination, zod, OpenAPI Phase B |
| v1-workers.test.ts | 18 | Worker roster rollup + attendance summary reads |
| v1-attendance-tasks.test.ts | 17 | Attendance keyset pagination + task detail joins |
| v1-intel-budget.test.ts | 15 | Intel digest + budget-variance v1 mirror, OpenAPI Phase D |
| v1-direct-reads.test.ts | 13 | Every project-subresource list route reads its subresource directly — getProjectPayload never called (#154, API-3) |
| bounded-reads.test.ts | 18 | DB-level bounds (take/keyset) on every list read (#155, API-4) |
| attendance-realdb.test.ts | 6 | Attendance day-rows under the real unique (workerId, date) constraint (#184) |
| reports-phase-codes.test.ts | 24 | Phase cost-code attribution + stamped posting loop (issue #39) |
| reports-budget-variance.test.ts | 24 | Budget variance derivations: rollup, allocation, per-phase rows, categories, CSV discrepancy evidence |
| professionals-directory.test.ts | 28 | Verification ladder, upsert/update state moves, credential checks, assignments, deny-by-default matrix |
| land-parcel-title-search.test.ts | 41 | Title search ladder: create/update/status, deterministic transcription match, role matrix |

**AI & document intelligence — 10 files / 263 tests**

| File | Tests | Purpose |
|---|---|---|
| ai-provider.test.ts | 46 | ZaiProvider: flag resolution, singleton, chat/vision/transcribe/speak, TTS chunk/WAV helpers |
| ai-authenticity.test.ts | 56 | Evidence authenticity screen: gating, demo AC (same photo two milestones), no fake insights, append-only |
| ai-draw-review.test.ts | 39 | Draw review action: flag/role gates, leak-free failures, note rows, non-influence |
| ai-trust-digest.test.ts | 34 | Trust digest: deterministic text, zero model figures, append-only, share GET gate, i18n parity |
| ai-legacy-timeout.test.ts | 11 | Legacy lib/ai.ts 20s caps + singleton + hung-ASR 500 |
| extract-document-pdf.test.ts | 8 | /api/ai/extract-document PDF path w/o ocrTextHint; honest failures |
| extract-document-queue.test.ts | 9 | The GET review-queue read that gives the extract-document family its consumer surface (#153) |
| document-review-client.test.ts | 16 | Frontend fetch contract of the document-review consumer (#153) |
| perceptual-hash.test.ts | 25 | 64-bit dHash determinism, variants/distinct scenes, honest null |
| pdf-text.test.ts | 19 | PDF text extraction operators, compression, honest failures, caps |

**Security, auth & rate limiting — 22 files / 420 tests**

| File | Tests | Purpose |
|---|---|---|
| mutation-safety.test.ts | 21 | The default-on mutation safety gate — CSRF origin/allowlist posture (SEC-1) |
| security-headers.test.ts | 29 | CSP, HSTS, Permissions-Policy, frame-ancestors (#178, SEC-11) |
| guard.test.ts | 21 | Role registry, capability projections, supplier pin, internal-error hygiene |
| permissions.test.ts | 22 | Tab/role permission matrix, fail-closed unknown roles, client narrower than contractor |
| rate-limit.test.ts | 38 | Token bucket, login lockout, USSD PIN lockout, AI route body caps |
| rate-limit-store.test.ts | 55 | sqlite store cross-process sharing (#33), env wiring, init honesty, fail-open; hermetic memory-default pins |
| next-auth-boot-guard.test.ts | 11 | Production NEXTAUTH_SECRET boot guard (missing/short/build-exempt) |
| nextauth-fallback-secret.test.ts | 18 | Byte-identical v4.24 fallback mirror, gating, real token verify (#94) |
| share-token-binding.test.ts | 9 | Share token binds to exactly one project (BE-1) + route contract |
| share-token-entropy.test.ts | 4 | CSPRNG mint at project creation + regenerate (SEC-3) |
| share-link-expiry.test.ts | 23 | Expiry boundary, no-oracle 404/401, confirm-before-decide route contract (#172) |
| share-regenerate-gate.test.ts | 6 | share.regenerate lifecycle through the real applyAction (#172) |
| client-pin-fail-closed.test.ts | 5 | Unpinned client fail-closed edges (#175, SEC-7) |
| membership-scope.test.ts | 26 | Project-membership read scoping for the site team (#174, SEC-6) |
| idempotency-scope.test.ts | 10 | Idempotency-Key principal scoping — /api/actions half + one-seam helpers (#177, SEC-10) |
| idempotency-scope-realdb.test.ts | 4 | Principal-scoped replay on the real engine (#177) |
| client-actions.test.ts | 15 | CLIENT_ACTIONS allowlist completeness; no owner-mutation leaks; idempotency pins |
| pii-scrub.test.ts | 42 | Phone masking shapes, non-PII preserved, transcripts, idempotency |
| pii-scrub-wiring.test.ts | 9 | ASR boundary + parse seam + persistence chain scrubbed |
| webhook-secret-warning.test.ts | 16 | BE-6 one-time production warning semantics |
| jobs-token.test.ts | 16 | Bearer parsing, constant-time compare, route verdict |
| seed-guard.test.ts | 20 | The seed chain's production guard — NODE_ENV gate + confirm (#126/#180, DB-5/SEC-14) |

**Offline, sync & frontend contracts — 16 files / 349 tests**

| File | Tests | Purpose |
|---|---|---|
| sync-flag-gate.test.ts | 23 | action-flag-gate single definition + per-item /api/sync gating + share body cap |
| actions-sync-body-cap.test.ts | 6 | 1MB/2MB raw-body caps on /api/actions and /api/sync |
| outbox-versions.test.ts | 55 | Entity versioning; deterministic two-client task conflict; attendance versioning |
| outbox-client-chain.test.ts | 29 | The client half of the offline conflict chain — 11-type stale/fresh/absent/force matrix (#183) |
| outbox-auto-retry.test.ts | 13 | Bounded auto-retry for failed outbox items (#132, FE-6) |
| outbox-auth-drain.test.ts | 15 | Session-expiry drain invariants — 401 drain, re-login auto-drain (#191) |
| supplier-outbox.test.ts | 23 | The SUPPLIER outbox lifecycle, behavioral on the real store (#128, FE-4) |
| supplier-sync-api.test.ts | 11 | The supplier-scoped half of POST /api/sync (#128) |
| supplier-dispatch-label.test.ts | 10 | The supplier dispatch label kept for the outbox (#141, FE-10) |
| frontend-robustness.test.ts | 7 | Stale-response discard, real server errors surfaced, fail-while-online queues |
| frontend-a11y.test.ts | 28 | Error boundaries, contrast classes, 44px targets, tablist pattern, aria labels |
| html-lang.test.ts | 9 | `<html lang>` tracks the active locale (#130, FE-5) |
| header-sim-toggle-gate.test.ts | 14 | The online/offline simulation toggle gated out of production builds (#136, FE-7) |
| sw-offline-shell.test.ts | 31 | SW cache rules, offline boot gate, manifest/icon/offline.html, capture attr |
| sw-update-prompt.test.ts | 37 | The "app updated — reload" prompt for waiting workers (#148, FE-11 half) |
| push-routes.test.ts | 38 | Push subscribe/unsubscribe routes, payload parse, click routing, sw.js wiring |

**Platform — flags, storage, jobs, search, notify, i18n, observability — 23 files / 536 tests**

| File | Tests | Purpose |
|---|---|---|
| flags-gating.test.ts | 73 | Flags registry, requireFlagOn uniform gate, every flag family on actions/sync/v1 |
| storage-factory.test.ts | 12 | Driver env matrix fail-closed + cache seam |
| storage-local-disk.test.ts | 28 | Local disk driver: writes, URLs, capabilities, stat, docs tree, read passthrough |
| storage-s3-compat.test.ts | 27 | S3-compatible driver: URLs, presign, put, stat, fail-closed construction |
| storage-sigv4.test.ts | 20 | SigV4 golden GET/PUT signatures, failure modes |
| storage-presign-routes.test.ts | 29 | presign/confirm/legacy upload routes through the adapter |
| storage-resign-routes.test.ts | 26 | re-sign route: gates, fresh presigned GETs, entitlement, rate limit |
| storage-document-read.test.ts | 17 | mode=document writes + extractDocument driver read seam (#37) |
| upload-confirm-realdb.test.ts | 6 | /api/upload/confirm idempotency on the real engine — P2002 race path (#159, API-8) |
| supabase-design.test.ts | 34 | Supabase SQL design: schema completeness, RLS coverage, money typing, FK indexes, append-only |
| jobs-handler-timeout.test.ts | 5 | Per-handler drain timeout (BE-7) |
| jobs-run-handler.test.ts | 9 | ONE jobs/run POST handler behind both auth wrappers (#160, API-9/INF-5) |
| jobs-run-route.test.ts | 7 | POST /api/jobs/run auth selection |
| search-pushdown.test.ts | 7 | The /api/search LIKE pushed down into the Prisma queries (#163, API-12) |
| search-pushdown-realdb.test.ts | 8 | Pushdown parity vs the old in-memory algorithm on the real engine (#163) |
| search-window-order.test.ts | 6 | Projects search window recent-first (#166 + #163) |
| health-route.test.ts | 13 | The #164 health split: public liveness vs gated detail |
| log.test.ts | 28 | Structured logger + requestId propagation (#204, OBS-2) |
| error-sink.test.ts | 19 | Opt-in fail-open error sink (#202, OBS-1) |
| notify-channels.test.ts | 55 | SMS webhook/AT/VAPID provider resolution fail-closed; honest send outcomes; push payload contract |
| notify-prefs-gating.test.ts | 15 | Recipient-preference gating of the SMS channel (#36) |
| i18n.test.ts | 82 | en/sw key parity, placeholder parity, field-surface coverage, no raw literals |
| projects-flags-audit.test.ts | 10 | POST /api/projects and /api/flags write audit events (#162, API-11) |

**DB integrity & migrations — 6 files / 172 tests**

| File | Tests | Purpose |
|---|---|---|
| db-integrity-constraints.test.ts | 127 | The migration SQL pinned as behavior: unique constraints, the migration-14 ledger posting-gate/append-only triggers, per-migration blocks (DB-6/7/8; #121/#124) |
| db-fk-pragma.test.ts | 18 | PRAGMA foreign_keys boot assert — stub half (#135, DB-12) |
| db-fk-pragma-boot.test.ts | 4 | The boot wiring — instrumentation.ts register() (#135) |
| db-fk-pragma-realdb.test.ts | 6 | PRAGMA foreign_keys on the real engine — ON posture + P2003 orphan rejection (#135) |
| db-log-gating.test.ts | 5 | Prisma query logging is dev-only (BE-8) |
| status-ladder-realdb.test.ts | 12 | Status-ladder CHECK constraints through the real engine (#129, DB-10/11) |

**Gateways & scored domain modules — 4 files / 172 tests**

| File | Tests | Purpose |
|---|---|---|
| ussd-route.test.ts | 48 | USSD grammar, body cap, HMAC, PIN throttle/lockout, fallback policy, sim footer |
| whatsapp-route.test.ts | 41 | WhatsApp grammar, identity-by-phone, allowlist, HMAC, rate limits, audit context |
| mjengo-score.test.ts | 44 | MjengoScore determinism, component formulas, aggregation, append-only history |
| draw-pack.test.ts | 39 | DrawPack determinism/canonical hash, one immutable pack per release, share gate, i18n |

**Website / marketing site — 6 files / 73 tests**

| File | Tests | Purpose |
|---|---|---|
| website-contact-route.test.ts | 13 | Contact endpoint rate limiting + retention cap (#131, WD-1) |
| website-escrow-copy.test.ts | 9 | Escrow language aligned on approval-gated (#138, WD-3) |
| website-pii-backup.test.ts | 14 | The website-data leads volume in backup guidance — incl. a real tar round-trip (#151, WD-11) |
| website-pwa-manifest.test.ts | 10 | Manifest + icon-512 wiring (#142, WD-5) |
| website-sitemap.test.ts | 8 | Sitemap lastModified derived at render + origin/basePath URL contract (#143, WD-6; MW-9 regression) |
| website-siteurl-gate.test.ts | 19 | The SITE_URL build-time warning decision + launch-gate checklist pins (#149, WD-9) |

**Fence & meta gates — 4 files / 78 tests** (detail in §2c)

| File | Tests | Purpose |
|---|---|---|
| action-schemas.test.ts | 59 | Action schema registry invariants (#161, API-10) |
| openapi-cross-check.test.ts | 4 | OpenAPI documented ⇔ implemented, both directions (#165, API-14) |
| compose-log-rotation.test.ts | 9 | Bounded container logs on every compose service (#214) |
| tests/finance/gate.test.ts | 6 | The finance gate's own file-list fence (#215) |

**Domain totals:** 9+12+10+10+11+10+22+16+23+6+4+6+4 = **143 files**;
142+274+236+199+246+263+420+349+536+172+172+73+78 = **3,159 tests**.

## 4. Coverage posture (covered vs not — the honest table)

Updated from MOCK_DEMO_BASELINE §5.4; each row states where it stands
TODAY (the 2026-09-16 wording is preserved in the source doc).

| Domain | Status today | Evidence / gap |
|---|---|---|
| Procurement chain end-to-end | **COVERED** | `supply-chain-realdb.test.ts` walks RFQ→quote→PO→delivery(discrepancy)→invoice→escrow-funded ledger posting on the real engine (#184, TEST-6); supplier responses remain simulated in the UI (external #43) |
| Receiving / inspection states | COVERED (read side) | delivery-photos link-on-verify + discrepancy counts; the #196/#201/#206 receive-path lifecycle gaps landed with tests; no dedicated state-machine suite beyond those |
| Consumption / stock reconciliation | **COVERED** | movement (DB-2), consumption (#186), reconciliation (#194), slice aggregation + BOQ (#195) — stub + realdb pairs |
| Offline conflict resolution | **COVERED** | the 11-type stale/fresh/absent/force matrix + §41 semantic outcomes (#183); outbox drain/retry/auth lifecycles (#132/#191); residuals: unguarded localStorage (#192), no Background Sync (#193) |
| Payment retry / timeout flows | COVERED | daraja pending semantics + 401 refresh + the one-story lifecycle (#211); reconcile sweep stop conditions (#212) |
| Share-token lifecycle | **COVERED** | binding (BE-1), entropy (SEC-3), expiry/re-issue/confirm-before-decide (#172) |
| Rate-limit concurrency | PARTIAL | single-process bucket math + cross-process sqlite store tested; no true concurrent-race test; multi-host seam documented (MD-7) |
| Migration correctness | **COVERED in-suite** | the #184 harness applies the real `prisma migrate deploy` per realdb file; migration SQL also pinned directly (db-integrity-constraints, 127 tests); the CI job on a runner still waits on #98 |
| E2E browser tests | **COVERED** (outside vitest) | Playwright 7-persona golden paths on a real dev server + seeded DB (#182); not part of `bun run test` |
| Frontend rendering tests | **NOT COVERED** | frontend invariants are still behavioral/source-contract pins, no jsdom/RTL rendering (open #137 = FE-8/TEST-8) |
| Coverage tooling | **NOT COVERED** | no `@vitest/coverage-*`, no thresholds (open #185) |
| CI execution | **BLOCKED** | workflows fire on every push/PR but jobs never start (billing lock #98); gates hold via local runs per wave |

## 5. TEST findings register (current status)

| ID | Finding | Issue(s) | Status |
|---|---|---|---|
| TEST-1 | Zero E2E/browser tests | #182 | ✅ Playwright 7 personas |
| TEST-2 | Migrations never executed against a real DB | #184 | ✅ in-suite harness; CI job waits on #98 |
| TEST-3 | 70/71 files stub Prisma | #184 | ✅ superseded — realdb family added; stubs retained by design |
| TEST-4 | No coverage tooling | #185 | **open** |
| TEST-5 | Inventory module zero tests | #186, #195 | ✅ (+ drift finds #282/#285/#286) |
| TEST-6 | No procurement E2E test | #184 | ✅ supply-chain-realdb |
| TEST-7 | Share-token lifecycle untested | #172 | ✅ tests landed with the fix |
| TEST-8 | No runtime DOM tests | #137 | **open** |
| TEST-9 | fileParallelism:false slow-but-safe | — | deliberate, keep |
| TEST-10 | StockMovement.unitCost unit drift (found BY the #184 harness) | #282 | ✅ normalized to integer cents |
| TEST-10b | BoqLine.estUnitPrice unit drift (found BY the #195 audit) | #285 | ✅ (+ cross-project line update #286) |

## 6. Gate commands

```bash
bun run test            # the full suite — 143 files / 3,159 tests
                        #   (counts as of 2026-09-27 @ b035c74; re-run for current)
bun run test:finance    # the money-invariant release gate — 27 files / 629 tests
                        #   (same stamp; run on money-path PRs + before every release)
bun run lint            # eslint — 0 errors, 0 warnings
bunx tsc --noEmit       # strict typecheck — 0 errors
bun run site:lint       # marketing-site lint (mjengoos-website PRs)
bun run site:typecheck  # marketing-site strict typecheck (mjengoos-website PRs)
bun run test:e2e        # Playwright 7-persona golden paths (needs a running,
                        #   seeded dev server — see playwright.config.ts)

# fresh-DB gate: all migrations apply cleanly (run against a throwaway
# DATABASE_URL, e.g. file:/tmp/gate.db):
bunx prisma migrate deploy

# drift gate: migrations ⇔ schema, must report zero DDL:
bunx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url file:/tmp/shadow.db
```

CI runs the same gates on every push/PR (`test.yml` full suite, `ci.yml`
lint + strict tsc for both apps + real production build, `docker.yml`
image builds + the #198 compose smoke job) — with the standing caveat
that job starts are blocked by the #98 billing lock until the owner
restores billing, so the local run is the gate that actually executes.

## 7. Honest posture (read this before trusting the number)

- **A green suite is necessary, not sufficient.** 3,159 tests say the
  pinned contracts hold; they do not say the app is bug-free — the
  2026-09-16 audit found the suite green WHILE money was Float and
  inventory could go negative. What the suite is good at: regression
  pinning. Every fix since lands with its own pins (house rule).
- **Unit-level by design.** No DB or secrets needed, except the 14 realdb
  suites' throwaway SQLite files. No jsdom/RTL rendering; frontend
  coverage is behavioral-store + source-contract pins (#137 open).
- **No coverage percentages exist.** No provider is installed (#185) —
  anyone quoting a percentage is making it up.
- **E2E is real but manual-triggered.** Playwright needs a seeded dev
  server; it does not run in `bun run test` and has never run in CI
  (blocked with everything else by #98).
- **The finance gate is a subset, not a separate suite.** 27 of the 143
  files, same code, scoped include — its value is speed on money-path
  PRs, not extra coverage.
- **Counts drift by design.** Every wave adds tests; that is why this
  file exists (DOC-1): quote counts only with the date stamp, re-measure
  before quoting.
