# MJENGOOS TEST PLAN

**Document status:** Living document · v1.0 · Author: QA Architect (Task 14-c)
**Applies to:** MjengoOS @ `/home/z/my-project` — Next.js 16 App Router · TypeScript · Prisma/SQLite (36 models) · `src/backend/` core + 6 domain services · 11-tab single-page frontend.
**Product philosophy:** honest product — never fabricate verification; "Verification Risk", never an accusation; USSD attendance is self-reported; unknown registry lookups return an honest miss with official-channel guidance. **Every test below is written to protect that philosophy, not just functionality.**

---

## 1. Current state of testing (honest)

**There is no automated test suite today.** Verified facts, not assumptions:

- `package.json` contains **no test runner** — no `bun test` config, no vitest, no jest, no playwright, no `typecheck` script. The only quality gates that exist are `bun run lint` (eslint, 0 errors / 0 warnings as of the 12-backend release) and `bun run build`.
- The `tests/` directory on disk contains 3 sandbox-infrastructure shell scripts (runtime/build helpers) — they are **not** application tests and are gitignored.
- All verification to date has been **manual, browser-based, session-documented** in `worklog.md`. Every claim below is traceable to a recorded session.

### 1.1 What manual verification has already covered (worklog: 11-verify, 12-backend)

| Area verified | How | Result on record |
|---|---|---|
| Unauthenticated API access | Direct `fetch` to guarded routes without a session | `401` on all guarded APIs |
| Role enforcement (hidden-tab mirror) | client session calling owner APIs (`suppliers`, `intel`, `ussd`, `ai×5`, `sync`, `projects` POST, `land` POST) directly | `403` — server-side `SITE_ROLES`, not just hidden UI |
| Cross-project (tenant) isolation | Client session and P1 share token probing P2 `projectId` on land/events + legal | plain `404`, no data leak |
| Rate limiting | 31 rapid bad-token requests to the public share endpoint | `429` on the 31st (30/min/IP window); per-user write limit 30/min, AI 12/min |
| USSD PIN lockout | 3 wrong PINs in the simulator | lockout with honest message; also verified: unknown number → honest miss, PIN-less worker → "You have no PIN yet" (not "wrong PIN") |
| Share-token scoping | Zero-login `/?share=<P1 token>` | 7 read-only tabs, parcel detail incl. history + legal reviews, no site-team tools; bad token → `404` |
| Supply truth logic | order → deliver → verify 88/100 bags | Short-delivery mismatch text, supplier trust counters recomputed, watchlist status |
| Registry honest-miss | Title search `209/99999`; professional `LSK/P/1999/0001` | "We do not guess" honest miss + seller warning + Ministry of Lands pointer; lowercase `lsk/p/2016/2319` found (normalization works); punctuation fallback `ir 118923` → `I.R. 118923` |
| Money integrity | Milestone release without evidence photo | Rejected — money never moves without photo proof |
| Client surface | client@mjengo.os login | Exactly 7 tabs (Overview, Site Plan, Materials, Fundis, Money, Evidence, Land) |
| Mobile | 390×844 viewport on every tab | scrollWidth 390 (one Land-tab overflow root-caused and fixed in 11-verify); desktop 1440 clean |
| Offline sync | Offline outbox flush with role-stamped actions | `__actor`/`__role` from session; client allowlist enforced per action |
| Health | `GET /api` | `{ok, db:ok}`, `503` when DB down |

**What has never been tested:** regression safety nets after code changes, concurrent writes, duplicate-payment attempts, repeated-release idempotency under retry, offline conflict resolution, XSS/sanitization of text fields, full reseed determinism assertions. That is what this plan adds.

---

## 2. Recommended test stack

