# MJENGOOS FEATURE AUDIT — STATUS MATRIX

**Document status:** v1.0 · 2026-08-28 · Author: Repository Auditor (Task 14-a)
**Method:** static inspection of every route/service/schema/component + targeted greps (TODO/mock/dummy/console.log/etc.) + live browser verification (agent-browser, session `14a`, roles: contractor + client). Companion documents: `docs/MJENGOOS_ROADMAP.md` (14-c, strategy) and `docs/MJENGOOS_TEST_PLAN.md` (14-c, QA). Where reality differs from spec optimism, reality wins.

---

## (a) Executive summary

MjengoOS is a **working, honest, demo-grade product**: **15 of the spec's 30 primary objectives are fully implemented (50%), 8 are partial (27%), 7 are missing (23%)** — i.e. 23 of 30 objectives are at least partially delivered. The strong core (P0–P2 tiers of spec §94) is real and browser-verified end-to-end: 36 Prisma models, 17 API routes behind a canonical guard (session + role matrix + per-user rate limits + tagged error boundary), 6 domain services in `src/backend/domains/`, an 11-tab SPA with a correctly-scoped 7-tab client surface and zero-login share links, a 37-action dispatcher with an append-only audit ledger, USSD for feature phones, and honest-miss registry semantics (land titles, professional boards) that never fabricate verification. The decisive gaps are infrastructural, not UX: **there is not a single automated test** (no runner in `package.json`, no test script — tests are 🔴 across the whole matrix), offline is a simulated toggle + persisted outbox rather than a PWA, money is simulated (no M-Pesa), and the marketplace/bidding/BOQ/wallet/organization/globalization tiers (P3–P5, P7 items) are absent. Code hygiene is unusually clean for this stage: **zero real TODO/FIXME/mock/dummy hits in `src/` + `prisma/`** (only false positives: input `placeholder=` attributes, a `'todo'` stepper-state string, documentation comments), and every `console.*` is a tagged `console.error` inside an error boundary.

---

## (b) Feature status matrix — all 30 primary objectives (spec §1)

Legend: ✅ complete · 🟡 partial · 🔴 missing · ⚠ broken · 🧪 needs testing.
Common notes that apply everywhere and are not repeated per-row: **AuthN** = NextAuth v4 credentials + JWT cookie (`src/lib/auth.ts`, scrypt hashes) on every guarded route. **Validation** = manual helpers in `src/backend/core/http.ts` (`fieldStr/fieldPos/fieldNonNeg/normalizeReference`) — solid but no schema library (`zod` is installed and unused). **Tests** = 🔴 no automated suite exists (no runner, no script; verification is manual browser QA documented in `worklog.md`). **Mobile** = responsive 390px verified in Wave-11 QA.

### Land & Property

