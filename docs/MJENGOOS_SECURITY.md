# MjengoOS Security — Technical Deep-Dive

**Document status:** v1.0 · 2026-08-28 · Author: Technical Documentation Engineer (Task 14-b)
**Method:** every claim below was verified by reading the code (`src/lib/auth.ts`, `src/backend/core/*`, all API routes, `next.config.ts`, `.gitignore`, `.env.example`, seeds). The final section is an honest list of accepted risks and known boundaries — documenting them is a product value, not an admission of failure.

---

## 1. Authentication

**NextAuth v4 credentials provider** (`src/lib/auth.ts`, mounted at `/api/auth/[...nextauth]`):

- **Password hashing: `node:crypto` scrypt** — no external bcrypt/argon2 dependency. `hashPassword()` = `randomBytes(16)` salt + `scryptSync(password, salt, 64)`, stored as `<salt hex>:<hash hex>`. `verifyPassword()` recomputes and compares with `timingSafeEqual` (constant time). `authorize()` lowercases/trims the email and returns `null` on any failure (no user-enumeration difference).
- **Session strategy: JWT** (`session: { strategy: 'jwt', maxAge: 30 days }`). The JWT carries `id`, `role`, `projectId` (via the `jwt`/`session` callbacks) so API routes decode the session straight off the cookie — `getSessionFromReq(req)` uses `getToken({ req, secret: NEXTAUTH_SECRET })`; no session table, no server-side revocation.
- **`NEXTAUTH_SECRET` is required** — without it, JWT verification fails and every guarded API returns 401 (documented in `.env.example` with `openssl rand -hex 32` guidance; the dev-server log flags a missing secret).
- Three seeded accounts (demo, see §9): `contractor@mjengo.os`, `client@mjengo.os` (pinned to project P1), `admin@mjengo.os`.
- No middleware.ts exists — the Next.js middleware layer is unused; all enforcement is at route handlers.

## 2. Authorization

**Role matrix** (`src/backend/core/policy.ts`):

| | contractor (owner) | admin | client (signed-in) | share link (no login) |
|---|---|---|---|---|
| `SITE_ROLES` APIs: suppliers, intel, ussd, all 5 AI routes, projects POST, land POST, sync (site actions) | ✅ | ✅ | 403 | 401 |
| Any-signed-in APIs: professionals, legal POST, upload, sync (allowlisted actions), actions (allowlisted) | ✅ | ✅ | ✅ (allowlist only) | n/a (token instead) |
| Land/legal reads (`GET /api/land`, `/api/land/events`, `/api/legal`) | any project | any project | **pinned to own project** | **pinned to token's project** |
| Project payload (`/api/project`) | ✅ | ✅ | ✅ | via `?share=` |
| Share-surface mutations (`POST /api/share`) | n/a | n/a | n/a | 5-action allowlist only |
| Frontend tabs | 11 | 11 | 7 (`CLIENT_HIDDEN_TABS=['copilot','supply','intel','ussd']`) | 7 (same list) |

Design rule (stated in `policy.ts` and `src/backend/README.md`): **"a hidden tab is UI, a rejected call is security"** — every client-hidden tab has its API under `SITE_ROLES`, so hiding UI is never the only defense.

**Client pinning (cross-project reads → 404).** In `land-service.resolveReadScope()` / `listParcelEvents()` and `legal-service.listReviews()`, a client-role session resolves to `session.user.projectId` *regardless of the `projectId`/`parcelId` requested*, and a share token resolves to its own project. A foreign parcel is answered with a plain **404 `Invalid share link`** — indistinguishable from an invalid token, so probing leaks nothing. (Browser-verified in Task 12: client passing P2's projectId still sees only P1's parcel; P1 token probing P2 events/legal → 404.)

**Share tokens.** `Project.shareToken` (cuid default) is the only credential for the Virtual Site Visit. Scope: read-mostly + a 5-action allowlist (`milestone.decide`, `variation.decide`, `comment.add`, `notification.read`, `notification.readAll`) enforced in `POST /api/share` (403 `Not permitted from a client link`), in the `/api/actions` share fallback, per-item in `/api/sync`, and client-side in the zustand store — all from the ONE list in `src/lib/client-actions.ts`. The actor is always stamped `__actor: project.client, __role: 'client'` — link visitors can never impersonate the site team. `share.regenerate` rotates the token (old link dies).

