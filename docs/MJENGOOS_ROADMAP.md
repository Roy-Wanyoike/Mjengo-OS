# MJENGOOS ROADMAP

**Document status:** Living document · v1.0 · Author: Product Strategist (Task 14-c)
**Method:** every claim below was verified against the repo (routes globbed, `schema.prisma` grepped, policies read) and the worklog's recorded browser verifications — not copied from the spec or assumed. Where reality differs from the spec's optimism, reality wins and is documented.
**Compass:** the spec's honest-product philosophy — never fabricate verification; "Verification Risk", not accusation; USSD is self-reported; unknown registry lookups return honest misses with official-channel guidance. **Every roadmap item must respect these rules or it does not ship.**

---

## 1. Where MjengoOS stands today — P0–P7 scorecard (spec §94)

Scores are honest coverage estimates of the spec tier's bullet items, with repo evidence.

### P0 — Foundation · **~90% — largely DONE**

| Spec item | Status | Evidence |
|---|---|---|
| Authentication | ✅ | NextAuth v4 credentials + JWT; 3 seeded users (owner/client/admin); `api/auth/[...nextauth]` |
| Authorization | ✅ | `src/backend/core/policy.ts` — `SITE_ROLES = ['contractor','admin']`, `SIGNED_IN_ROLES` incl. client, `CLIENT_ACTIONS` allowlist; enforced server-side (client→owner-API 403s browser-verified in 12-backend) |
| Multi-tenancy | ◐ | **No `Organization` model** — isolation is project-scoped (client pinned to own project; share tokens pinned; foreign ids → 404). Single-org per deployment; multi-org is H2. |
| Database | ✅ | Prisma/SQLite, 36 models, deterministic 11-script seed chain (`db:seed:all`) |
| Audit logging | ✅ | `AuditEvent` + canonical `logAudit`; every action dispatched through `applyAction` auto-writes audit; offline actions attributed via `__actor`/`__role` |
| Core project management | ✅ | Project/Phase/Task CRUD via actions + `POST /api/projects`; create-project dialog |
| Property management | ◐ | `LandParcel`/`ParcelDocument`/`ParcelEvent` exist and link to projects, but property creation isn't part of the project flow (seeded parcels) |

### P1 — Construction MVP · **~85% — mostly DONE**

| Spec item | Status | Evidence |
|---|---|---|
| Projects / phases / tasks | ✅ | Models + Site Plan tab + actions |
| Workers / attendance | ✅ | Worker + Attendance (6 methods; verification verified/reported/exception; append-only overrideLog); Fundis tab; USSD check-in |
| Materials | ✅ | Material/Delivery/Consumption; Materials tab |
| Procurement | ◐ | Supply orders direct-to-supplier (order→deliver→verify with trust recompute) — **no RFQ publish, no bidding** (P3 gap bleeding into P1) |
| Daily reports | ✅ | `Recap` model + AI recap route; Overview day digest |
| Client dashboard | ✅ | 7-tab client surface + zero-login share link (Virtual Site Visit) |
| Offline functionality | ◐ | Outbox + `/api/sync` (≤200/flush, allowlist, role-stamped) — but device storage is **simulated**; no service worker/PWA manifest (`public/` has no `manifest.json`/`sw.js`); true offline needs H1 |

### P2 — Trust · **~75% — largely DONE**

| Spec item | Status | Evidence |
|---|---|---|
| Land verification | ✅ | Land tab; title search with honest miss + seller warning + Ministry of Lands pointer; punctuation-insensitive fallback (`ir 118923` → `I.R. 118923`) |
| Surveyors | ✅ | Directory of 5 (one deliberately unverified — the honest example); no survey-request workflow (see P2 gaps) |
| Professionals | ✅ | 16 professionals across LSK·EBK·BORAQS·IQSK; board-roll verification with found + honest-miss; legal review requests with scope honesty |
| Property passport | ❌ | **No PropertyPassport model/route/UI.** Ingredients all exist (parcel, docs, events, legal opinions, photos, milestones) — assembly gap. |
| Evidence | ✅ | SitePhoto/SiteZone/PhotoComment/timelapse; milestone proof-of-work gate; AI analyze-photo |
| Document management | ◐ | Land documents with OCR progress + honest notes; seeded only — no general upload/versioning |

### P3 — Marketplace · **~40% — suppliers + benchmarks only**