| # | Feature | Module (tab/route/service files) | Frontend | Backend | Database | API | AuthN | AuthZ | Validation | Error handling | Mobile | Offline | Tests | Integration | Current implementation | Missing work | Priority | Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Property & land verification (obj 1) | `land-tab.tsx` + `land/*` · `/api/land`, `/api/land/events` · `backend/domains/land/land-service.ts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ session OR share-token, client pinned to own project | 🟡 manual | ✅ boundary + honest miss | ✅ | 🔴 | 🔴 | 🟡 simulated eRegistry | Title search (case/punct-normalized), parcel cards, OCR match %, history, surveyor directory; unknown numbers → honest miss "we do not guess" + Ministry of Lands pointer (browser-verified this audit) | Real registry integration (Ardhisara API); OCR is seeded scores, not a live pipeline | P2 | Ship as-is for demo; build OCR + registry adapters behind the existing honest-miss interface |
| 2 | Property passport (obj 27) | none (LandParcel is the raw material) | 🔴 | 🔴 | 🟡 | 🔴 | ✅ | ✅ | n/a | n/a | n/a | n/a | 🔴 | 🔴 | Parcel registry record + docs + events + legal opinions all exist per-parcel, but there is no consolidated "passport" view/export | Passport page/PDF aggregating registry record, documents, OCR scores, history, legal status per parcel | P2 | Cheap, high-trust win — compose existing data into one export |
| 3 | Verified professional network (obj 2) | `land/professional-directory.tsx` · `/api/professionals` · `backend/domains/professionals/professionals-service.ts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ SITE_ROLES on POST | 🟡 manual | ✅ | ✅ | 🔴 | 🔴 | 🔴 | 16 seeded professionals (LSK/EBK/BORAQS/IQSK), 15-card directory with board-verified badges + honest "Not confirmed" | No professional onboarding/self-registration; no real board API | P2 | Keep directory read-only; add signup + board API adapter later |
| 4 | Professional verification (obj 26) | same as row 3 · `VerificationRequest` model | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ reg-no normalization (lowercase/punct) | ✅ found/not_found honest results | ✅ | 🔴 | 🔴 | 🔴 | Verify-someone flow: found → board roll detail + marks verified; not_found → honest "we cannot confirm it / does not prove it is fake"; requests logged | Real board registry lookups | P2 | Pattern is correct — swap simulated registry for live adapters |

### Project Management

| # | Feature | Module | Frontend | Backend | Database | API | AuthN | AuthZ | Validation | Error handling | Mobile | Offline | Tests | Integration | Current implementation | Missing work | Priority | Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5 | Construction project management (obj 3) | `app.tsx`, `project-switcher.tsx`, `create-project-dialog.tsx`, `site-plan-tab.tsx` · `/api/projects`, `/api/project`, `/api/actions` · `lib/mjengo.ts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ POST /api/projects SITE_ROLES; client pinned | 🟡 manual | ✅ | ✅ | 🟡 outbox for actions | 🔴 | 🔴 | Multi-project SPA: switcher, 6-phase template wizard, phase/task CRUD (37 action types), progress tracking | Templates are fixed; no project archiving/archive view | P0/P1 | Keep; harden with tests |
| 6 | Project budgeting (obj 13) | `overview-tab.tsx`, `money-tab.tsx`, `expense-dialog.tsx` · `actions/money.ts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ amounts >0 validated | ✅ | ✅ | 🟡 expense.create via outbox | 🔴 | 🔴 | Phase budgets, budget-spent KPI, expense recording, CSV exports, variation orders move budget on approval | No budget-vs-actual forecasting | P1 | Solid; forecasting belongs to AI tier later |
| 7 | BOQ management (obj 14) | none | 🔴 | 🔴 | 🔴 | 🔴 | n/a | n/a | n/a | n/a | n/a | n/a | 🔴 | n/a | Nothing — no BOQ model, UI, or import (materials ≠ BOQ) | BOQ model, import (Excel/CSV), phase mapping, quantity tracking vs consumption | P1/P3 | Sizeable feature; design after marketplace direction is set |

### Site Operations

| # | Feature | Module | Frontend | Backend | Database | API | AuthN | AuthZ | Validation | Error handling | Mobile | Offline | Tests | Integration | Current implementation | Missing work | Priority | Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 8 | Site management (obj 4) | `site-plan-tab.tsx`, `site-map-card.tsx`, `evidence-tab.tsx` · `actions/evidence.ts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ client read-only | ✅ zone coords clamped, dup rejected | ✅ | ✅ | 🟡 zone actions via outbox | 🔴 | 🔴 | Interactive site map (≤8 zones, % coords over plan image), photo tagging, timelapse scrubber, photo comments, Bias-Free Ledger, PDF report | Single schematic image per project; no multi-floor/blueprints | P1 | Excellent differentiator — keep |
| 9 | Construction reporting (obj 22) | `overview-tab.tsx` (recap), `evidence-tab.tsx` (PDF), `export-utils.ts`, `intel-tab.tsx` (digests) · `/api/ai/recap` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ recap hidden for client | 🟡 | ✅ | ✅ | 🔴 recap is online-only | 🔴 LLM (z-ai SDK) | AI day recap (WhatsApp-style), jsPDF site report, 5 CSV exports, intel digests; WhatsApp/SMS = channel stubs | Scheduled/digested delivery to real WhatsApp (Twilio/Meta) | P1/P6 | Channel stubs are the gap, not the reports |
| 10 | Document management (obj 23) | `land-tab.tsx` (read-only OCR cards) · `ParcelDocument` model | 🟡 | 🔴 | ✅ | 🔴 | ✅ | ✅ | n/a | n/a | ✅ | n/a | 🔴 | 🟡 OCR scores are seeded | Parcel documents render with OCR-vs-registry progress bars + honest notes; photo upload exists (`/api/upload`) but **no document upload flow** | Upload UI + storage + OCR pipeline for title deeds/search certs | P2 | Highest-value land gap after passport |

