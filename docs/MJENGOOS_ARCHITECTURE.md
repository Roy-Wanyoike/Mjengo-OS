# MjengoOS Architecture — Technical Deep-Dive

**Document status:** v1.0 · 2026-08-28 · Author: Technical Documentation Engineer (Task 14-b)
**Method:** every statement below was verified by reading the source at `/home/z/my-project`. Where something does not exist, it is listed under "Not implemented / boundaries". Companion documents: `MJENGOOS_FEATURE_AUDIT.md` (status matrix), `MJENGOOS_ROADMAP.md` (strategy), `MJENGOOS_TEST_PLAN.md` (QA), `MJENGOOS_DATABASE.md`, `MJENGOOS_API.md`, `MJENGOOS_SECURITY.md`.

---

## 1. System overview

One Node process, one SQLite file, no external services except the z-ai SDK. Everything renders on a single Next.js route (`/`); all server logic hangs off `/api/*`.

```
                        ┌──────────────────────────────────────────────────┐
                        │  Browser (single-page app, src/app/page.tsx)      │
                        │  MjengoApp shell · 11 tabs · zustand store         │
                        │  (owner surface · client role · share-token link)  │
                        └───────────────┬──────────────────────────────────┘
                                        │ fetch (JSON, session cookie or ?share= token)
                        ┌───────────────▼──────────────────────────────────┐
                        │  Next.js 16 App Router — src/app/api/**/route.ts  │
                        │  THIN CONTROLLERS: parse → call service → shape   │
                        │  core/guard.ts withGuard: 401 / 403 / 429 / 500    │
                        └───────┬──────────────────────┬───────────────────┘
                                │                      │
              ┌─────────────────▼────────┐   ┌─────────▼──────────────────┐
              │ src/backend/domains/*     │   │ src/lib/mjengo.ts          │
              │ 6 domain services         │   │ Wave-1 action engine       │
              │ supply · intel · land ·   │   │ (37 action types, shared   │
              │ land/legal · professionals│   │  by /api/actions,          │
              │ · ussd                    │   │  /api/share, /api/sync)    │
              └─────────┬────────────────┘   └─────────┬─────────────────┘
                        │         both layers share core/audit (logAudit)  │
              ┌─────────▼──────────────────────────────▼──────────────────┐
              │ Prisma Client (src/lib/db.ts, dev singleton, query log)   │
              └─────────┬─────────────────────────────────────────────────┘
                        │
                 ┌──────▼──────┐        ┌─────────────────────────────┐
                 │ SQLite       │        │ z-ai-web-dev-sdk            │
                 │ db/custom.db │        │ (LLM · vision · ASR)        │
                 │ 36 models    │        │ used only by /api/ai/* via  │
                 └──────────────┘        │ src/lib/ai.ts               │
                                         └─────────────────────────────┘

  Public share-token surface (no login):
    /?share=<token> → GET /api/share · POST /api/share (allowlist)
    GET /api/project?share= · GET /api/land?share= · /api/land/events?share= · /api/legal?share=
    — every one of these pins the caller to the ONE project the token unlocks.
```

Two backend layers coexist by design (documented in `src/backend/README.md`):

| Layer | Home | Powers | Status |
|---|---|---|---|
| **Canonical backend** | `src/backend/core/*` + `src/backend/domains/*` | suppliers, intel, land, legal, professionals, ussd routes | new code goes here |
| **Legacy action engine** | `src/lib/mjengo.ts` + `src/lib/actions/{trust,money,evidence}.ts` | `/api/actions`, `/api/share`, `/api/sync` (37 action types) | stable, browser-verified; both layers share `core/audit` and `core/guard` (via the `src/lib/guard.ts` re-export shim) |

---

## 2. Frontend architecture

**One page, one shell.** `src/app/page.tsx` renders `<MjengoApp />` (`src/components/mjengo/app.tsx`, 333 lines). `src/app/layout.tsx` wraps it in `AuthSessionProvider` (NextAuth `SessionProvider`). There is no router beyond the single route — "pages" are tab states. Login is an app state (`LoginScreen`), not a route.