| Spec item | Status | Evidence |
|---|---|---|
| Suppliers | ✅ | `Supplier` model (6 seeded) with trust metrics (verified/watchlist/new via `recomputeSupplierTrust`) |
| Material prices | ✅ | `PriceBenchmark` (6 seeded); market-cost compare at verify (+N% labels); benchmark autofill |
| Warehouses | ❌ | No model/route/UI |
| Regional search | ❌ | No location-based supplier/material search |
| Contractor bidding | ❌ | No model/route/UI |

### P4 — Finance · **~50% — ledger/escrow yes, invoicing/provider no**

| Spec item | Status | Evidence |
|---|---|---|
| Ledger | ✅ | `Transaction` (wage/material/transport/milestone; method mpesa/cash/bank/card; auto-references `MPESA-XXXXXXXX`); Money tab |
| Expenses | ✅ | Expense dialog; typed transactions |
| Invoices | ❌ | No Invoice model. "Voice-to-invoice" is copilot naming; milestones are the nearest abstraction |
| Approvals | ◐ | Milestone approval workflow is real (client-only decide, evidence gate, escrow debit) — but only for milestones |
| Payment abstraction | ❌ | Method strings + reference only; no provider interface, no M-Pesa API, **no fake payment success anywhere (honest)** |
| Reconciliation | ❌ | Escrow balance is internally consistent; nothing to reconcile against (no statements/webhooks) |
| Provider integrations | ❌ | None (webhook appears nowhere in src) |

### P5 — Universal Wallet · **0% — not started (by design today)**

`EscrowWallet` is `projectId @unique`-bound — strictly project escrow, not a wallet product. No reusable APIs, SDK, payment links, webhooks, developer dashboard, or sandbox. The spec itself sequences this as a separate product (P5) after P4.

### P6 — AI · **~70% — routes exist, honesty-guarded**

| Spec item | Status | Evidence |
|---|---|---|
| Photo analysis | ✅ | `api/ai/analyze-photo` + Evidence tab |
| Voice | ✅ | `api/ai/voice-log` (Swahili/Sheng/English ASR → structured delivery log) |
| Anomaly detection | ✅ | `api/ai/anomaly-scan` + `RiskSignal`/`IntelDigest`/`RiskAssessment` (Verification Risk banding low/medium/high) |
| AI copilot | ✅ | Copilot tab + `api/ai/parse-text`, `api/ai/recap`; rate-limited 12/min (LLM costs real money) |
| OCR | ◐ | Honest OCR progress on seeded land documents; no full document-OCR pipeline |
| Forecasting | ❌ | No forecast route/model |

### P7 — Scale · **~10% — foundations only**