### Workers & Offline

| # | Feature | Module | Frontend | Backend | Database | API | AuthN | AuthZ | Validation | Error handling | Mobile | Offline | Tests | Integration | Current implementation | Missing work | Priority | Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 11 | Worker management (obj 5) | `fundis-tab.tsx`, `worker-dialogs.tsx` · `actions/trust.ts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ client hides mutations | ✅ 4-digit PIN, rates | ✅ | ✅ | 🟡 check-in via outbox | 🔴 | 🔴 | Worker CRUD, daily rates, attendance heat table, bulk attendance, wages.pay + payroll.approve, verification triage (verified/reported/exception) w/ append-only overrideLog | No worker documents (IDs/certificates); no biometric anything (by philosophy, correct) | P1 | Keep the honest triage model |
| 12 | Workers without smartphones (obj 6) | `ussd-tab.tsx` · `/api/ussd` · `backend/domains/ussd/ussd-service.ts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ SITE_ROLES | ✅ phone normalization (07xx/+254/254/7xx), 20-char cap, 3-PIN lockout, 5-min expiry | ✅ honest messages | ✅ | n/a (USSD is inherently online server-side) | 🔴 | 🔴 simulator (no telco gateway) | Full state machine (menu → attendance/balance/help), in-tab phone simulator; attendance recorded as `reported` with honest "self-reported" labeling; PIN lookup | Real telco USSD gateway (Africa's Talking) | P1 | The simulator is production-faithful; gateway is a config swap when bought |
| 13 | Offline-first field operations (obj 7) | `use-mjengo.ts` (zustand persist outbox) · `/api/sync` | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ SITE_ROLES + client allowlist enforced server-side, actions role-stamped | ✅ ≤200/flush, per-item results | ✅ | ✅ | 🟡 | 🔴 | 🔴 | Persisted outbox (survives reload), manual connectivity toggle, auto-sync on reconnect, exact server delta verified in QA | **No PWA**: no manifest/service worker — a real offline page-load is impossible; connectivity is a toggle, not `navigator.onLine` | P1 | Add SW + manifest + real online detection; keep the outbox |

### Procurement & Marketplace

| # | Feature | Module | Frontend | Backend | Database | API | AuthN | AuthZ | Validation | Error handling | Mobile | Offline | Tests | Integration | Current implementation | Missing work | Priority | Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 14 | Procurement (obj 8) | `supply-tab.tsx` · `/api/suppliers` · `backend/domains/supply/supply-service.ts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ SITE_ROLES | ✅ qty/cost non-negative, benchmark autofill | ✅ (a past bug was caught by the boundary in 12-backend) | ✅ | 🔴 | 🔴 | 🔴 | Order → deliver → verify lifecycle; verification compares delivered-vs-invoiced qty and unit-cost-vs-benchmark×1.1; supplier trust recompute (on-time %, fair-price %, watchlist) — order creation re-verified in browser this audit | No RFQ/quoting; no delivery-document photos yet | P1 | Extend verify with photo evidence (reuse `/api/upload`) |
| 15 | Hardware/material marketplace (obj 9) | none | 🔴 | 🔴 | 🔴 | 🔴 | n/a | n/a | n/a | n/a | n/a | n/a | 🔴 | n/a | Nothing — supplier directory + benchmarks only | Catalog/cart/checkout across suppliers | P3 | Defer until supplier network is real |
| 16 | Supplier & warehouse discovery (obj 10) | `supply-tab.tsx` (supplier cards) · `Supplier` model | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | 🔴 | 🔴 | 🔴 | 6-supplier directory with trust metrics, materials, location, click-to-call | No warehouses/branches; no geo search; no supplier onboarding | P3 | Add supplier self-onboarding before warehouses |
| 17 | Regional price comparison (obj 11) | `supply-tab.tsx` (benchmarks table + autofill) · `PriceBenchmark` model | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | 🔴 | 🔴 | 🔴 | Single-market KES benchmarks (6 materials), similarity-based autofill in order dialog, "at market / +N%" labels | Benchmarks are seed-only (no update API/UI); no per-county/regional dimension; no price history | P3 | Add county field + update path before multi-region |
| 18 | Contractor bidding (obj 12) | none | 🔴 | 🔴 | 🔴 | 🔴 | n/a | n/a | n/a | n/a | n/a | n/a | 🔴 | n/a | Nothing | Tender publish, bid submission, comparison, award | P3 | Design on top of SupplyOrder + Supplier |

