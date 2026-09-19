# MjengoOS — Master Audit Index (MASTER_AUDIT)

> **What this is.** The front door to `docs/audit/` — every document in the
> folder with a one-line purpose, the status of each findings register
> **as measured against the GitHub tracker today** (the baselines themselves
> are dated, immutable records whose rows were *annotated* — never rewritten —
> as waves 1–28 resolved them), and the register-ID → issue-number crosswalk
> the mission expected. Created for **issue #190** (DOC-4 in the issue
> labeling).
>
> **Companion living documents:** `PENDING_WORK.md` (the rolling
> what-remains register) and `TEST_BASELINE.md` (the canonical test-count
> home, DOC-1 convention).

- **Created:** 2026-09-27 · **Register status measured at:** `main @ b035c74` —
  issue states read live from the GitHub tracker (166 issues: 147 closed,
  19 open), suite counts measured by execution (`bun run test` →
  143 files / 3,159 tests — see `TEST_BASELINE.md`).
- **Historical scope.** The 2026-09-16 baseline wave produced 15 documents
  (audited at `main @ 8b0003a`, 176 commits). Two more followed inside the
  same mission (`EXECUTION_BOARD.md`, `RESTORE_DRILL_2026-09-18.md`), and
  this index + `TEST_BASELINE.md` complete the set at 19.

---

## 1. The documents

| Document | Kind | Purpose (one line) | Findings register | Register status today |
|---|---|---|---|---|
| [`DISCOVERY_BASELINE.md`](./DISCOVERY_BASELINE.md) | dated record | Phase 0 method + exit-gate record for the 2026-09-16 re-audit wave (self-described "master index" of that wave — superseded in the navigation role by this file, kept as the exit-gate evidence) | — (points at the others) | dated 2026-09-16 |
| [`REPOSITORY_INVENTORY.md`](./REPOSITORY_INVENTORY.md) | dated record | Monorepo layout + git forensics (3 authors, 176 commits, one branch) | — | dated 2026-09-16 |
| [`TECHNOLOGY_BASELINE.md`](./TECHNOLOGY_BASELINE.md) | dated record | Declared-vs-actually-used runtime stack and dependencies | — | dated 2026-09-16 |
| [`RUNTIME_BASELINE.md`](./RUNTIME_BASELINE.md) | dated record | Build/install/test/lint/tsc/migration-drift gates re-run by the orchestrator | — | dated 2026-09-16 (live counts → `TEST_BASELINE.md`) |
| [`FEATURE_MATRIX.md`](./FEATURE_MATRIX.md) | dated record | Feature × stack-layer completeness matrix with per-feature issue pointers | per-feature `Issue` column | dated 2026-09-16 |
| [`API_BASELINE.md`](./API_BASELINE.md) | dated record | 60 paths / 75 method-endpoints, OpenAPI 29/29 documented = implemented, zero silent stubs | **API-1…API-14** | **14/14 resolved** |
| [`FRONTEND_BASELINE.md`](./FRONTEND_BASELINE.md) | dated record | 14 tab surfaces on real APIs, versioned offline sync, i18n/a11y posture | **FE-1…FE-12** | 6 resolved · 2 partial · 4 open |
| [`WEBSITE_BASELINE.md`](./WEBSITE_BASELINE.md) | dated record | 19 marketing routes, CTAs/SEO/honesty sweep, contact endpoint | **WD-1…WD-9, WD-11** | **10/10 resolved** |
| [`DATABASE_BASELINE.md`](./DATABASE_BASELINE.md) | dated record | 68 models / zero drift / invariant verdicts (payment strong, ledger service-level) | **DB-1…DB-12** | 10 resolved · 1 partial · 1 open |
| [`SECURITY_BASELINE.md`](./SECURITY_BASELINE.md) | dated record | Authn/authz/IDOR/share-tokens/rate-limit/uploads/webhooks/secrets re-audit | **SEC-1…SEC-13** | 10 resolved · 3 open |
| [`MOCK_DEMO_BASELINE.md`](./MOCK_DEMO_BASELINE.md) | dated record | Mock/demo/placeholder sweep (zero accidental production mocks, 11 honest seams) + the ORIGINAL static test inventory (§5 — now extracted and kept current in `TEST_BASELINE.md`) | **MD-1…MD-8**, TEST-* | MD: 1 resolved · 2 partial · 5 open |
| [`INTEGRATION_BASELINE.md`](./INTEGRATION_BASELINE.md) | dated record | Docker/compose/systemd/CI, integration status matrix, env audit, docs accuracy | **INF-1…9, OBS-1…5, DOC-1…4, ENV-1** | 11 resolved · 1 partial · 4 open · 3 no-action |
| [`PENDING_WORK.md`](./PENDING_WORK.md) | **living** | The rolling register — everything not yet fixed, prioritized, with annotations as waves land | all families (rolling) | see §3 |
| [`PRODUCTION_READINESS.md`](./PRODUCTION_READINESS.md) | dated record | The wave verdict: READY WITH APPROVED RISKS + the real-money P1 register | — (summarizes) | dated 2026-09-16 |
| [`GITHUB_SYNC.md`](./GITHUB_SYNC.md) | dated record | The token-blocked-era runbook: local-first branches + one-command issue/PR sync | — | historical (token arrived; protocol absorbed into house style) |
| [`EXECUTION_BOARD.md`](./EXECUTION_BOARD.md) | dated record | 2026-09-16 end-of-mission snapshot: 107 issues, 36 closed, 21 PRs merged | — | dated snapshot; live truth = the tracker |
| [`RESTORE_DRILL_2026-09-18.md`](./RESTORE_DRILL_2026-09-18.md) | dated record | The #199 backup script + §7.2 restore runbook executed for real, with outputs | — | dated 2026-09-18 |
| [`MASTER_AUDIT.md`](./MASTER_AUDIT.md) ← this file | **living** | The front door: doc index, register status, crosswalk, verification conventions | — | — |
| [`TEST_BASELINE.md`](./TEST_BASELINE.md) | **living** | The canonical test baseline: measured suite shape, families, gate commands, honest posture (DOC-1 count home) | TEST-* (current status) | see §3 |