**Identity never comes from the request body.** `requestedBy`/`searchedBy` (legal, title search), and `__actor`/`__role` (actions, sync, share) are stamped server-side from the session or token; `applyAction()` strips `__actor`/`__role` from the payload before handlers run, so a queued/offline payload can never override attribution.

## 3. Rate limiting

- **Per-user sliding window** in `withGuard` — key `api/<tag>:<userId|email>`; the limits are abuse guards, not quotas (240/min reads down to 12/min AI).
- **Per-IP on every public surface** — `/api/share` GET+POST, `GET /api/land`, `/api/land/events`, `GET /api/legal`, `GET /api` health (share tokens are secrets worth brute-force guarding; the 31st bad-token probe in a minute returns 429 — browser-verified in Task 12).
- Implementation: in-memory `Map` with opportunistic sweeping, capped at 10,000 keys (`core/rate-limit.ts`) — see §9 for the restart caveat.
- Full limits table: MJENGOOS_API.md §1.

## 4. Input validation

- **Field validators** (`core/http.ts`): `fieldStr` (required trimmed non-empty), `fieldPos` (> 0), `fieldNonNeg` (≥ 0, e.g. delivered quantity may legitimately be 0), `optionalId`, `normalizeReference` (collapse whitespace + uppercase registry numbers — `lsk/p/2016/2319` finds `LSK/P/2016/2319`). All throw `ApiError(400, …)` with the exact message the UI toasts.
- **Kenyan phone normalization** (`core/phones.ts`): `07…`/`+254…`/`254…`/`7…`/`1…` → canonical `07XXXXXXXX`; both sides of every USSD lookup are normalized so no spelling mismatch creates a false "not registered".
- **USSD hardening** (`ussd-service.ts`): input trimmed and capped at **20 chars** (`MAX_INPUT_LEN`); 3-attempt PIN lockout (attempts encoded in `lastMenu`); 5-minute session expiry; PIN-less workers get an honest "no PIN yet" rather than a misleading "wrong PIN".
- **Range clamping**: task/phase progress clamped 0-100; zone coords clamped 0-100 %; anomaly-scan alert `type`/`severity` whitelisted before persisting; voice-log base64 capped at 12 MB.
- **No schema library on the request path** — `zod` is installed but unused; validation is the manual helpers above (honest boundary: solid for current surface, not a general hardening).

## 5. AI route specifics

- All five AI routes: `SITE_ROLES` + `ai` limit (12/min/user) — LLM calls cost real money per request.
- `analyze-photo` `url` variant reads files from `public/` with `..` sequences stripped (basic path-traversal mitigation) — it can only read within `public/`.
- Anomaly-scan prompts instruct "Only flag genuine discrepancies — do not invent problems" (honesty contract in the prompt itself).

## 6. File upload security

`POST /api/upload` (any signed-in session, 20/min):
- Accepts a base64 **data URL only**, matched by `/^data:image\/(png|jpe?g|webp);base64,(.+)$/i` — mime allowlist png/jpeg/webp, anything else 400.
- Filename is fully server-generated: `upload-<epoch ms>-<8 random hex>.<ext>` — user-controlled filenames never touch the filesystem.
- Decoded bytes are written with `fs.writeFile` to **`public/photos/`** (directory auto-created).
- **Accepted boundary, stated honestly:** files under `public/` are served statically by Next.js with **no authentication on GET** — anyone with the URL can view an evidence photo. For this product's purpose (demonstration evidence photos meant to be shareable with the client via the share link) this is accepted; a production posture would move uploads behind an authenticated media route. There is also **no malware/content scanning** beyond the mime prefix check (the base64 body is not re-encoded or inspected).

## 7. Transport & headers