**Tab registry.** The 11-tab list lives in `header.tsx` as the `TABS` array (key, label, icon):

```
overview · site · materials · supply · fundis · money · evidence · land · intel · ussd · copilot
```

`app.tsx` exports `CLIENT_HIDDEN_TABS = ['copilot', 'supply', 'intel', 'ussd']`. The header computes `tabs = isShareClient ? TABS.filter(...) : TABS` — the client surface (share link or client-role login) sees exactly 7 tabs. `app.tsx` additionally guards against a stale tab key (`activeTab` falls back to `overview` if hidden). Land is deliberately client-visible: it shows *their* plot's verified status.

**Per-tab components** in `src/components/mjengo/` (27 files): `overview-tab`, `site-plan-tab`, `materials-tab`, `supply-tab`, `fundis-tab`, `money-tab`, `evidence-tab`, `land-tab` (+ `land/` sub-components: parcel detail, parcel-history, legal-review, professional-directory), `intel-tab`, `ussd-tab`, `copilot-tab`, plus dialogs (`create-project-dialog`, `share-dialog`, `expense-dialog`, `worker-dialogs`), `project-switcher`, `diaspora-banner`, `timelapse-card`, `site-map-card`, `photo-comments`, `export-utils`, `welcome-screen`.

**State: `useMjengo` zustand store** (`src/hooks/use-mjengo.ts`, 653 lines) — the app's single source of truth:

- State: `data` (full `ProjectPayload`), `projects` (list), `activeProjectId`, `viewMode` (`'owner' | 'client'`), `shareToken`, `clientRole`, `shareError`, `notificationsSeenAt`, `actionBusy`, `loading`, `online`, `syncing`, `outbox`, `lastSyncAt`.
- Persisted to localStorage under **`mjengo-os-store`** via `zustand/persist`, `partialize` keeps `online, outbox, data, lastSyncAt, activeProjectId, shareToken` (viewMode/projects are deliberately NOT persisted).
- `load()` → parallel `GET /api/projects` + `GET /api/project[?projectId=]`; `switchProject(id)`; `createProject()` → `POST /api/projects`.
- `bootFromShare(token)` → `GET /api/share?token=` → sets `viewMode:'client'` + `shareToken`; a 404 from a URL param drives the full-screen dead-link screen.
- **`dispatch(type, payload, label)`** is the single mutation path, with three client branches before the owner path:
  1. share-link client + allowlisted action → `POST /api/share` (online only);
  2. logged-in client-role + allowlisted → `POST /api/actions` (session cookie);
  3. any other client-view dispatch → toast "Read-only client view — site data is managed by the site team" and return `false`.
  Owner + online → `POST /api/actions`; owner + offline → optimistic local write + queue (below).
- `CLIENT_ACTIONS` is imported from `src/lib/client-actions.ts` — the same server-safe module the API routes use, so client and server enforce ONE list.

**Toasts:** `sonner` (`toast.*` used directly across components). A `use-toast.ts` hook exists in `src/hooks/` for shadcn-style toasts.

### Offline-first design (client outbox)

Honest framing: **offline is simulated, not a PWA.** There is no service worker, no `manifest.json` (verified: `public/` contains only `audio/`, `photos/`, `logo.svg`, `robots.txt`).

