# Mjengo-OS — PM Backlog & Release Plan (Task 2-a)

**Owner:** Senior Product Manager · **Date:** Wave planning following tasks 0, 1-a, 1-b, 1-c
**Baseline:** `main` @ 8daad52 — lint clean, `tsc --noEmit` clean, **495 tests / 23 files green**

> **STATUS (2026-09, docs refresh):** Waves 3, 4 and 5 below are **SHIPPED and
> verified** (see `docs/RELEASE-NOTES.md` v0.2.1–v0.2.3; the issue texts in §2
> remain paste-ready for the GitHub backlog). v1 **Phase D** (workers /
> attendance / task detail / suppliers / parcels / intel / budget-variance —
> OpenAPI 21 → 29 paths) also **shipped** (September 2026, `feat/v1-phase-d`).
> **Wave 6 — the AI wave — SHIPPED** (September 2026): AI draw review,
> evidence authenticity screen, diaspora trust digest + the `ai`-flagged
> provider seam — full specs and paste-ready issue texts in
> `docs/wave6-plan.md`. Current state: **1,513 tests / 54 files green**,
> 68-model schema, 9 migrations. What follows is the historical plan text,
> kept verbatim (append-only discipline) with the three narrative-honesty
> fixes from task 7-c §4 applied in place.

**Constraint reminders:** GitHub token currently invalid — every issue/PR below is written **paste-ready** with placeholder numbers (`#TBD`). Every feature lands as: issue → branch → PR ("Closes #N") → verified → merged. No feature requires external credentials to build or test; external services appear only as **honest seams** (existing patterns: `PaymentProvider`, `NOTIFY_SMS_WEBHOOK_URL`, `USSD_WEBHOOK_SECRET`). Philosophy is non-negotiable: no fake features, **AI never approves, the ledger never lies**.

---

## 1. The Release Plan

Three waves, each 2–3 features built **in parallel on disjoint file areas**, merged sequentially. Wave numbering continues the repo's history (W1–W2 already shipped in the 17 unpushed commits).

### Wave 3 — Trust Foundation (security fix + the diaspora money surfaces + the data moat)

| # | Feature | Pitch | Effort |
|---|---------|-------|--------|
| W3-1 | **Sync flag-family gate (S1) + share POST validation (S2)** | Close the one real security hole: offline outbox flushes can dispatch flagged actions (wallet/land/supply) with flags off; harden the public share POST with a zod schema + byte cap on the way past. | **S** |
| W3-2 | **v1 Phase C API — milestones/escrow + invoices** | The REST surface for the money story: milestone ladder, escrow balance, invoice lifecycle with 3-way-match verdicts — read-only, OpenAPI-documented, the surface diaspora integrations and the Wave-4 draw pack build on. | **M** |
| W3-3 | **MjengoScore — contractor trust score** | A deterministic 0–100 trust score derived purely from evidence the system already records (evidence-backed releases, verified attendance, budget pace, variation discipline, delivery accuracy). The embedded-finance data moat. | **M** |

**W3-1 — Sync flag-gate hardening (S1) + share validation (S2)**
- **Pitch:** "A flag OFF must close its feature everywhere — online, share-link, *and* offline sync."
- **Files (verified):** `src/backend/api/sync.ts` (per-item gate in the applier loop, lines ~528+), `src/backend/api/actions.ts` (extract/share the family-gate), `src/backend/modules/intel/flags.ts` (doc: remove "documented as a follow-up", now enforced), `src/backend/api/share.ts` (zod body schema + maxBytes), `src/shared/client-actions.ts` (read-only reference), new `tests/unit/sync-flag-gate.test.ts`; extend `tests/unit/flags-gating.test.ts`.
- **Acceptance criteria (testable):**
  - `POST /api/sync` with a `WALLET_ACTIONS` type (e.g. `payment.pay`) while `wallet` flag OFF, contractor session → **per-item** `{ ok: false, error: 'Feature disabled by feature flag (wallet)…' }`, no ledger rows, **no idempotency record written** for the denied item; other items in the batch still process.
  - Same call with flag ON → applies exactly as today. Admin session with flag OFF → applies (documented bypass).
  - `LAND_ACTIONS`/`SUPPLY_ACTIONS` families verified the same way (one test each).
  - `POST /api/share` bodies > 64 KB → 413-style 400 honest error; malformed body → 400 `{ error, field? }` (zod strictObject, same contract as v1).
- **Investor narrative:** "Security review found one gap; it shipped as a fix with tests before any new feature rode on top" — diligence-ready answer for any technical DD question on flag gating.

**W3-2 — v1 Phase C API (milestones + escrow + invoices)**
- **Pitch:** "The escrow/milestone ladder and invoice 3-way match finally speak REST — SDKs, bank integrations and the diaspora portal all hang off this."
- **Files (verified):** new `src/backend/api/v1/project-milestones.ts`, `milestone-detail.ts`, `project-invoices.ts`, `invoice-detail.ts`, `project-escrow.ts`; extend `src/backend/api/v1/schemas.ts` (query schemas), `respond.ts` (`NOT_FOUND_MESSAGES` additions), reuse `scope.ts` (client pinning); new shims `src/app/api/v1/projects/[id]/milestones/route.ts`, `src/app/api/v1/milestones/[id]/route.ts`, `src/app/api/v1/projects/[id]/invoices/route.ts`, `src/app/api/v1/invoices/[id]/route.ts`, `src/app/api/v1/projects/[id]/escrow/route.ts`; update `src/app/api/openapi.json/route.ts` (14 → 19 paths); data via `getProjectPayload()` (milestones, `invoices` slice, `escrowWallet` already in the payload — verified `lib/mjengo.ts:96,106,215`) + direct `db` reads for detail routes (pattern: `supply-order-detail.ts`); 3-way verdict from `src/backend/modules/invoices/three-way.ts`; new `tests/unit/v1-milestones.test.ts`, `tests/unit/v1-invoices.test.ts`.
- **Acceptance criteria (testable):**
  - `GET /api/v1/projects/:id/milestones` — keyset pagination (createdAt/id total order), `?status=` filter before pagination, 120/min read limit, client pinned to own project (403 foreign, 404 unknown), item shape: id/name/amount/status/evidencePhotoIds/decidedBy/decisionNote/releasedAt.
  - `GET /api/v1/milestones/:id` — full ladder history (`requestedAt→decidedAt→releasedAt`), 404 mapping via extended `NOT_FOUND_MESSAGES`.
  - `GET /api/v1/projects/:id/invoices` + `:id` detail — lines, subtotal/tax/total, status ladder (draft→…→paid/disputed), payment reference, **3-way-match verdict summary** on detail.
  - `GET /api/v1/projects/:id/escrow` — `{ balance, ledgerAccountCode }` (balance is the ledger-derived projection; honest note carried into OpenAPI).
  - **No flag gates** on these routes (honest boundary already documented in `flags.ts`: the escrow/milestone ladder and invoices deliberately survive the `wallet` flag) — the OpenAPI text says so.
  - OpenAPI reflects all new paths field-for-field; v1 error shape `{ error, field? }` everywhere; 495+ tests green.
