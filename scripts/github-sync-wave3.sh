#!/usr/bin/env bash
# github-sync-wave3.sh — 2026-09-17 wave-3 sync kit for Roy-Wanyoike/Mjengo-OS.
#
# The 2026-09-16 wave's issues #221–#246 are merged; this kit ships wave 3:
# the three P1 gates (#122 money, #174 authz, #182 E2E) + repo hygiene +
# reference docs. Local-first delivery: everything below executes only when
# a token exists (gh auth). Idempotent: dedups issues/PRs before creating,
# never force-pushes, never touches main directly.
#
# Usage:  bash scripts/github-sync-wave3.sh           # labels + issue + branches + PRs
#         bash scripts/github-sync-wave3.sh --merge   # … then merge in dependency order
set -euo pipefail

REPO="Roy-Wanyoike/Mjengo-OS"
# Dependency order: chore → #122 → #174. #182 + docs are independent.
BRANCHES=(
  "chore/remove-unreachable-legacy"
  "fix/122-integer-cents-money"
  "fix/174-project-membership-authz"
  "feat/182-playwright-e2e"
  "docs/audit3-authz-matrices"
)

say()  { printf '\033[1;36m[sync]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[sync]\033[0m %s\n' "$*" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || die "gh CLI not installed"
command -v jq >/dev/null 2>&1 || die "jq not installed"
gh auth status >/dev/null 2>&1 || die "gh not authenticated — run: gh auth login"
for b in "${BRANCHES[@]}"; do
  git rev-parse --verify --quiet "refs/heads/$b" >/dev/null \
    || die "local branch '$b' not found — run this in the repo clone that has the wave-3 branches"
done

# ---------------------------------------------------------------- labels ----
for l in "P1-high,DC2626,high" "P2-medium,D97706,medium" "security,DC2626,bug" \
         "finance,059669,improvement" "database,7C3AED,improvement" "backend,2563EB,improvement" \
         "qa,EA580C,improvement" "documentation,64748B,improvement" "production,BE185D,improvement"; do
  IFS=, read -r name color desc <<<"$l"
  gh label create "$name" --color "$color" --description "$desc" -R "$REPO" --force >/dev/null 2>&1 || true
done
say "labels ensured"

# ------------------------------------------------------------- dedup helpers -
ALL_ISSUES_JSON="$(gh issue list -R "$REPO" --state all --limit 1000 --json number,title 2>/dev/null || echo '[]')"
ALL_PRS_JSON="$(gh pr list -R "$REPO" --state all --limit 1000 --json number,title,headRefName 2>/dev/null || echo '[]')"
find_issue() { printf '%s' "$ALL_ISSUES_JSON" | jq -r --arg t "$1" '.[] | select(.title==$t) | .number' | head -1; }
find_pr_by_head() { printf '%s' "$ALL_PRS_JSON" | jq -r --arg h "$1" '.[] | select(.headRefName==$h) | .number' | head -1; }

# ------------------------------------------------------------------ issue ----
# One NEW issue for the hygiene branch (the money/authz/E2E issues already exist:
# #122, #174, #182 — verified open on 2026-09-17).
CHORE_TITLE="chore(repo): remove unreachable legacy files + restore test-referenced policy matrices"
CHORE_BODY='**Problem**
290 legacy files (pre-rebuild duplicates, dead session drafts, unreferenced shadcn defaults, dead hooks) sit in the tree. 300 of the 782 strict-tsc errors blocked the integer-cents work (#122) from passing the repo-wide gate.

**What this does**
- Removes reachability-proven dead trees (zero imports from src/app, src/frontend, src/backend, tests, seeds, scripts, build configs).
- Keeps + restores the three module policy matrices (intel/land/professionals) — tests import them; the first sweep missed test imports, corrected in the same branch.

**Verification**: full gates green on the stacked branch (90 files / 2,135 tests, tsc, lint, fresh migrate deploy).'
CHORE_NUM="$(find_issue "$CHORE_TITLE")"
if [ -z "$CHORE_NUM" ]; then
  CHORE_NUM="$(gh issue create -R "$REPO" --title "$CHORE_TITLE" --body "$CHORE_BODY" \
    --label "P2-medium" --label "backend" | grep -oE '[0-9]+')" || true
  say "created chore issue #$CHORE_NUM"
else
  say "chore issue already exists: #$CHORE_NUM"
fi
[ -n "$CHORE_NUM" ] || die "could not create/find the chore issue"

# ---------------------------------------------------------------- branches ----
for b in "${BRANCHES[@]}"; do
  if git ls-remote --heads "https://github.com/$REPO.git" "$b" | grep -q .; then
    say "branch '$b' already on remote — skipping push (no force-push)"
  else
    git push -u origin "$b"
  fi
done

# -------------------------------------------------------------------- PRs ----
open_pr() { # head base title body
  local num; num="$(find_pr_by_head "$1")"
  if [ -n "$num" ]; then say "PR for '$1' already exists: #$num"; return 0; fi
  gh pr create -R "$REPO" --head "$1" --base "$2" --title "$3" --body "$4"
}

open_pr "chore/remove-unreachable-legacy" "main" \
  "chore(repo): remove unreachable legacy files + restore test-referenced policy matrices (closes #$CHORE_NUM)" \
  "Issue: #$CHORE_NUM
What changed: 290 dead files removed (pre-rebuild duplicates, v2-domain dead-session drafts, unreferenced ui/hooks/policy copies); the three test-referenced policy matrices restored.
Why: the dead trees carried 300 of the 782 strict-tsc errors that blocked the #122 money conversion from passing the repo-wide gate.
Files/modules: src/frontend/ui (22 unused components), src/frontend/hooks, src/backend/modules policy/repository copies, v2-domain drafts.
Tests: full suite green on the stacked branch (90/2,135) + tsc + lint + fresh migrate deploy.
Manual verification: reachability grep across src/app, src/frontend, src/backend, tests, seeds, scripts, build configs.
Migration: none (no schema change).
Security impact: smaller attack/review surface; no behavior change.
Known limitations: none."

open_pr "fix/122-integer-cents-money" "chore/remove-unreachable-legacy" \
  "feat(money): integer-cents across every money path — the ledger never lies (closes #122)" \
  "Issue: #122 (P1 — the real-money gate, DB-1)
What changed: migration 12 Float→BigInt CENTS (data-preserving) + zero-padded migration ordering (fresh deploy was BROKEN — Prisma applies lexicographically, 12_ sorted before 2_draw_pack: 'no such table: DrawPack'); supply write paths completed (upsertCatalogItem/upsertSupplier/receiveQuote/upsertRule were still storing raw KSh numbers into BigInt columns — 100x read-back corruption); supplier-portal GET + supply-slice quote/order DTOs stripped of raw BigInt-bearing relations (whole-payload JSON 500); core payload list/summary converted (getProjectsList/summary math was mixing BigInt+number — every /api/projects 500); stockValue zero edge.
Why: the ledger never lies — exact bigint money end-to-end, KSh only at boundaries.
Tests: 90 files / 2,135 green; fresh migrate deploy ✅; drift ✅; payload JSON zero-BigInt-leak probe ✅; E2E (feat/182 branch) drives the seeded app green.
Manual verification: dev server + seeded DB, /api/projects + /api/project 200 with sane KSh.
Migration: 12_integer_cents_money + renames 0-9 → 00-09 (fresh installs only — no production DB exists).
Security impact: removes a 100x money-corruption class and a whole-payload crash.
Known limitations: quantities stay Float by design (Supabase numeric(18,3) parity).
Depends on: the chore PR (stacked)."

open_pr "fix/174-project-membership-authz" "fix/122-integer-cents-money" \
  "feat(security): project-membership read scoping for the site team (closes #174)" \
  "Issue: #174 (P1 — SEC-6)
What changed: ProjectMembership model + additive-only migration 13; membership-scope.ts (contractor/admin portfolio grant in code; supervisor/procurement/qs/finance fail-closed on their rows); wired into all 14 v1 read families + /api/projects + /api/project + /api/sync; worker PII (idNumber/emergency contacts) restricted to membership-holders + contractor/admin + the project's client (nulls otherwise — not an oracle); seed blanket grant (single-org posture, SECURITY.md records revisit triggers); Supabase design parity (project_memberships + RLS).
Why: worker PII (Kenya DPA 2019) + escrow visibility were readable by ANY owner-role session across the whole portfolio.
Tests: +26 adversarial (zero-calls portfolio pin, fail-closed, 403/404 uniformity, PII strip, migration pins); 91 files / 2,161 green; fresh deploy (14 migrations) ✅.
Manual verification: n/a (API-level, mock-honest DB layer).
Migration: 13_project_membership (additive-only).
Security impact: closes the SEC-6 read-scope hole.
Known limitations: mutations not membership-gated yet (single-org accepted risk, documented; follow-up recommended).
Depends on: the #122 PR (stacked)."

open_pr "feat/182-playwright-e2e" "main" \
  "feat(qa): Playwright E2E golden paths — all 7 personas green (closes #182)" \
  "Issue: #182 (P1 — TEST-1)
What changed: @playwright/test + config + tests/e2e with 7 persona golden-path specs + shared helpers; package.json scripts (test:e2e).
Why: zero automated browser tests — every browser-verified claim was manual.
Tests: FULL SUITE 7 passed (35.3s) against the real dev server + seeded DB. The first runs found two real payload bugs (fixed in the #122 PR) — the exact regression-proofing TEST-1 exists for.
Manual verification: the run evidence above; runbook in the config header (bun run dev with the seeded DB, then bun run test:e2e).
Migration: none.
Security impact: none.
Known limitations: CI execution blocked by #98 (billing lock) — local gate is the documented substitute."

open_pr "docs/audit3-authz-matrices" "main" \
  "docs: MJENGOOS reference docs, AI seam config template, QA screenshots" \
  "What changed: MJENGOOS_*.md + ARCHITECTURE_ROADMAP.md reference docs; .z-ai-config.example (the z-ai SDK seam template referenced by src/backend/lib/ai.ts); QA screenshots.
Why: reference material recovered from the dead session, kept as history.
Tests: docs only.
Known limitations: written against the pre-rebuild repo — historical reference."

# ------------------------------------------------------------------- merge ----
if [ "${1:-}" = "--merge" ]; then
  for b in "${BRANCHES[@]}"; do
    num="$(find_pr_by_head "$b")"
    [ -n "$num" ] && gh pr merge "$num" -R "$REPO" --merge --delete-branch && say "merged #$num ($b)"
  done
  say "wave 3 merged — then: git checkout main && git pull"
else
  say "PRs opened. Review, then re-run with --merge (or merge manually)."
fi