1. **Connectivity is a manual toggle** in the header (`Switch` bound to `setOnline` in `header.tsx`) — it simulates field connectivity loss; `navigator.onLine` is never consulted.
2. **While "offline"**, `dispatch()` applies `reduceLocal(data, type, payload)` — a hand-written optimistic reducer mirroring 26 action types (task/phase CRUD, deliveries, consumptions, attendance, workers, expenses, transactions, materials, project.update with proportional phase-budget rescale, wages.pay, alert.ack, photo.apply, escrow.topup, milestone.decide, variation.decide, comment.add, notification.read/readAll, zone.create/delete) — then appends an `OutboxItem { id, type, payload, label, createdAt, projectId }` to `outbox` (persisted to localStorage, survives reload).
3. **On reconnect** (`setOnline(true)`) or via the header **Sync** button (badge shows queue depth), `syncNow()` POSTs the whole outbox to **`/api/sync`** (`{ actions: [...] }`, max 200 per flush) and keeps only items the server reported as failed.
4. **Server side** (`src/app/api/sync/route.ts`): each action is applied independently; non-site-team sessions are restricted to `CLIENT_ACTIONS` per-item; every flushed action gets `__actor`/`__role` stamped from the session (the queued payload can never override identity) so the Bias-Free Ledger attributes offline work to the person whose device queued it. Response `{ ok, synced, failed, results[], data, projects }`.
5. **Ledger attribution** — `applyAction()` in `src/lib/mjengo.ts` strips `__actor`/`__role` from the payload before handlers run and uses them only for the `logAudit` entry; handlers never see caller-supplied identity.

---

## 3. Backend architecture — `src/backend/`

### 3.1 `core/` — the shared kernel

| Module | Exports (actual names) | Provides |
|---|---|---|
| `core/guard.ts` | `withGuard(handler, opts)`, `getSessionFromReq(req)`, `unauthorized()`, `forbidden(role?)`, types `GuardSession`, `GuardOptions` | The canonical guard v2. `withGuard` gives every route: 401 without session → 403 when `roles` set and session role missing → 429 when the per-user rate budget (`key = tag:userId|email`) is exhausted → error boundary (`ApiError` → its status/message; anything else logged `[tag]` + generic 500, no internals leaked). Session decoded straight off the JWT cookie via `next-auth/jwt getToken`. `src/lib/guard.ts` is a re-export shim so 20 legacy imports keep working. |
| `core/http.ts` | `ApiError(status, message)`, `badRequest()`, `notFound()`, `accessDenied()`, `apiErrorResponse(e, tag)`, `readJson(req)`, `unknownAction()`, `fieldStr()`, `fieldPos()`, `fieldNonNeg()`, `optionalId()`, `normalizeReference()` | The HTTP vocabulary: services throw `ApiError`; validators throw 400 with the exact UX-critical message the UI toasts; `readJson` turns malformed JSON into `{}`; `normalizeReference` collapses whitespace + uppercases registry numbers. |
| `core/rate-limit.ts` | `checkRateLimit(key, limit, windowMs)`, `clientIpOf(req)`, `rateLimitedResponse()`, `ipRateLimited(req, tag, limit, windowMs)` | In-memory sliding-window limiter (deliberately no Redis — one Node process). `Map<string, number[]>` of hit timestamps, opportunistic sweep, capped at 10,000 keys. `clientIpOf` reads `x-forwarded-for` → `x-real-ip` → `'local'`. 429 body: `{ error: 'Too many requests — wait a moment and try again.' }` |
| `core/policy.ts` | `SITE_ROLES`, `SIGNED_IN_ROLES`, `LIMITS` | The authorization matrix + 9 rate-limit presets (see MJENGOOS_API.md §2). `SITE_ROLES = ['contractor','admin']`; the rule "a hidden tab is UI, a rejected call is security" — every `CLIENT_HIDDEN_TABS` tab has its APIs under `SITE_ROLES`. |
| `core/phones.ts` | `normalizeKenyanPhone(raw)`, `phoneForLookup(raw)` | Kenyan mobile normalization: `+254…`/`254…`/`7…`/`1…` all → canonical `07XXXXXXXX`; non-mobile input → `null` (callers fall back to the trimmed raw so lookups miss honestly, never crash). |
| `core/audit.ts` | re-exports `logAudit`, `summarizeAction`, `kindForAction`, `AuditActor` from `src/lib/audit.ts` | Canonical import point for the Bias-Free Ledger. `logAudit(projectId, kind, actor, summary, meta?)` is append-only and never throws (auditing must not break actions). |

### 3.2 `domains/` — the six services