- **Investor narrative:** The wallet/payments rails (Phase A/B) told the fintech story; Phase C surfaces escrow + 3-way match — the controls tied to 70–151% of overrun **costs** (variation orders' share of cost overruns; Lukale 2018, Strathmore) — as a bank-grade REST API. This is the API an M-Pesa partner or diaspora platform integrates against.

**W3-3 — MjengoScore**
- **Pitch:** "Every photo, attendance PIN and ledger row already tells the truth about a contractor — MjengoScore turns that history into a number lenders can underwrite."
- **Files (verified):** new `src/backend/modules/intel/score.ts` (pure engine, `RULE_VERSION` pattern like `engine.ts`), extend `src/backend/modules/intel/service.ts` (orchestration), `src/backend/modules/intel/types.ts`, `src/backend/actions/intel.ts` (new `score.recompute` action), `prisma/schema.prisma` (additive `MjengoScore` model + migration), new `src/frontend/mjengo/intel/sections/score-section.tsx` (wired in `intel-tab.tsx`), i18n `src/frontend/i18n/dicts/{en,sw,check}.ts`; new `tests/unit/mjengo-score.test.ts`.
- **Acceptance criteria (testable):**
  - Deterministic: identical rows → identical score (property-style test with two runs); every component traceable to source rows (engine documents exact thresholds inline, `RULE_VERSION` bump rule).
  - Components (all from existing tables, zero new collection): evidence-backed release ratio (`Milestone.evidencePhotoIds`), attendance verification rate (`Attendance.verification`), budget pace (R1 finding), variation discipline (`VariationOrder` count/budgetImpact vs budget), delivery discrepancy rate (R3 inputs), invoice dispute rate (`Invoice.status='disputed'`).
  - Score history append-only (rows never edited) — latest per project wins in UI; recomputes on `score.recompute` action only (no background magic).
  - UI shows score + component breakdown + "describes, humans decide" honesty band; **the score never gates any action and never auto-approves anything** (test: adding score rows changes no action outcomes).
  - `en`/`sw` keys added in the same PR (compile-time parity via `check.ts`).
- **Investor narrative:** $13.2B embedded-finance market — underwriting requires data nobody has; we accumulate verified-evidence history as a free byproduct of running construction. The score is the moat: 12 months of MjengoOS usage = 12 months of underwriting-grade signal competitors cannot buy.

### Wave 4 — Diaspora Trust + Reach (the $5.04B story goes live, plus the field channels)

| # | Feature | Pitch | Effort |
|---|---------|-------|--------|
| W4-1 | **Diaspora Evidence Draw Pack** | When a milestone releases, freeze the proof — an immutable, hash-stamped pack of evidence photos, ledger ref, variations and attendance window, delivered through the existing revocable share link. | **M/L** |
| W4-2 | **Africa's Talking SMS provider (env-gated seam)** | A real Kenyan SMS rail behind the existing notify provider interface — configured by env, invisible (fail-closed) when unset. | **S/M** |
| W4-3 | **WhatsApp bi-directional field bot seam** | The honest-simulation WhatsApp webhook exactly like the USSD line: workers text in, actions dispatch through the same domain appliers, replies say "MjengoOS sim". | **M** |

**W4-1 — Diaspora Evidence Draw Pack**
- **Pitch:** "Widespread diaspora losses (Nation, Jun 2025: 'Dream homes, real losses') happen because clients can't hold proof. A draw pack is proof you can hold."
- **Files (verified):** `prisma/schema.prisma` (additive immutable `DrawPack` model + migration), `src/backend/actions/money.ts` (hook in `milestone.decide` approve path — the release transaction already runs atomically there), `src/backend/api/share.ts` (GET `?token&drawPack=<id>` — pack served through the *existing* revocable token, zero new auth surface), `src/frontend/mjengo/share-dialog.tsx` + new `draw-pack-viewer.tsx` (printable pattern: `finder/sections/invoices/printable-invoice.tsx`), `src/frontend/mjengo/money-tab.tsx` (pack links on released milestones), i18n dicts; new `tests/unit/draw-pack.test.ts`.
- **Acceptance criteria (testable):**
  - `milestone.decide → approve` creates exactly one `DrawPack` (idempotent on re-decide: second decide is already refused by the status ladder — test asserts no second pack, no duplicate ledger ref).
  - Pack content: evidence photo ids, released amount + `ledgerRef`, variations open at decision time, attendance summary for the request→decide window, MjengoScore at release (from W3-3; nullable if never computed — honest).
  - `contentHash` = stable SHA-256 over canonical pack JSON (test: same inputs → same hash).
  - Immutable: no code path updates a pack (schema has no mutable fields; test attempts fail / simply don't exist).
  - Revoked/regenerated share token → pack 404s with the same message as the project view; pack fetch rate-limited in the existing share GET bucket.
- **Investor narrative:** The Feb-2026 diaspora-scam press cycle is the marketing moment; $5.04B CBK remittance flow is the TAM. Draw packs convert "trust us" into "verify this" — the retention hook that makes the share link a product, not a feature.

**W4-2 — Africa's Talking SMS provider**
- **Pitch:** "SMS is still the rail that reaches Kenya — wire the country's dominant aggregator without changing a single call site."
- **Files (verified):** `src/backend/modules/notify/channels.ts` (new `AtSmsProvider implements ChannelProvider`), `src/backend/modules/notify/service.ts` (resolution: `NOTIFY_SMS_WEBHOOK_URL` webhook first, else `AT_API_KEY`+`AT_USERNAME`), `src/backend/modules/notify/types.ts` (docs), `.env.example`, extend `tests/unit/notify-channels.test.ts`.
- **Acceptance criteria (testable):**
  - Env unset → provider resolves to `null`, all rows stay `deliveryStatus: 'logged'` (fail-closed, unchanged default; test exists today, stays green).
  - `AT_API_KEY` set → provider posts to AT's REST endpoint (mocked fetch in tests): 2xx with `{ SMSMessageData: { Recipients: [{ messageId }] } }` → `sent` + `providerRef`; 4xx/5xx → `failed` with leak-free detail (status only); timeout 8s → `failed`; **never throws into `notify()`**.
  - Webhook provider keeps precedence (backwards compat test).
  - `.env.example` + module header document the credential tradeoff honestly: the webhook relay keeps credentials out of the app; the AT provider holds them in env — both documented, operator's choice.
- **Investor narrative:** Field adoption is the wedge (9/10 mobile-money transactions in SSA still ride USSD/SMS); a configured Kenyan SMS rail cuts activation friction and CAC for exactly the workers who will never install an app first.

**W4-3 — WhatsApp field bot seam**
- **Pitch:** "The field already talks WhatsApp — meet it there, honestly: a webhook contract, keyword grammar, and the same domain appliers the app uses."
- **Files (verified):** new `src/app/api/whatsapp/route.ts` (mirrors `src/app/api/ussd/route.ts` — GET = contract doc, POST = parse + dispatch + plain-text reply, `X-Signature` HMAC when `WHATSAPP_WEBHOOK_SECRET` set, 20/min/phone + 40/min/IP buckets like USSD), worker resolution by `Worker.phone` (mirrors `resolveWorkerByPin`), new `src/frontend/mjengo/whatsapp-panel.tsx` inside the existing `ussd-tab.tsx` surface (simulator, same pattern as the USSD sim), i18n dicts; new `tests/unit/whatsapp-route.test.ts`.
- **Acceptance criteria (testable):**
  - Grammar: `PRESENT` / `ABSENT` / `HALF` → attendance via `applyAction('attendance.record'|…)` with `__actor` from the phone→worker match; `BALANCE` → unpaid wage balance reply; free text → `comment.add`; `HELP` → usage. **Allowlist contains zero wallet/land/supply actions** (flag-family safe by construction — test asserts the allowlist contents).
  - Unknown phone → honest "not registered" reply, no rows written.
  - Secret set → unsigned/`X-Signature` mismatched POST → 401 (timing-safe compare, like Daraja); unset → open demo posture documented.
  - Every reply footer: `— MjengoOS sim` (no Meta/Cloud API wired; the route documents the aggregator contract it would accept).
  - Rate limits + audit context (IP/requestId via `withAuditContext`) same as USSD.
- **Investor narrative:** WhatsApp is where Kenya's construction sites actually communicate; bi-directional capture there is the CAC-reduction story (workers onboard with a text, not a training session). The seam is honest today and a config away from real — same playbook that made the USSD line credible.

### Wave 5 — Engagement & Coverage (pick by remaining capacity; all three documented)

| # | Feature | Pitch | Effort |
|---|---------|-------|--------|
| W5-1 | **Web push notifications** | Keep the diaspora client in the loop when the tab is closed — VAPID-gated push through the notify provider seam, honest 'logged' default. | **M** |
| W5-2 | **Kiswahili completion** | Parity is 291/291 today; hold that line through Waves 3–5's new keys + a QA pass on phrasing + (stretch) a Kiswahili marketing landing. | **M** |
| W5-3 | **Supplier-side portal role** | The one structural marketing gap: suppliers get their own scoped surface (catalog, quotes, orders, invoices, delivery confirm) — closes the marketplace promise. | **L, capacity-gated* |

\* **Start rule for W5-3:** begin only if Waves 3+4 merged clean with zero red tests and no open S-level defects; otherwise it moves to Wave 6 untouched. It is the only Wave-5 item that touches the role matrix (`src/shared/permissions.ts`, `guard.ts`, `tab-meta.ts`) — the highest-collision file family in the repo — which is exactly why it goes last.

**W5-1 — Web push (files):** `public/sw.js` (push + notificationclick handlers — PWA already ships), new `src/app/api/push/route.ts` (subscribe/unsubscribe), `src/backend/modules/notify/channels.ts` (`WebPushProvider`), `notify/service.ts` (resolution), `prisma/schema.prisma` (additive `PushSubscription`), `.env.example` (VAPID keys), tests mocked. **AC:** no VAPID env → subscribe stores intent, sends stay `logged` (fail-closed); with env → mocked web-push send records `sent`/`failed` honestly; unsubscribe revokes; notification clicks deep-link to the project. **Investor:** retention loop for the paying (diaspora) persona.

**W5-2 — Kiswahili completion (files):** `src/frontend/i18n/dicts/{en,sw}.ts` + `check.ts`; extend `tests/unit/i18n.test.ts`; optional `mjengoos-website` Kiswahili landing. **AC:** every key added by W3/W4/W5 ships with real Kiswahili (compile-time assert already enforces parity — extend the runtime test to catch placeholder values); 17 dynamic keys (`role.*`, `nav.*`) audited; jargon policy (PPE, QS, Finder stay English) documented in the dict header — it already is; keep. **Investor:** inclusion story — a Nairobi foreman's site language is a first-class product language, not a localization afterthought.

**W5-3 — Supplier portal (files):** `prisma/schema.prisma` (`User.role += 'supplier'`, `User.supplierId`), `src/shared/permissions.ts`, `src/backend/lib/guard.ts`, `src/frontend/mjengo/nav/tab-meta.ts`, supplier-scoped views in `src/frontend/mjengo/finder/sections/*` + new supplier surface, seed (`prisma/seed-extras/users.ts`, `supply.ts`), tests: supplier pinned to own `supplierId` (foreign catalog/quotes/invoices → 403, same honesty as client pinning). **Investor:** marketplace liquidity needs the supply side in-product; today the marketing site promises supplier views that don't exist (1-c promise gap) — this closes the last structural gap before the raise.

### Wave 6 — The Advisory AI Layer (SHIPPED, September 2026)

All three features + the foundation landed, merged in order W6-1 → W6-3 →
W6-2, and browser-verified end-to-end (real model calls; see
`docs/wave6-plan.md` for the full specs and §2 of that file for the
paste-ready issue texts, and `docs/RELEASE-NOTES.md` v0.2.4 for the plain-
language story):

| # | Feature | State |
|---|---------|-------|
| 8-f | **AI provider seam** (`modules/ai/`, `ai` flag DEFAULT OFF, chat/vision/transcribe + `speak()`) | Shipped — `feat/ai-foundation` @ a948e8c, merged c44004e |
| W6-1 | **AI Draw Review** — advisory vision+LLM note over frozen draw packs (`AiReviewNote`, migration 5) | Shipped — `feat/ai-draw-review` @ 443357c, merged f186b48 |
| W6-3 | **Evidence Authenticity Screen** — dHash duplicates + vision phase-consistency (`PhotoHash`/`AiInsight`, migrations 6/7) | Shipped — `feat/ai-authenticity` @ e27e4de, merged c79cc2b |
| W6-2 | **Diaspora Trust Digest + voice** — deterministic EN/SW text, TTS through the share link (`TrustDigest`, migration 8) | Shipped — `feat/ai-trust-digest` @ 51601f3, merged 0f52bfe |

Also shipped with the wave: the production timeout fix (SDK call cap 8 s →
20 s, `ec6bc87`, after real multi-photo vision measured 6–8 s alone) and the
v1 Phase-D read surface above. Suite at wave close: **1,513 tests / 54
files**, tsc + lint clean.

### Backlog beyond Wave 6 (documented, deliberately unscheduled)
- **BOQ versioning + variation-order control depth** (L) — core variation ladder already ships (`VariationOrder` + `variation.submit/decide`); full BOQ snapshots/diff land after draw packs + v1 expose the shapes (1-a's #2 gap — sequenced, not dropped).
- **Daraja production** (M-L) — blocked on real creds; sandbox + reconcile engine + branch `feat/daraja-reconcile` are ready.
- **Wave 7 candidates (from the task 7-a research, `docs/research/market-gaps-2026-09.md`):**
  - **WhatsApp voice-note ASR ingest** (M) — a voice note in, `transcribe()` → PII scrub → proposed delivery log, foreman confirms by reply before any row is written;
  - **Ledger Q&A on WhatsApp** (S-M) — "how much cement did we buy this month?" answered from the pinned read-only project digest, role-scoped;
  - **Invoice price-book checks** (S-M) — LLM cross-checks of extracted invoices against the supplier catalog + `PricePoint` intel, flagged into the 3-way-match queue before a human approves;
  - **Photo progress-% estimation** (M) — structured per-phase completion estimate as *variance vs claimed progress* (a flag, never an override).
  - Also documented in the wave-6 plan's beyond-Wave-7 list: MjengoScore explainability report, pre-release draw review, `AiInsight` decide action, digest audio caching, upload-time attachment hashing.
- **Theft shield, e-signature (KICA), DOSH/OSHA gating, carbon/ESG, equipment tracking, offline Gantt** — trigger-gated, per 1-c's deferral list.
- ~~**Remaining v1 resources**~~ — **shipped** as Phase D (workers/attendance, task detail, suppliers, parcels, intel, budget-variance; OpenAPI 21 → 29 paths).
- ~~**AI Draw Review**~~ — **shipped** as W6-1 above (right-sized from this plan's L to the M that actually shipped).
- **S4–S6 small hardenings** (USSD secret posture, single-instance limiter → SQLite store branch, `/api/search` limit) — the two finished branches already cover the limiter + the S6 search caps landed with Phase D; any remainder is folded into future v1 issues.

---

## 2. GitHub Issue Texts (paste-ready; numbers = #TBD until token works)

### Issue W3-1 (#TBD)

**Title:** `[security] /api/sync bypasses the feature-flag family gate (S1) — plus zod/size validation on POST /api/share (S2)`

**Problem statement**
`requireFlagOn()` is only enforced in `src/backend/api/actions.ts:59`. The offline sync drain (`src/app/api/sync` → `src/backend/api/sync.ts:528+`) applies outbox actions **without any flag-family gate**, so a contractor session (or any non-admin session that reaches sync) can flush `payment.decide`/`payment.pay`/`wallet.*`/`land.*`/`supply.*` actions while the `wallet`/`land_verification`/`marketplace` flags are OFF. The offline PWA makes this the primary mutation path for site users, so a flag OFF does not actually close its feature. `flags.ts` itself documents this as a known follow-up ("outside this flag's enforcement"). Separately, `POST /api/share` accepts an unvalidated JSON body with no size cap (S2, low-med) — the only public mutating route without a zod schema.

**Proposed solution**
1. Extract the flag-family gate (the `FLAGGED_ACTION_FAMILIES` table + lookup currently local to `actions.ts`) into a shared server-safe helper so `/api/actions` and `/api/sync` enforce **one** gate definition.
2. In the sync applier loop, call the gate **per item, before** idempotency-record creation and `applyAction`: a denied item returns the existing per-item failure shape `{ id, ok: false, error: "Feature disabled by feature flag (<key>) — …" }` (batch semantics — other items continue; the route already reports partial failures this way). A denied item must NOT write an idempotency key (nothing was applied). Admin sessions bypass, exactly as in `/api/actions`.
3. Add a `zod` strictObject body schema (token/type/payload bounds) + a 64 KB raw-body cap to `POST /api/share`; validation failures return the shared `{ error, field? }` shape.
4. Update the honesty docs: `flags.ts` enforcement map (the follow-up note becomes "enforced in /api/sync"), `sync.ts` header comment, `SECURITY.md` if the surface list mentions share/sync.

**Acceptance criteria**
- [ ] Contractor session, `wallet` flag OFF, outbox `[payment.pay]` → per-item `ok:false` with the flag-disabled error; **zero ledger rows; zero IdempotencyRecord rows** for that item
- [ ] Same with flag ON → applies exactly as today (regression: existing sync tests stay green)
- [ ] Admin with flag OFF → item applies (documented bypass)
- [ ] One test each for `LAND_ACTIONS` and `SUPPLY_ACTIONS` families
- [ ] Non-flagged actions (`milestone.*`, `attendance.*`, `task.*`) unaffected in sync while flags off
- [ ] `POST /api/share` with body > 64 KB → 400 honest error; malformed body → 400 with field; valid decision (milestone.decide) still works
- [ ] `bun run lint`, `bunx tsc --noEmit`, `bun run test` all green (495 + new)
- [ ] Docs updated (`flags.ts` map, `sync.ts` header); no behavior change for admins

**Technical notes**
Files: `src/backend/api/sync.ts`, `src/backend/api/actions.ts`, `src/backend/modules/intel/flags.ts`, `src/backend/api/share.ts`, new `tests/unit/sync-flag-gate.test.ts`, `tests/unit/flags-gating.test.ts` (extended). Reuse `requireFlagOn`/`featureDisabledResponse` as-is; the gate helper must stay free of guard.ts import cycles (flags.ts takes `GuardSession` structurally — keep that). Share-body cap mirrors Daraja's 64 KB pattern (`webhooks/daraja/[secret]/route.ts`).

**Done definition**
One PR, branch `fix/sync-flag-gate`, squash-merged with "Closes #TBD" — all AC boxes checked, suite green, and a security note appended to the worklog stating the bypass class is closed for all three cross-cutting routes (`actions` / `share` / `sync`).

---

### Issue W3-2 (#TBD)

**Title:** `[api] v1 Phase C — milestones/escrow + invoices read surface with OpenAPI (3-way match verdicts)`

**Problem statement**
v1 covers wallets/payments/projects/supply (14 paths) but none of the money-governance domain: the escrow/milestone release ladder and the invoice lifecycle with 3-way match are only reachable through the internal `/api/actions` + webapp payload. Every external integration story (diaspora portals, accounting sync, bank statement matching — and our own Wave-4 draw packs) needs these as stable, documented REST resources. `getProjectPayload()` already carries `milestones`, `invoices` and `escrowWallet` (`lib/mjengo.ts:96,106,215`), so this is surface work, not new domain logic.

**Proposed solution**
Five read-only routes, Phase-B pattern (`project-tasks.ts` / `supply-order-detail.ts`), no mutations (those stay on `/api/actions`, documented in OpenAPI):
- `GET /api/v1/projects/:id/milestones` — keyset-paginated list, `?status=` filter, deterministic (createdAt, id) order
- `GET /api/v1/milestones/:id` — detail: full status ladder timestamps, evidence photo ids, decision history
- `GET /api/v1/projects/:id/invoices` + `GET /api/v1/invoices/:id` — lifecycle + lines + totals + payment refs; detail carries the **3-way-match verdict summary** computed by `modules/invoices/three-way.ts`
- `GET /api/v1/projects/:id/escrow` — `{ balance, ledgerAccountCode }` (ledger-derived projection, honest note in OpenAPI)

Shared plumbing: `schemas.ts` (query schemas), `respond.ts` (`NOT_FOUND_MESSAGES` += milestone/invoice not-found messages), `scope.ts` client-pinning reuse. OpenAPI 14 → 19 paths, field-for-field truthful. **No flag gates on these resources** — the honest boundary in `flags.ts` (release ladder + invoices survive the wallet flag) carries into the OpenAPI descriptions.

**Acceptance criteria**
- [ ] All five routes: zod-validated inputs, 120/min read limit, `{ error, field? }` errors, `{ ok: true, data, nextCursor?, hasMore? }` successes
- [ ] Client-role scoping: own project 200, foreign 403 (indistinguishable-from-miss for probes), unknown project 404
- [ ] Milestone list pagination + status filter; stale cursor → 400
- [ ] Invoice detail includes 3-way verdict; disputed/paid states represented honestly
- [ ] Escrow route returns the ledger-derived balance (never a stored number) with the honest note
- [ ] `/api/openapi.json` documents all 19 paths; an SDK generated from it round-trips the shapes (manual check documented in PR)
- [ ] Tests: `tests/unit/v1-milestones.test.ts`, `tests/unit/v1-invoices.test.ts` (pattern: `v1-projects.test.ts`) — cover scoping, pagination, 404 mapping, rate-limit headers
- [ ] 495+ tests, lint, tsc green

**Technical notes**
Files: new `src/backend/api/v1/{project-milestones,milestone-detail,project-invoices,invoice-detail,project-escrow}.ts` + five `src/app/api/v1/**/route.ts` shims (thin re-exports, pattern `src/app/api/v1/projects/[id]/tasks/route.ts`); update `src/app/api/openapi.json/route.ts`. Data from `getProjectPayload` (lists) and `db.milestone/invoice.findFirst` (details). No schema changes, no flag changes, no frontend.

**Done definition**
PR `feat/v1-phase-c` squash-merged with "Closes #TBD"; OpenAPI regenerated and reviewed; suite green; the PR description includes a curl walkthrough of the milestone ladder (locked → released) via the new routes.

---

### Issue W3-3 (#TBD)

**Title:** `[intel] MjengoScore — deterministic contractor trust score (evidence-derived, history-preserving)`

**Problem statement**
Everything an embedded-finance underwriter needs is already recorded — evidence-backed releases, verified attendance, budget pace, variation discipline, delivery accuracy, invoice disputes — but it exists only as scattered rows. 1-a ranked a contractor trust score as a top-5 investor feature (data moat, $13.2B embedded-finance market); today we can't show a number.

**Proposed solution**
A pure engine `src/backend/modules/intel/score.ts` (the `engine.ts` discipline: documented thresholds, `RULE_VERSION`, same rows in → same number out), orchestrated by `intel/service.ts` on a new `score.recompute` intel action, persisted append-only in a new `MjengoScore` table (latest wins in UI, history preserved like `RiskAssessment`). Components, each traceable to source rows:
1. Evidence-backed release ratio (released milestones with ≥1 evidence photo / released)
2. Attendance verification rate (`Attendance.verification` = verified vs reported, trailing window)
3. Budget discipline (R1 budget_pace gap, reused from the risk engine)
4. Variation discipline (approved variation budgetImpact total vs project budget)
5. Delivery discrepancy rate (R3 inputs)
6. Invoice dispute rate

Score = 100 − weighted deductions. **Honesty rules: the score gates nothing, approves nothing, and is labeled "describes, humans decide"; it is a projection, recomputed only on explicit action, never a background magic number.** UI: `intel/sections/score-section.tsx` with component breakdown; `en`+`sw` keys ship in the same PR.

**Acceptance criteria**
- [ ] Determinism test: two computes over identical fixtures → identical score + components
- [ ] Each component has a test with a fixture that moves it and only it (traceability)
- [ ] Empty/young project → honest low-confidence state (components null + explanation), not a fake 0 or 100
- [ ] History: second recompute appends a row; UI reads latest; no row is ever updated (test)
- [ ] Non-influence test: score rows change no action outcomes anywhere (grep-level assertion in test)
- [ ] `score.recompute` is a normal intel action (audit event, role-checked like `risk.recompute`)
- [ ] `en`/`sw` keys present (compile-time parity assert), lint/tsc/495+ green
- [ ] Prisma migration is additive-only (existing rows untouched — migration test)

**Technical notes**
Files: new `src/backend/modules/intel/score.ts`, `src/frontend/mjengo/intel/sections/score-section.tsx`, `tests/unit/mjengo-score.test.ts`; extend `modules/intel/{service,types}.ts`, `actions/intel.ts`, `intel-tab.tsx`, `prisma/schema.prisma` (+migration), `i18n/dicts/{en,sw,check}.ts`. No external deps, no new flags (intel is not flag-gated today — keep it that way).

**Done definition**
PR `feat/mjengo-score` squash-merged with "Closes #TBD"; the PR description shows the score for the seeded demo project with each component traced to seed rows (the investor-demo artifact).

---

### Issue W4-1 (#TBD)

**Title:** `[trust] Diaspora Evidence Draw Packs — immutable, hash-stamped proof bundles served through the share link`

**Problem statement**
Diaspora construction losses are widely reported (Nation's "Dream homes, real losses", Jun 2025; the Feb 2026 diaspora-scam reporting — qualitative, no fabricated rate); the share link shows *live* state, but releases have no frozen, portable, verifiable artifact. When money moves (milestone release), the diaspora client needs the evidence *as it was at decision time* — photos, ledger ref, open variations, attendance window — in one pack they can keep, forward, or hand to a lender.

**Proposed solution**
On `milestone.decide → approve` (inside the existing atomic release path in `actions/money.ts`), write one immutable `DrawPack` row: milestone id + amount + ledger ref, evidence photo ids, variations open at decision time, attendance summary for request→decide window, MjengoScore at release (nullable — honest). `contentHash` = SHA-256 over canonical JSON. Served read-only via `GET /api/share?token=<t>&drawPack=<id>` through the **existing revocable share token** (no new auth surface); printable web view in the client surface (`printable-invoice.tsx` pattern); released milestones in `money-tab.tsx` link their packs.

**Acceptance criteria**
- [ ] Approve → exactly one pack; re-decide is impossible (status ladder) → no second pack ever (test)
- [ ] Pack fields + `contentHash` stable across recomputation of the same inputs (test)
- [ ] Immutable: no update path exists for packs (schema-level + no service function — test file documents the contract)
- [ ] Share token revoked/regenerated → pack 404s with the standard share error; valid token → pack JSON + printable view data
- [ ] Pack fetch counts in the existing share GET rate-limit bucket (30/min)
- [ ] Pack cites MjengoScore only when computed; otherwise explicit null + "not computed" copy (honest)
- [ ] Audit event for pack creation; ledger unchanged (pack is a projection, never money)
- [ ] Tests `tests/unit/draw-pack.test.ts`; 495+ green; en/sw keys

**Technical notes**
Files: `prisma/schema.prisma` (+additive migration), `src/backend/actions/money.ts` (hook only — the release transaction itself is untouched), `src/backend/api/share.ts` (GET param branch), new `src/frontend/mjengo/draw-pack-viewer.tsx`, `share-dialog.tsx`, `money-tab.tsx`, i18n, tests. **Depends on:** W3-3 for the score citation (soft — nullable if absent), W3-2 for the milestone JSON shape convention.

**Done definition**
PR `feat/draw-packs` squash-merged with "Closes #TBD"; PR description includes the demo walkthrough: release a milestone → open the share link → view + print the pack → verify the hash.

---

### Issue W4-2 (#TBD)

**Title:** `[notify] Africa's Talking SMS provider behind the ChannelProvider seam (env-gated, fail-closed)`

**Problem statement**
`WebhookSmsProvider` (generic gateway, `NOTIFY_SMS_WEBHOOK_URL`) is the only wired channel. Teams that standardize on Africa's Talking — the dominant Kenyan aggregator — must stand up a relay to use our notifications. 1-c ranked an AT provider behind the existing seam as a top next action (M, High).

**Proposed solution**
`AtSmsProvider implements ChannelProvider` in `modules/notify/channels.ts`: direct AT REST call with `AT_API_KEY` + `AT_USERNAME` (+ optional `AT_SENDER_ID`), 8s timeout, `providerRef` from `messageId`, error-class-only details (no key/URL leakage). Resolution in `service.ts`: webhook URL **first** (backwards compatible), else AT env pair, else null. Unset → no external call, rows stay `logged` (fail-closed default unchanged). `.env.example` + module header document the credential tradeoff honestly (webhook keeps creds out of the app; AT provider holds them in env).

**Acceptance criteria**
- [ ] No env → provider null; all-`logged` behavior unchanged (existing tests stay green)
- [ ] AT env set, mocked fetch: 2xx `{SMSMessageData:{Recipients:[{messageId}]}}` → `sent` + providerRef; 4xx/5xx → `failed` + status-only detail; timeout → `failed`; network → error class only
- [ ] `send()` never throws into `notify()` (in-app row survives every failure — test)
- [ ] Webhook precedence test (both configured → webhook wins)
- [ ] `.env.example` updated; README honesty note updated (SMS now: webhook OR AT, both optional)
- [ ] Tests extend `tests/unit/notify-channels.test.ts` (all fetch mocked; **no network, no creds needed in sandbox**)

**Technical notes**
Files: `src/backend/modules/notify/{channels,service,types}.ts`, `.env.example`, `tests/unit/notify-channels.test.ts`. Mirrors `WebhookSmsProvider` structure exactly; zero call-site changes (the seam is the interface).

**Done definition**
PR `feat/at-sms-provider` squash-merged with "Closes #TBD"; suite green; a one-paragraph operator doc in the PR explains webhook-vs-AT choice.

---

### Issue W4-3 (#TBD)

**Title:** `[field] WhatsApp bi-directional bot — honest webhook seam + simulator (USSD pattern)`

**Problem statement**
Sites communicate on WhatsApp; our only out-of-app capture is the USSD line (honest simulation). 1-a ranked a bi-directional WhatsApp field bot top-5 (field adoption, CAC). Meta Cloud API needs external creds — so build the honest seam exactly like USSD: a documented webhook contract, a working simulator, real domain dispatch, and zero fake delivery claims.

**Proposed solution**
`src/app/api/whatsapp/route.ts`: GET = contract doc; POST `{ from, text, timestamp }` → resolve worker by `Worker.phone` (mirror `resolveWorkerByPin`) → keyword grammar (`PRESENT`/`ABSENT`/`HALF` → attendance appliers with `__actor`; `BALANCE` → unpaid wages reply; free text → `comment.add`; `HELP` → usage) → plain-text reply, footer `— MjengoOS sim`. `X-Signature` HMAC (`WHATSAPP_WEBHOOK_SECRET`, timing-safe, unset = documented open demo posture), 20/min/phone + 40/min/IP buckets, audit context via `withAuditContext`. **The action allowlist contains zero wallet/land/supply types** — flag-family safe by construction. Frontend: WhatsApp panel with simulator in the existing `ussd-tab.tsx` (Field channels surface).

**Acceptance criteria**
- [ ] Grammar tests: each keyword dispatches the right `applyAction` with correct actor stamping; free text → comment
- [ ] Allowlist static test: no WALLET/LAND/SUPPLY action type reachable from the route
- [ ] Unknown phone → honest "not registered" reply, zero rows
- [ ] Secret set: unsigned/mismatched signature → 401; unset: documented open posture
- [ ] Rate-limit tests (phone + IP buckets) pass; every reply carries the sim footer
- [ ] Attendance written via WhatsApp bumps `Attendance.version` (sync interplay — reuses appliers, so it must)
- [ ] Tests `tests/unit/whatsapp-route.test.ts`; 495+ green; en/sw keys

**Technical notes**
Files: new `src/app/api/whatsapp/route.ts`, new `src/frontend/mjengo/whatsapp-panel.tsx`, `ussd-tab.tsx`, i18n, tests. Pattern source: `src/app/api/ussd/route.ts` (contract + signature + limits) and `src/backend/api/share.ts` (allowlist discipline). **Depends on:** W3-1 conceptually (gate helper exists if grammar ever expands into flagged families).

**Done definition**
PR `feat/whatsapp-seam` squash-merged with "Closes #TBD"; simulator demoable in the running app; contract documented for a future Meta Cloud API wiring.

---

### Issue W5-1 (#TBD)

**Title:** `[notify] Web push notifications — VAPID-gated honest channel through the provider seam`

**Problem statement**
Diaspora clients only see milestone/variation/invoice events when the tab is open. In-app rows exist; the push channel doesn't. The PWA (`public/sw.js`, manifest) already ships offline; push is the retention loop for the paying persona.

**Proposed solution**
`WebPushProvider` in `channels.ts` (web-push lib, VAPID env pair), `PushSubscription` model (additive) + `POST /api/push/subscribe|unsubscribe` (session-scoped), `sw.js` push/notificationclick handlers deep-linking to the project. No VAPID env → subscribe stored, sends stay `logged` (fail-closed). Notify call sites unchanged — the seam is the interface.

**Acceptance criteria:** unset env → all `logged` (fail-closed test); mocked send → `sent`/`failed` honestly recorded with providerRef; unsubscribe revokes (test); sw handler unit-tested (payload shape + click routing); no break to the existing PWA offline behavior (sw test suite). **Done:** PR `feat/web-push`, "Closes #TBD", suite green. **Depends on:** W4-2 merged (channels.ts hot file — sequential).

---

### Issue W5-2 (#TBD)

**Title:** `[i18n] Kiswahili completion — Waves 3–5 key coverage + QA pass + dynamic-key audit`

**Problem statement**
`en`/`sw` sit at 291/291 parity (test-asserted), but Waves 3–5 add ~40+ keys and the 17 dynamic keys (`role.*`, `nav.*`) were never audited; 1-c listed Kiswahili completion as pending. Parity must hold **on the day new features merge**, not retroactively.

**Proposed solution**
Per-wave rule (already in each issue's AC: en+sw ship together); this issue covers the rest: translation QA pass on the existing 291 (natural phrasing, jargon policy per the dict header), dynamic-key audit (every `t()` call with a template string enumerated in a test), runtime placeholder-value detector in `i18n.test.ts`, stretch: Kiswahili landing on the marketing site.

**Acceptance criteria:** every `t('<literal>')` static key enumerated by test; dynamic keys enumerated + asserted present in both dicts; placeholder-value detector green; QA-pass diff reviewed by a Kiswahili speaker (documented in PR); stretch landing is separate PR. **Done:** PR `feat/i18n-sw-completion`, "Closes #TBD", all i18n tests green.

---

### Issue W5-3 (#TBD) — *capacity-gated: start only if W3+W4 merged clean*

**Title:** `[roles] Supplier-side portal — the scoped supplier surface (closes the marketplace promise gap)`

**Problem statement**
The marketing site promises supplier-side views (1-c promise gap #1: "no supplier role exists"). Suppliers today are rows, not users — quotes/orders/invoices are managed by the buyer side only. Marketplace liquidity needs the supply side in-product.

**Proposed solution**
`User.role += 'supplier'` + `User.supplierId` link; session shaping in `guard.ts`; **server-enforced scoping identical to client pinning** — a supplier session can only read/mutate their own catalog items, quotes, orders, invoices, and confirm deliveries (foreign ids → 403 indistinguishable-from-miss). Permissions matrix + `tab-meta.ts` entry; supplier surface = scoped `finder/sections/*` views + a supplier home; seed a demo supplier user.

**Acceptance criteria:** supplier foreign-probe tests (catalog/quote/order/invoice) mirror the client-pinning tests; supplier cannot reach client/contractor tabs (server + client mirror); delivery-confirm via supplier writes the same delivery rows with `__role: 'supplier'` audit stamping; role matrix test updated; seed includes supplier login; 495+ green. **Done:** PR `feat/supplier-role`, "Closes #TBD". **Files:** `prisma/schema.prisma`, `src/shared/permissions.ts`, `src/backend/lib/guard.ts`, `src/frontend/mjengo/nav/tab-meta.ts`, `finder/sections/*`, `prisma/seed-extras/{users,supply}.ts`, tests. **Note:** highest-collision feature in the plan (role matrix) — that is why it is last and gated.

---

## 3. Merged-Branches Documentation (the 11 finished, unmerged local branches)

All 11 are **one finished commit each, blocked only on the invalid GitHub token** (task 0). Recommended merge order = ascending blast radius (env/docs/hygiene → tests-only → features small→large); re-run the full suite after each merge. Each lands as a squash-merge PR.

| # | Branch | What it does | Key files | PR references |
|---|--------|--------------|-----------|---------------|
| 1 | `fix/env-example-portable` | Portable `DATABASE_URL` in `.env.example` so the documented quickstart works for cloners | `.env.example` (+4/−2) | Refs #TBD (docs issue) |
| 2 | `chore/gitignore-hygiene` | Drops overbroad bare `test`/`prompt` ignore patterns that can swallow real files | `.gitignore` (−3) | Refs #TBD (hygiene) |
| 3 | `docs/readme-polish-contributing` | README polish (TOC, model count) + CONTRIBUTING guide + issue/PR templates | `README.md`, `DEPLOYMENT.md` + 4 (+164) | Refs #TBD |
| 4 | `feat/tests-core-modules` | Pins reports/land/professionals invariants — the 1-b untested-module gaps | `tests/unit/professionals-directory.test.ts` (611), `tests/unit/reports-budget-variance.test.ts` (601) (+1918) | **Closes #44** |
| 5 | `feat/v1-wallet-route-tests` | Pins wallet/payment REST route-layer invariants | `tests/unit/v1-wallets.test.ts` (1143), `tests/unit/v1-payments.test.ts` (389) (+1532) | **Closes #69** |
| 6 | `feat/notify-pref-gating` | Recipient notification preferences gate the SMS channel attempt (honest skip states) — closes the "prefs half-built" finding (1-b) | `modules/notify/{types,service}.ts` + `tests/unit/notify-prefs-gating.test.ts` (+439) | Refs #TBD (notify issue) |
| 7 | `feat/pdf-text-extraction` | Server-side PDF text-layer extraction for documents (no client hint) | `modules/documents/**` + 2 test files (+1299) | Refs #TBD (docs-intel) |
| 8 | `feat/rate-limit-sqlite-store` | Opt-in SQLite-backed rate-limit store (cross-process; in-memory default unchanged) — the S5 single-instance answer | `lib/rate-limit.ts` + `tests/unit/rate-limit-store.test.ts` (+1355) | Refs #TBD (S5) |
| 9 | `feat/reports-phase-codes` | Transaction phase cost-codes: real attribution with documented estimate fallback | `modules/wallet/service.ts` + `tests/unit/reports-phase-codes.test.ts` (+1100) | Refs #TBD (reports) |
| 10 | `feat/storage-doc-read` | Driver read seam for documents + presigned GET re-signing — the parked §9.5 seam | `lib/storage/**`, `modules/documents/**` + 2 test files (+1686) | Refs #TBD (storage) |
| 11 | `feat/daraja-reconcile` | Reconciles pending Daraja intents via the jobs drainer + webhook source-IP allowlist | `modules/wallet/**`, jobs + `tests/unit/daraja-reconcile.test.ts` (669) (+1752) | Refs #TBD (payments) |

### Suggested squash-merge PR descriptions (paste-ready)

**PR for `feat/tests-core-modules`** — Title: `test(core-modules): pin reports/land/professionals invariants`
> Closes #44.
> **What:** 1,918 lines of unit tests pinning the invariants of the three modules the 1-b audit flagged untested: reports (budget variance, 601 LOC), professionals (directory/verification ladder, 611 LOC), land (repository invariants). Tests only — zero runtime changes.
> **Why:** 495 tests were green but these modules had no pinning; every future feature (MjengoScore, v1 Phase C land/professional surfaces) builds on them.
> **Verify:** `bun run lint` · `bunx tsc --noEmit` · `bun run test` (suite + these files). Squash-merge.

**PR for `feat/v1-wallet-route-tests`** — Title: `test(v1): pin wallet/payment REST route layer invariants`
> Closes #69.
> **What:** 1,532 lines pinning the v1 wallet/payments REST family: role scoping, pagination/cursors, idempotency replays, error shapes `{ error, field? }`, rate-limit behavior (1,143 wallet + 389 payment tests). Tests only.
> **Why:** v1 is the public API contract investors/integrators see; Phase C (milestones/invoices) follows this exact pattern and should inherit a pinned foundation.
> **Verify:** full suite green. Squash-merge.

**PR for `fix/env-example-portable`** — Title: `fix(env): portable DATABASE_URL in .env.example`
> Refs #TBD (docs tracking). A cloner following the README quickstart got a non-portable `DATABASE_URL`; now file: relative and explained. `.env.example` only. Verify: fresh clone + `bun run dev` boots. Squash-merge.

**PR for `chore/gitignore-hygiene`** — Title: `chore(gitignore): drop overbroad bare 'test'/'prompt' ignores`
> Refs #TBD. Bare `test`/`prompt` patterns could silently ignore real files; removed (also removes the stray junk line flagged in 1-b hygiene). `.gitignore` only, −3 lines. Verify: `git status` clean, no newly-tracked junk. Squash-merge.

**PR for `docs/readme-polish-contributing`** — Title: `docs: README polish + CONTRIBUTING + issue/PR templates`
> Refs #TBD. README TOC + model count accuracy, CONTRIBUTING guide, issue/PR templates — the process scaffolding the wave-3+ issue→branch→PR loop needs. Docs only. Squash-merge.

**PR for `feat/notify-pref-gating`** — Title: `feat(notify): recipient preferences gate the SMS channel (honest skip states)`
> Refs #TBD. Closes the 1-b finding "notification prefs half-built": stored preferences now gate the SMS attempt; skips are recorded honestly in `deliveryDetail` (never a fake 'sent'). +439 incl. 320 test lines. Verify: suite green, notify-prefs tests demonstrate skip states. Squash-merge.

**PR for `feat/pdf-text-extraction`** — Title: `feat(docs-intel): server-side PDF text-layer extraction`
> Refs #TBD. Document intelligence no longer needs the client to hint text: the server extracts PDF text layers (no new heavy deps; extraction failure degrades honestly to the existing pipeline). +1,299 incl. 628 test lines. Squash-merge.

**PR for `feat/rate-limit-sqlite-store`** — Title: `feat(rate-limit): opt-in SQLite-backed store (in-memory default unchanged)`
> Refs #TBD (audit S5). The in-process limiter's single-instance honesty note gets its upgrade path: env-gated SQLite store for cross-process deployments; default behavior byte-identical. +1,355 incl. 517 test lines. Squash-merge.

**PR for `feat/reports-phase-codes`** — Title: `feat(reports): transaction phase cost-codes — real attribution, documented estimate fallback`
> Refs #TBD. Budget-variance reporting attributes transactions to phases via real cost-code links; unattributable rows use an explicitly-documented estimate fallback (never silent). +1,100 incl. 807 test lines. Squash-merge.

**PR for `feat/storage-doc-read`** — Title: `feat(storage): driver read seam for documents + presigned GET re-signing`
> Refs #TBD. The parked §9.5 seam (DEPLOYMENT.md): document reads flow through the storage driver (S3/R2 when configured, local-disk default unchanged) with presigned GET re-signing. +1,686 incl. 528 test lines. Squash-merge.

**PR for `feat/daraja-reconcile`** — Title: `feat(wallet): reconcile pending Daraja intents via jobs drainer + webhook source-IP allowlist`
> Refs #TBD (payments). Pending M-Pesa intents that never got a webhook callback are reconciled by the jobs drainer (sandbox+reconcile path 1-c flagged as ready); the webhook gains a source-IP allowlist. +1,752 incl. 669 test lines. Largest merge — take last, rebase if wallet files moved. Squash-merge.

**Suggested merge order:** 1 → 2 → 3 (trivial, zero-runtime) → 4 → 5 (tests-only, close #44/#69) → 6 → 7 → 8 → 9 → 10 → 11 (features, ascending size). Full suite re-run after each; any red → stop, fix on the branch, never on main.

---

## 4. Sequencing Rationale (dependencies + conflict analysis)

**Why Wave 3 has these three, in this order:**
1. **S1 first because it is a defect, not a feature.** The offline PWA's outbox is the *primary* mutation path for site users; Wave 4 deliberately increases outbox-adjacent traffic (WhatsApp field actions). Gate integrity must precede volume. It's also S-effort — it never justifies blocking a wave.
2. **v1 Phase C before the products that consume it.** W4-1's draw packs and any external diaspora integration should target the milestone/invoice JSON shapes Phase C freezes — building the portal first risks re-shaping the API under a shipped feature. Same logic as Phase B (projects/supply) preceding Finder surfaces.
3. **MjengoScore before draw packs.** The pack cites the score-at-release; computing it first means packs are complete from day one (and the score has one wave of history before investor demos).

**Intra-wave parallelism (Wave 3) — disjoint file areas:**
- W3-1: `api/sync.ts`, `api/actions.ts`, `api/share.ts`, `flags.ts` docs, sync tests
- W3-2: `api/v1/*` (new files), `app/api/v1/**` shims, `openapi.json`, v1 tests
- W3-3: `modules/intel/*`, `prisma/schema.prisma` (+ the wave's only migration), intel frontend section, i18n dicts
No shared files (tests dir is additive; i18n touched by exactly one feature per wave — the rule that keeps waves conflict-free). Merge order W3-1 → W3-2 → W3-3 (security → contract → feature), rebase-on-merge.

**Intra-wave parallelism (Wave 4):**
- W4-1: `schema.prisma` (+migration), `actions/money.ts`, `api/share.ts`, share/money frontend, i18n
- W4-2: `modules/notify/{channels,service,types}.ts`, `.env.example`
- W4-3: new `app/api/whatsapp/route.ts`, `whatsapp-panel.tsx`, `ussd-tab.tsx`, i18n
Disjoint. Note W4-1 touches `api/share.ts` which W3-1 hardened — sequential across waves, fine. W4-3 reuses the W3-1 gate helper conceptually but imports nothing from it (allowlist is flag-family-free by construction).

**Intra-wave parallelism (Wave 5):** W5-1 touches `channels.ts` (hot after W4-2 — sequential merge, parallel build is fine since the provider interface is frozen); W5-2 touches i18n + tests (disjoint); W5-3 touches the role matrix — **deliberately capacity-gated and last** because `permissions.ts`/`guard.ts`/`tab-meta.ts` are the highest-collision files in the plan; gating its start avoids rebasing three waves of work onto a new role.

**Cross-wave dependencies (the honest chain):**
```
W3-1 (gate) ──► W4-3 (WhatsApp allowlist discipline; outbox volume safe)
W3-2 (API)  ──► W4-1 (draw pack mirrors v1 milestone shapes) ──► future Phase D, AI Draw Review
W3-3 (score)──► W4-1 (pack cites score) ──► embedded-finance narrative
W4-2 (notify provider) ──► W5-1 (web push joins the same seam)
```
Nothing in Wave 3 has a hard code dependency on anything unfinished — that is why it is Wave 3.

**The token-unblock step sits in front of everything:** when a valid GitHub token arrives → push main's 17 commits → open the 11 branch PRs (texts above) and merge in order → file the Wave-3 issues (paste §2) → branch → PR → verify → merge. Until then, Wave-3 branches are cut locally off main and stay push-ready, exactly like the 11 before them.

**What is deliberately NOT in these waves (and why it's still the right order):** Daraja production (external creds — the sandbox+reconcile branch is ready to merge and waiting); BOQ versioning (L — foundation `VariationOrder` ships; full snapshots/diff follow once v1 + draw packs freeze the shapes they diff); AI Draw Review (needs the W3-2/W3-3/W4-1 evidence substrate to review against); supplier portal (largest collision surface — last, capacity-gated). All are documented backlog, not dropped scope.