| Layer | Tool | Why this one |
|---|---|---|
| Unit + integration | **`bun test`** (bun's built-in runner) | Zero new dependencies — `bun-types` is already a devDependency; the repo already runs all scripts through bun (`bun run db:seed`, `bun prisma/seed.ts`). Fast, native TS, no config file needed for pure-logic tests. (Vitest is the fallback if the team later wants browser-mode component tests — it can reuse the same test files.) |
| E2E | **Playwright** (`@playwright/test`) | Matches how the product is actually used: a single-page app with three role surfaces (owner/admin/client) plus a **zero-login share surface** — Playwright handles multi-context (sessions) and multi-viewport (390×844 mobile assertions were done manually; codify them) natively. The worklog's agent-browser sessions prove the flows are browser-testable. |
| DB fixtures | Scratch SQLite via `DATABASE_URL` env + existing seed scripts | The project already has a complete 11-script deterministic seed chain (`bun run db:seed:all`) — reuse it as the fixture factory; point tests at a copy (e.g. `file:./test.db`), never the dev `db/custom.db`. |

Adoption guardrail: tests are added **without touching application code** behavior; when a test finds a bug, the bug is fixed in the app and the test is committed alongside (inspect → test → fix → retest).

---

## 3. Phased adoption plan

**Phase 1 — Pure-logic unit tests (no DB, no network) · target ≥ 60 cases, first week**
Exactly the deterministic core in `src/backend/core` + pure recomputes:

- `core/phones.ts` — `normalizeKenyanPhone` / `phoneForLookup`: `07..`, `+2547..`, `2547..`, `7..` forms; rejects landlines `011..`? (Kenya mobile prefixes), empty, garbage, too-long; idempotency (normalizing an already-normalized number).
- `core/http.ts` — `fieldStr` (trims, rejects non-strings), `fieldPos` (rejects 0/negative/NaN/`"5"` string coercion), `fieldNonNeg`, `optionalId`, `normalizeReference` (auto `MPESA-XXXXXXXX` format, bank → `BANK-`, card → `CARD-`).
- `core/rate-limit.ts` — `checkRateLimit` sliding window: allows exactly `limit` calls in the window, denies `limit+1`, recovers after `windowMs` (use fake timers); `clientIpOf` header precedence; `ipRateLimited` returns null-when-allowed.
- `core/policy.ts` — `SITE_ROLES` / `SIGNED_IN_ROLES` constants and `LIMITS` shape (compile-time guard: adding a new limit preset without a route using it should fail a completeness test).
- `domains/supply/supply-service.ts` — `recomputeSupplierTrust` banding: verified-count vs mismatch-count thresholds → `verified` / `watchlist` / `new`; above-benchmark threshold (`unitCost > marketCost × 1.1`).
- Intel risk banding (schema contract): `score 0–33 → low`, `34–66 → medium`, `67–100 → high` — assert band helper boundaries in tests that consume `RiskAssessment`.

**Phase 2 — API integration tests against a scratch SQLite DB · second week**
Boot route handlers directly (or via `next dev` on a scratch port with `DATABASE_URL` pointing at a seeded copy):

- Fixture: copy dev DB → run `db:seed:all` → snapshot as golden fixture; each suite starts from the snapshot.
- Cover: `withGuard` matrix (401/403/200 × 3 roles × representative routes), `/api/sync` allowlist + `actions[] > 200` rejection + `__actor` stamping, money action state machine (`locked → evidence_submitted → release_requested → released/rejected`, double-decide rejection, insufficient-escrow rejection, cross-project milestone id rejection, evidence photo must belong to the project), supply order lifecycle incl. trust recompute side effects, USSD state machine transitions, land/legal project pinning, share-token 404/200, per-route rate limits.
- **Financial invariant tests (spec §80):** escrow `balance` must equal `Σ top-ups − Σ released milestones`; every release writes exactly one `Transaction(type: 'milestone')`; duplicate identical `escrow.topup` payload is two intentional top-ups (allowed) but duplicate `milestone.decide` approve is **rejected** (state machine) — document both.

**Phase 3 — Playwright E2E for the critical workflow · weeks 2–4**
Codify §4's mapped chain (the supported subset) as one long spec test plus per-tab specs; three browser contexts (owner, client, share-link visitor); mobile project (`390×844`) asserting `document.scrollWidth === 390` on every tab (the exact regression 11-verify caught by hand).

**Phase 4 — Security & tenant-isolation suite · week 4+**
The §6.4 probes as permanent specs: 401 unauth matrix, 403 role matrix, 404 cross-project matrix, 429 rate-limit windows (share 30/min/IP), XSS probe battery, sync-allowlist bypass attempts, share-token enumeration (bad tokens must be 404 and rate-limited — never 500 or timing-oracle distinguishable).

CI gate (when a CI runner exists): `bun run lint` + `bun test` + `playwright test` on every change; `bun run build` on release.

---

## 4. Critical E2E workflow — spec §81 mapped to MjengoOS TODAY

The spec demands this 31-step chain "must actually work". Honest mapping, verified against the repo (routes, `schema.prisma`, tab components) — not against the spec's optimism:

| # | Spec step | Status in MjengoOS today | Where / what's missing |
|---|---|---|---|
| 1 | Create organization | **Not supported** | No `Organization` model (36 models checked). Deployment is single-org; users are contractor/client/admin. |
| 2 | Create client | **Partial** | Client is a `String client` field on `Project` (+ `clientType`), set in the create-project dialog. No Client entity, directory, or login per client. |
| 3 | Create property | **Partial** | `LandParcel` exists (optionally linked to a project) with parcels/surveyors sub-tabs, but parcels are seeded/managed in the Land tab — property creation is not part of project creation. |
| 4 | Upload title | **Partial** | `ParcelDocument` model with OCR progress + honest notes; `/api/upload` handles photos. No general title-document upload UI — documents arrive via seed; no arbitrary file upload for titles. |
| 5 | Verify document | **Partial** | OCR progress bars (96/91/71/88% seeded) with honest caveats. No authoritative registry verification — by design (simulated registry, honest-miss pattern on searches instead). |
| 6 | Find surveyor | **Supported** | Land tab → Surveyors directory (5 seeded, one deliberately unverified — the honest example). |
| 7 | Surveyor verifies credentials | **Partial** | Surveyor records carry verified status, but credential verification is not interactive. Interactive board-roll verification exists for **professionals** (LSK/EBK/BORAQS/IQSK) via `api/professionals` verify (found + honest miss), not surveyors. |
| 8 | Client requests survey | **Not supported** | No survey-request workflow. The analogous flow — legal review requests with scope (`title/transfer/diligence/dispute`) — exists via `api/legal`. |
| 9 | Surveyor accepts | **Not supported** | No acceptance state machine for surveys. |
| 10 | Offline field inspection | **Partial** | Offline outbox + `/api/sync` exists for site actions (attendance, materials…). No surveyor field-inspection form. |
| 11 | Sync | **Supported** | `/api/sync`: ≤200 actions per flush, per-action allowlist for clients, `__actor`/`__role` stamped from session (offline actions are ledger-attributed). |
| 12 | Survey report | **Not supported** | No survey-report model. Closest existing deliverable: `LegalReview` opinions (delivered, scope-honest, covered-checks checklist). |
| 13 | Create project | **Supported** | Overview tab → create-project dialog → `POST /api/projects` (withGuard, SITE_ROLES). |
| 14 | Create BOQ | **Not supported** | No BOQ model or UI. Money tab tracks budget/expenses/escrow; milestones are the payment-against-work abstraction. |
| 15 | Publish procurement request | **Partial** | Supply tab → new-order dialog with benchmark auto-fill by material similarity — but it's a direct purchase order to a chosen supplier, not a published RFQ. |
| 16 | Supplier bids | **Not supported** | No bidding. Suppliers have trust metrics (verified/watchlist/new) used to inform, not a bid intake. |
| 17 | Select supplier | **Partial** | Supplier chosen in the order dialog (cards show trust metrics to inform choice); no comparative bid selection. |
| 18 | Purchase order | **Supported** | `SupplyOrder` via `order.create` (status `ordered`), audit-logged. |
| 19 | Delivery | **Supported** | `order.deliver` action; Delivery model for materials flow; verify flow asks "How many actually arrived?". |
| 20 | Inventory update | **Partial** | Materials tab tracks deliveries + consumption per material. Supply verify updates delivered-vs-invoiced; no warehouse-level inventory. |
| 21 | Worker attendance | **Supported** | Fundis tab (methods: geofence/ussd/app/kiosk_pin/qr_card/manager; verification: verified/reported/exception; append-only overrideLog) + USSD check-in (self-reported, honestly labeled). |
| 22 | Daily report | **Supported** | `Recap` model + AI recap route; Overview "Day N" digest. |
| 23 | Photo progress | **Supported** | Evidence tab: SitePhoto upload (`/api/upload`), zones, timelapse, photo comments, AI analyze-photo. |
| 24 | Client review | **Partial** | Client surface shows photos and can comment (`comment.add` is a client action); formal review/acceptance exists only as milestone decisions. |
| 25 | Invoice | **Not supported** | No Invoice model. "Voice-to-invoice" is a copilot naming for structured delivery logs; supply orders reference "invoiced quantity" only. |
| 26 | Approval | **Partial** | `milestone.decide` (approve/reject, by client, with note) — a real approval workflow for milestones, not for invoices. |
| 27 | Payment | **Partial** | `escrow.topup` records method + reference (auto `MPESA-XXXXXXXX`); approve → release debits escrow and writes `Transaction(type: 'milestone')`. No payment provider executes anything — reference strings only (honest: no fake payment success). |
| 28 | Ledger | **Supported** | `Transaction` ledger (wage/material/transport/milestone…) + `AuditEvent` audit ledger; Money tab. |
| 29 | Reconciliation | **Not supported** | Escrow balance vs transactions is internally consistent; no provider statements/webhooks to reconcile against. |
| 30 | Project completion | **Partial** | `Project.status` supports `completed`, but there is no guided completion workflow (snag list, handover, final account). |
| 31 | Property Passport | **Not supported** | No PropertyPassport model/route. All ingredients exist (parcel, documents, events, legal opinions, photos, milestones) — it is an assembly gap, not a data gap. |

**Score: 10 supported · 12 partial · 9 not supported.** The Phase-3 E2E spec must run the supported spine end-to-end (create project → phase/task → materials delivery → attendance → recap → photo → milestone evidence → client release request → client approve → escrow debit + ledger → audit trail) and assert the partial steps fail **honestly** (never silently pretend).

---

## 5. Manual browser test protocol (reusable, pre-Playwright)

Run before every release; log results in the worklog. Environment: dev server on `:3000 (do not restart mid-run)`, pristine reseed via `bun run db:seed:all`.

### 5.1 Login matrix

| # | Role | Credentials | Expected |
|---|---|---|---|
| L1 | Owner/contractor | `contractor@mjengo.os` / `mjengo2026` | Login OK; 11 tabs; full site-team surface |
| L2 | Client | `client@mjengo.os` / `mjengo2026` | Login OK; exactly 7 tabs — Overview, Site Plan, Materials, Fundis, Money, Evidence, Land (no Copilot/Supply/Intel/USSD) |
| L3 | Admin | `admin@mjengo.os` / `admin2026` | Login OK; 11 tabs; all owner APIs return 200 |
| L4 | Bad password | valid email + wrong password | Login rejected; no session cookie |
| L5 | Share visitor | none (localStorage cleared, `/?share=<valid P1 token>`) | Virtual Site Visit: 7 read-only tabs incl. Land parcel detail w/ history + legal; no site-team tools |
| L6 | Bad share token | `/?share=garbage` | 404 / honest "link not found", never a stack trace |

### 5.2 Tab visibility matrix

| Tab | Owner | Admin | Client | Share visitor |
|---|---|---|---|---|
| Overview | ✓ | ✓ | ✓ | ✓ |
| Site Plan | ✓ | ✓ | ✓ | ✓ |
| Materials | ✓ | ✓ | ✓ | ✓ |
| Supply | ✓ | ✓ | ✗ (403 at API even if forced) | ✗ |
| Fundis | ✓ | ✓ | ✓ | ✓ |
| Money | ✓ | ✓ | ✓ | ✓ |
| Evidence | ✓ | ✓ | ✓ | ✓ |
| Land | ✓ | ✓ | ✓ (read-only; search input hidden, "Registry searches — read-only") | ✓ (own parcel only) |
| Intel | ✓ | ✓ | ✗ | ✗ |
| USSD | ✓ | ✓ | ✗ | ✗ |
| AI Copilot | ✓ | ✓ | ✗ | ✗ |

### 5.3 Ten highest-value destructive flows (expected results)

| # | Flow | Expected result |
|---|---|---|
| D1 | `escrow.topup` with amount 0 / negative / `"abc"` | Rejected: "Top-up amount must be a number greater than zero"; escrow balance unchanged; no Transaction written |
| D2 | `milestone.requestRelease` with **no** evidence photos | Rejected: "Attach proof-of-work photos first" — money never moves without photo proof |
| D3 | `milestone.decide` approve when escrow balance < amount | Rejected: "Insufficient escrow balance — top up first"; milestone stays `release_requested` |
| D4 | `milestone.decide` on the same milestone twice | Second call rejected: "Milestone is not awaiting a client decision" (duplicate-release prevention, spec §80 financial test) |
| D5 | Contractor (non-client) tries `milestone.decide` via direct API | Rejected by allowlist/role policy — only the client decides releases |
| D6 | Supply `order.verify` short delivery (88 of 100 bags) | Order flagged mismatch "Short delivery: 88 of 100 bag received vs invoiced"; supplier verified/mismatch counters recomputed; status may downgrade to watchlist |
| D7 | USSD: 3 wrong PINs in one session | Lockout with honest message; no attendance row created; session attempts visible in state |
| D8 | Attendance manual override with exception reason | verification → `exception`, overrideLog **appended** (append-only — earlier entries never erased), exceptionReason recorded |
| D9 | `/api/sync` flush containing a client-forbidden action (e.g. `worker.*`) mixed with allowed ones | Per-action result: forbidden one `ok:false` with role error; allowed ones succeed; nothing silently dropped |
| D10 | Upload photo > size cap / malformed base64 to `/api/upload` | Clean 4xx with exact UX message; no partial file written; error boundary logs tagged, no stack leak |

### 5.4 Security probes (must-pass, every release)

| # | Probe | Expected |
|---|---|---|
| S1 | Unauthenticated `GET/POST` to guarded APIs (suppliers, intel, ussd, projects, land POST, ai×5, sync, upload) | `401` |
| S2 | Client session calling owner API (e.g. `POST /api/suppliers`) | `403` |
| S3 | Client session probing foreign `projectId` (P2) on land/events + legal | plain `404`, no foreign data |
| S4 | 31 rapid requests to share endpoint (bad tokens) | `429` on the 31st; tokens never verifiable via error differences |
| S5 | XSS probe: `<script>alert(1)</script>` and `<img src=x onerror=…>` in project name, worker name, photo comment, legal scope note, supply order note | Stored **as text**, rendered escaped; no execution anywhere (React default escaping intact — verify no `dangerouslySetInnerHTML` on these paths) |
| S6 | `GET /api` health | `{ok:true, db:"ok"}`; with DB stopped → 503 (do not attempt on shared dev DB — verify code path only) |
| S7 | Prototype pollution / oversized payload: `actions[]` of 201 to `/api/sync` | `400` "actions[] too long (max 200 per flush)" |

---

## 6. Per-module test case tables

Priorities: **P0** = release blocker (honesty/security/money), **P1** = core workflow, **P2** = polish/regression.

### 6.1 Money (escrow, milestones, variations, ledger)

| ID | Preconditions | Steps | Expected result | Pri |
|---|---|---|---|---|
| MO-01 | Owner logged in, project P1 open | Money tab → top up escrow KES 100,000, method M-Pesa, reference blank | Balance increases by 100,000; auto-reference `MPESA-XXXXXXXX` generated; audit event written | P1 |
| MO-02 | Escrow ≥ amount | Create milestone "Roofing" KES 40,000 → attach ≥1 evidence photo → request release | Status chain locked → evidence_submitted → release_requested; client notification created | P1 |
| MO-03 | Milestone in release_requested | Client logs in → Money tab → approve with note | Status `released`; escrow debited 40,000; one `Transaction(type:'milestone')` written; decidedBy stamped | P0 |
| MO-04 | Milestone already released | Repeat `milestone.decide` approve | Rejected — no double payment | P0 |
| MO-05 | Escrow 0 | Request release approval on 40,000 milestone | "Insufficient escrow balance — top up first" | P0 |
| MO-06 | Milestone with no evidence photos | `milestone.requestRelease` | Rejected — proof-of-work gate | P0 |
| MO-07 | Two projects exist | Submit milestone action with P2 milestone id while scoped to P1 | "Milestone not found in this project" (project pinning) | P0 |
| MO-08 | Owner on Money tab | Add expense (material, KES 2,500, method cash) | Transaction row appears; totals update; audit logged | P1 |
| MO-09 | Variation submitted | Client rejects variation with note | Variation rejected; phase budget **not** adjusted; decision recorded | P1 |
| MO-10 | Escrow has balance | Verify balance = Σ top-ups − Σ released milestones across seeded data | Invariant holds (ledger honesty) | P0 |

### 6.2 Fundis (workers, attendance, offline sync)

| ID | Preconditions | Steps | Expected result | Pri |
|---|---|---|---|---|
| FU-01 | Owner logged in | Fundis tab → add worker (name, phone `0712345678`, daily wage) | Worker card appears; phone stored normalized | P1 |
| FU-02 | Worker exists | Mark attendance present, method geofence | Row created; verification `verified` (worker/kiosk evidence class) | P1 |
| FU-03 | Worker exists | Override a verified record to absent with reason "forgot" | verification → `exception`; overrideLog **appends** (previous entry retained); never erased | P0 |
| FU-04 | Attendance exists | Mark wage paid | `paid=true`; unpaid-wage sums (used by USSD balance) decrease | P1 |
| FU-05 | Device "offline" (queue actions locally) | Queue 3 attendance actions → flush `/api/sync` | All 3 applied; each stamped `__actor`/`__role` from session; audit ledger entries attributed | P0 |
| FU-06 | Client session offline queue | Queue `worker.create` + `comment.add` → flush | `worker.create` per-action `ok:false` (not in CLIENT_ACTIONS); comment succeeds | P0 |
| FU-07 | Sync flush of 201 actions | POST `/api/sync` | 400, max 200 per flush | P1 |
| FU-08 | Two workers, same date | Duplicate attendance for same worker+date | Second record rejected or surfaced as exception (no silent double wage) | P0 |
| FU-09 | Worker with attendance history | Delete worker | Cascade behavior documented: attendance rows cascade-deleted, Transaction wage ledger remains — confirm no orphaned UI | P1 |
| FU-10 | Mobile 390px | Open Fundis tab | scrollWidth 390; no horizontal overflow | P2 |

### 6.3 Evidence (photos, zones, comments, AI analysis)

| ID | Preconditions | Steps | Expected result | Pri |
|---|---|---|---|---|
| EV-01 | Owner logged in | Capture/upload photo with zone + caption | Photo in public/photos; SitePhoto row; appears in timeline/timelapse | P1 |
| EV-02 | Photo exists | Attach as milestone evidence | Milestone evidencePhotoIds includes id; status → evidence_submitted | P1 |
| EV-03 | Photo from P2 | Attempt to attach to P1 milestone via API | "One or more photos do not belong to this project" | P0 |
| EV-04 | Client logged in | Comment on photo | Comment added (`comment.add` is a client action); owner sees it | P1 |
| EV-05 | Owner | Run AI photo analysis on a progress photo | Structured result with confidence; human confirmation required for any derived claim; no fabricated verification | P0 |
| EV-06 | Empty project (no photos) | Open Evidence tab | Honest empty state, not a broken grid | P2 |
| EV-07 | Upload malformed base64 | POST `/api/upload` | Clean 4xx; no file written; error boundary tagged `[api/upload]` | P1 |
| EV-08 | XSS probe in caption/comment | Submit `<img src=x onerror=alert(1)>` | Stored as text, rendered escaped | P0 |
| EV-09 | Share visitor | Open share link → Evidence | Read-only photos/timelapse visible; no upload/comment controls for site-team-only actions | P1 |
| EV-10 | Mobile 390px | Evidence tab + timelapse | scrollWidth 390 | P2 |

### 6.4 Supply (suppliers, orders, benchmarks, trust)

| ID | Preconditions | Steps | Expected result | Pri |
|---|---|---|---|---|
| SU-01 | Owner logged in | Supply tab → new order, material "cement" | Benchmark auto-fills market cost by material-name similarity | P1 |
| SU-02 | Order status `ordered` | Mark delivered | Status `delivered` | P1 |
| SU-03 | Delivered order (100 bags) | Verify with 100 arrived, at-market unit cost | Status `verified`; supplier verifiedCount +1; "at market" label | P1 |
| SU-04 | Delivered order (100 bags) | Verify 88 arrived | Mismatch: "Short delivery: 88 of 100 bag received vs invoiced"; mismatchCount +1; trust may downgrade to watchlist | P0 |
| SU-05 | Delivered order | Verify with unit cost > market × 1.1 | Above-benchmark mismatch flagged (+N%) | P1 |
| SU-06 | New supplier (no orders) | Check supplier card | Status `new` — honest, not pre-trusted | P0 |
| SU-07 | Client session | `POST /api/suppliers` (any action) | 403 | P0 |
| SU-08 | Owner | Verify same order twice | Second attempt rejected or surfaced as already-verified — no double-counted trust | P1 |
| SU-09 | Benchmarks list | Open benchmarks table | Market costs render with units; used in verify comparison | P2 |
| SU-10 | Mobile 390px | Supply tab | scrollWidth 390 | P2 |

### 6.5 Land (parcels, title search, surveyors, professionals, legal)

| ID | Preconditions | Steps | Expected result | Pri |
|---|---|---|---|---|
| LA-01 | Owner logged in | Title search `I.R. 118923` | Found: parcel summary | P1 |
| LA-02 | Any signed-in role | Search `209/99999` (unknown) | **Honest miss**: "we do not guess" + seller warning + Ministry of Lands official-channel pointer — never a fabricated match | P0 |
| LA-03 | Owner | Search `ir 118923` (punctuation/space variant) | Found via punctuation-insensitive fallback (false misses on real parcels are the scariest answer) | P0 |
| LA-04 | Land tab | Open Surveyors | 5 listed incl. one deliberately unverified, clearly labeled | P1 |
| LA-05 | Owner | Professionals verify `lsk/p/2016/2319` (lowercase) | Found (normalization); board roll detail; professional marked verified | P1 |
| LA-06 | Owner | Verify `LSK/P/1999/0001` (unknown) | Honest "we cannot confirm it / does not prove it is fake" — miss, not accusation | P0 |
| LA-07 | Owner | Legal request scope `diligence` | Assigned to a **verified** lawyer; covered-checks checklist shown; scope disclaimer | P1 |
| LA-08 | Client session | Attempt `POST /api/land` (title search) | 403 (registry writes are site-team only) | P0 |
| LA-09 | Client of P1 | Probe P2 parcelId on land/events + legal | Plain 404 | P0 |
| LA-10 | Share visitor | Open parcel detail | History timeline + legal reviews render (share-aware); read-only | P1 |
| LA-11 | Parcel with caveat (Ruiru R. 443/2) | Open parcel history | Caveat/succession/mutation events flagged with attention dots; "No events flagged" line only for clean parcels | P1 |
| LA-12 | Mobile 390px | Land tab incl. badges | scrollWidth 390 (whitespace-nowrap regression guard) | P2 |

### 6.6 Intel (signals, digests, Verification Risk)

| ID | Preconditions | Steps | Expected result | Pri |
|---|---|---|---|---|
| IN-01 | Owner logged in | Open Intel tab | Live KPIs computed from real project data (attendance verified %, milestones-with-evidence, open signals) — not static numbers | P0 |
| IN-02 | Seeded assessments | Open Verification Risk panel | Grouped by entity type; factors lists; band low 0–33 / medium 34–66 / high 67–100; footer "not an accusation" | P0 |
| IN-03 | Open signal exists | Acknowledge → Resolve | Status badges transition open → acknowledged → resolved | P1 |
| IN-04 | Client session | `GET/POST /api/intel` | 403 (site-team surface) | P0 |
| IN-05 | Owner | Inspect digest "Day N" | Digest reflects current project state after reseed | P1 |
| IN-06 | Worker with low verification | Check assessment naming | Says "Verification Risk" everywhere — never "fraud score"/"suspicion" (wording is a P0 honesty invariant) | P0 |
| IN-07 | All signals resolved | Open Intel | Zero-open-states render honestly (empty states, not fake feed) | P2 |
| IN-08 | Mobile 390px | Intel tab | scrollWidth 390 | P2 |

### 6.7 USSD (simulator, state machine, honest self-report)

| ID | Preconditions | Steps | Expected result | Pri |
|---|---|---|---|---|
| US-01 | Owner logged in | Simulate dial → menu → 1 (attendance) → PIN `1234` | "Asante <name>! checked in… **Self-reported**"; Attendance row method `ussd`, verification `reported` — never shown as verified | P0 |
| US-02 | Worker with unpaid wages | Dial → 2 (balance) → PIN | Balance equals live unpaid-wage sum (KES) | P1 |
| US-03 | Any worker | 3 wrong PINs | Lockout; honest message; no attendance row | P0 |
| US-04 | Unknown phone number | Dial → attendance → any PIN | Honest "number not recognized"-class message — no phantom check-in | P0 |
| US-05 | PIN-less worker | Attendance flow | "You have no PIN yet" — not "wrong PIN" (no misleading error) | P0 |
| US-06 | Session idle > 5 minutes | Resume input | Honest "dial again" expiry message; state not resurrected | P1 |
| US-07 | Input buffer | Type multi-digit PIN using keypad then Send | Keys accumulate (the mid-verification bug class of 11-d); one submission per Send | P1 |
| US-08 | Client session | `GET/POST /api/ussd` | 403 | P0 |
| US-09 | Successful check-in | Inspect audit ledger | Attendance + audit entry written | P1 |
| US-10 | Mobile 390px | USSD simulator panel | scrollWidth 390; keypad usable | P2 |

### 6.8 Share (public Virtual Site Visit)

| ID | Preconditions | Steps | Expected result | Pri |
|---|---|---|---|---|
| SH-01 | Valid P1 share token | Open `/?share=<token>` (clean localStorage) | 7 tabs render; project data visible; zero login required | P1 |
| SH-02 | Bad token | `/?share=garbage` | 404/honest not-found; no enumeration hints | P0 |
| SH-03 | P1 token | Probe P2 events/legal/parcel ids | 404 — token pinned to its own project | P0 |
| SH-04 | Share visitor | Look for site-team tools (order create, attendance edit, intel) | Absent — not merely disabled buttons that still call APIs | P0 |
| SH-05 | Rapid-fire | 31 requests within a minute | 429 on the 31st; per-IP limit 30/min | P0 |
| SH-06 | Share visitor | Attempt POST mutations via console | Rejected by role/allowlist — share surface is read-only | P0 |
| SH-07 | Share visitor | Open Land tab | Own parcel + history + legal reviews render share-aware; registry search input hidden | P1 |
| SH-08 | Mobile 390px | Share surface all tabs | scrollWidth 390 (11-verify found the Land overflow here first) | P2 |
| SH-09 | Two projects' tokens | Visit P1 then P2 tokens sequentially | No cross-project state bleed in localStorage/session | P1 |
| SH-10 | Client-visibility parity | Compare share tabs vs client tabs | Same 7-tab set; client additionally gets Money actions (milestone decide) share lacks | P1 |

---

## 7. Definition of Done checklist (adapted from spec §95)

A feature is **NOT** complete unless every box is checked — with evidence, not vibes:

- [ ] **UI** — rendered in the owning tab(s), correct role surface (11/7-tab matrices)
- [ ] **Backend** — logic lives in `src/backend/` (core or domain service), route is a thin controller behind `withGuard`
- [ ] **Database** — Prisma model + migration/db:push applied; seeded in the 11-script chain (`db:seed:all`)
- [ ] **Validation** — `fieldStr/fieldPos/fieldNonNeg` on every input; exact UX error strings (not stack traces)
- [ ] **Authorization** — role enforced server-side (`SITE_ROLES`/`SIGNED_IN_ROLES`/allowlists); hidden tab mirrored by API rejection
- [ ] **Tenant isolation** — foreign projectId/parcelId/photoId/milestoneId probes return 404 (pinning verified)
- [ ] **Error handling** — error boundary catches; tagged `[api/<route>]`; no leaks to client
- [ ] **Loading state** — skeletons/spinners during fetch
- [ ] **Empty state** — honest empty text, no broken grids
- [ ] **Mobile** — 390×844 scrollWidth 390 on every new surface
- [ ] **Offline where required** — action works via outbox + `/api/sync`, role-stamped, ≤200 per flush
- [ ] **Tests** — Phase 1–4 case for the new logic; this plan updated with new cases
- [ ] **Audit logging** — `logAudit` on every mutation (money/supply/land/ussd already comply)
- [ ] **Documentation** — `src/backend/README.md` conventions + this test plan + README updated
- [ ] **Honesty audit** — no fabricated verification anywhere: misses are misses, USSD is self-reported, risk is "Verification Risk", unknowns point to official channels

---

*Maintained alongside `MJENGOOS_ROADMAP.md` in `/home/z/my-project/docs/`. When a Phase lands, update §1 (current state) and move §3 phases to "done" — this document must never claim tests that do not exist.*