| Service | Key exports | Responsibility & honesty contract |
|---|---|---|
| `domains/supply/supply-service.ts` | `listSupplyData(projectId)`, `createOrder(body, actor)`, `markDelivered(body, actor)`, `verifyDelivery(body, actor)`, `recomputeSupplierTrust(supplierId)` | Order lifecycle ordered → delivered → verified/mismatch. Verify compares delivered quantity vs invoiced (short delivery) and `unitCost` vs `marketCost × 1.1` (above-benchmark %); mismatches stated plainly, never as fraud. Trust counters recomputed from the order ledger inside a `db.$transaction` — the directory reflects evidence, not opinion. TRUST_RULES: verified = ≥80% orders verified AND <2 mismatches; watchlist = <50% verified OR ≥2 mismatches; new = no history. |
| `domains/intel/intel-service.ts` | `getIntelData(projectId)`, `updateSignal(body, actor)` | GET returns signals + digests + assessments + a `live` block computed from REAL project data on every read (attendance verified/reported/exception mix, milestones with evidence, open signal counts). The risk metric is ALWAYS "Verification Risk" — evidence-backed-ness, never "fraud". Signal lifecycle: open → acknowledged / resolved (+ audit). |
| `domains/land/land-service.ts` | `resolveReadScope(req)`, `listLandData(req)`, `searchTitle(body, actor)`, `listParcelEvents(req)`, `REGISTRY_SOURCE` | Read-scope resolution: site team → any project; client role → pinned to `session.user.projectId`; share token → pinned to the token's project (cross-project ids answered with a plain 404, indistinguishable from an invalid link). Title search: `normalizeReference` + punctuation-insensitive fallback ("ir 118923" finds "I.R. 118923" — a false miss on a real parcel is the scariest answer this product can give); unknown numbers → **honest miss**: `found:false`, "We do not guess — an official search at the Ministry of Lands or Ardhisasa is the only authoritative source." `REGISTRY_SOURCE = 'eRegistry (simulated)'` on every row. |
| `domains/land/legal-service.ts` | `listReviews(req)`, `requestReview(body, actor)`, `SCOPE_CHECKS` | Scope-honest legal opinions: `coveredChecks` lists exactly what the scope covers (title / transfer / diligence / dispute maps), never blanket assurance. `requestedBy` is stamped from the session (server truth), never the body. Lawyer assigned deterministically (first verified lawyer, name-asc). |
| `domains/professionals/professionals-service.ts` | `listProfessionals()`, `verifyRegistration(body, actor)` | Board-roll verify-someone. Found → detail + `verified:true` with source "`<board>` registry (simulated)" (request + update in one `db.$transaction`). Not found → **honest miss**: "This does not prove it is fake — it means we cannot confirm it. Verify directly with the board (LSK/BORAQS/EBK)." Open to every signed-in role on purpose — a diaspora client verifying their own lawyer is the point. |
| `domains/ussd/ussd-service.ts` | `listUssdData(projectId)`, `startSession(phone)`, `sendInput(phone, input)`, `endSession(phone)` | Full `*384*746#` state machine (main → pin → help; menu state in `UssdSession.lastMenu`). Hardening: both sides of every lookup phone-normalized; 5-minute session expiry with honest "dial again" message; 3-attempt PIN lockout (attempts encoded `pin:1`/`pin:2` in `lastMenu`); honest "You have no PIN yet" for PIN-less workers (not "wrong PIN"); unknown number → plain "not registered"; input capped at 20 chars. **A USSD check-in is SELF-REPORTED**: attendance created with `verification:'reported'`, `recordedBy:'USSD self check-in'`, and the worker is told so ("Self-reported — confirm at the site kiosk for verified status"). Balance = honest live sum of unpaid attendance wages. |

### 3.3 Layering rules (enforced by convention, checked in review)