## 2. Overall verdict (and what changed since the baseline)

**2026-09-16 baseline verdict** (PRODUCTION_READINESS.md): *READY WITH
APPROVED RISKS* for the documented posture (single-operator, Kenya sandbox
rails, honest seams); real-money operation additionally required the P1
register — integer-cents money (DB-1), E2E automation (TEST-1),
project-membership authz (SEC-6).

**All three P1 gates have since closed** — #122 (integer cents, wave 3),
#182 (Playwright 7-persona golden paths, wave 3), #174 (project-membership
model, wave 3) — and the wave-1 fixes (SEC-1…4, DB-2/4/6/7/8, FE-1/MD-1)
landed through PRs #221–#245. What remains open today is the P2/P3 tail
(§3) plus the four honest-open externals (§6).

## 3. Register status at a glance

Counts are per **register row in the baseline doc** (a row that spawned two
issues counts once; an issue that closed two rows counts twice). "Partial" =
one half landed, the other half is tracked (open issue or unfiled).

| Register | Doc | Rows | Resolved | Partial | Open | No action |
|---|---|---|---|---|---|---|
| API-1…14 | API_BASELINE §5 | 14 | **14** | 0 | 0 | 0 |
| DB-1…12 | DATABASE_BASELINE §5 | 12 | **10** | 1 (DB-10) | 1 (DB-9) | 0 |
| SEC-1…13 | SECURITY_BASELINE register | 13 | **10** | 0 | 3 (SEC-5, SEC-8, SEC-12) | 0 |
| FE-1…12 | FRONTEND_BASELINE §6 | 12 | **6** | 2 (FE-2, FE-11) | 4 (FE-6, FE-8, FE-9, FE-12) | 0 |
| WD-1…9, WD-11 | WEBSITE_BASELINE §9 | 10 | **10** | 0 | 0 | 0 |
| MD-1…8 | MOCK_DEMO_BASELINE §4 | 8 | 1 (MD-1) | 2 (MD-3, MD-7) | 5 (MD-2, MD-4, MD-5, MD-6, MD-8) | 0 |
| TEST-1…9 | MOCK_DEMO_BASELINE §7 | 9 | **6** | 0 | 2 (TEST-4, TEST-8) | 1 (TEST-9) |
| INF/OBS/DOC/ENV | INTEGRATION_BASELINE §9 | 19 | **11** | 1 (INF-4) | 4 (INF-2, INF-3, OBS-3, ENV-1) | 3 (INF-6, OBS-4, OBS-5) |
| **Total (baseline registers)** | | **97** | **68** | **6** | **19** | **4** |

