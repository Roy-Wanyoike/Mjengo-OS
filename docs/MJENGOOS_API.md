# MjengoOS API Reference — Technical Deep-Dive

**Document status:** v1.0 · 2026-08-28 · Author: Technical Documentation Engineer (Task 14-b)
**Method:** every route under `src/app/api/**/route.ts` (17 files, 16 route groups + the `/api` health endpoint) was read in full. Body shapes come from the actual destructuring/`fieldStr`/`fieldPos` reads; response shapes from the actual `return` statements; error messages are quoted verbatim.

---

## 1. Conventions

**Auth model (three flavors):**
1. `withGuard(handler, { roles, rateLimit, tag })` — session required; optional role allowlist; per-user sliding-window limit; tagged error boundary.
2. Raw route with manual `getSessionFromReq` + optional `?share=<token>` — the land/legal/public surface.
3. Fully public + per-IP rate limit — `/api/share`, `GET /api`, `GET /api/land*`, `GET /api/legal`.

**Standard error envelope** (`src/backend/core/http.ts`):

```json
{ "error": "human-readable message" }
```
- `ApiError(status, message)` thrown by services → `{ error: message }` with that status.
- Unexpected exception → `console.error('[api/<tag>]', e)` server-side + `{ "error": "Something went wrong on our side — please try again." }` with 500. Internals never leak.
- Rate limited → 429 `{ "error": "Too many requests — wait a moment and try again." }`
- Legacy shape (Wave-1 routes only): `/api/actions` and `/api/share` POST catch blocks return 400 `{ "ok": false, "error": ... }`.

**Standard success envelope:** mutations return `{ "ok": true, ...payload }` (plus `data` = refreshed `ProjectPayload`, and `projects` where noted); GET reads return the plain payload object (no `ok` wrapper) — e.g. `/api/project` returns the `ProjectPayload` directly.

**Rate-limit presets** (`src/backend/core/policy.ts` `LIMITS`) — requests per 60 s window:

| Preset | limit | window | Keyed by | Used by |
|---|---|---|---|---|
| `read` | 240 | 60 s | user | suppliers GET, intel GET, ussd GET, professionals GET |
| `write` | 30 | 60 s | user | suppliers POST, intel POST, projects POST, legal POST |
| `search` | 20 | 60 s | user | land POST (title.search), professionals POST |
| `ussd` | 90 | 60 s | user | ussd POST (a flow is ~10 keypresses) |
| `ai` | 12 | 60 s | user | all five /api/ai/* routes |
| `upload` | 20 | 60 s | user | upload POST |
| `sync` | 30 | 60 s | user | sync POST |
| `share` | 30 | 60 s | **IP** | share GET+POST, land GET, land/events GET, legal GET |
| `health` | 60 | 60 s | **IP** | GET /api |

Per-user key = `api/<tag>:<userId|email>`; per-IP key = `api/<tag>:<clientIp>` (from `x-forwarded-for` → `x-real-ip` → `local`).

---

## 2. Route-by-route reference

### `GET /api` — health (public)
- Per-IP `health` limit. Runs `SELECT 1` against SQLite.
- 200 `{ ok: true, service: "MjengoOS", db: "ok", time: ISO }` · 503 with `db:"unreachable"` when the DB is down. Deliberately leaks nothing else.

### `/api/auth/[...nextauth]` — NextAuth v4
- Standard GET/POST auth handlers (credentials provider, JWT strategy; see MJENGOOS_SECURITY.md).

### `POST /api/actions` — owner/client action dispatch (session, or share-token fallback)
- Body: `{ type: ActionType, payload?, projectId?, shareToken? }`. 400 `type required` when `type` missing.
- No session → share-token fallback: token must resolve (404 `Invalid or expired link`) AND `type` must be in `CLIENT_ACTIONS` (else 401). Client-role session: non-allowlisted type → 403 `Not permitted for role "client"`. Site team: identity stamped `__actor`/`__role` from session (never overridable by payload).
- Calls `applyAction` (37 action types; see MJENGOOS_DATABASE.md writers).
- 200 `{ ok: true, result, data, projects }` · 400 `{ ok:false, error }` on action failure.
- **Note:** no rate limit on this route (it predates the guard v2 presets; mutations here are individually guarded by action-level validation).

### `GET /api/project` — full project payload (session, or `?share=` token)
- `?projectId=` optional (falls back to first project). No session and no/invalid `share` → 401.
- 200 `ProjectPayload` (project, phases, workers, materials, consumptions, deliveries, photos, alerts, transactions, recaps, summary, escrow, milestones, variations, zones, notifications, auditEvents, photoComments) · 404 `Project not found` / `No project found` · 500 `Failed to load project`.

### `GET|POST /api/projects` — project list & creation
- **GET**: `withGuard` with **no options** — any signed-in role, no rate limit. 200 `{ ok: true, projects: ProjectListItem[] }`.
- **POST**: `SITE_ROLES` + `write`. Body `{ name, client?, clientType?, location?, budget, startDate?, targetDate?, template? }`; 400 `name required` / `budget must be a positive number`. Creates the project + phase rows from a template (bungalow 5-phase / maisonette 6 / duplex 5 / blank 1, budget split by template percentages). 200 `{ ok: true, result: { id, shareToken }, data, projects }`.

### `POST /api/sync` — offline outbox flush (session; any role)
- `sync` limit; `maxDuration = 60`. Body `{ actions: [{ id, type, payload, projectId? }], projectId? }`.
- 400 `actions[] required` / `actions[] too long (max 200 per flush)`.
- Each action applied independently; non-site-team roles restricted per-item to `CLIENT_ACTIONS` (failed item: `Not permitted for role "<role>"`); every applied action stamped `__actor`/`__role` from the session.
- 200 `{ ok: true, synced, failed, results: [{ id, ok, error? }], data, projects }` (data refreshed for the single distinct projectId or the top-level one).

### `/api/share` — public "Virtual Site Visit" (no login, per-IP)
- **GET** `?token=` → per-IP `share` limit. 400 `Share token required` · 404 `Invalid or expired link` (also when the payload can't load) · 200 `{ ok: true, data: ProjectPayload, project: { name, client, location, status } }`.
- **POST** `{ token, type, payload }` → per-IP limit (tag `api/share:post`). 400 `Share token required` / `type required` · 403 `Not permitted from a client link` for anything outside the allowlist `['milestone.decide','variation.decide','comment.add','notification.read','notification.readAll']` · 404 `Invalid or expired link`. Actor is always stamped as the project's client (`__role:'client'`) — link visitors can never impersonate the site team. 200 `{ ok: true, result, data }`.

### `GET|POST /api/suppliers` — supply chain (SITE_ROLES)
- **GET** `?projectId=` → `read` limit → `listSupplyData` → `{ suppliers, orders, benchmarks }`.
- **POST** `write` limit; body `{ action, ... }`:
  - `order.create` — `supplierId` ("Pick a supplier from the directory"), `materialName`, `quantity > 0`, `unit`, `unitCost > 0`, `marketCost > 0`, `projectId?` → `{ ok, order }` + audit.
  - `order.deliver` — `orderId`; only from `ordered` (400 `Only ordered items can be marked delivered (this one is <status>)`); 404 `Order not found`.
  - `order.verify` — `orderId`, `deliveredQuantity ≥ 0` ("Enter how many units actually arrived"); only from `delivered`; mismatch rules: short delivery or `unitCost > marketCost × 1.1` → status `mismatch` with honest `issue` text; recomputes supplier trust → `{ ok, order, supplier }`.
  - anything else → 400 `Unknown action`.

### `GET|POST /api/intel` — site intelligence (SITE_ROLES)
- **GET** `?projectId=` (**required** — 400 `projectId required` from the service) → `{ signals, digests, assessments, live: { attendance { total, verified, reported, exception, verifiedPct }, milestones { total, withEvidence, released }, signals { high, medium, low } } }` — `live` computed from real attendance/milestone/signal rows on every read.
- **POST** `write` limit; `action: 'signal.ack' | 'signal.resolve'`, `id` (400 `Signal id required`, 404 `Signal not found`) → `{ ok, signal }` + audit.

### `GET|POST /api/land` — LandVerify
- **GET** — public surface: per-IP `share` limit; session OR `?share=` token (`resolveReadScope`: 401 `Sign in required` without either; 404 `Invalid share link` for a bad token). Client role and share tokens are **pinned to their own project** regardless of the `projectId` param. 200 `{ parcels (with documents), surveyors, searches (last 10) }`.
- **POST** — `SITE_ROLES` + `search` limit; only `action: 'title.search'` (else 400 `Unknown action`). Body `query` (400 `Enter a title or parcel number to search`). `normalizeReference` + punctuation-insensitive fallback; found → `{ ok, search }` with registry summary; **honest miss** → `search.found = false`, summary "No record found for … We do not guess — an official search at the Ministry of Lands or Ardhisasa is the only authoritative source." Source always `eRegistry (simulated)`.

### `GET /api/land/events` — parcel history (session OR share, per-IP)
- `share` limit. `?parcelId=` required (400 `parcelId required`). Scoping: site team any parcel; client role → their project's parcels; share token → the token's project. A foreign parcelId is answered 404 `Invalid share link` (indistinguishable from a bad token). 200 `{ events }`.

### `GET|POST /api/legal` — legal reviews
- **GET** — per-IP `share` limit; session OR `?share=&parcelId=`. Same pinning as events; foreign parcel → 404 (`Parcel not found` for client sessions, `Invalid share link` for share links). 200 `{ reviews }`.
- **POST** — `withGuard` **any signed-in role** + `write` limit; only `action:'request'`. Body `scope` (title/transfer/diligence/dispute; 400 `Pick a review scope (title, transfer, diligence or dispute)`), `parcelId` (404 `Parcel not found`). Assigns the first verified lawyer deterministically; `requestedBy` stamped from the session. → `{ ok, review }` + audit.

### `GET|POST /api/professionals` — board registry (any signed-in role, deliberately)
- **GET** `read` limit → `{ professionals, requests (last 10) }`. Open to clients on purpose — verifying your own lawyer is the point.
- **POST** `search` limit; only `action:'verify'`. Body `registrationNo` (400 `Enter a registration number to verify`), normalized (`lsk/p/2016/2319` → `LSK/P/2016/2319`). Found → `{ ok, request, professional }` (professional marked verified, source "`<board>` registry (simulated)"); not found → `{ ok, request }` with the honest miss: "…This does not prove it is fake — it means we cannot confirm it. Verify directly with the board (LSK/BORAQS/EBK) before relying on it."

### `GET|POST /api/ussd` — USSD simulator (SITE_ROLES)
- **GET** `?projectId=` → `read` limit → `{ sessions (last 30, with logs), workers (id,name,phone,pin) }`.
- **POST** `ussd` limit (90/min); body `{ action, phone, input? }`:
  - `start` → 400 `phone required` if unparseable; creates session, returns main menu `{ ok, session, logs }`.
  - `input` → state machine; 404 `No active session — dial *384*746# to start`; input trimmed & capped at 20 chars; PIN flow (3 attempts → lockout message + abandoned), attendance check-in (`verification:'reported'`, audit entry), balance (live unpaid-wage sum), help submenu.
  - `end` → 404 `No active session`; marks abandoned.

### `POST /api/upload` — evidence photo (any signed-in role)
- `upload` limit. Body `{ dataUrl }` (400 `dataUrl required` when missing/not a data URL; 400 `Unsupported image format (png/jpg/webp only)` when the mime regex fails). Writes `public/photos/upload-<epoch>-<8hex>.<png|jpg|webp>` (base64-decoded). 200 `{ url: "/photos/<name>" }` · 500 `Could not save the photo`.
- Boundary (accepted for demo evidence photos): files under `public/` are served statically with **no auth on GET** — see MJENGOOS_SECURITY.md §6.

### `/api/ai/*` — AI features (all SITE_ROLES, `ai` limit = 12/min, `maxDuration = 120`)

| Route | Body | Behavior | Response |
|---|---|---|---|
| `POST /api/ai/analyze-photo` | `{ dataUrl? \| url?, photoId?, phaseId?, apply?, projectId? }` | VLM inspection with phase context (prompt demands STRICT JSON, conservative, evidence-based). `url` variant reads the file from `public/` with `..` stripped (basic traversal guard). `apply:true` runs the `photo.apply` action (attaches analysis, may bump phase progress). | `{ ok, analysis, phaseId, phaseName, recordedProgress, appliedPhotoId, data }` · 400 `Invalid dataUrl` / `dataUrl or url required` · 404 `No project` · 500 `Photo analysis failed` |
| `POST /api/ai/anomaly-scan` | optional `{ projectId? }` (empty body OK — falls back to first project) | Ledger reconciliation via `buildProjectDigest` + LLM (material variance, ghost workers, budget trajectory >8 pts, supplier pricing); persists ≤4 `Alert` rows with type/severity whitelisted. | `{ ok, alerts, summary, data }` · 500 `Anomaly scan failed` |
| `POST /api/ai/parse-text` | `{ text, projectId? }` | Text variant of the voice parser (typed notes / WhatsApp forwards). | `{ ok, ...parsed }` · 400 `text required` · 500 `Parsing failed` |
| `POST /api/ai/recap` | optional `{ projectId? }` | 6 PM EAT WhatsApp-style daily recap (LLM); persists a `Recap` row + a `Notification` (channel `whatsapp` — delivery-log stub). | `{ ok, recap }` · 500 `Recap generation failed` |
| `POST /api/ai/voice-log` | `{ audioBase64, projectId? }` | z-ai SDK ASR (Swahili/Sheng/English) → `parseDeliveryTranscript`. | `{ ok, ...parsed }` · 400 `audioBase64 required` / `Audio too large (max ~9MB)` (12 MB base64 cap) / `Could not hear any speech in that voice note` · 500 `Voice processing failed` |

---

## 3. The 37 action types (dispatched by `/api/actions`, `/api/share`, `/api/sync`)

`applyAction(type, payload, projectId)` in `src/lib/mjengo.ts` routes to four modules; every success is auto-audited to the Bias-Free Ledger:

- **Core (`lib/mjengo.ts`)**: `task.create/update/delete`, `phase.update/create`, `delivery.create`, `consumption.create`, `attendance.checkin`, `attendance.setStatus`, `worker.create/update`, `wages.pay`, `expense.create`, `transaction.delete`, `material.create`, `project.update`, `share.regenerate`, `alert.ack`, `photo.apply`
- **Trust (`lib/actions/trust.ts`)**: `attendance.record`, `attendance.exception`, `attendance.override`, `payroll.approve`
- **Money (`lib/actions/money.ts`)**: `escrow.topup`, `milestone.create/evidence/requestRelease/decide`, `variation.submit/decide`
- **Evidence (`lib/actions/evidence.ts`)**: `comment.add`, `comment.resolve`, `zone.create/delete`, `notification.read/readAll`, `photo.zone`

**Client allowlist (`CLIENT_ACTIONS`, enforced identically in `/api/actions`, `/api/share` POST, `/api/sync`, and the zustand store):** `milestone.decide`, `variation.decide`, `comment.add`, `notification.read`, `notification.readAll`.