Health endpoint (`GET /api`, 503 on DB down) + audit trail + security headers exist. **Not started:** analytics platform, third-party integrations/webhooks, observability (metrics/tracing), i18n (`next-intl` is installed but appears **nowhere in src/**), multi-country (Kenyan phone normalization is intentionally hardcoded in `core/phones.ts`).

**Overall: the spec's center of gravity (P0–P2 + AI) is genuinely built; P3–P5 are the frontier; P7 is untouched.**

---

## 2. Forward roadmap

Effort: **S** ≤ 3 days · **M** ~1–2 weeks · **L** 2+ weeks. Each item names the honest-product rule it must respect.

### H1 — Next 2–4 weeks · high-value completions inside the current architecture

| # | Item | Why it matters (spec tie) | Scope sketch (models / routes / UI) | Effort | Deps | Honest-product rule |
|---|---|---|---|---|---|---|
| H1-1 | **Invoicing on the existing ledger** | §94 P4 "invoices"; closes §81 steps 25–26 (Invoice → Approval) which today are "not supported" | Models: `Invoice` (projectId, lines JSON, total, status: draft→sent→approved→paid, milestoneId?) · Routes: reuse `/api/actions` `invoice.create/approve/pay` pattern (approve = client action; pay writes `Transaction` + links invoice) · UI: Money tab invoice section | M | Escrow/ledger (done) | An invoice is a **request for payment**, never proof of payment; unpaid stays visibly unpaid |
| H1-2 | **Notification center** | §96 manual audit demands "notification" works everywhere; `Notification` model already exists but is a stub list | Routes: already dispatched (milestone release etc.); add `GET /api/notifications` + read/readAll (client actions already allowlisted) · UI: header bell with unread count, mark-read (wire the existing handlers at header.tsx:172) | S | Model exists | Channels whatsapp/sms stay labeled "delivery log" until a real provider exists — never claim "SMS sent" |
| H1-3 | **Global search (⌘K)** | §96 audits "search"; 11 tabs of data with no cross-tab find | UI: `cmdk` (already a dependency) palette across projects/materials/workers/suppliers/parcels; deep-links to tab + entity | S | — | Empty results say "no matches", never fabricated suggestions |
| H1-4 | **PWA: manifest + service worker** | §94 P1 "offline functionality" — the simulated outbox must become a real installable offline app | `public/manifest.json`, service worker caching the app shell + queued-action persistence in IndexedDB; `/api/sync` unchanged | M | `/api/sync` (done) | Offline banner must state exactly what is queued and what isn't; sync failures surface per-action, never silently dropped |
| H1-5 | **Document upload + versioning (land first)** | §94 P2 "document management"; §81 steps 4–5 (Upload title → Verify document) | Model: `ParcelDocument.version`/fileUrl via existing `/api/upload` · Routes: `doc.upload` site-team action · UI: Land parcel detail upload + version list | M | `/api/upload` (done) | OCR progress stays honest ("extracting… X%"); a document is "uploaded", never "verified", unless a verification source actually verified it |
| H1-6 | **Test Phase 1 (this plan)** | §80 "do not stop when the application compiles" | `bun test` unit suite for phones/http/rate-limit/policy/supply-trust/intel-banding (~60 cases) per `MJENGOOS_TEST_PLAN.md` §3 | M | — | Tests assert honest behaviors (404s, honest misses, self-reported labels) as first-class |

**Top-3 recommendation: H1-1 (invoices), H1-4 (PWA offline), H1-2 (notification center)** — they convert the three most-called-out gaps in the §81 chain and §96 audit, using only existing architecture.

### H2 — 1–3 months · structural

| # | Item | Why it matters | Scope sketch | Effort | Deps | Honest-product rule |
|---|---|---|---|---|---|---|
| H2-1 | **Multi-tenant organizations** | §94 P0 multi-tenancy; §81 step 1 "Create organization" | Models: `Organization`, `User.organizationId`, project→org scoping · Routes: org CRUD + guard scoping by org (not just project pinning) · UI: org switcher, invitations · Tests: tenant-isolation suite (Test Plan Phase 4) is the acceptance gate | L | H1-6 tests | Isolation is proven by failing probes (404 cross-org), not by hidden UI; audit events record org + actor |
| H2-2 | **Payment provider abstraction + M-Pesa sandbox** | §94 P4 "payment abstraction, provider integrations"; §80 financial test "duplicate payment prevention" | Models: `PaymentProvider` interface, `PaymentAttempt` (idempotency key, status) · Routes: `POST /api/payments/intent`, `POST /api/payments/webhook/<provider>` (Daraja sandbox: STK push → callback) · UI: Money tab provider status ("sandbox — not live money", stated plainly) | L | H1-1 invoices | Sandbox is always labeled sandbox; no live KES moves without licensing + client sign-off; webhook replays are idempotent |
| H2-3 | **BOQ module** | §81 steps 14–15; §94 P1/P3 bridge (BOQ → procurement) | Models: `Boq`, `BoqItem` (qty, unit, rate, category) linked to phase; procurement request derives from BOQ items · Routes: `boq.create/update/publish` · UI: Site Plan or Money tab BOQ editor, cost roll-up | M–L | — | BOQ totals are estimates, labeled as such vs. actuals (ledger) — never presented as final cost |
| H2-4 | **Procurement requests + supplier bidding** | §81 steps 15–17; §94 P3 "contractor bidding" | Models: `ProcurementRequest` (published, from BOQ), `SupplierBid` (amount, lead time) · Routes: publish/award actions; award writes `SupplyOrder` · UI: Supply tab request board | M–L | H2-3 | **Never auto-select the cheapest bidder** — award is an explicit human decision; trust metrics inform, warnings never decide |
| H2-5 | **Warehouse + regional marketplace search** | §94 P3 remaining bullets | Models: `Warehouse`, `StockLevel`; location fields on suppliers/warehouses + distance-aware search · UI: Supply tab map/region filter | M | H2-4 | Stock levels show `updatedAt` age — stale data is labeled stale |
| H2-6 | **Survey workflow (parcel → surveyor → report)** | §81 steps 8–12 (currently not supported) | Models: `SurveyRequest` (client→surveyor), `SurveyReport` (geo refs, photos, findings) · Routes: request/accept/submit + offline-capable report drafts via `/api/sync` · UI: Land tab requests + report viewer | M | H1-4 offline | A surveyor's report is professional work product — attributed, dated, never AI-fabricated; unverified surveyor = cannot accept requests |
| H2-7 | **Playwright E2E suite (Test Plan Phase 3)** | Lock in the §81 supported spine; make releases boring | `@playwright/test` — 3 contexts (owner/client/share) + mobile project; codify §5 protocols | M | H1-6 | Specs assert honest failures (403/404/429/honest-miss texts) |

### H3 — 3–6+ months · strategic

| # | Item | Why it matters | Scope sketch | Effort | Deps | Honest-product rule |
|---|---|---|---|---|---|---|
| H3-1 | **Universal Wallet as a separate reusable product** | §94 P5: reusable wallet APIs, SDK, payment links, webhooks, developer dashboard, sandbox — a *product*, not a feature of MjengoOS | Standalone service (own repo/deploy): wallet accounts, ledger, API keys, webhooks, sandbox env, dev dashboard; MjengoOS becomes **its first client** via the H2-2 provider abstraction | L | H2-2, + licensing | **No regulated stored-value wallet without licensing** — until licensed, the product is an escrow-ledger/bookkeeping layer with explicit "not a bank" boundaries; balances always reconcile to the double-entry ledger |
| H3-2 | **Property Passport** | §94 P2; §81 final step — the trust product's crown deliverable | Model: `PropertyPassport` (assembled view: parcel + verified docs + survey reports + legal opinions + build evidence + milestone/payment history) · Route: `GET /api/property-passport/:parcelId` (+ share) · UI: Land tab passport view + PDF export (jspdf already a dep) | M | H2-6, doc versioning | Passport distinguishes **verified vs self-reported vs unverified** for every entry, with dates and sources; it never summarizes an honest miss as a green tick |
| H3-3 | **Multi-country config** | §94 P7 | Country config module (phone normalization per country — `core/phones.ts` generalized, currency, registry adapters) | L | H2-1 | Registry adapters default to honest miss ("no official source connected for <country> yet") rather than fake lookups |
| H3-4 | **i18n (Swahili-first)** | §94 P7; Kenya audience; next-intl already installed (currently unused) | Route locales (en/sw), string extraction, language toggle; USSD menus in Swahili already prove the tone | M | — | Honest-miss and warning copy must be translated **first** — the honesty rules live in the words |
| H3-5 | **Analytics platform + observability** | §94 P7 | Aggregations over existing tables (verification-risk trends, escrow flow, attendance truth-gap); error/perf metrics (OpenTelemetry-friendly) | M–L | — | Dashboards label self-reported vs verified data separately — an analytics layer must not launder reported data into verified-looking charts |
| H3-6 | **AI forecasting (guarded)** | §94 P6 forecasting | Cost/schedule forecasts from ledger + progress; confidence intervals | M | Data volume | Forecasts ship with uncertainty and "based on self-reported inputs" disclosures; never presented as commitments |

---

## 3. Deliberately NOT planned

Things the spec itself forbids or defers — listed here to prove we internalized the ethics, and to make "no" a documented decision rather than an omission:

1. **No fabricated verification claims.** Registry lookups, board-roll checks, and surveyor status will never return invented matches to please a user. An honest miss with official-channel guidance is the correct answer to an unknown — forever.
2. **No regulated stored-value wallet without licensing.** Until CBK/PSL licensing and legal sign-off exist, escrow remains a project-bound ledger of record, and the Universal Wallet stays a sandbox/ledger product. We will not move or claim to hold client money.
3. **No auto-releasing milestone money on AI progress alone.** Money moves only on human (client) approval gated by photo evidence. AI photo analysis informs humans; it never authorizes payment — no exceptions, including H3-6.
4. **Never auto-selecting the cheapest bidder.** Procurement award is an explicit human decision even after H2-4 bidding exists; trust metrics and price warnings inform, they never decide.
5. **No claiming SMS/WhatsApp/notifications were delivered until a real provider confirms delivery.** Channels stay labeled "delivery log" until then.
6. **No treating USSD self-reported attendance as verified.** The reported/verified/exception distinction — and its append-only override log — is a permanent data-honesty contract, not a UI preference.
7. **No "fraud score" language — ever.** The metric is "Verification Risk", it is never an accusation, and the UI says so next to every assessment.
8. **No cosmetic demo features.** Per §96: nothing ships that is decorative without functionality; anything unverifiable ships labeled as such or doesn't ship.

---

## 4. Tracking

- Review cadence: scorecard (§1) re-scored at the end of every wave; deltas cited to commits + worklog entries.
- Each H-item gets a worklog task ID when started; Definition of Done per `MJENGOOS_TEST_PLAN.md` §7 applies to every item.
- This roadmap must never mark an item done that the repo cannot prove — same rule as the product.