`next.config.ts` sets, for every response (`source: "/(.*)"`):
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-DNS-Prefetch-Control: on`

Deliberately **absent** (with in-code comments explaining why): `X-Frame-Options`/`frame-ancestors` (the app is previewed in an iframe), camera `Permissions-Policy` restrictions (evidence capture needs the device camera). Also absent: **no CSP** and no HSTS — see §9. `output: "standalone"` and `reactStrictMode: false` are also set; `typescript.ignoreBuildErrors: true` is a known repo-level risk (flagged in the feature audit).

## 8. Audit logging — the Bias-Free Ledger

- **Model:** `AuditEvent` (append-only; nothing in the codebase updates or deletes rows): `projectId`, `kind`, `actor`, `role`, `summary`, `meta?`, `createdAt`.
- **Entry point:** `logAudit(projectId, kind, actor, summary, meta?)` (`src/lib/audit.ts`, re-exported by `backend/core/audit.ts`) — **never throws** (a failed audit log must not break the user's action; it `console.error`s instead).
- **Coverage:** the `applyAction` dispatcher auto-logs **every one of the 37 action types** (success path only). Domain services log their mutations explicitly — 10 `logAudit` call sites total across `src/`:
  - `lib/mjengo.ts` — dispatcher (all actions)
  - `supply-service` — order create / deliver / verify (with honest verdict text)
  - `intel-service` — signal ack / resolve
  - `land-service` — found title searches
  - `legal-service` — review requests
  - `ussd-service` — USSD self check-in (actor = the worker, role `worker`)
- What is recorded: who (`actor` + `role` — from the session/token, including offline-flushed and share-link actions), what (`kind` + `summarizeAction` one-liner), when (`createdAt`), extra JSON (`meta: { type }`). Attendance corrections additionally persist their own append-only `overrideLog` on the row itself.

## 9. Secrets & repo hygiene

- **`.env` is git-ignored** (Task 13: previously tracked — with the real `NEXTAUTH_SECRET` — and untracked via `git rm --cached`; a future rollback can no longer clobber or leak the secret). `.gitignore` (13 documented sections) also excludes `db/*.db` (+ journal/shm/wal), `public/photos/upload-*` (runtime uploads; seed demo photos stay tracked), logs, `tool-results/`, `upload/`, `.zscripts/`, `agent-ctx/`, `tests/`, release ZIPs, OS/editor junk.
- **`.env.example` is committed** as the setup template: `DATABASE_URL="file:../db/custom.db"`, `NEXTAUTH_SECRET` placeholder + `openssl rand -hex 32` guidance, optional `NEXTAUTH_URL`. `Z_AI_API_KEY` is consumed by the z-ai SDK (not listed in `.env.example`; provided by the hosting environment).

## 10. Security boundaries / known accepted risks (honest list)

1. **SQLite single-writer** — one file, one Node process; concurrent write bursts serialize (and busy errors are possible under true parallelism). Accepted for demo scale; the seed chain runs strictly sequentially for this reason.
2. **In-memory rate limits** — the sliding-window `Map` resets on process restart and is per-process; limits are abuse guards, not quotas, by explicit design (no Redis constraint).
3. **No MFA / no password reset flow** — single-factor credentials only; JWT sessions cannot be revoked server-side before the 30-day expiry (sign-out drops the cookie; a stolen token remains valid).
4. **No malware scanning on uploads** — mime-prefix check only (see §6); no re-encoding, no content inspection.
5. **Uploaded photos are publicly readable** (`/photos/upload-*` requires no auth) — accepted boundary for demo evidence photos.
6. **Demo credentials shipped in seeds AND in the UI** — `contractor@mjengo.os` / `mjengo2026`, `client@mjengo.os` / `mjengo2026`, `admin@mjengo.os` / `admin2026`, with one-tap fill buttons on the login screen. Never deploy the seed data to a real environment.
7. **Simulated registries & money** — land registry and board rolls are seed data labeled "eRegistry (simulated)" / "… registry (simulated)"; escrow/M-Pesa references are generated strings, not real transactions.
8. **`typescript.ignoreBuildErrors: true`** and no automated test suite — type errors do not fail the build; security regression coverage is manual QA only (see `MJENGOOS_TEST_PLAN.md`).
9. **No CSP / HSTS headers** — only the three baseline headers of §7 are set.
10. **Global admin role** — `admin` shares the full site-team surface with no project scoping and no separate audit of admin-specific powers; there is no org/tenant layer to constrain it.
11. **`/api/actions` has no rate-limit preset** (legacy route; guarded by validation + authn/authz only) — noted here rather than hidden.
12. **USSD simulator is authenticated as site team** — the `*384*746#` flows run behind `SITE_ROLES`; real gateway integration (Africa's Talking etc.) does not exist, so no real-phone attack surface exists yet either.
13. **`GET /api/projects` returns the full project list to any signed-in role** — including client-role users (names, budgets, progress of all projects; the client UI hides the switcher but the API does not scope the list). Data-level pinning exists everywhere else (land/legal/project payload boots the client's own project); the list endpoint is the one unscoped read.
