# MjengoOS — Pending Work Register (2026-09-16 wave)

> The visible answer to *"what is still broken or incomplete?"* — every row
> links to evidence (per-surface baseline docs) and to a delivery vehicle
> (merged branch awaiting PR, or a proposed issue). "reg" rows need a GitHub
> issue at sync time; `scripts/github-sync.sh` carries the paste-ready bodies.

## 1. Fixed this wave — branches ready for issue + PR (gates green)

| ID | Finding | Priority | Branch / commit | Tests |
|---|---|---|---|---|
| SEC-1 | CSRF-by-default on all mutating routes (SameSite=None + text/plain tolerated + allowlist off) | **P1** | `fix/audit2-security` @ 11bce21 | +mutation-safety suite |
| SEC-2 | Dev fallback secret accepted in any non-production runtime → forgeable admin sessions | **P1** | `fix/audit2-security` @ 4ad6111 | +prod-rejection pins |
| SEC-3 (entropy) | Share token minted as Prisma cuid() (not CSPRNG) | P2 | `fix/audit2-security` @ 064f1b7 | +entropy pins |
| SEC-4 | USSD/WhatsApp webhooks fail-open when secrets unset | P2 | `fix/audit2-security` @ c8635ad | +503 fail-closed pins |
| FE-1/MD-1 | Demo quick-fill credentials ship in every bundle | **P1**/Med | `fix/audit2-security` @ 82564f8 | +static gate pin |
| DB-2 | consumeStock persisted before negative-stock throw; hardcoded closingQty 0; non-atomic transfers | **High** | `fix/audit2-data` @ 638f8aa | +atomicity suite |
| DB-6/7/8 | No unique (workerId,date); non-unique PO/invoice codes; 1 index in whole DB | Med | `fix/audit2-data` @ 5b0caad (migration `10_integrity_constraints`) | +real-sqlite constraint tests |
| DB-4 | v1 money mutations bypassed the audit trail | Med-High | `fix/audit2-data` @ 35bbb33 | +audit pins ×4 routes |

## 2. Proposed issues — not started this wave (prioritized)

### P1 (production blockers for real-money/real-scale operation)

| ID | Proposed issue title | Domain | Notes |
|---|---|---|---|
| DB-1 | `fix(db): integer-cents (or Decimal) money across wallet/ledger/invoices` | finance | Supabase design already specifies NUMERIC(18,2); SQLite path needs service+schema change; blocks real-money pilot |
| TEST-1 | `feat(qa): Playwright E2E golden paths (7 personas)` | qa | manual browser verification is not regression-proof; CI-ready |
| SEC-6 | `feat(authz): project-membership model replacing portfolio-wide site-team reads` | security | design change; pairs with Supabase RLS `project_member` |

### P2 (major quality/completeness)

| ID | Proposed issue title | Domain | Notes |
|---|---|---|---|
| SEC-3r | `feat(security): share-link expiry + re-issue + decision-power review` | security | entropy fixed this wave; expiry + milestone.decide-from-link remains |
| SEC-5 | `chore(auth): next-auth v4→v5 migration plan (supported pairing with Next 16)` | security | |
| DB-3 | `feat(db): DB-level ledger enforcement on SQLite (triggers/checks) parity with Supabase design` | finance | |
| DB-5 | `fix(seed): production guard on destructive seed scripts` | data | NODE_ENV gate + confirm prompt |
| API-3 | `perf(api): v1 list routes must not materialize full project payload` | backend | |
| API-4 | `perf(api): bound core reads (take/cursor) — milestones, variations, comments, attendance, supply` | backend | |
| API-5 | `feat(security): confirm-before-decide on share-link money actions` | security | overlaps SEC-3r |
| FE-3 | `feat(i18n): complete EN-only sub-surfaces (audit tab, finder dialogs, land professionals, overview cards, PDF/CSV)` | frontend | |
| FE-4 | `feat(offline): supplier-portal outbox parity` | frontend | |
| WD-1 | `fix(website): per-visitor rate-limit bucket (TRUST_PROXY default posture) + lead-drop alerting` | website | |
| WD-2 | `feat(website): wire analytics endpoint or remove dead code` | website | |
| INF-7 | `feat(ops): automated backups + restore runbook + drill` | ops | restore procedure missing (DOC-4) |
| OBS-1/2 | `feat(observability): structured logs w/ correlation IDs, error tracking, metrics` | sre | |
| INF-1 | `fix(deploy): systemd unit drops to non-root service user` | ops | |
| API-1r | `fix(security): require webhook secrets when secrets are SET but routes also rate-limit per-identity` | backend | residual after SEC-4 |

### P3 (non-blocking improvements)

API-2 wire-or-remove `/api/ai/extract-document` orphan · API-7 default the
SQLite rate-limit store · API-8 idempotent upload/confirm · API-9 dedupe
jobs/run POST handler · API-10 typed /api/actions payload at route · API-11
audit POST /api/projects · API-12 real search index (replace in-memory
300-row window) · API-14 extend OpenAPI to the app surface · FE-6 outbox
auto-retry with backoff · FE-7 hide offline-simulation toggle in prod ·
FE-8 runtime DOM a11y suite · FE-9 USSD body i18n · FE-11 SW staleness cue ·
FE-12 offline worklist for online-only flows · WD-3 "escrow-style" wording ·
WD-4/5/6/11 website minor set (gateway param, manifest, sitemap date, leads
in backup set) · DB-9 soft-FK sweep · DB-10 enums/CHECKs parity · DB-11
ledger reversal marking · MD-2 VAPID subject default · MD-4 replace
Math.random refs · MD-6 supplier demo-editing scope · TEST-2 DB-backed test
harness · TEST-3 coverage config · INF-9 quickstart db/ mkdir note ·
next-intl/lodash-es/uuid cleanup pass.

## 3. Externally blocked (honest-open, owner/business action)

| Issue | Blocker | Workaround today |
|---|---|---|
| #40 USSD production telco gateway | Safaricom/onboarding deal | faithful `*384#` simulation, labeled |
| #43 M-Pesa production certification | Daraja go-live creds/certs | sandbox behind the seam; reconcile sweep keeps books honest |
| #41 Native app | ADR-0001 revisit triggers | PWA-first (offline shell, installable) |
| #98 CI billing lock | account billing (owner) | local gates re-run per wave (exact CI commands) |

## 4. Definition-of-done check for this register

Every P0/P1 engineering item is either **fixed on a green branch** (§1) or
**carries a proposed issue with owner-ready body** (§2). External items (§3)
document blocker + workaround. Remaining P2/P3 are explicitly listed, not
hidden.
