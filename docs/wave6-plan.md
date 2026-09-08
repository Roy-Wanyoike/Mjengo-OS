# Mjengo-OS — Wave 6 Release Plan: The AI Wave (Task 7-c)

**Owner:** Senior Product Manager · **Date:** September 2026
**Inputs:** `worklog.md` (waves 1–5 shipped: 1244 tests / 45 files green on `main` @ 91edeed; task 7-a research; task 8-f AI foundation), `docs/research/market-gaps-2026-09.md` (the Research Expert's market-gap analysis — every market claim below cites it), `docs/backlog.md` (the release-plan format this follows).
**Constraint reminders:** GitHub token still invalid — every issue below is **paste-ready** with `#TBD` numbers. No feature requires external credentials to build or test: the z-ai SDK self-configures via `.z-ai-config` (no env vars), and every test file **mocks the SDK with `vi.mock('z-ai-web-dev-sdk')`** — zero network, zero keys. Philosophy is non-negotiable and now has a contract: **AI describes and flags; it NEVER approves; the ledger never lies in either direction.**

---

## 0. Prerequisite (before any Wave-6 branch is cut)

**Merge `feat/ai-foundation` (task 8-f, commit a948e8c) into `main` first.** It is green in isolation (1274 tests / 46 files, lint + tsc clean) and it provides the contract every Wave-6 feature codes against:

- **Flag:** `ai` — sixth key in `src/backend/modules/intel/flags.ts` `FLAG_KEYS`, **DEFAULT OFF** (the new `FLAG_DEFAULTS` map; admin opts in via the header flags popover `FLAG_ROWS` in `src/frontend/mjengo/header.tsx`; `NEXT_FLAGS_OFF` can only force it off). Seeded disabled in `prisma/seed-extras/intel.ts`.
- **Seam:** `src/backend/modules/ai/types.ts` (`AiProvider`: `chat(messages)` / `vision(prompt, imageDataUrls)` / `transcribe(audioDataUrl)`, result `{ok:true,text} | {ok:false,error} | null`, never throws, leak-free errors) + `src/backend/modules/ai/provider.ts` (`ZaiProvider` wrapping `z-ai-web-dev-sdk`, 8s cap, lazy singleton, and **`resolveAiProvider(flags)`** — `flags.ai !== true` → `null`, the honest "AI features are off" state).
- **Tests:** `tests/unit/ai-provider.test.ts` (28 tests, SDK fully vi.fn'd — the mock idiom every Wave-6 test file reuses). `tests/unit/flags-gating.test.ts` registry pins updated for the sixth key.
- No Wave-6 feature adds a **new** flag — all three ride `ai` (8-f's design: "the single switch for the whole AI surface"). Each feature only appends its call sites to the `ai` entry's enforcement-map comment in `flags.ts` (comment-only, keep-both on merge).

**Coordinator note (state of the shared tree):** uncommitted v1 Phase-D WIP (`src/backend/api/v1/project-*` files, `openapi.json/route.ts`, `tests/unit/v1-*.test.ts`) is present in the working tree from a parallel agent. Commit/land that work (or park it on its branch) **before** cutting Wave-6 branches so the three feature branches share one clean base — the W4/W5 parallel-worktree discipline.

---

## 1. The Release Plan

Three features, built **in parallel on disjoint file areas** (two pairs can run concurrently — see §3), merged sequentially. Wave numbering continues the repo's history (W1–W5 shipped; this is the **AI wave, v0.2.4** in the RELEASE-NOTES cadence).

### Wave 6 — The Advisory AI Layer (AI flags, humans decide — every output a ledger row)

| # | Feature | Pitch | Effort |
|---|---------|-------|--------|
| W6-1 | **AI Draw Review (MVP)** | The first AI review of construction money that runs on evidence the system itself manufactured: a vision + LLM pass over a frozen draw pack's photos vs its milestone/invoice/budget context, output a confidence-labeled advisory note — the approval click stays human. | **M** |
| W6-2 | **Diaspora Trust Digest with voice (TTS)** | A weekly EN/SW "what your money did" digest — releases, progress, AI flags, MjengoScore delta — read as numbers straight off the ledger and delivered as text plus a downloadable voice note through the revocable share link. | **S/M** |
| W6-3 | **Evidence Authenticity Screen** | Perceptual-hash duplicate detection ("this photo paid for the foundation AND the slab") plus a vision phase-consistency pass at draw-pack generation — in the genAI era a photo is no longer proof; a hash-chained, cross-checked, ledger-bound photo still is. | **M** |

**Research validation (task 7-a picks, PM judgment applied):** all three picks are validated against the code — the substrate exists for each (draw packs W4-1 with `DrawPack.evidencePhotoIds`; recap/digest cores + notify seams for W6-2; the storage-driver `read()` seam + sharp already in the dependency tree for W6-3). Three deliberate adjustments, each flagged in the feature spec: (1) W6-2 extends the `AiProvider` contract with a `speak()` method (the contract has no TTS — the module header's "ANALYSIS ONLY" note gets a documented amendment, see W6-2); (2) W6-2's digest **text is deterministically composed from rows in both languages — the model only voices it, never authors it** (more honest than the LLM-written daily recap, and the investor story demands "exactly what KSh 650,000 bought"); (3) W6-3 hashes through `sharp` (already in `package.json` dependencies ^0.34.5 and installed — zero new deps; the bit math is pure TS) rather than a from-scratch JPEG decoder.

**The Wave-6 route convention (extends the 8-f contract):** gate failures keep the standard shapes — 401 no session, 403 wrong role or flag off (`requireFlagOn`), 429 rate-limited, 400 malformed body. **AI outcome states return HTTP 200 with the honest-state body** — `{ ok: true, … }` on success; `{ ok: false, error }` on a failed attempt (leak-free, from the provider); `{ ok: false, unavailable: true, error }` when `resolveAiProvider` returned null (flag on, SDK/config missing). No row is ever written on a failed or unavailable attempt — a faked analysis is impossible by construction. (Deviation from the six legacy `/api/ai/*` routes, which throw → 500; the new routes follow the `AiTextResult` three-state contract 8-f established.)

**W6-1 — AI Draw Review (MVP)**
- **Pitch:** "Built cut US draw reviews from 7 days to 3 and lenders pay for it; in Kenya we go further — we manufacture the verified evidence the review runs on." (7-a Gap 1 investor one-liner, [HousingWire, May 2026] for the Built claim.)
- **What it is:** a POST route + module service that, for a given released milestone's **frozen draw pack** (or the milestone's pack once it exists), runs: (a) one **vision pass** over the pack's capped evidence-photo set (`DrawPack.evidencePhotoIds` → `SitePhoto` rows → bytes → data URLs, the `analyze-photo` byte-resolution pattern); (b) one **LLM cross-check** (`chat`) against the pack's own frozen context (milestone name/amount/ledgerRef, variations open, attendance window, MjengoScore-at-release) plus live context (invoice 3-way-match verdicts via `modules/invoices/three-way.ts`, phase budget vs ledger spend). Output: a **confidence-labeled AI Review Note** — advisory findings only — stored **append-only**; re-runs append, latest wins (the `MjengoScore` history pattern). The `milestone.decide` approval path in `actions/money.ts` is **untouched** — the review runs after the pack exists, over frozen evidence; AI never approves and the release flow never waits on AI.
- **Files (all verified on `main`):**
  - NEW `src/backend/modules/ai/draw-review.ts` — the review service (context assembly, provider calls via `resolveAiProvider(await getFlags())`, STRICT-JSON parse with honest failure, `AiReviewNote` row write, audit event).
  - NEW `src/app/api/ai/draw-review/route.ts` — POST `{ projectId, drawPackId | milestoneId }`; gate = `enforceAiRoutePolicy` (src/backend/lib/rate-limit.ts — session + site-team roles + 10/min, the pattern of the six existing routes in `src/app/api/ai/*`) + `requireFlagOn('ai', gate.session)` (src/backend/modules/intel/flags.ts).
  - `prisma/schema.prisma` — append `AiReviewNote` model (id, `drawPackId` FK, projectId, `providerId`, confidence `low|medium|high`, findings JSON, summary, `generatedAt`, `createdAt`, **`reviewedBy`/`reviewedAt` nullable, no code path writes them in Wave 6** — "AI flags, humans decide" columns ready like DrawPack's discipline) + migration `prisma/migrations/5_ai_review_note/migration.sql` (ONE CREATE TABLE, additive-only — the 1_/2_/3_/4_ house rule).
  - `src/backend/api/share.ts` — the existing GET `?token&drawPack=<id>` branch response gains `notes` (read-only, latest-first) so **share-link clients** see the note; the token gate, 404 mapping and 30/min bucket are untouched (the branch lives at lines ~85–100).
  - `src/frontend/mjengo/draw-pack-viewer.tsx` — an "AI Review Note" section inside the pack viewer: advisory banner ("AI advisory — not a decision"), confidence badge, findings list, provider + generated-at line; hidden with an honest "AI review not run / AI features are off" state when absent (the payload already carries `intel.flags` — `data.intel.flags.ai` gates the trigger surfaces).
  - `src/frontend/mjengo/money-tab.tsx` — on released milestones with a pack (the same rows that render `drawPack.view` at line ~590): a "Run AI review" button (hidden unless `data.intel.flags.ai`) + latest-note chip; fetches POST `/api/ai/draw-review`, then re-fetches the pack viewer data.
  - `src/frontend/mjengo/audit-tab.tsx` — `AUDIT_KINDS` += `'ai_review'` (the `AUDIT_ROLES` list already contains `'ai'`).
  - `src/backend/modules/intel/flags.ts` — comment-only: append the route to the `ai` flag's enforcement-map entry.
  - i18n `src/frontend/i18n/dicts/{en,sw}.ts` — end-append `# W6-1 ai draw review` block (the W4-1/W4-3/W5-1/W5-3 end-append rule).
  - NEW `tests/unit/ai-draw-review.test.ts`; EXTEND `tests/unit/draw-pack.test.ts` (the share-response round-trip pins must admit the new `notes` key) — both SDK-mocked.
- **Acceptance criteria (testable):**
  - Flag OFF (`ai` false) → POST returns the standard flag-disabled 403 for non-admins (admin bypass documented); **`sdk.create` is never called** (vi.mock assertion); the money-tab button is absent when `intel.flags.ai` is false (component-level test on the payload fixture).
  - Flag ON, `resolveAiProvider` → null (SDK unavailable) → 200 `{ ok:false, unavailable:true, error }`; **no `AiReviewNote` row, no audit row**; UI shows the honest unavailable state.
  - Provider returns `{ ok:false, error }` (SDK throw / 8s timeout / empty response) → 200 `{ ok:false, error }`, error leak-free (assert planted URL/API-key/body text absent), **no row written**.
  - Provider success → one append-only row with confidence + findings + summary; **a second run appends** (latest wins; first row byte-identical after re-run — the MjengoScore determinism test shape); no update/delete path exists (stub contract + source walk, the DrawPack test idiom).
  - **Non-influence:** adding note rows changes no action outcomes — grep-level test that `AiReviewNote` is referenced only in the ai module + share read + viewer + i18n display strings (extend the `mjengo-score.test.ts` allowlist-walk pattern; `actions/money.ts` and `lib/mjengo.ts` untouched by this feature).
  - Vision input = the pack's evidence photos resolved to bytes (local-disk via `readFile` public path OR driver `read()`/`keyFor()` — the analyze-photo byte pattern); **capped photo set** (e.g. first 6, documented) so a pack can never blow the route budget.
  - Share serving: valid token → `notes` present read-only; revoked token → the standard 404 before any note query; foreign pack id → pack-404 (indistinguishable); fetches count in the existing `share.get` 30/min bucket (test with fake timers).
  - Route-level rate limit 10/min (the AI-route bucket policy) — 11th call 429 + Retry-After.
  - Audit event kind `'ai_review'` on every successful run (actor/role stamps mirror the house `withAuditContext` shape used by the AI routes' gate).
  - en/sw keys parity (compile-time assert + test); lint, tsc, full suite green.
- **Effort: M** — module + route + model/migration + two frontend surfaces + i18n + ~40 tests. (Research said "M for full depth, MVP is days" — the days-scale claim holds for the core pass; M is the honest rating including share serving, the viewer section, and the non-influence test surface.)
- **Conflict analysis:** owns `money-tab.tsx`, `draw-pack-viewer.tsx`, `share.ts` (GET drawPack branch only), migration `5_`. Collisions with W6-2 on `share.ts` (adjacent GET branches — W6-2 rebases, keep both) and with all three on `prisma/schema.prisma` (append-at-end model blocks), `audit-tab.tsx` (one kind line each — keep both), `i18n` dicts (end-append blocks in merge order), `flags.ts` (comment lines — keep both). No overlap with W6-3's files at all.
- **Investor narrative:** the category is already hot money in the US (Built's Draw Agent, [HousingWire, May 2026]; loan-management software a $1.19B→$2.65B market per 7-a's source list) — and nobody anywhere runs the review over evidence the platform itself hash-chained at the moment money moved. The screenshot: a released KSh 650,000 draw with photos, ledger ref, and an AI note saying "evidence consistent, 2 advisory flags — human decides."

**W6-2 — Diaspora Trust Digest with voice (TTS)**
- **Pitch:** "A weekly voice note in Swahili that says exactly what KSh 650,000 bought — backed by a hash-chained draw pack, not a cousin's promise." (7-a Gap 3 investor one-liner.)
- **What it is:** a weekly bilingual **Trust Digest** per project: deterministic EN + SW text composed from rows (milestones released this week with amounts + ledger refs from `DrawPack`; overall progress; MjengoScore delta from the two latest `MjengoScore` rows; AI flags this week — `AiReviewNote` findings + `AiInsight` rows from W6-1/W6-3; attendance summary), shaped WhatsApp-forward-ready (plain text, short lines, footer — the `runDailyRecap` message conventions). The digest text is **never LLM-authored**: every number is a ledger row; the model's only job is **TTS** — rendering the exact deterministic text as audio through the new `speak()` seam. Delivery: in-app notification row via the event policy (the recap's honest `in_app`/`'logged'` default), optional SMS leg through the existing notify providers, and a **share-link viewer** (`?token&trustDigest=latest`) with on-demand audio render + download so the diaspora client can forward the voice note on WhatsApp themselves. No outbound WhatsApp provider exists — nothing pretends otherwise.
- **Files (all verified):**
  - `src/backend/modules/ai/types.ts` — **the seam extension**: `AiAudioResult = { ok: true; audioDataUrl: string } | { ok: false; error }` and `speak(text, opts?: { voice?, speed? })` on `AiProvider`; header amendment documenting why TTS joins an analysis seam: *speak() renders text the CALLER already holds — the model invents nothing; feeding model output back as fact stays forbidden.*
  - `src/backend/modules/ai/provider.ts` — `ZaiProvider.speak()`: `zai.audio.tts.create({ input, voice?, speed?, response_format: 'mp3' })` — **the SDK returns the raw fetch `Response`** (verified in the SDK dist), so the provider owns `arrayBuffer()` → base64 → `data:audio/mpeg;base64,…`, content-type honesty (non-audio response → `{ ok:false }`), the same 8s race + leak-free error mapping + empty-input validation as `chat`/`vision`/`transcribe`.
  - NEW `src/backend/modules/ai/trust-digest.ts` — builder (deterministic EN/SW templates over the row set) + render orchestration (one `speak()` per language, honest per-language status) + notify emit.
  - `prisma/schema.prisma` — append `TrustDigest` model (id, projectId, weekStart, textEn, textSw, releasedTotalKES, releasesCount, scorePrev/scoreNow/scoreDelta nullable, aiFlagsCount, progressPct, audioStatusEn/audioStatusSw `'unavailable'|'failed'|'ready'` + renderedAt stamps, createdAt) + migration `prisma/migrations/8_trust_digest/migration.sql` (ONE CREATE TABLE). Append-only, latest-per-week wins.
  - NEW `src/app/api/ai/trust-digest/route.ts` — GET (latest digest for the session's project, `?lang=en|sw&audio=1` renders audio on demand, 4/min — TTS is the expensive call) + POST (generate this week's digest — the `runDailyRecap` route pattern); gate = `enforceAiRoutePolicy` + `requireFlagOn('ai', …)`.
  - `src/backend/api/share.ts` — GET += `?token&trustDigest=latest[&lang=sw&audio=1]` branch: token-gated digest JSON + on-demand audio (same honest states; counts in the existing share GET bucket).
  - `src/backend/actions/intel.ts` — `INTEL_ACTIONS` += `'trust.digest'` + dispatcher case (the `digest.generate` precedent — audit auto-written, explicit action only, no background magic).
  - `src/backend/modules/intel/policy.ts` — role matrix entry mirroring `digest.generate` (contractor/admin; client/share_client/supervisor/finance refused).
  - `src/backend/modules/jobs/handlers.ts` — `JobType` += `'digest.trust'` + handler → the shared core (the `recap.daily` route+job twin pattern; the cron-drainable weekly path).
  - `src/backend/modules/events/service.ts` — `NOTIFY_POLICY` += `'digest.trust'` (in_app row, client audience; optional `sms` leg rides the existing provider resolution).
  - NEW `src/frontend/mjengo/intel/sections/trust-digest-section.tsx` + mount in `src/frontend/mjengo/intel-tab.tsx` (the tab's section list, after `DigestSection`): this week's digest card — EN/SW text toggle, score-delta + flags count, generate button (flag-gated), audio player + download, honest per-language audio status.
  - `src/frontend/mjengo/audit-tab.tsx` — `AUDIT_KINDS` += `'ai_digest'`.
  - `src/backend/modules/intel/flags.ts` — comment-only enforcement-map lines for the route + action + job.
  - i18n dicts — end-append `# W6-2 trust digest` block.
  - NEW `tests/unit/ai-trust-digest.test.ts`; EXTEND `tests/unit/ai-provider.test.ts` (speak() invariants — request shape, raw-Response handling, non-audio content-type, leak-free, 8s, empty input, flag-off → `sdk.create` never called) and `tests/unit/mjengo-score.test.ts` (allowlist += the trust-digest module **reads** the two latest score rows for the delta — the W4-1 read-only-allowlist precedent).
- **Acceptance criteria (testable):**
  - **Seam:** `speak('')` → `{ ok:false }` without contacting the SDK; flag off → `resolveAiProvider` → null → no render, honest `'unavailable'` statuses; SDK failure/timeout/non-audio response → `{ ok:false }` leak-free, digest row's audio status `'failed'`, **text digest still delivered** (TTS failure never degrades the text); success → `data:audio/mpeg;base64,…` round-trips to playable bytes (base64 decoded length > 0, prefix asserted).
  - **Determinism of text:** identical rows → byte-identical EN and SW text (two-run deep-equal, the MjengoScore idiom); **no number in either text that isn't traceable to a fixture row** (test asserts each rendered figure against the fixture).
  - Flag OFF → route 403 (non-admin), action refused by role/flag gate, job handler skips honestly, UI card shows the "AI features are off" state, `sdk.create` never called across all four surfaces (vi.mock).
  - Never throws into callers: every provider/render failure lands as an honest status or row state (the notify-channels 4-arm failure-loop test pattern).
  - TrustDigest rows append-only (no update path — stub + source walk); regeneration appends; latest-per-(project, weekStart) wins.
  - Share serving: valid token → digest JSON (+ audio only on explicit `&audio=1`, rendered on demand); revoked token → standard 404 before any digest query; rate-limited in the existing share bucket.
  - Event policy: one in-app notification row per generation with honest `'logged'` deliveryStatus (nothing claims WhatsApp delivery); SMS leg only when a provider is configured (mocked provider test — the notify-channels idiom).
  - en/sw keys parity; lint, tsc, full suite green.
- **Effort: S/M** — the smallest of the three (no vision, no complex parsing; deterministic templates + one new SDK method + serving surfaces). Research said S; upgraded to S/M for the seam-contract change, bilingual templates, and the three serving paths (route + share + job). The one untouched SDK capability (TTS) becomes the emotional investor demo.
- **Conflict analysis:** owns `modules/ai/{types,provider}.ts` (the ONLY Wave-6 change to the 8-f foundation files — W6-1/W6-3 import them, never modify), `actions/intel.ts`, `intel/policy.ts`, `jobs/handlers.ts`, `events/service.ts`, `intel-tab.tsx`, migration `8_`. Collides with W6-1 on `share.ts` (adjacent GET branches — sequential merge, keep both) and the shared end-append family (schema, i18n, audit-tab, flags.ts comments). **Reads W6-1's `AiReviewNote` + W6-3's `AiInsight` tables for the flags section → lands LAST** (or ships with an honest zero-flags note if re-sequenced — the models are the hard dependency, note it in the branch README).
- **Investor narrative:** diaspora-facing competitors sell humans-as-trust (manual weekly updates, 7-a §2 matrix — DiasporaBuild/Tujitume/Fingerprint); nobody sends the payer 8 timezones away a **voice note in their mother tongue whose every number is a ledger row**. $5.04B/yr Kenyan remittances (CBK via 7-a) is the flow; Swahili is under-served by global AI while Kenya leads the world in AI-tool usage (7-a §1, both flagged secondary where they are).

**W6-3 — Evidence Authenticity Screen**
- **Pitch:** "In the genAI era a photo is no longer proof; a hash-chained, cross-checked, ledger-bound photo still is." (7-a Gap 2 investor one-liner, anchored to Truepic's genAI draw-fraud warning.)
- **What it is:** two complementary checks over the project's evidence photos: (a) **dHash duplicate detection** — a 64-bit difference hash per `SitePhoto` (bytes resolved through the storage driver's `read()`/`keyFor()` seam, so local-disk and S3/R2 both work), compared across the project's photo history **and across prior draw packs' frozen photo sets** — the "this exact photo paid for the foundation AND the slab" flag, with Hamming distance and the matched photo/pack in the detail; (b) a **vision phase-consistency pass** at draw-pack generation (prompt with the phase list + the pack's milestone context, the `analyze-photo` prompt discipline): does the photo set actually show the milestone's claimed phase, and are there render/screenshot/AI-generation tells? Both write **append-only `AiInsight` rows** with `source` labeled `'dhash'` (rule-computed, deterministic) or `'vision'` (model-computed, confidence-labeled) and **human-decision fields empty** — AI flags, humans decide (the decide action is an explicit Wave-7 follow-up; in Wave 6 the columns exist and nothing writes them, grep-pinned).
- **Files (all verified):**
  - NEW `src/backend/lib/perceptual-hash.ts` — `dHash(bytes: Buffer): Promise<string | null>` (9×8 grayscale via **sharp — already in `package.json` dependencies ^0.34.5 and installed**, zero new deps; decode failure → honest null) + pure-TS `hammingDistance(a, b)` + `DUPLICATE_HAMMING_THRESHOLD` (documented, e.g. ≤ 6 bits of 64).
  - NEW `src/backend/modules/ai/authenticity.ts` — the screen service: hash backfill for the project's photos (first run computes + caches `PhotoHash` rows), duplicate comparison incl. cross-pack, vision pass via `resolveAiProvider`, `AiInsight` row writes, audit event.
  - `prisma/schema.prisma` — append `PhotoHash` (id, photoId @unique, storageKey, dhash, computedAt) + `AiInsight` (id, projectId, targetType `'site_photo'|'draw_pack'`, targetId, kind `'duplicate'|'phase_mismatch'|'render_suspect'`, source `'dhash'|'vision'`, severity, detail JSON, confidence?, **`decidedBy`/`decision`/`decidedAt` nullable — no Wave-6 code path writes them**, createdAt) + migrations `prisma/migrations/6_photo_hash/` and `7_ai_insight/` (ONE CREATE TABLE each).
  - `src/backend/modules/drawpack/service.ts` — post-freeze hook in/after `createDrawPackForRelease`: run the screen **never-fails** (any error → console.error + audited `'ai_screen'` failed event; the pack and the release result flow back unchanged — the W4-1 "pack failure never fails the release" discipline, one test class reused verbatim); flag off → hook skips silently-by-design (documented).
  - NEW `src/app/api/ai/authenticity-screen/route.ts` — POST `{ projectId }` on-demand screen + backfill (enforceAiRoutePolicy + requireFlagOn('ai')).
  - `src/frontend/mjengo/evidence-tab.tsx` — authenticity flags on photos (source-labeled badges: "duplicate — rule" vs "phase mismatch — AI, medium confidence"), flag-gated "Run authenticity screen" button (`data.intel.flags.ai`), honest empty state.
  - `src/frontend/mjengo/audit-tab.tsx` — `AUDIT_KINDS` += `'ai_screen'`.
  - `src/backend/modules/intel/flags.ts` — comment-only enforcement-map lines.
  - i18n dicts — end-append `# W6-3 evidence authenticity` block.
  - NEW `tests/unit/perceptual-hash.test.ts` (pure: known fixtures → known hash; one-bit/two-bit pixel changes → small Hamming distances; different scenes → large; corrupt bytes → null) + NEW `tests/unit/ai-authenticity.test.ts` (SDK-mocked).
- **Acceptance criteria (testable):**
  - **Hash math (pure, no SDK):** identical bytes → distance 0; a re-encoded/shifted variant of the same scene → distance ≤ threshold; distinct scenes → distance well above; sharp failure / non-image bytes → null, **never a throw**.
  - **The demo AC:** a fixture project where the same photo is attached to milestone A's evidence and milestone B's evidence → screening at B's draw-pack generation writes exactly one `AiInsight` kind `'duplicate'` whose detail names both milestones/packs + the Hamming distance.
  - Flag OFF → route 403 (non-admin), evidence-tab button hidden, draw-pack hook skips, **`sdk.create` never called**, zero vision-source rows; `PhotoHash` rows also not written in Wave 6 (the whole screen rides the `ai` flag — one switch, per 8-f's "single switch" design; the dhash/vision split is a *labeling* honesty property — `source` on every row — not a gating split. Documented in the module header.)
  - Vision failure/unavailable → honest per-photo skip, no `AiInsight` rows, **the pack generation and the money release still succeed** (the never-fails hook test).
  - Append-only `AiInsight`/`PhotoHash` (no update path — stub contract + source walk); decision fields stay null across every Wave-6 code path (grep pin).
  - **Non-influence:** insight rows change no action outcomes (grep-level, the score-test allowlist pattern); `actions/money.ts` + `lib/mjengo.ts` untouched — the hook lives inside the drawpack module's post-release step.
  - Backfill idempotent: second screen run recomputes nothing (PhotoHash cache hit test), duplicate insights not double-written per (target, kind) window.
  - Vision input bytes via the storage driver read seam (mocked driver fixture — the storage-document-read test idiom); capped photo set per vision call (documented).
  - en/sw parity; lint, tsc, full suite green.
- **Effort: M** — hash util + two models/two migrations + the never-fails hook + an on-demand route + evidence-tab surface + ~50 tests. Research said S–M; M is honest once the two-model migration discipline and the cross-pack comparison detail are included.
- **Conflict analysis:** owns `evidence-tab.tsx`, `lib/perceptual-hash.ts`, `modules/drawpack/service.ts` (post-freeze hook only), migrations `6_`/`7_`. **No file overlap with W6-1** (W6-1 owns the viewer/money-tab side of the same packs; W6-3 owns the drawpack service + evidence tab). Shares only the end-append family (schema, i18n, audit-tab, flags.ts comments). W6-2 reads its `AiInsight` table → merge before W6-2.
- **Investor narrative:** Truepic documents genAI fake progress photos for US lenders (7-a §2) and a recycled *real* photo defeats naive deepfake detectors (7-a's practitioner source) — everyone else verifies photos; we verify photos **against a ledger**, anchored to the immutable pack the money moved on. 92% of Kenyan adults hit by scams in the past year (GASA via 7-a, [secondary — pull the report PDF before external use]) is the demand-side wind at our back.

### Wave 7 outline (one paragraph each — deliberately deferred by the research, no full specs)

- **WhatsApp voice-note ASR ingest (Gap 4, M):** the WhatsApp webhook (`src/app/api/whatsapp/route.ts`) gains an audio leg — a voice note arrives, the route fetches/decodes it, `transcribe()` (the seam 8-f already ships) turns it into text, the existing PII scrubber + `parseDeliveryTranscript` (both in `src/backend/lib/`) propose a structured delivery log, and the foreman confirms by reply before any ledger row is written — "the foreman's WhatsApp voice note becomes a ledger entry — no app, no form, in Sheng." Needs webhook audio plumbing (Meta Cloud API media fetch) which is why it was deferred; the grammar/allowlist discipline from W4-3 carries over unchanged.
- **Ledger Q&A on WhatsApp (Gap 6, S–M):** the client asks the bot "how much cement did we buy this month / why was the walling draw held?" — `chat()` over the pinned, read-only `buildProjectDigest` context with confidence labels and "verify in app" pointers, role-scoped to the client's own project through the existing session/pin seams. Conversational turn state on WhatsApp is the new surface; Procore charges ~$10k+/yr for the web-app version of this (7-a §2).
- **Invoice price-book checks (Gap 7, S–M):** `extract-document` already OCRs invoices; add LLM cross-checks against the supplier catalog + price-book + `PricePoint` market intel — unit-price outliers, quantity-vs-consumption mismatch (the anomaly-scan substrate), duplicate invoice numbers, arithmetic checks — surfacing flags into the existing 3-way-match queue **before a human approves**. Closes the last input-side gap of the money story.
- **Photo progress-% estimation (Gap 8, M):** upgrade the vision analysis to a structured per-phase completion estimate surfaced as *variance vs the contractor-claimed progress %* — a flag, never an override ("Buildots-grade progress verification from a $80 Android phone"). Needs model-prompt iteration across real site photos, which is why the research deferred it.

Also documented (backlog beyond Wave 7, not dropped): MjengoScore explainability report (7-a Gap 5, S — the six components + history as a bilingual plain-language trust narrative); the W6 extensions called out above (pre-release draw review over the requested milestone's evidence, `AiInsight` decide action to fill the human-decision fields, digest audio caching, upload-time attachment hashing in the project-less confirm flow).

---

## 2. GitHub Issue Texts (paste-ready; numbers = #TBD until the token works)

### Issue W6-1 (#TBD)

**Title:** `[ai] AI Draw Review MVP — advisory vision+LLM cross-check over frozen draw packs (AI never approves)`

**Labels:** `ai`, `wave-6`, `backend`, `frontend`, `honest-seam`

**Problem statement**
Draw packs (W4-1) freeze the evidence a release moved on — photos, ledger ref, variations, attendance, score — but nobody reviews that evidence against the money except the humans who already decided. The market pays for exactly this review (Built's Draw Agent cut US draw timelines 7→3 days, HousingWire May 2026), yet in Kenya there is no inspection industry to automate — the evidence is a foreman's phone photo. We are the system of record: we can run the review over evidence we hash-chained ourselves. Task 8-f shipped the contract (`src/backend/modules/ai/`, flag `ai` DEFAULT OFF, `resolveAiProvider`); this is the first feature on it.

**Proposed solution**
New module `src/backend/modules/ai/draw-review.ts` + POST route `src/app/api/ai/draw-review/route.ts` (`enforceAiRoutePolicy` + `requireFlagOn('ai', …)` — the pattern of the six existing `/api/ai/*` routes): resolve the pack (`drawPackId`, or `milestoneId` → its unique pack), assemble context (pack snapshot fields + live invoice 3-way verdicts via `modules/invoices/three-way.ts` + phase budget vs ledger spend), run one **vision** pass over the capped evidence-photo set (bytes via the analyze-photo resolution pattern) and one **chat** cross-check, parse STRICT JSON, and append one `AiReviewNote` row (confidence `low|medium|high`, findings, summary, `providerId`, human-decision columns present but **never written in this issue**). Serve notes read-only through the existing share GET `drawPack` branch; render an advisory section in `draw-pack-viewer.tsx` and a flag-gated "Run AI review" action on released milestones in `money-tab.tsx`. The `milestone.decide` path in `actions/money.ts` is untouched — the review runs over frozen evidence after release; re-runs append (latest wins).

**Acceptance criteria**
- [ ] Flag `ai` OFF → route 403 for non-admins (admin bypass documented); money-tab button hidden; **SDK never contacted** (`sdk.create` call-count 0 with the SDK vi.mock'ed)
- [ ] Flag ON, provider null (no `.z-ai-config`) → 200 `{ ok:false, unavailable:true, error }`; no row, no audit row
- [ ] Provider `{ ok:false }` (throw / 8s timeout / empty) → 200 `{ ok:false, error }` leak-free (planted URL/key/body asserted absent); no row written
- [ ] Success → one append-only `AiReviewNote` (confidence + findings + summary + providerId); second run appends, latest wins, first row byte-identical; no update/delete path (stub contract + source walk)
- [ ] Vision photo set capped (documented constant); bytes resolved for local-disk and mocked driver both
- [ ] Share GET `drawPack` gains `notes` read-only; revoked token → standard 404 before any note query; foreign pack id indistinguishable from miss; existing share 30/min bucket respected
- [ ] Non-influence: `AiReviewNote` referenced only in ai module + share read + viewer + i18n (grep-level test, the mjengo-score allowlist pattern); `actions/money.ts` / `lib/mjengo.ts` untouched
- [ ] Route 10/min AI-policy bucket (11th call 429 + Retry-After); audit event kind `ai_review` on success
- [ ] Migration `5_ai_review_note` = ONE CREATE TABLE, additive-only (migration test)
- [ ] en/sw `# W6-1 ai draw review` end-append blocks, parity pinned; lint / tsc / full suite green (SDK mocked everywhere — no network, no keys)

**Technical notes**
Files: NEW `src/backend/modules/ai/draw-review.ts`, `src/app/api/ai/draw-review/route.ts`, `tests/unit/ai-draw-review.test.ts`; extend `prisma/schema.prisma`, `src/backend/api/share.ts` (GET branch only), `src/frontend/mjengo/{draw-pack-viewer,money-tab,audit-tab}.tsx`, `src/backend/modules/intel/flags.ts` (comment-only), i18n dicts, `tests/unit/draw-pack.test.ts` (share round-trip pins admit `notes`). Wave-6 route convention: AI outcome states return 200 with the honest-state body (`{ok:false, unavailable?…}`), gate failures keep 401/403/400/429. Depends on: `feat/ai-foundation` merged (prerequisite §0).

**Done definition**
PR `feat/ai-draw-review` squash-merged with "Closes #TBD"; PR description walks the demo: release a milestone → "Run AI review" → note appears in the pack viewer with confidence + advisory banner → flag off → button gone, route 403, zero SDK calls.

---

### Issue W6-3 (#TBD)

**Title:** `[ai] Evidence Authenticity Screen — dHash duplicate detection + vision phase-consistency at draw-pack generation`

**Labels:** `ai`, `wave-6`, `backend`, `frontend`, `honest-seam`

**Problem statement**
Evidence photos are the root of the whole trust chain — packs freeze them, the score counts them, releases pay on them — and nothing today can tell a recycled photo from a fresh one. Truepic warns US lenders that genAI is coming for progress photos; a practitioner writeup shows a recycled *real* photo defeats naive deepfake detectors (both via the 7-a research doc). The exact fraud we exist to prevent — "this photo paid for the foundation AND the slab" — is currently undetectable. We have the substrate: `SitePhoto` rows, the storage driver `read()`/`keyFor()` seam, immutable `DrawPack` sets, and the 8-f vision seam behind the `ai` flag.

**Proposed solution**
1. `src/backend/lib/perceptual-hash.ts`: 64-bit dHash — decode + resize to 9×8 grayscale through **sharp (already a dependency — zero new deps)**, bit extraction + `hammingDistance` in pure TS; decode failure → honest null, never a throw.
2. `src/backend/modules/ai/authenticity.ts`: the screen — backfill `PhotoHash` rows for the project's photos (bytes via the storage driver read seam), duplicate comparison across the photo history **and prior packs' frozen sets**, and a vision phase-consistency + render-tell pass over the pack's capped photo set (phase list in the prompt, the analyze-photo discipline). Output: append-only `AiInsight` rows, `source` labeled `'dhash'` (rule) vs `'vision'` (model, confidence-labeled), human-decision columns present and **unwritten** ("AI flags, humans decide" — the decide action is a Wave-7 follow-up).
3. Hooks: post-freeze inside `createDrawPackForRelease` (never fails the pack or the release — the W4-1 discipline) + on-demand POST `/api/ai/authenticity-screen` + flag-gated display in `evidence-tab.tsx`.

**Acceptance criteria**
- [ ] Pure hash tests: identical bytes → 0; same-scene variant → ≤ threshold; distinct scenes → well above; corrupt/non-image bytes → null without throwing
- [ ] The demo AC: same photo in two milestones' evidence → screening at the second pack's freeze writes exactly one `duplicate` insight naming both milestones + the Hamming distance
- [ ] Flag `ai` OFF → route 403 (non-admin), tab button hidden, draw-pack hook skips, `sdk.create` never called, zero rows of either source (one switch for the whole screen — the dhash/vision split is row-level labeling, not gating; documented in the module header)
- [ ] Vision failure/unavailable → honest skip, zero vision rows, **pack + release still succeed** (never-fails hook test)
- [ ] `PhotoHash` backfill idempotent (cache hits, no recompute); no duplicate insights per (target, kind) window
- [ ] Append-only both models; decision fields null across all Wave-6 code paths (grep pin)
- [ ] Non-influence: insight rows change no action outcomes (grep-level test); `actions/money.ts` / `lib/mjengo.ts` untouched
- [ ] Migrations `6_photo_hash` + `7_ai_insight` = ONE CREATE TABLE each, additive-only
- [ ] Vision bytes via a mocked storage driver fixture; photo set per vision call capped
- [ ] en/sw `# W6-3 evidence authenticity` end-append blocks; lint / tsc / full suite green (SDK mocked; sharp fixtures are local Buffers)

**Technical notes**
Files: NEW `src/backend/lib/perceptual-hash.ts`, `src/backend/modules/ai/authenticity.ts`, `src/app/api/ai/authenticity-screen/route.ts`, `tests/unit/perceptual-hash.test.ts`, `tests/unit/ai-authenticity.test.ts`; extend `prisma/schema.prisma`, `src/backend/modules/drawpack/service.ts` (post-freeze hook ONLY — the release transaction path stays byte-identical), `src/frontend/mjengo/{evidence-tab,audit-tab}.tsx`, `src/backend/modules/intel/flags.ts` (comment-only), i18n dicts. sharp is in `package.json` dependencies (^0.34.5) and installed — first src/ call site; verify the native binary loads in the sandbox, and keep the honest null fallback if it ever doesn't (fail-closed, never blocks an upload/release). Depends on: `feat/ai-foundation` merged. **Runs in parallel with W6-1 (disjoint files); merges second.**

**Done definition**
PR `feat/ai-authenticity` squash-merged with "Closes #TBD"; PR description shows the duplicate-photo demo (one photo, two milestones, the flag) + the flag-off run with zero SDK calls.

---

### Issue W6-2 (#TBD)

**Title:** `[ai] Diaspora Trust Digest with voice — weekly EN/SW "what your money did" + TTS through the share link`

**Labels:** `ai`, `wave-6`, `backend`, `frontend`, `i18n`, `honest-seam`

**Problem statement**
The diaspora client's weekly question — "what did my money actually do?" — is answered today by an LLM-written daily recap (in-app only) and by competitors' **manual** weekly updates (DiasporaBuild/Tujitume/Fingerprint, 7-a §2: humans as the trust mechanism — trust that doesn't scale). TTS is our one untouched SDK capability, Swahili is under-served by global AI, and no one targets the payer 8 timezones away with voice in their mother tongue. The seam (task 8-f) has no TTS method — this issue extends it.

**Proposed solution**
1. **Extend the seam:** `AiProvider.speak(text, opts?)` → `AiAudioResult` (`{ ok:true, audioDataUrl } | { ok:false, error }`), implemented via `zai.audio.tts.create` (the SDK returns the raw fetch `Response` — the provider owns arrayBuffer → base64 data URL, content-type honesty, the shared 8s race + leak-free errors). Header amendment in `types.ts`: speak() renders text the caller already holds — deterministic digest text, never model-authored; the model invents nothing.
2. **The digest:** `src/backend/modules/ai/trust-digest.ts` — weekly EN + SW text **deterministically composed from rows** (releases + amounts + ledger refs from `DrawPack`; overall progress; MjengoScore delta from the two latest rows; AI flags from `AiReviewNote`/`AiInsight`; attendance summary), WhatsApp-forward-shaped, append-only `TrustDigest` rows.
3. **Delivery:** intel action `trust.digest` (the `digest.generate` precedent) + POST/GET `/api/ai/trust-digest` (the recap route pattern; GET renders audio on demand, 4/min) + `digest.trust` job type (cron-drainable) + `digest.trust` event → in-app notification (honest `'logged'`, optional SMS leg) + a share-link branch `?token&trustDigest=latest&lang=sw&audio=1` so the client reads, plays, downloads and forwards the voice note on WhatsApp themselves. Frontend: `trust-digest-section.tsx` in the intel tab (EN/SW toggle, score delta, audio player + download, honest per-language statuses).

**Acceptance criteria**
- [ ] `speak('')` → `{ ok:false }` without SDK contact; flag OFF → all four surfaces (route, action, job, share) honest-off, `sdk.create` never called
- [ ] SDK failure / 8s timeout / non-audio content-type → `{ ok:false }` leak-free, audio status `'failed'`, **text digest still delivered**
- [ ] Success → `data:audio/mpeg;base64,…` (prefix + decoded-length asserted); per-language statuses recorded honestly
- [ ] Text determinism: identical rows → byte-identical EN + SW text; every rendered figure traceable to a fixture row (no model-authored numbers)
- [ ] `TrustDigest` append-only; regeneration appends; latest-per-(project, weekStart) wins
- [ ] Share: valid token → digest JSON (+ audio only on explicit `&audio=1`); revoked token → standard 404 before any query; existing share bucket respected
- [ ] One in-app notification per generation, honest `'logged'` (nothing claims WhatsApp delivery); SMS leg only with a configured provider (mocked)
- [ ] `trust.digest` action role-gated like `digest.generate` (contractor/admin); audit kind `ai_digest`
- [ ] en/sw `# W6-2 trust digest` end-append blocks; lint / tsc / full suite green (SDK mocked)

**Technical notes**
Files: extend `src/backend/modules/ai/{types,provider}.ts` (the only Wave-6 change to the foundation files — W6-1/W6-3 import, never modify), `src/backend/actions/intel.ts`, `src/backend/modules/intel/policy.ts`, `src/backend/modules/jobs/handlers.ts`, `src/backend/modules/events/service.ts`, `src/frontend/mjengo/{intel-tab,audit-tab}.tsx`, `src/backend/modules/intel/flags.ts` (comment-only), i18n dicts, `tests/unit/ai-provider.test.ts` (speak invariants) + `tests/unit/mjengo-score.test.ts` (read-only allowlist for the score delta); NEW `src/backend/modules/ai/trust-digest.ts`, `src/app/api/ai/trust-digest/route.ts`, `src/frontend/mjengo/intel/sections/trust-digest-section.tsx`, `tests/unit/ai-trust-digest.test.ts`, `prisma/migrations/8_trust_digest/`. Depends on: W6-1 + W6-3 merged (the flags section reads their tables). **Merges last.**

**Done definition**
PR `feat/ai-trust-digest` squash-merged with "Closes #TBD"; PR description: generate the digest on the seeded project → EN/SW text with score delta + flags count → play the Swahili voice note → share link renders it for the client → flag off → honest-off everywhere, zero SDK calls.

---

## 3. Sequencing (merge order, parallel pairs, collision map)

**Recommended merge order: W6-1 → W6-3 → W6-2** (branch cut order: W6-1 and W6-3 cut together and built **in parallel**; W6-2 cut after or in parallel with a hard note that it merges last).

**Why W6-1 first:**
1. It is the flagship and the biggest demo — the single screenshot that fuses the three differentiators (evidence, ledger, AI), and the category is already funded in the US (Built's Draw Agent). Landing it first means the wave's riskiest integration surface (vision over real pack photos + share serving) is de-risked before the smaller features build confidence on top.
2. It touches `share.ts` first — both W6-1 and W6-2 add adjacent GET branches to the same function; W6-1's delta is the smaller, so it takes the file first and W6-2 rebases trivially (keep both branches).
3. It has zero dependencies on the other two (the digest *reads* its tables; the authenticity screen doesn't care about notes).

**Why W6-3 second (parallel with W6-1):** completely disjoint from W6-1 — W6-1 owns the viewer/money-tab side of draw packs, W6-3 owns the drawpack-service hook + evidence tab + its own lib/models. The two can be built simultaneously in worktrees (the Wave-3/4/5 discipline) and merge back-to-back with only end-append conflicts. W6-2 needs both `AiReviewNote` and `AiInsight` tables to exist for its "AI flags this week" section — so it merges last and reads both.

**Why W6-2 last:** the seam extension (`types.ts`/`provider.ts`) is the only change to the shared 8-f foundation files — landing it last means W6-1/W6-3 branches never carry an unmerged contract change; and the digest's flags section + the migration numbering (below) both want the other two landed.

**Parallel pairs:** W6-1 ∥ W6-3 (disjoint — build together, merge sequentially). W6-2 must NOT merge before either (schema reads + share.ts + i18n order), though its *branch* can be started in parallel once the contract shape is agreed (the flags-count read can be stubbed behind an interface until rebase).

**Expected collision files and resolution:**

| File | W6-1 | W6-3 | W6-2 | Resolution |
|---|---|---|---|---|
| `prisma/schema.prisma` | `AiReviewNote` block | `PhotoHash` + `AiInsight` blocks | `TrustDigest` block | Append-at-end model blocks in merge order; each migration folder **numbered up front** by the agreed merge order: `5_ai_review_note` (W6-1), `6_photo_hash` + `7_ai_insight` (W6-3), `8_trust_digest` (W6-2). If merge order changes, renumber before merge (the W5-3 `3_`→`4_` precedent — don't discover it at merge time). |
| `prisma/migrations/*` | `5_` | `6_`, `7_` | `8_` | Same rule as above. |
| `src/frontend/i18n/dicts/{en,sw}.ts` | `# W6-1` block | `# W6-3` block | `# W6-2` block | End-append blocks appended in **merge order** (W6-1, W6-3, W6-2) — keep both, the house rule since W4. |
| `src/backend/api/share.ts` | GET `drawPack` branch += notes | — | GET += `trustDigest` branch | Adjacent GET branches; W6-1 merges first, W6-2 rebases; keep both. |
| `src/frontend/mjengo/audit-tab.tsx` | `AUDIT_KINDS` += `ai_review` | += `ai_screen` | += `ai_digest` | One-line list appends — keep both (any order). |
| `src/backend/modules/intel/flags.ts` | comment-only enforcement-map lines | comment lines | comment lines | Comment-only — keep all lines, merge in order. |
| `tests/unit/draw-pack.test.ts` | share round-trip pins += notes | — | — | W6-1 only. |
| `tests/unit/mjengo-score.test.ts` | — | — | allowlist += trust-digest read | W6-2 only (the W4-1 read-only allowlist precedent). |
| `tests/unit/ai-provider.test.ts` | — | — | speak() suite extended | W6-2 only (it owns the seam change). |
| `src/frontend/mjengo/money-tab.tsx` / `draw-pack-viewer.tsx` | owns | — | — | W6-1 exclusive. |
| `src/frontend/mjengo/evidence-tab.tsx` | — | owns | — | W6-3 exclusive. |
| `src/frontend/mjengo/intel-tab.tsx` + new section | — | — | owns | W6-2 exclusive. |
| `src/backend/actions/intel.ts` + `intel/policy.ts` | — | — | owns | W6-2 exclusive (the `trust.digest` action). |
| `src/backend/modules/jobs/handlers.ts` + `events/service.ts` | — | — | owns | W6-2 exclusive. |
| `src/backend/modules/drawpack/service.ts` | — | owns (post-freeze hook) | — | W6-3 exclusive; release transaction path byte-identical. |
| `src/backend/modules/ai/{types,provider}.ts` | imports only | imports only | **extends (speak)** | W6-2 is the only modifier — lands last; W6-1/W6-3 branches never touch the foundation files. |

**Cross-wave chain (the honest dependency map):**
```
feat/ai-foundation (8-f, ai flag DEFAULT OFF + AiProvider contract)
   └─► W6-1 draw review (pack-scoped vision+chat; share += notes)   ─┐
   └─► W6-3 authenticity screen (dHash + vision at pack freeze)     ─┤ both read by
                                                                    └─► W6-2 trust digest (flags section) + speak() seam extension
```
Each merge: `--no-ff`, full-suite re-run (expect ~1274 → ~1400+ tests across the wave), `bunx prisma db push` from `main` after each schema-merging PR (new tables only, no data change — the coordinator-run rule from W3-3/W4-1), re-seed only when the demo needs it. The token-unblock step still sits in front of issue creation (paste §2 the moment it works, then branch → PR "Closes #N" → verify → merge, per `docs/GITHUB-HANDOFF.md`).

**What is deliberately NOT in Wave 6:** WhatsApp voice-note ASR ingest, ledger Q&A on WhatsApp, invoice price-book checks, photo progress-% estimation (all Wave 7, §1 outline — the research's deferrals hold); MjengoScore explainability (backlog); pre-release draw review (the note informs the *human* decision only if it exists pre-decide — deferred because the UX of advisory-in-the-decision-flow deserves its own design pass, noted in W6-1's spec); `AiInsight` decide action; digest audio caching; upload-time attachment hashing (the upload-confirm flow is project-less by design — 8-a's documented scope cut — so project-scoped comparison happens at pack freeze + on demand).

---

## 4. Docs honesty fixes (for the Documentation agent — do BEFORE any investor-facing use)

The 7-a research flagged two narrative claims that an investor will Google. Verified locations today (grep-verified; the marketing site `mjengoos-website/` is clean of both):

1. **"70–151%" is variation-orders' SHARE OF OVERRUN COST, not an overrun magnitude.** Primary: Lukale 2018, Strathmore repository (su-plus.strathmore.edu). Fix the framing wherever it implies magnitude:
   - `docs/backlog.md:41` — "the exact controls Strathmore data says drive 70–151% of overruns" → e.g. "…the controls tied to 70–151% of overrun *costs* (Lukale 2018, Strathmore)".
   - `src/backend/modules/intel/score.ts:~143` — code comment "variation orders drive 70–151% of Kenyan overruns" → "variation orders accounted for 70–151% of cost-overrun costs (Lukale 2018)".
   - Grep `70–151|70-151` across README/docs before the raise; worklog entries are history — append corrections, never rewrite.
2. **"4-in-5 diaspora clients lose money" is UNSOURCED** (could not be traced to a primary; the honest qualitative anchors are Nation's "Dream homes, real losses", Jun 2025, and the Feb 2026 diaspora-scam reporting). Soften to "widespread diaspora losses" or cite the qualitative sources:
   - `docs/backlog.md:63` — the W4-1 pitch "4 out of 5 diaspora clients lose money…" → "widespread diaspora losses (Nation, Jun 2025) because they can't hold proof…".
   - `docs/backlog.md:228` — "4/5 diaspora clients report lost money or incomplete projects (1-a)" → "diaspora losses are widely reported (Nation 2025; thekenyandiaspora.com 2026); 1-a's 4-in-5 figure remains unsourced".
3. **While at it (same honesty pass, from the research's unverified list):** never cite externally without the primary — the 48%-of-VC/AI stat, the 92%-of-Kenyans-scammed stat (pull the GASA report PDF), and the Kenya-leads-world-in-AI-usage claim (identify the underlying survey). All flagged in `docs/research/market-gaps-2026-09.md` §7's unverified list.

*(This plan itself cites the research doc — numbers above are its claims with its confidence labels; nothing invented here.)*

---

*Prepared by task 7-c (Senior Product Manager). Research-only + this one document — no code was written or modified.*
