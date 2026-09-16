#!/usr/bin/env bash
# github-sync.sh — 2026-09-16 audit wave sync kit for Roy-Wanyoike/Mjengo-OS.
#
# Idempotent: searches existing issues/PRs before creating (no duplicates),
# never force-pushes, never touches main directly. Requires gh CLI + jq,
# authenticated with repo + issues + pull-requests scope.
#
# Usage:  bash scripts/github-sync.sh           # labels + issues + branches + PRs
#         bash scripts/github-sync.sh --merge   # … then merge the wave PRs
set -euo pipefail

REPO="Roy-Wanyoike/Mjengo-OS"
BR_SECURITY="fix/audit2-security"
BR_DATA="fix/audit2-data"
BR_DOCS="docs/audit2-baseline"
BR_README="docs/readme-product-thesis"

say()  { printf '\033[1;36m[sync]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[sync]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[sync]\033[0m %s\n' "$*" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || die "gh CLI not installed — https://cli.github.com/"
command -v jq >/dev/null 2>&1 || die "jq not installed"
gh auth status >/dev/null 2>&1 || die "gh not authenticated — run: gh auth login"
for b in "$BR_SECURITY" "$BR_DATA" "$BR_DOCS" "$BR_README"; do
  git rev-parse --verify --quiet "refs/heads/$b" >/dev/null \
    || die "local branch '$b' not found — run this in the audit clone"
done

# ---------------------------------------------------------------- labels ----
LABELS=(
  "P0-critical,BE0100,critical"
  "P1-high,DC2626,high"
  "P2-medium,D97706,medium"
  "P3-low,6B7280,low"
  "security,DC2626,bug"
  "finance,059669,improvement"
  "database,7C3AED,improvement"
  "backend,2563EB,improvement"
  "frontend,DB2777,improvement"
  "qa,EA580C,improvement"
  "documentation,64748B,improvement"
  "production,BE185D,improvement"
)
for l in "${LABELS[@]}"; do
  IFS=, read -r name color desc <<<"$l"
  gh label create "$name" --color "$color" --description "$desc" -R "$REPO" \
    --force >/dev/null 2>&1 || true
done
say "labels ensured"

# ------------------------------------------------------------- dedup helpers -
ALL_ISSUES_JSON="$(gh issue list -R "$REPO" --state all --limit 1000 --json number,title 2>/dev/null || echo '[]')"
ALL_PRS_JSON="$(gh pr list -R "$REPO" --state all --limit 1000 --json number,title,headRefName 2>/dev/null || echo '[]')"

find_issue() {
  printf '%s' "$ALL_ISSUES_JSON" | jq -r --arg t "$1" '.[] | select(.title==$t) | .number' | head -1
}
find_pr_by_head() {
  printf '%s' "$ALL_PRS_JSON" | jq -r --arg h "$1" '.[] | select(.headRefName==$h) | .number' | head -1
}

ensure_issue() { # title, body, labels(csv) → prints issue number
  local title="$1" body="$2" labels="$3" n
  n="$(find_issue "$title")"
  if [[ -n "$n" ]]; then
    say "issue exists: #$n — $title"
  else
    n="$(gh issue create -R "$REPO" --title "$title" --body "$body" --label "$labels" | grep -oE '[0-9]+$')"
    say "issue created: #$n — $title"
  fi
  printf '%s' "$n"
}

ensure_pr() { # head, base, title, body → prints pr number
  local head="$1" base="$2" title="$3" body="$4" n
  n="$(find_pr_by_head "$head")"
  if [[ -n "$n" ]]; then say "PR exists: #$n ($head)"; printf '%s' "$n"; return; fi
  git push -u origin "$head"
  n="$(gh pr create -R "$REPO" --base "$base" --head "$head" --title "$title" --body "$body" | grep -oE '[0-9]+$')"
  say "PR created: #$n ($head)"
  printf '%s' "$n"
}

# ----------------------------------------------------------------- bodies ----
body_head() { cat <<'EOF'
**Source:** 2026-09-16 fresh re-audit (Phase-0 baseline — docs/audit/).
**Evidence:** see the per-surface baseline doc referenced below.
**Gates:** branch green — vitest / lint / tsc all exit 0.
EOF
}

ISS_SEC1_TITLE="fix(security): default-on mutation-safety gate on all browser-reachable mutating routes (SEC-1)"
ISS_SEC1_BODY="$(body_head)

**Problem.** Session cookie is SameSite=None (iframe preview posture) and every mutating route parsed req.text() as JSON regardless of Content-Type with the origin allowlist off by default — a cross-site page could fire a simple-request POST (text/plain) carrying JSON and the session cookie would ride along (actions/sync/wallet/payments).

**Fix.** src/backend/lib/mutation-safety.ts: Origin-host match or MUTATION_ORIGIN_ALLOWLIST → else 403; Sec-Fetch-Site same-origin/none → else 403; non-browser clients with a body must send application/json → else 415. Wired into route-kit's pipeline (every route()/publicRoute() mutation) + the /api/ai gate. GET/HEAD untouched; auth/webhooks/ussd/whatsapp/jobs-bearer exempt (own auth models). .env.example documents the allowlist.

**Tests.** tests/unit/mutation-safety.test.ts (origin match/mismatch/allowlist, fetch-metadata, content-type discriminator, bodyless pass).

**Detail:** docs/audit/SECURITY_BASELINE.md SEC-1."

ISS_SEC2_TITLE="fix(auth): restrict dev fallback-secret verification to development/test runtimes (SEC-2)"
ISS_SEC2_BODY="$(body_head)

**Problem.** The #94 fix made the guard accept sessions signed by the deterministic fallback secret — in ANY runtime without NODE_ENV=production (staging/preview/unset) that key is public-source-derivable → forgeable admin sessions.

**Fix.** Fallback verification only when NODE_ENV is explicitly development or test; otherwise 401 + one-time loud error. Dev quickstart unaffected (next dev sets development).

**Tests.** Production-rejection pins in tests/unit/nextauth-fallback-secret.test.ts.

**Detail:** docs/audit/SECURITY_BASELINE.md SEC-2."

ISS_SEC3_TITLE="fix(security): mint share tokens with a CSPRNG at project creation (SEC-3 entropy)"
ISS_SEC3_BODY="$(body_head)

**Problem.** Initial project share tokens defaulted to Prisma cuid() — not CSPRNG; the regenerate path was already CSPRNG.

**Fix.** Creation sites mint crypto.randomBytes(24).toString('base64url') (~192-bit). Regenerate path re-verified.

**Residual (tracked as share-link expiry issue):** link expiry + decision-power review.

**Tests.** tests/unit/share-token-entropy.test.ts.

**Detail:** docs/audit/SECURITY_BASELINE.md SEC-3."

ISS_SEC4_TITLE="fix(security): fail USSD/WhatsApp closed when secrets are unset in production (SEC-4)"
ISS_SEC4_BODY="$(body_head)

**Problem.** With USSD_WEBHOOK_SECRET/WHATSAPP_WEBHOOK_SECRET unset the routes warned and accepted unauthenticated writes (real attendance rows).

**Fix.** In production → 503 JSON config error before any processing; non-production keeps the documented warn-and-accept demo posture. Startup warning message made honest (fail-closed).

**Tests.** +10 cases across ussd-route/whatsapp-route/webhook-secret-warning tests.

**Detail:** docs/audit/SECURITY_BASELINE.md SEC-4."

ISS_FE1_TITLE="fix(auth): gate the demo quick-fill login panel out of production bundles (FE-1/MD-1)"
ISS_FE1_BODY="$(body_head)

**Problem.** Demo credentials (incl. admin@mjengo.os) rendered in every bundle.

**Fix.** Panel wrapped in module-scope process.env.NODE_ENV !== 'production' constant — production builds DCE the panel + credentials; manual login stays.

**Tests.** Static pin in tests/unit/frontend-a11y.test.ts.

**Detail:** docs/audit/FRONTEND_BASELINE.md FE-1, MOCK_DEMO_BASELINE.md MD-1."

ISS_DB2_TITLE="fix(inventory): atomic, validated stock movements with derived closing quantities (DB-2)"
ISS_DB2_BODY="$(body_head)

**Problem.** consumeStock persisted the movement BEFORE the negative-stock throw (negative stock could persist); return/damage/adjust reported hardcoded closingQty: 0; transfers were non-atomic.

**Fix.** Validate projected closing before persisting; writes transaction-wrapped; real derived closing from movement sums; transfers atomic (out+in in one transaction).

**Tests.** tests/unit/inventory-atomicity.test.ts.

**Detail:** docs/audit/DATABASE_BASELINE.md DB-2."

ISS_DB678_TITLE="feat(db): integrity constraints + hot-path indexes — migration 10_integrity_constraints (DB-6/DB-7/DB-8)"
ISS_DB678_BODY="$(body_head)

**Problem.** No unique (workerId,date) on Attendance (duplicate day rows → payroll double-count); PO/invoice business codes non-unique; a single non-unique index in the whole DB (full scans on hot paths).

**Fix.** UNIQUE(workerId,date); UNIQUE(projectId,orderCode) PurchaseOrder; UNIQUE(projectId,invoiceCode) Invoice; indexes Attendance(projectId,date), LedgerEntry(accountId), StockMovement(inventoryItemId). MaterialRequest.requestCode deliberately unconstrained (two overlapping generators — documented in the migration). Additive-only; fails loudly on pre-existing duplicates (that is the point).

**Tests.** tests/unit/db-integrity-constraints.test.ts — real better-sqlite3 :memory: applying all migrations in order, asserting constraint + index behavior. Drift check: zero DDL. Seeds re-validated.

**Detail:** docs/audit/DATABASE_BASELINE.md DB-6/7/8."

ISS_DB4_TITLE="fix(audit): v1 money mutations write audit events (DB-4)"
ISS_DB4_BODY="$(body_head)

**Problem.** v1 wallet deposit/withdraw/transfer + payments mutations bypassed the AuditEvent trail entirely (legacy action path was audited; the v1 surface was not).

**Fix.** logAudit wired into the four v1 money handlers following the established pattern (actor/role from guard context, before/after captured).

**Tests.** tests/unit/v1-money-audit.test.ts.

**Detail:** docs/audit/DATABASE_BASELINE.md DB-4."

ISS_DOCS_TITLE="docs(audit): Phase-0 discovery baseline + 2026-09-16 QA report"
ISS_DOCS_BODY="$(body_head)

**Deliverable.** docs/audit/: DISCOVERY_BASELINE (master + exit gate), REPOSITORY_INVENTORY, TECHNOLOGY_BASELINE, RUNTIME_BASELINE, API_BASELINE, FRONTEND_BASELINE, WEBSITE_BASELINE, DATABASE_BASELINE, SECURITY_BASELINE, MOCK_DEMO_BASELINE, INTEGRATION_BASELINE, FEATURE_MATRIX, PENDING_WORK, PRODUCTION_READINESS, GITHUB_SYNC + scripts/github-sync.sh + docs/QA-REPORT-2026-09-16.md.

**Why.** Fresh from-scratch re-audit per the production-readiness mission; prior QA claims re-verified (all held) + new findings registered."

ISS_README_TITLE="docs(readme): product-thesis refresh — the evidence-backed operating system for construction"
ISS_README_BODY="$(body_head)

**Deliverable.** README rewritten around the expanded thesis (land verification → planning → procurement → execution → payments → handover), offline-first positioning, enforced-invariant framing, while preserving the operational sections (quickstart, env, testing, deployment) of the current README."

# Register issues (not started) -------------------------------------------------
REG_TITLES_BODIES_LABELS=(
"fix(db): integer-cents (or Decimal) money across wallet/ledger/invoices|DB-1 P1. Money is Float everywhere; ledger balance check is service-level with 0.005 tolerance (docs/audit/DATABASE_BASELINE.md DB-1). Supabase design already specifies NUMERIC(18,2) — bring the SQLite path to integer cents before any real-money pilot.|P1-high,finance,database"
"feat(qa): Playwright E2E golden paths (7 personas)|TEST-1 P1. Browser verification to date is manual; no automated E2E exists (docs/audit/MOCK_DEMO_BASELINE.md). Personas: client, contractor, supervisor, procurement, supplier, finance, professional. CI-ready once #98 unblocks.|P1-high,qa"
"feat(authz): project-membership model replacing portfolio-wide site-team reads|SEC-6 P2. All site-team roles read every project incl. worker PII + escrow (docs/audit/SECURITY_BASELINE.md SEC-6). Design a project_member model; pairs with Supabase RLS.|P2-medium,security"
"feat(security): share-link expiry + re-issue + decision-power review|SEC-3r P2. Entropy fixed this wave; links never expire and carry milestone.decide money powers (docs/audit/SECURITY_BASELINE.md SEC-3 residual, API_BASELINE.md API-5).|P2-medium,security"
"chore(auth): next-auth v4→v5 migration plan (supported pairing with Next 16)|SEC-5 P2. v4.24.15 on Next 16/React 19 is cast-shimmed and unsupported for the auth core (docs/audit/SECURITY_BASELINE.md SEC-5).|P2-medium,security"
"feat(db): DB-level ledger enforcement on SQLite parity with the Supabase design|DB-3 P2. Balance/append-only invariants are service-only on the SQLite path (docs/audit/DATABASE_BASELINE.md DB-3).|P2-medium,finance,database"
"fix(seed): production guard on destructive seed scripts|DB-5 P2. seed-all wipes 21 tables with deleteMany and no NODE_ENV guard (docs/audit/DATABASE_BASELINE.md DB-5).|P2-medium,database"
"perf(api): v1 list routes must not materialize the full project payload|API-3 P2. v1 project-subresource lists call getProjectPayload (~15-table aggregation) then slice one page (docs/audit/API_BASELINE.md API-3).|P2-medium,backend"
"perf(api): bound core reads (take/cursor)|API-4 P2. Unbounded findMany on milestones/variations/photoComments/attendance/supply (docs/audit/API_BASELINE.md API-4).|P2-medium,backend"
"feat(i18n): complete EN-only sub-surfaces|FE-3 P2. Audit tab, finder dialogs, land professionals, overview cards, site-map, PDF/CSV content remain EN-only (docs/audit/FRONTEND_BASELINE.md FE-3).|P2-medium,frontend"
"feat(offline): supplier-portal outbox parity|FE-4 P2. Supplier portal dispatch is online-only with no queue (docs/audit/FRONTEND_BASELINE.md FE-4).|P2-medium,frontend"
"fix(website): per-visitor rate-limit bucket + lead-drop alerting|WD-1 P2. Default posture = one global 5/hr bucket; 500-cap drops leads silently (docs/audit/WEBSITE_BASELINE.md WD-1).|P2-medium,frontend"
"feat(ops): automated backups + restore runbook + drill|INF-7 P2. Backup guidance exists, restore procedure does not (docs/audit/INTEGRATION_BASELINE.md INF-7 and DOC-4).|P2-medium,production"
"feat(observability): structured logs w/ correlation IDs, error tracking, metrics|OBS-1/2 P2. Health endpoint is good; everything beyond is absent (docs/audit/INTEGRATION_BASELINE.md).|P2-medium,production"
)

# --------------------------------------------------------------- execute -----
say "creating wave issues…"
N_SEC1="$(ensure_issue "$ISS_SEC1_TITLE"   "$ISS_SEC1_BODY"   "P1-high,security,backend")"
N_SEC2="$(ensure_issue "$ISS_SEC2_TITLE"   "$ISS_SEC2_BODY"   "P1-high,security")"
N_SEC3="$(ensure_issue "$ISS_SEC3_TITLE"   "$ISS_SEC3_BODY"   "P2-medium,security")"
N_SEC4="$(ensure_issue "$ISS_SEC4_TITLE"   "$ISS_SEC4_BODY"   "P2-medium,security,backend")"
N_FE1="$(ensure_issue  "$ISS_FE1_TITLE"    "$ISS_FE1_BODY"    "P1-high,security,frontend")"
N_DB2="$(ensure_issue  "$ISS_DB2_TITLE"    "$ISS_DB2_BODY"    "P1-high,database")"
N_DB6="$(ensure_issue  "$ISS_DB678_TITLE"  "$ISS_DB678_BODY"  "P2-medium,database")"
N_DB4="$(ensure_issue  "$ISS_DB4_TITLE"    "$ISS_DB4_BODY"    "P2-medium,database,finance")"
N_DOCS="$(ensure_issue "$ISS_DOCS_TITLE"   "$ISS_DOCS_BODY"   "P3-low,documentation")"
N_RM="$(ensure_issue   "$ISS_README_TITLE" "$ISS_README_BODY" "P3-low,documentation")"

say "creating register issues…"
for row in "${REG_TITLES_BODIES_LABELS[@]}"; do
  IFS='|' read -r t b l <<<"$row"
  ensure_issue "$t" "$b" "$l" >/dev/null
done

say "pushing branches + opening PRs…"
P_SEC="$(ensure_pr "$BR_SECURITY" main \
  "fix(security): audit-2 wave — mutation safety, fallback-secret runtime, token entropy, webhook fail-closed, demo-cred gating" \
  "Closes #$N_SEC1
Closes #$N_SEC2
Closes #$N_SEC3
Closes #$N_SEC4
Closes #$N_FE1

$(body_head)
Five focused commits; 73 files / 1,852 tests green; lint + tsc clean.")"

P_DATA="$(ensure_pr "$BR_DATA" main \
  "fix(data): audit-2 wave — inventory atomicity, integrity constraints + indexes, v1 money audit trail" \
  "Closes #$N_DB2
Closes #$N_DB6
Closes #$N_DB4

$(body_head)
Three focused commits; 74 files / 1,847 tests green; lint + tsc clean; migration drift zero; seeds re-validated.")"

P_DOCS="$(ensure_pr "$BR_DOCS" main \
  "docs(audit): Phase-0 discovery baseline + 2026-09-16 QA report + GitHub sync kit" \
  "Closes #$N_DOCS

$(body_head)
Full baseline set under docs/audit/ + QA-REPORT-2026-09-16.md.")"

P_RM="$(ensure_pr "$BR_README" main \
  "docs(readme): product-thesis refresh" \
  "Closes #$N_RM

$(body_head)
README rewritten around the expanded product thesis; operational sections preserved.")"

say "done. PRs: security #$P_SEC · data #$P_DATA · docs #$P_DOCS · readme #$P_RM"

if [[ "${1:-}" == "--merge" ]]; then
  for p in "$P_SEC" "$P_DATA" "$P_DOCS" "$P_RM"; do
    gh pr merge "$p" -R "$REPO" --merge --delete-branch || warn "merge of #$p failed — merge manually"
  done
  say "merges requested."
fi
