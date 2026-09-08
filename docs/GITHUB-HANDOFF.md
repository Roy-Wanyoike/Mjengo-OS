# GitHub Operations Handoff — Mjengo-OS

**Status:** All engineering complete and verified locally (see `worklog.md`, `docs/backlog.md`, `docs/RELEASE-NOTES.md`). The GitHub token provided this session (`ghp_1o0W…`) is rejected by the GitHub API with **401 Bad credentials** (tested repeatedly with both `token` and `Bearer` formats — it was revoked/invalid before this session's work began). Everything below executes the moment a valid token is supplied.

## Current state (verified 2026-09-08)

- **Local `main`: 78 commits ahead of `origin/main`** (`git rev-list --count origin/main..main`) — lint clean, `tsc --noEmit` clean, **1,513 tests / 54 files all passing**, browser-verified (Wave 6 included — real AI calls through the live app).
- GitHub holds **16 open PRs (#56–#71)** whose branches were pushed by the previous session but never merged. Every one of those branch heads is **reachable from local `main`** (they were merged locally with `--no-ff`), so pushing `main` will mark them merged automatically.
- **32 open issues** — most are closed by code already on local `main` (see mapping below).

## One-command unblock (when a valid token exists)

```bash
cd /home/z/my-project
git remote set-url origin https://<TOKEN>@github.com/Roy-Wanyoike/Mjengo-OS.git
git push origin main                      # PRs #56–#71 auto-mark merged
git push origin --all                     # remaining feature branches incl. waves 3–5
```

## Issue auto-closure mapping (via merged-PR "Closes #N")

| Issue | Title | Closed by |
|---|---|---|
| #15 | Backend route boilerplate | PR #56 (refactor) |
| #16 | Repo polish | PR #56/#62 |
| #17 | No automated test suite | PR #56 (vitest suite) |
| #18 | No container deployment | PR #57 (compose stack) |
| #19 | README not recruiter-grade | PR #62 (recruiter README) |
| #20 | Jobs never drain on schedule | PR #56/#63 |
| #21 | SMS logged-only | PR #56 (webhook seam) + AT provider on main |
| #22 | Wallet payments simulated | PR #56 (Daraja sandbox behind seam) |
| #23 | Offline sync last-write-wins | PR #56 (entity versions) |
| #24 | Delivery photo count typed | PR #56 (real evidence photos) |
| #25 | Voice PII leak | PR #56 (phone-number scrub) |
| #26 | Flags display-only | PR #56 (server-side gating) |
| #27 | Uploads local-disk only | PR #57 (S3/R2 driver + presign) |
| #28 | No REST API / OpenAPI | PR #58 (v1 Phase B) + Phase C on main |
| #29 | Docs overclaim seams | PR #59 (honest copy sweep) |
| #30 | .env.example not portable | PR #60 |
| #31 | .gitignore overbroad | PR #61 |
| #32 | README TOC / CONTRIBUTING | PR #62 |
| #33 | Rate-limit in-process only | PR #68 (SQLite store, opt-in) |
| #34 | Daraja intents never re-polled | PR #63 (reconcile sweep) |
| #35 | No Safaricom IP allowlist | PR #63 |
| #36 | Notify prefs don't gate | PR #66 |
| #37 | Doc uploads local-disk | PR #65 (driver read seam) |
| #38 | Presigned GET expiry | PR #65 (re-signing) |
| #39 | Phase spend is estimate-only | PR #70 (cost-codes attribution) |
| #42 | PDF text extraction missing | PR #67 |
| #44 | Core modules untested | PR #64 |
| #69 | v1 wallet routes untested | PR #71 |
| #40 | USSD gateway not wired | **stays open** (external telco deal — honest seam by design) |
| #41 | Native app deferred | **stays open** (ADR-0001 tracking issue) |
| #43 | M-Pesa production creds | **stays open** (external certification) |

## New issues to create for Waves 3–5 (paste-ready bodies: `docs/backlog.md` §2)

Create these **before** pushing wave branches so the PRs can carry "Closes #N" (use the API or the issue templates in `.github/ISSUE_TEMPLATE/`):

1. `[security] /api/sync bypasses the flag-family gate (S1) + share POST validation (S2)` → branch `fix/sync-flag-gate` (already merged locally — reference the merge commit)
2. `[api] v1 Phase C — milestones/escrow + invoices read surface with OpenAPI` → `feat/v1-phase-c`
3. `[intel] MjengoScore — deterministic contractor trust score` → `feat/mjengo-score`
4. `[trust] Diaspora evidence draw packs` → `feat/draw-packs`
5. `[notify] Africa's Talking SMS provider` → `feat/at-sms-provider`
6. `[field] WhatsApp bi-directional bot seam` → `feat/whatsapp-seam`
7. `[notify] Web push notifications (VAPID)` → `feat/web-push`
8. `[roles] Supplier-side portal` → `feat/supplier-role`

## New issues to create for Wave 6 + v1 Phase D (paste-ready bodies: `docs/wave6-plan.md` §2)

Same rule — create the issues, then reference the existing merge commits (all
five branches were merged locally with `--no-ff` and are preserved):

1. `[ai] AI Draw Review MVP — advisory vision+LLM cross-check over frozen draw packs` → branch `feat/ai-draw-review` @ 443357c, merged in `f186b48`
2. `[ai] Evidence Authenticity Screen — dHash duplicate detection + vision phase-consistency` → `feat/ai-authenticity` @ e27e4de, merged in `c79cc2b`
3. `[ai] Diaspora Trust Digest with voice — weekly EN/SW + TTS through the share link` → `feat/ai-trust-digest` @ 51601f3, merged in `0f52bfe`
4. *(foundation — no separate issue needed, or fold into W6-1's)* `feat/ai-foundation` @ a948e8c, merged in `c44004e` (the `ai` flag + provider seam)
5. *(v1 Phase D — same pattern as the Phase-C issues)* `feat/v1-phase-d`, merged in `2c3152a` (workers/attendance/tasks/suppliers/parcels/intel/budget-variance; OpenAPI 21 → 29 paths)

> The full paste-ready bodies (problem statement / proposed solution / ACs /
> tech notes / done definition) live in `docs/wave6-plan.md` §2 — issues W6-1,
> W6-3, W6-2, in that order. Because all of this is already merged on local
> `main`, the same honest path applies: create the issues, push `main`, close
> each with a comment referencing the merge commit (or re-open small PRs from
> the preserved branches with "Closes #N" bodies).

## After the push

- Re-run the browser verification (scripts pattern documented in `worklog.md` tasks 3–5; Wave-6 AI verification in task 9).
- CI (`.github/workflows/ci.yml`) runs lint + strict typecheck + `next build` on every push — currently paused by the account's billing lock; they resume unchanged.