Post-baseline rows (found by QA/coverage waves, not in the 2026-09-16
registers): SEC-14 (#180, resolved) · SEC-15 (#181, **open**) · TEST-10
(#282, resolved) · TEST-10b (#285, resolved) · INF-12 (#209, **open**) ·
QA-found #241 (money bounds, resolved) · #242 (offline copy, resolved) ·
#286 (cross-project BOQ line, resolved) · #214 (container log rotation,
resolved) · #215 (finance gate, resolved) · #216 (dependabot, resolved).

**The 19 open issues today** (tracker, not guesswork): the four externals
(#40 #41 #43 #98, §6) · #127 (DB-9) · #133 (DB-10 residual) · #137
(FE-8/TEST-8) · #140 (FE-9) · #150 (FE-12) · #181 (SEC-15) · #185 (TEST-4)
· #190 (this index) · #192 #193 (offline residuals) · #203 (BOQ
traceability) · #205 (OBS-3) · #208 (staging env) · #209 (INF-12) · #217
(external watch). Unfiled-but-open register rows: SEC-8, SEC-12 (both
parked pending the ADR-0007 v5 cutover), MD-2, MD-4, MD-6, MD-8, INF-2,
INF-3, ENV-1 (Info/Low polish, deliberately not issued yet).

## 4. Register-ID → issue crosswalk

Conventions: `✅` = issue closed via a merged PR (see §5 for what that
requires). "unfiled" = no GitHub issue exists (the row is tracked only in
the baseline register / PENDING_WORK). Issue numbers link on the tracker:
`Roy-Wanyoike/Mjengo-OS#<n>`.

### API (API_BASELINE.md §5)

| ID | Finding (one line) | Issue(s) | Status |
|---|---|---|---|
| API-1 | USSD/WhatsApp webhooks accept unauthenticated writes when secrets unset | folded into #170 (SEC-4 fix) + residual #156 | ✅ #170, ✅ #156 |
| API-2 | `/api/ai/extract-document` orphaned (no consumer, absent from OpenAPI) | #153 | ✅ |
| API-3 | v1 subresource lists materialize the full ~15-table payload per page | #154 | ✅ |
| API-4 | Unbounded Prisma reads (no take) on core lists | #155 (+ window inversion #166) | ✅ |
| API-5 | Share-link bearer token carries indefinite money-decision power | #172 (confirm-before-decide, with SEC-3r) | ✅ |
| API-6 | `/api/notifications` GET defaults owner roles to first project | #157 | ✅ |
| API-7 | In-process rate-limit store is the default | #158 (sqlite default) | ✅ |
| API-8 | `/api/upload/confirm` non-idempotent | #159 | ✅ |
| API-9 | jobs/run POST handler duplicated verbatim | #160 (= INF-5) | ✅ |
| API-10 | `/api/actions` payload is `any` at the route | #161 (action-schemas registry) | ✅ |
| API-11 | POST /api/projects + /api/flags write no AuditEvent | #162 | ✅ |
| API-12 | `/api/search` in-memory ≤300-row window | #163 (pushdown) + #166 (window order) | ✅ |
| API-13 | `/api/health` exposes counts publicly | #164 (liveness/detail split) | ✅ |
| API-14 | OpenAPI covers only v1 + 2 app reads | #165 (ADR 0008 + cross-check test) | ✅ |

### DB (DATABASE_BASELINE.md §5)

| ID | Finding (one line) | Issue(s) | Status |
|---|---|---|---|
| DB-1 | Float money everywhere (the real-money gate) | #122 | ✅ |
| DB-2 | Inventory movement non-atomicity + fake closingQty | #119 (+ quote-editing twin #147) | ✅ |
| DB-3 | Ledger invariants service-code-only on SQLite | #124 (migration 14 triggers) | ✅ |
| DB-4 | v1 money mutations write no AuditEvent | #120 | ✅ |
| DB-5 | Seeds wipe 20+ tables, no production guard | #126 (+ #180) | ✅ |
| DB-6 | One non-unique index in the whole DB; JS-reduced balances | #121 (constraints) + #144 (SQL SUM) | ✅ |
| DB-7 | No unique (workerId, date) on Attendance | #121 | ✅ |
| DB-8 | Business codes not unique | #121 | ✅ |
| DB-9 | 11+ soft FK scalars can dangle | #127 | **open** |
| DB-10 | "Immutable" ledger rows updated for reversal marking | SQLite enforcement ✅ #124; reversal-as-new-rows modeling **open** #133 | partial |
| DB-11 | Zero enums/CHECKs on SQLite | #129 (status-ladder CHECKs) | ✅ |
| DB-12 | FK pragma posture unverified at runtime | #135 (boot assert) | ✅ |

### SEC (SECURITY_BASELINE.md register)

| ID | Finding (one line) | Issue(s) | Status |
|---|---|---|---|
| SEC-1 | CSRF-by-default on all mutating routes (P1) | #167 | ✅ |
| SEC-2 | Dev fallback secret accepted in any non-prod runtime (P1) | #168 | ✅ |
| SEC-3 | Share token cuid() entropy, no expiry | #169 (entropy) + #172 (expiry/re-issue/confirm, "SEC-3r") | ✅ |
| SEC-4 | USSD/WhatsApp webhooks fail-open when secrets unset | #170 + residual #156 | ✅ |
| SEC-5 | next-auth v4.24.15 on Next 16 — unsupported pairing | #173 (ADR 0007 + exact pin + advisory watch landed; **v5 cutover scheduled, not executed**) | planned |
| SEC-6 | Portfolio-wide reads for site-team roles (P1) | #174 | ✅ |
| SEC-7 | Unpinned client fail-open edges (shareToken echo) | #175 | ✅ |
| SEC-8 | Upload confirm lacks magic-number sniff | unfiled | open |
| SEC-9 | USSD PIN lockout keyed on attacker-supplied phone | #176 | ✅ |
| SEC-10 | Idempotency-Key replay is global, not principal-scoped | #177 | ✅ |
| SEC-11 | Minimal security headers (no CSP/HSTS/PP) | #178 | ✅ |
| SEC-12 | AUTH_SECRET alias split-brain | unfiled — dies with the ADR-0007 v5 cutover (AUTH_SECRET-only model) | open (planned) |
| SEC-13 | In-memory rate-limit store multiplies per instance | #179 | ✅ |
| SEC-14 | (post-baseline) demo seeds one command from known admin creds | #180 | ✅ |
| SEC-15 | (post-baseline) no server-side session revocation / shorter JWT | #181 | **open** |

### FE (FRONTEND_BASELINE.md §6)

| ID | Finding (one line) | Issue(s) | Status |
|---|---|---|---|
| FE-1 | Demo quick-fill credentials ship in every bundle (P1) | #171 (with MD-1) | ✅ |
| FE-2 | Simulated money rails need in-UI posture labeling | #123 (banner); the rails themselves = external #43 | partial |
| FE-3 | EN-only sub-surfaces (audit tab, finder dialogs, …) | #125 (+ uikit fallbacks #152) | ✅ |
| FE-4 | Supplier portal online-only dispatch | #128 (supplier outbox) | ✅ |
| FE-5 | `<html lang>` static while locale is SW | #130 | ✅ |
| FE-6 | Failed outbox items never auto-retry | #132 | **open** |
| FE-7 | Offline-simulation toggle ships in production header | #136 | ✅ |
| FE-8 | Frontend invariants enforced only by static source pins | #137 | **open** |
| FE-9 | USSD tab body EN-only | #140 | **open** |
| FE-10 | Supplier dispatch drops its action label | #141 (decision: KEEP) | ✅ |
| FE-11 | No SW staleness cue / install cue | #148 (staleness toast); install cue remains | partial |
| FE-12 | No offline worklist for online-only flows | #150 | **open** |

### WD (WEBSITE_BASELINE.md §9 — the id WD-10 is simply not used)

| ID | Finding (one line) | Issue(s) | Status |
|---|---|---|---|
| WD-1 | One global 5/hr contact bucket; silent 500-cap drops | #131 | ✅ |
| WD-2 | Analytics unconfigured → zero measurement | #134 | ✅ |
| WD-3 | "Escrow-style" copy vs no-escrow disclosure | #138 | ✅ |
| WD-4 | Button/not-found drop the gateway preview param | #139 | ✅ |
| WD-5 | icon-512 unreferenced; no manifest | #142 | ✅ |
| WD-6 | Sitemap lastModified frozen constant | #143 | ✅ |
| WD-7 | Signup role select lacks client required | #145 | ✅ |
| WD-8 | Dead demo_requested analytics event | #146 | ✅ |
| WD-9 | SITE_URL localhost fallback (launch gate) | #149 | ✅ |
| WD-11 | website-data leads volume absent from backup guidance | #199 (scheduled backup) + #151 (manual path/DPA) | ✅ |

### MD (MOCK_DEMO_BASELINE.md §4)

| ID | Finding (one line) | Issue(s) | Status |
|---|---|---|---|
| MD-1 | Demo quick-fill + seedable known admin passwords | #171 (with FE-1) + #180 (seed guard) | ✅ |
| MD-2 | VAPID subject defaults to mailto:admin@localhost | unfiled | open |
| MD-3 | Contact PII plaintext, no retention policy | retention/DPA guidance landed with #151; encryption/forwarding unfiled | partial |
| MD-4 | Math.random in user-visible reference ids | unfiled | open |
| MD-5 | Open gateway posture when secrets unset (accepted risk) | owner decision recorded; related external #40 | accepted risk |
| MD-6 | Supplier catalog demo-editing (no ownership model) | unfiled | open |
| MD-7 | No multi-host rate limiting | sqlite default landed #179; Redis-class seam remains a documented gap | partial |
| MD-8 | Zero-VAT invoices (labeled) | unfiled | open |

### TEST (MOCK_DEMO_BASELINE.md §7 — current status; living detail in TEST_BASELINE.md)

| ID | Finding (one line) | Issue(s) | Status |
|---|---|---|---|
| TEST-1 | Zero E2E/browser tests | #182 (Playwright, 7 personas) | ✅ |
| TEST-2 | Migrations never executed against a real DB | #184 (in-suite harness; the CI job waits on external #98) | ✅ (in-suite) |
| TEST-3 | 70/71 files stub Prisma | #184 (real-DB suites; stub idiom retained by design) | ✅ (superseded) |
| TEST-4 | No coverage tooling | #185 (issue self-numbers it "TEST-3") | **open** |
| TEST-5 | Inventory module zero tests | #186 + #195 (+ drift findings #282/#285/#286) | ✅ |
| TEST-6 | No procurement chain end-to-end test | #184 (supply-chain-realdb) | ✅ |
| TEST-7 | Share-token expiry lifecycle untested | tests landed with #172 (share-link-expiry + share-regenerate-gate) | ✅ |
| TEST-8 | No runtime DOM/rendering tests | #137 (with FE-8) | **open** |
| TEST-9 | fileParallelism:false slow-but-safe | deliberate (4GB CI box) | no action |
| TEST-10 | (post-baseline) StockMovement.unitCost unit drift | #282 | ✅ |
| TEST-10b | (post-baseline) BoqLine.estUnitPrice unit drift | #285 (+ cross-project line update #286) | ✅ |

### INF / OBS / DOC / ENV (INTEGRATION_BASELINE.md §9)

| ID | Finding (one line) | Issue(s) | Status |
|---|---|---|---|
| INF-1 | systemd jobs unit runs as root | #197 | ✅ |
| INF-2 | No HEALTHCHECK in either Dockerfile | unfiled | open |
| INF-3 | Base images tag-pinned, not digest-pinned | unfiled (adjacent: #209 publish/scan) | open |
| INF-4 | CI never executed (billing); no container smoke | #198 (smoke job landed); execution = external #98 | partial |
| INF-5 | jobs/run POST handler duplicated | #160 (with API-9) | ✅ |
| INF-6 | jobs-tick sidecar has no healthcheck | documented-by-design | no action |
| INF-7 | No automated backup/restore | #199 (script + timer + drilled runbook) | ✅ |
| INF-8 | ARCHITECTURE.md module map gaps | #189 (with DOC-3) | ✅ |
| INF-9 | Fresh-clone db/ mkdir risk | #200 (verified non-issue on pinned Prisma) | ✅ |
| OBS-1 | No error tracking | #202 (opt-in fail-open sink) | ✅ |
| OBS-2 | Unstructured logs, no correlation ids | #204 (structured logger + requestId) | ✅ |
| OBS-3 | No metrics/tracing | #205 | **open** |
| OBS-4 | /api/health does a real DB roundtrip | better than bare 200 | no action |
| OBS-5 | Health exposes coarse counts | superseded posture after #164's split | no action |
| DOC-1 | Stale test counts in living docs | #187 (date-stamp convention; canonical home now TEST_BASELINE.md) | ✅ |
| DOC-2 | ADR-0002 61-vs-68 model drift | #188 | ✅ |
| DOC-3 | ARCHITECTURE module tree omissions | #189 (with INF-8) | ✅ |
| DOC-4 (register) | DEPLOYMENT backup-without-restore | folded into #199 (§7.2.2) | ✅ |
| DOC-4 (issue label) | ⚠ the label was **reused** for this index | #190 | this PR |
| ENV-1 | AUTH_SECRET alias undocumented | unfiled — same root as SEC-12, dies with ADR-0007 v5 | open (planned) |

## 5. Verification conventions (how a register row maps to issues/PRs)

These are the mission's working rules, codified here so the crosswalk above
is auditable:

1. **One issue = one branch = one PR.** Every register row that gets worked
   spawns a GitHub issue first (the 2026-09-16 register became
   #119–#224 via `scripts/github-sync.sh`); the fix lands on a dedicated
   branch, the PR title carries `closes #N`, and only the merge closes the
   issue. `main` is never pushed directly. (The GITHUB_SYNC.md runbook is
   the token-blocked-era origin of this protocol.)
2. **Tests land with the code, in the same PR.** A fix without a pinning
   test does not flip a register row. The pinning suite is named in the
   register annotation (e.g. "pinned by tests/unit/website-pii-backup.test.ts").
3. **Baselines are annotated, never rewritten.** The per-surface baseline
   docs are dated audit records; resolving a row adds a dated annotation to
   the register cell — `**RESOLVED/FIXED/CLOSED <date> via #<issue>**` plus
   the what-actually-landed summary — without deleting the original finding
   text. This index summarizes those annotations; the cells remain the
   primary evidence.
4. **Status vocabulary.** `✅ resolved` = issue closed by a merged PR (rules
   1–2 held). `planned` = an ADR/issue exists but the cutover is scheduled,
   not executed (SEC-5). `partial` = one half landed, the other half is
   explicitly tracked. `superseded` = a later finding/fix subsumed the row
   (TEST-3, OBS-5). `unfiled` = deliberately no issue yet (Info/Low polish).
   `no action` = recorded and consciously not pursued (TEST-9, INF-6).
   `externally blocked` = §6.
5. **Counts convention (DOC-1).** Living docs (README, CONTRIBUTING,
   DEPLOYMENT, RELEASE-NOTES, TEST_BASELINE) quote the suite size only with
   an "as of `<date>`" stamp — `git grep 'counts as of'` finds every site;
   dated audit records keep the numbers that were true when written.
   **TEST_BASELINE.md is the canonical count home.**
6. **Evidence hierarchy.** Merged PR > closed issue > worklog entry > doc
   claim; measurements are re-executed, never copied (this file's counts
   were measured at `main @ b035c74` by running the gates, not quoted).

## 6. Honest-open externals (owner/business action, documented workarounds)

| Issue | Blocker | Workaround today |
|---|---|---|
| #40 USSD production telco gateway | Safaricom/onboarding deal | faithful `*384#` simulation, labeled |
| #43 M-Pesa production certification | Daraja go-live creds/certs | sandbox behind the seam; reconcile sweep keeps books honest |
| #41 native app | ADR-0001 revisit triggers | PWA-first (offline shell, installable) |
| #98 CI billing lock | account billing (owner) | gates re-run locally per wave (exact CI commands); the #198 smoke job rides the first run after unblock |

## 7. Maintenance

- **When a register row resolves:** annotate the baseline cell (rule 3),
  update `PENDING_WORK.md`, and update this file's §3 tally + §4 crosswalk
  row in the same PR.
- **When a new audit doc lands:** add it to §1.
- **Counts:** re-measure (`bun run test`), then refresh TEST_BASELINE.md and
  the `counts as of` stamps (rule 5).