### Finance & Wallet

| # | Feature | Module | Frontend | Backend | Database | API | AuthN | AuthZ | Validation | Error handling | Mobile | Offline | Tests | Integration | Current implementation | Missing work | Priority | Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 19 | Payments & financial ledger (obj 15) | `money-tab.tsx` · `actions/money.ts` · Transaction/EscrowWallet/Milestone/VariationOrder | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ decisions are CLIENT actions (allowlisted); release needs evidence photos | ✅ balance≥amount enforced, evidence required before request | ✅ ("Insufficient escrow balance — top up first") | ✅ | 🟡 client decisions via outbox | 🔴 | 🔴 simulated money | Milestone escrow (top-up → lock → evidence → client approve/reject → release), variation orders, transactions ledger, M-Pesa/cash/bank methods | **All money is simulated** — no provider, no invoices, no reconciliation | P4 | Keep simulation for demo; add Daraja (M-Pesa) STK push + webhook + invoice model next |
| 20 | Universal Wallet infrastructure (obj 16) | none (EscrowWallet is per-project) | 🔴 | 🔴 | 🟡 | 🔴 | n/a | n/a | n/a | n/a | n/a | n/a | 🔴 | n/a | Per-project escrow wallet only | SDK, payment links, webhooks, developer dashboard, sandbox | P5 | Far out; depends on P4 payments being real |

### Client Monitoring

| # | Feature | Module | Frontend | Backend | Database | API | AuthN | AuthZ | Validation | Error handling | Mobile | Offline | Tests | Integration | Current implementation | Missing work | Priority | Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 21 | Client remote project monitoring (obj 17) | `share-dialog.tsx`, `diaspora-banner.tsx`, `app.tsx` client mode · `/api/share`, `/api/project?share=` | ✅ | ✅ | ✅ | ✅ | ✅ zero-login share token (rate-limited 30/min/IP) OR client login | ✅ client pinned to own project (foreign ids → 404); 5-action decision allowlist; actor stamped from link, never spoofable | 🟡 | ✅ 404 invalid link; 429 verified | ✅ 390px (QA) | 🟡 decisions queue via outbox | 🔴 | 🔴 | Virtual Site Visit: 7-tab read-only surface, milestone approve/reject, variation decisions, photo comments, notifications — client surface re-verified this audit (exactly 7 tabs, no search input on Land) | Email digests; multi-client per project | P1 | The core diaspora promise is delivered |
| 22 | Notifications (obj 24) | header bell · `Notification` model · `actions/evidence.ts`/`money.ts` + AI recap | 🟡 | ✅ | ✅ | 🟡 (model-level, via actions) | ✅ | 🟡 | 🟡 | ✅ | ✅ | 🔴 | 🔴 | 🟡 in-app only; `channel` supports whatsapp/sms/push but those are **delivery-log stubs** | Real WhatsApp/SMS/push delivery (Twilio/Meta/FCM) | P1/P6 | Wire one real channel; the data model is ready |

### AI