1. **Routes are thin controllers**: parse (`readJson`) → discriminate on `action` → call one service function → `NextResponse.json(...)`. No business logic, no Prisma calls in `src/app/api/**` (the Wave-1 routes `/api/actions`, `/api/share`, `/api/project`, `/api/projects` are the documented legacy exception — they call the `src/lib` engine directly).
2. **Services throw `ApiError`**; the guard boundary turns it into `{ error }` with the right status.
3. **Every user-visible mutation goes through `logAudit`** — domain services call it explicitly; the legacy engine's `applyAction` calls it automatically after every successful action.
4. **Identity comes from the session, never the body** (`requestedBy`, `searchedBy`, `__actor` are server-stamped).
5. **Validators in `core/http`** produce deterministic UX-critical messages — the same strings the UI toasts.

---

## 4. Honest-product rules enforced in code (where to find them)

| Rule | Code location |
|---|---|
| Honest miss on unknown title/parcel numbers + "we do not guess" + Ministry of Lands/Ardhisasa pointer; registry always labeled simulated | `land-service.ts` `searchTitle()` (found:false branch), `REGISTRY_SOURCE` |
| False-miss avoidance: punctuation-insensitive title fallback | `land-service.ts` `searchTitle()` squashed-reference pass |
| Honest miss on unknown board registrations ("not found ≠ fake") | `professionals-service.ts` `verifyRegistration()` |
| "Verification Risk" naming — never "fraud score" | `intel-service.ts` header comment + schema comment on `RiskAssessment` |
| Intel `live` block computed from real data, nothing hardcoded | `intel-service.ts` `getIntelData()` |
| USSD attendance is self-reported (`verification:'reported'`) and the worker is told so | `ussd-service.ts` `sendInput()` attendance create + "Asante… Self-reported" message |
| No-PIN is not "wrong PIN"; unknown number is not an error | `ussd-service.ts` `NO_PIN`, `UNKNOWN_NUMBER` |
| Supply mismatches stated plainly ("Short delivery: 88 of 100 bag…", "N% above benchmark"), never called fraud; trust recomputed from evidence | `supply-service.ts` `verifyDelivery()`, `recomputeSupplierTrust()` |
| Legal opinions list exactly what they cover; requester stamped from session | `legal-service.ts` `SCOPE_CHECKS`, `requestReview()` |
| Money never moves without proof-of-work photos; insufficient escrow refused; budget moves only after client approval | `src/lib/actions/money.ts` (`milestone.requestRelease` evidence gate, `milestone.decide` balance check, `variation.decide` budget move) |
| Attendance overrides are append-only (`overrideLog` JSON, never erased); manager-set attendance is `reported`, worker-initiated is `verified` | `src/lib/mjengo.ts` `attendance.setStatus` / `attendance.checkin` |
| Ledger attribution: offline/share actions attributed to a real person, never "someone" | `/api/sync` + `/api/share` `__actor`/`__role` stamping |

---

## 5. Not implemented / boundaries (one line each)

- **Multi-tenant organizations** — no `Organization` model, no team membership; "admin" is a global role, projects are not grouped per company.
- **PWA / service worker** — no `manifest.json`, no SW registration; offline is the simulated toggle + localStorage outbox described in §2.
- **Background job queue** — no cron/worker (recaps and anomaly scans are generated only when a user clicks; digests are seed-written).
- **Payment provider integration** — M-Pesa is not wired; escrow is simulated KES (`EscrowWallet.balance`), references are auto-generated strings like `MPESA-XXXXXXXX`.
- **WhatsApp** — `Notification.channel='whatsapp'` rows are a delivery-log stub; no WhatsApp Business API integration exists.
- **Global search** — the only search is the land title/parcel search (`/api/land` POST); nothing searches across projects, photos, or ledger entries.
- **Notification center (cross-project / push)** — an in-app per-project bell exists (`header.tsx` `NotificationBell`, `notification.read/readAll` actions), but there is no aggregated cross-project center and no push/email/SMS delivery.
- **Automated tests** — no test runner or test script in `package.json`; verification is the manual browser QA recorded in `worklog.md` (see `MJENGOOS_TEST_PLAN.md`).
- **i18n** — `next-intl` is installed but used nowhere in `src/`; UI copy is English + fixed Swahili strings.
- **Real registry integrations** — the land registry (`eRegistry (simulated)`) and board rolls are simulated seed data behind honest-miss interfaces.
