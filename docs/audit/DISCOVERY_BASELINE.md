# MjengoOS — Phase 0 Discovery & Baseline (2026-09-16 re-audit)

> **Purpose.** This is the evidence-based baseline for the 2026-09-16 fresh
> re-audit wave. Per the mission mandate, nothing from prior waves
> (`docs/QA-REPORT-2026-09-10.md`, release notes, README claims) was trusted
> as proof — every conclusion below was re-derived from the repository at
> `main @ 8b0003a` (176 commits, clean tree) and re-verified by running the
> gates. The companion documents in this folder carry the per-surface detail;
> this file is the master index and the Phase 0 exit-gate record.

## 1. Method

- **Fresh clone** with full history + all `refs/pull/*/head` (PRs #1–#118 range) for git forensics.
- **Seven parallel read-only baseline audits** (backend/API, frontend, website, database, security, mock/demo+tests, infra/integrations/docs), each evidence-first (`file:line`), each writing its own baseline doc (below).
- **Gate runs by the orchestrator** (not trusted from docs): `bun install --frozen-lockfile` (955 pkgs), `bunx vitest run`, `bun run lint`, `bunx tsc --noEmit`, `prisma migrate diff` drift check.
- **Two implementation waves** executed against the findings (security, data-integrity) on dedicated branches — see §5 and `PENDING_WORK.md`.

## 2. Baseline deliverables in this folder

| File | Surface | Headline |
|---|---|---|
| `API_BASELINE.md` | Backend + API (Phase 0.6) | 60 paths / 75 method-endpoints; OpenAPI 29/29 documented = implemented, zero drift; zero silent stubs; 14 findings (API-1..14, all P2/P3) |
| `FRONTEND_BASELINE.md` | OS app UI (Phase 0.5) | 14 surfaces, all consuming real APIs; offline/sync genuinely versioned + conflict-aware; 12 findings (FE-1..12) |
| `WEBSITE_BASELINE.md` | Marketing site | 19 routes all WORKING; CTAs/links/SEO pass; contact form real + hardened; 11 findings (WD-1..11) |
| `DATABASE_BASELINE.md` | Data layer (Phase 0.7) | 68 models / 68 tables / 69 RLS tables; migration drift NONE; invariants: payment STRONG, inventory/financial/audit with real gaps → 12 findings (DB-1..12) |
| `SECURITY_BASELINE.md` | AppSec (Phase 0.8) | IDOR sweep PASS (all 14 v1 routes pinned); prior fixes verified present; new CSRF-by-default + fallback-secret surface → 13 findings (SEC-1..13) |
| `MOCK_DEMO_BASELINE.md` | Mock/demo sweep + tests (Phase 0.10/0.11) | ~2,300 keyword hits, **zero accidental production mocks**; 11 honest seams verified; tests NOT DB-backed, no E2E automation → MD-1..8, TEST gaps |
| `INTEGRATION_BASELINE.md` | Infra + integrations + docs (Phase 0.9) | Docker/compose/systemd GOOD; CI definitions correct but never executed (billing lock); all integrations env-gated honest seams; observability gaps |
| `REPOSITORY_INVENTORY.md` | Repo structure (Phase 0.1) | Monorepo map |
| `TECHNOLOGY_BASELINE.md` | Stack + deps (Phase 0.2) | Declared vs actually-used |
| `RUNTIME_BASELINE.md` | Build/test/run (Phase 0.3/0.4) | Gates re-run by orchestrator |
| `FEATURE_MATRIX.md` | Feature completeness (Phase 0.5) | Domain × stack-layer matrix |
| `PENDING_WORK.md` | Register (Phase 0.14) | Everything not fixed this wave, prioritized |
| `PRODUCTION_READINESS.md` | Wave verdict | Go/No-Go for this wave |

## 3. Gate results (re-run 2026-09-16, main @ 8b0003a)

| Gate | Result |
|---|---|
| `bun install --frozen-lockfile` | 955 packages, OK |
| `bunx vitest run` | **71 files / 1,811 tests — all passing** |
| `bun run lint` (eslint) | exit 0 |
| `bunx tsc --noEmit` (strict) | exit 0 |
| `prisma migrate diff` (migrations ↔ schema) | zero DDL = no drift (re-verified post-wave on `fix/audit2-data`) |

Prior-wave claims (1,811 tests, lint/tsc clean, no drift) **independently verified true**.

## 4. What the fresh audit found that prior waves had not

Verified-holding: all previously-claimed fixes (BE-1..12 of the 2026-09-10 wave)
were re-confirmed present in code by the security and API auditors.

Newly surfaced (top items; full registers in the per-surface docs):

- **SEC-1 (P1)** CSRF-by-default: `SameSite=None` (iframe posture) + text/plain-tolerant body parsing on every mutating route + origin allowlist off by default.
- **SEC-2 (P1)** the #94 dev-fallback-secret fix accepted fallback-signed sessions in *any* non-production runtime (staging/preview = forgeable admin).
- **FE-1/MD-1 (P1/Med)** demo quick-fill credentials (incl. `admin@mjengo.os`) ship in every bundle.
- **DB-2 (High)** `consumeStock` persisted the movement before its negative-stock throw; return/damage/adjust reported hardcoded `closingQty: 0`; transfers non-atomic.
- **DB-1 (High)** money is `Float` everywhere with a 0.005-tolerance service-level balance check (Supabase design already specifies the NUMERIC fix).
- **DB-4 (Med-High)** v1 money routes bypassed the audit trail.
- **DB-6/7/8 (Med)** no unique `(workerId,date)` on Attendance (payroll double-count risk), non-unique business codes, a single non-unique index in the whole DB.
- **SEC-3/SEC-4 (P2)** share-token cuid() entropy + no expiry; USSD/WhatsApp fail-open when secrets unset.
- Plus P2/P3 registers: unbounded reads, payload-slicing v1 lists, i18n EN-only sub-surfaces, website shared rate-limit bucket, observability gaps, no E2E automation, tests not DB-backed.

## 5. What this wave fixed (branches, pending GitHub PRs)

| Branch | Commits | Findings closed | Tests added |
|---|---|---|---|
| `fix/audit2-security` | 5 | SEC-1, SEC-2, SEC-3 (entropy), SEC-4, FE-1/MD-1 | +41 (1,811 → 1,852) |
| `fix/audit2-data` | 3 | DB-2, DB-6/DB-7/DB-8, DB-4 | +36 (1,811 → 1,847) |

Both branches: full gates green (see `RUNTIME_BASELINE.md` §3). Local `main`
was **not** modified — the honest path is issue → PR → review → merge, executed
through `GITHUB_SYNC.md` + `scripts/github-sync.sh` once a valid token exists.

## 6. Phase 0 exit gate (0.15)

| Exit criterion | Status |
|---|---|
| Repository structure understood | ✅ `REPOSITORY_INVENTORY.md` |
| Major applications/modules identified | ✅ OS app + website + prisma + supabase design |
| Technology stack verified from source | ✅ `TECHNOLOGY_BASELINE.md` |
| Build status known | ✅ install/build clean (gates §3) |
| Test status known | ✅ 71/1,811 green (static: not DB-backed, no E2E) |
| Runtime status known where runnable | ✅ gates + prior live-probe evidence re-checked in code; browser re-verification deferred to PR review (sandbox constraint) |
| Feature inventory exists | ✅ `FEATURE_MATRIX.md` |
| API inventory exists | ✅ `API_BASELINE.md` (60/75 + OpenAPI 29/29) |
| Database inventory exists | ✅ `DATABASE_BASELINE.md` (68 models, drift none) |
| Security baseline exists | ✅ `SECURITY_BASELINE.md` |
| Integration baseline exists | ✅ `INTEGRATION_BASELINE.md` (matrix per provider) |
| Mock/demo behavior inventoried | ✅ `MOCK_DEMO_BASELINE.md` (zero accidental) |
| Existing GitHub work searched | ✅ git forensics over all refs + handoff/backlog mapping (API rate-limited from sandbox; tracker cross-check happens at sync time) |
| Initial pending-work register exists | ✅ `PENDING_WORK.md` |
| Major blockers documented | ✅ #40 telco, #43 M-Pesa certs, #41 native app, #98 CI billing lock |
| Unknowns explicitly documented | ✅ per-doc UNKNOWN markers (none converted to DONE) |

**Exit gate: PASSED.** The register answer to *"what actually works, what does
not, what is missing, what is blocked, and what proves it"* lives in
`FEATURE_MATRIX.md` + `PENDING_WORK.md` + the per-surface baselines.
