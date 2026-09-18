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
| DB-6/7/8 | No unique (workerId,date); non-unique PO/invoice codes; 1 index in whole DB | Med | `fix/audit2-data` @ 5b0caad (migration `10_integrity_constraints`) | +real-sqlite constraint tests — DB-6 fully closed 2026-09-19 by #144 (SQL SUM balances + migration `15_hot_path_indexes`) |
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
| SEC-5 | `chore(auth): next-auth v4→v5 migration plan (supported pairing with Next 16)` | security | 2026-09-18: ADR 0007 + exact pin 4.24.15 + Dependabot advisory watch landed (#173); v5 cutover scheduled per ADR phases |
| DB-3 | `feat(db): DB-level ledger enforcement on SQLite (triggers/checks) parity with Supabase design` | finance | 2026-09-19: CLOSED on SQLite — migration `14_ledger_invariants` (#124) lands the posting-gate balance trigger, append-only guards, reversal-only update whitelist, side/amount CHECKs + the `LedgerMaintenance` exemption; DB-10 (immutability alignment) and the ledger part of DB-11 close with it |
| DB-5 | `fix(seed): production guard on destructive seed scripts` | data | NODE_ENV gate + confirm prompt |
| API-3 | `perf(api): v1 list routes must not materialize full project payload` | backend | |
| API-4 | `perf(api): bound core reads (take/cursor) — milestones, variations, comments, attendance, supply` | backend | |
| API-5 | `feat(security): confirm-before-decide on share-link money actions` | security | overlaps SEC-3r |
| FE-3 | `feat(i18n): complete EN-only sub-surfaces (audit tab, finder dialogs, land professionals, overview cards, PDF/CSV)` | frontend | |
| FE-4 | `feat(offline): supplier-portal outbox parity` | frontend | |
| WD-1 | `fix(website): per-visitor rate-limit bucket (TRUST_PROXY default posture) + lead-drop alerting` | website | |
| WD-2 | `feat(website): wire analytics endpoint or remove dead code` | website | |
| INF-7 | `feat(ops): automated backups + restore runbook + drill` | ops | 2026-09-18: landed via #199 — `deploy/backup/` (script + systemd timer, shellcheck-clean, drilled incl. live-WAL backup + script-level restore: docs/audit/RESTORE_DRILL_2026-09-18.md) + DEPLOYMENT §7.2.1/§7.2.2; covers app-db/app-photos/website-data (also closes the WD-11 "leads in backup set" gap); operator still owes one full-stack drill on real hardware |
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
| #98 CI billing lock | account billing (owner) | local gates re-run per wave (exact CI commands); docker.yml now also carries the `smoke` job from #198 (compose-up + /api/health probe + migrate-line assert + /website probe) whose first execution rides the first run after unblock |

## 4. Definition-of-done check for this register

Every P0/P1 engineering item is either **fixed on a green branch** (§1) or
**carries a proposed issue with owner-ready body** (§2). External items (§3)
document blocker + workaround. Remaining P2/P3 are explicitly listed, not
hidden.

---

# Wave 3 addendum (2026-09-17) — the three P1 gates CLOSED

| P1 | Status | Branch | Evidence |
|---|---|---|---|
| #122 integer-cents money (DB-1) | **FIXED — verified branch** | `fix/122-integer-cents-money` (c518181, stacked on chore) | 90 files / 2,135 tests ✅ · tsc ✅ · lint ✅ · fresh `migrate deploy` ✅ · drift ✅ · payload JSON zero-BigInt-leak probe ✅ · E2E green against the seeded app |
| #174 project-membership authz (SEC-6) | **FIXED — verified branch** | `fix/174-project-membership-authz` (96b084d, stacked on #122) | 91 files / 2,161 tests ✅ · tsc ✅ · lint ✅ · fresh deploy (14 migrations) ✅ |
| #182 Playwright E2E (TEST-1) | **FIXED — verified branch** | `feat/182-playwright-e2e` (aeaa46f, on main) | **7/7 persona golden paths passed (35.3s)** against the real dev server + seeded DB · unit gates unchanged ✅ |

Wave-3 findings fixed along the way (all evidence in worklog.md):
- **P0**: fresh `prisma migrate deploy` was BROKEN (lexicographic migration order — `12_` before `2_draw_pack`). Fixed by zero-padding 00–09.
- **P0**: whole `/api/project` payload crashed JSON serialization (BigInt money riding raw supplier relations in supply-slice DTOs) + `/api/projects` 500 (BigInt/number mix in list+summary math) — found BY the new E2E suite.
- **P1-grade**: supply write paths (catalog/supplier/quote-receive/rules) stored raw KSh into BigInt-cent columns — 100× read-back corruption.
- Hygiene: chore branch (dead-code removal) + docs branch; chore branch corrected to keep the test-referenced policy matrices.

**GitHub write remains BLOCKED (no token).** One-command sync when a token exists:
`bash scripts/github-sync-wave3.sh` (labels + issue + pushes + PRs, idempotent), then `--merge`.
Offline transfer: `mjengo-wave3.bundle` (verified complete history; `git clone mjengo-wave3.bundle`).
Dev DB: rebuilt on the renamed migration set + reseeded (`bun run seed`).

Next wave candidates from the register (P2): #124 DB-enforced ledger invariants · #144 SQL SUM aggregation · #154/#155 bounded reads · #156 webhook residual · #194 stock reconciliation · #199 backups · #202/#204 observability · #183 offline conflict matrix · #184 real-SQLite harness · #212 escrow drift alarm.