| # | Feature | Module | Frontend | Backend | Database | API | AuthN | AuthZ | Validation | Error handling | Mobile | Offline | Tests | Integration | Current implementation | Missing work | Priority | Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 23 | AI construction intelligence (obj 18) | `intel-tab.tsx` · `/api/intel` · `backend/domains/intel/intel-service.ts` | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ SITE_ROLES | 🟡 | ✅ | ✅ | 🔴 | 🔴 | 🔴 | Live KPIs computed from real attendance/milestone/signal data + seeded digests + Verification Risk panel ("not an accusation" footer) + signal ack/resolve | **RiskAssessment + IntelDigest are seed-written only** — no recomputation engine, scores go stale as evidence changes | P2/P6 | Build a recompute job on every verify/attendance action — honesty core |
| 24 | Photo-based progress analysis (obj 19) | `copilot-tab.tsx` · `/api/ai/analyze-photo`, `/api/upload` · `lib/ai.ts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ SITE_ROLES; client sees locked card | 🟡 image mime check on upload | ✅ 12/min rate limit (LLM cost guard) | ✅ | 🔴 | 🔴 | 🔴 VLM (z-ai SDK) | Camera/file capture → `/api/upload` (base64→public/photos) → VLM analysis (observations/PPE/materials/workmanship) stored on SitePhoto; progressPct | Camera permissions vary by device; batch analysis | P6 | Works; add analysis caching |
| 25 | Voice-to-structured-data (obj 20) | `copilot-tab.tsx` · `/api/ai/voice-log` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ SITE_ROLES | 🟡 | ✅ | ✅ | 🔴 | 🔴 | 🔴 ASR+LLM (z-ai SDK) | Swahili/English voice → parsed material rows matched to catalog → confirm-and-log to ledger (verified in Wave QA) | Speaker diarization, offline voice notes | P6 | Keep |
| 26 | Financial anomaly detection (obj 21) | `copilot-tab.tsx` (Scan) · `/api/ai/anomaly-scan` · Alert model + intel signals | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | 🔴 | 🔴 | 🔴 LLM heuristic | On-demand AI scan (cement variance etc.) writes Alerts; intel signals aggregate cost/schedule/trust/supply/safety | Detection is manual-trigger only; no scheduled scans; no statistical baselines | P6 | Schedule daily scan in the same engine as gap #4 |

### Platform & Cross-cutting

| # | Feature | Module | Frontend | Backend | Database | API | AuthN | AuthZ | Validation | Error handling | Mobile | Offline | Tests | Integration | Current implementation | Missing work | Priority | Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 27 | Audit trails (obj 25) | `evidence-tab.tsx` (Bias-Free Ledger) · `lib/audit.ts`, `backend/core/audit.ts` · AuditEvent | ✅ | ✅ | ✅ | 🟡 (via actions) | ✅ | ✅ actor/role always session-stamped (offline included) | 🟡 | ✅ never throws, never blocks | ✅ | 🟡 ledger entries ride action sync | 🔴 | 🔴 | Every one of 37 action types auto-writes an append-only AuditEvent (actor, role, summary); chronological ledger UI with kind filters | Long-term archival/retention policy | P0 | The product's spine — protect with tests first |
| 28 | Multi-tenant organizations (obj 28) | none (User.role + projectId) | 🔴 | 🔴 | 🟡 (project-scoped isolation only) | n/a | ✅ | ✅ project pinning verified (cross-project → 404) | n/a | n/a | n/a | n/a | 🔴 | 🔴 | 3 roles (contractor/client/admin); isolation is per-project, single-org per deployment | Organization/Team/Invitation models; per-org billing | P0→P7 (spec puts multi-tenancy in P0) | Add Organization model before commercial launch; current isolation is honest for single-org |
| 29 | APIs & integrations (obj 29) | all 17 routes · `backend/core/*` | n/a | ✅ | ✅ | ✅ | ✅ | ✅ SITE_ROLES matrix + CLIENT_ACTIONS allowlist + rate limits (read/write/search/ussd/ai/upload/sync/share/health) | 🟡 manual | ✅ uniform ApiError boundary, health endpoint | n/a | 🔴 | 🟡 internal REST only | Clean internal REST API (thin controllers → 6 domain services), documented in `src/backend/README.md`; `bun run db:seed:all` one-command data | No public API, SDK, webhooks, API keys, versioning | P7 | Publish the wallet/payment APIs only when real (P4/P5) |
| 30 | Future African/global expansion (obj 30) | `backend/core/phones.ts` (KE normalization) | 🔴 | 🔴 | 🟡 | 🔴 | n/a | n/a | n/a | n/a | n/a | n/a | 🔴 | 🟡 | Kenya-first throughout: KES, Kenyan phone normalization, county list, Swahili voice | Multi-currency, i18n (`next-intl` installed **unused**), multi-country registries, telcos | P7 | Deliberately deferred; keep honest-miss + phone-normalization patterns as the template |

---

## (c) Findings

### c.1 Code-smell grep results (src/ + prisma/)

| Pattern | Real hits | Detail |
|---|---|---|
| `TODO` / `FIXME` / `XXX` | **0** | none in `src/` or `prisma/` |
| `mock` / `dummy` / `hardcoded` / `fake API` | **0** | only false positives: doc comments ("Nothing in this tab is a hardcoded number", "07XXXXXXXX" canonical-form docs) |
| `coming soon` / `unimplemented` | **0** | none |
| `placeholder` | **0 real** | all matches are `placeholder="…"` input attributes (not a finding) and a `'todo'` string-literal state name in the Money stepper |
| `console.log` | **0** | every `console.*` is a tagged `console.error` inside a route/store error boundary (21 occurrences) — correct by design |
| Unused deps | 2 | `zod` (installed, never imported in `src/`), `next-intl` (installed, never imported) — plus `react-hook-form`/`@hookform/resolvers` unused by the mjengo app (shadcn template leftovers) |

**Verdict: the codebase contains no unfinished-work markers at all.** Unimplemented spec areas are simply absent (no stubs), which is honest but means the matrix above — not the code — is the record of what's missing.

### c.2 Dead buttons / links / forms

- Browser pass (contractor + client, all nav tabs): **none found**. Every nav button navigates; action buttons observed (Approve/Reject release, variation decisions, New order, Deliver, zone buttons, keypad) map to real handlers.
- No `href="#"` or disabled-by-default buttons except the intentional ones: USSD keypad/Dial disabled until a phone is picked (correct gating), Sync disabled when outbox empty (correct).

### c.3 Forms without handlers / APIs without UI / UI without backend

- Forms without handlers: **none found** (all dialogs dispatch actions or POST to real routes).
- APIs without UI: `/api` (health) is operational tooling — intentional. All 16 other routes have UI consumers. `/api/upload` is consumed by `copilot-tab.tsx` only (Evidence tab displays uploaded photos; acceptable but worth noting the capture point lives in Copilot).
- UI without backend: **none** — every tab fetches from real APIs (no fake data in components; demo data comes from the 11-script seed chain).

### c.4 Database models without full business logic (36 models)

| Model | Read by app | Written by app | Verdict |
|---|---|---|---|
| RiskAssessment | ✅ intel-service | ❌ **seed-only** (`seed-extras/intelligence.ts`) | Scores go stale — no recomputation engine. **Top gap** (honesty core) |
| IntelDigest | ✅ intel-service | ❌ seed-only | Daily digests aren't generated daily; "live" KPIs above them are real |
| ParcelEvent | ✅ land UI | ❌ seed-only | Registry-sourced so arguably correct, but no ingest path exists |
| ParcelDocument | ✅ land UI (OCR bars) | ❌ seed-only | No document upload flow (gap #5) |
| Surveyor | ✅ directory | ❌ seed-only | Read-only registry — acceptable |
| PriceBenchmark | ✅ supply autofill | ❌ seed-only | No price update API/UI (gap #7) |
| VerificationRequest | ✅ | ✅ professionals verify | Healthy — this one has full logic |
| All other 29 models | — | ✅ via 37 actions / 6 services / AI routes | Healthy |

### c.5 Broken or risky things found during the audit

1. **Dev server died mid-audit** — port 3000 refused connections after ~20 minutes of use; `dev.log` ends cleanly (no crash trace: last entry `GET /api/ussd 200`), suggesting an environment-level kill, not app failure. Restarted with `nohup bun run dev` → recovered immediately (200, session intact). Risk: shared-infra flakiness, worth an uptime guard.
2. `next.config.ts` sets `typescript.ignoreBuildErrors: true` — the production build does not type-check; `tsc --noEmit` was only ever run ad-hoc by agents. Add a `typecheck` script and remove the flag.
3. **No automated tests at all** (no runner in devDeps, no `test` script) — every release gate is manual browser QA. Highest-leverage gap.
4. Photo uploads write to `public/photos` on local disk — not multi-instance safe, lost on redeploy, and `db/custom.db` + photos are both gitignored (rightly) but there is no backup story.
5. `next-auth` CLIENT_FETCH_ERROR on `/api/auth/csrf` appeared in console **only** during the window the server was down (infra, not app). No other console or page errors in the entire pass.
6. Small: seeded `TitleSearch` history now includes this audit's test rows (`209/99999` ×2, actor "Site Manager") and one audit supply order (`cement`, Kariobangi, 10 bag × KSh 780, status `ordered`) left in P1 demo data — re-run `bun run db:seed:all` for a pristine demo.

---

## (d) Top-10 gap list (ranked, drives the next wave)

| # | Gap | Priority (spec §94) | Effort | Why now |
|---|---|---|---|---|
| 1 | **Automated test suite** — vitest unit tests for `backend/core` (guard, policy, phones, rate-limit) + 6 domain services + Playwright smoke of login/11 tabs/role matrix | P0 | M | Zero tests today; every "verified" claim rests on manual sessions. Protects the honesty rules themselves |
| 2 | **Type-safety gate** — remove `ignoreBuildErrors`, add `typecheck` script, fix residual errors | P0 | S | Builds currently ship without type checking |
| 3 | **RiskAssessment recompute engine + daily digest generation** — recompute Verification Risk on attendance/verify/milestone events; generate IntelDigest nightly | P2 (honesty core) | M | Stale seed scores quietly misrepresent how evidence-backed records are |
| 4 | **True offline PWA** — manifest + service worker (shell cache), `navigator.onLine` detection alongside the toggle | P1 | M | Outbox/sync is genuinely good; the missing 20% is what makes "offline-first" literally true |
| 5 | **Document upload + OCR flow** — ParcelDocument upload UI → storage → OCR → match score | P2 | M | Documents are the evidence backbone of LandVerify; today they're seeded props |
| 6 | **Property passport** — consolidated per-parcel export (registry + docs + OCR + history + legal) as PDF/page | P2 | S | Pure composition of existing data; flagship trust artifact |
| 7 | **Regional price comparison** — county dimension on PriceBenchmark + regional search + price update path | P3 | M | Benchmarks exist but are single-market and frozen |
| 8 | **Contractor bidding / RFQ** — publish order to N suppliers, collect quotes, award (extends SupplyOrder + Supplier) | P3 | L | The P3 marketplace entry point |
| 9 | **Real payments** — M-Pesa Daraja STK push + webhook + reconciliation against Transaction/EscrowWallet; invoice model | P4 | L | Escrow workflow is complete; only the money is fake |
| 10 | **Deploy hardening** — object storage for photos, Dockerfile + CI (lint/typecheck/test), error tracking | P7 | M | Local disk + no CI is fine for demo, fatal for pilot |

---

## (e) Verified working in browser (agent-browser, session `14a` — 2026-08-28)

**Contractor (contractor@mjengo.os / owner):**
- Login → session → project load: 200; header shows project switcher (3 projects), Share, Notifications (2 unread), connectivity toggle.
- All **11 tabs render**: Overview · Site Plan · Materials · Supply · Fundis · Money · Evidence · Land · Intel · USSD · AI Copilot.
- **Overview**: KPI region, 5-photo timelapse filmstrip, site-map zones (5), anomaly Acknowledge buttons, recap button.
- **Money**: escrow KSh 1,200,000 · milestones (Released / Awaiting client / Roofing evidence attach) · client approve/reject buttons with escrow math · variation approve/reject.
- **Supply**: KPIs (6 orders, 50% verified, 1 mismatch, 1 watchlist), supplier trust cards, orders list.
- **Land**: parcel 209/12345 detail — OCR 96%/91% progress bars, "No events flagged" history, delivered legal opinion with covered-checks + boundary disclaimer; **honest-miss title search `209/99999` → "We do not guess" + seller warning**, recorded under session identity "Site Manager".
- **Intel**: live KPIs (70% attendance verified, 49/70 evidence-backed; 2/3 milestones with evidence; 1 high-severity signal), digests, Verification Risk panel.
- **USSD**: honest self-reported explainer, keypad simulator (correctly disabled until a phone is chosen), 3 seeded session logs.
- **Destructive flow (1 of the allowed POSTs): created supply order** — Kariobangi Hardware Wholesalers, "cement", 10 bag × KSh 780 (at market) → appeared instantly as `ordered` with Delivered button and audit ledger entry (dev.log confirms `POST /api/suppliers 200` + AuditEvent INSERT).

**Client (client@mjengo.os):**
- **Exactly 7 tabs**: Overview · Site Plan · Materials · Fundis · Money · Evidence · Land — no Copilot/Supply/Intel/USSD; no project switcher, no Share button.
- Money shows the client-decision surface ("Client decision — Amina & Yusuf (Diaspora · Boston) approves via the share link" + Approve/Reject release KSh 650,000 + variation decisions) and **no** owner affordances (no top-up/new-milestone buttons).
- Land is read-only for clients: parcel card present, **title-search input absent**.

**Console/errors:** page errors empty at every checkpoint; single `next-auth CLIENT_FETCH_ERROR` only while the dev server was down (infra). Dev server outage recovered via `nohup bun run dev` (see finding c.5.1).

---

*End of audit — Task 14-a, Repository Auditor.*
