# GitHub Sync Runbook — 2026-09-16 audit wave

> **Why this exists.** This wave was produced in an environment without a
> valid GitHub token (the prior PAT expired 2026-09-11; none is available in
> the sandbox). Everything is delivered **locally-first**: green branches,
> evidence docs, and this one-command sync kit. Nothing was pushed and local
> `main` was never modified — the honest issue → PR → review → merge flow
> executes the moment a token exists.

## What gets synced

| Branch | Contents | PR closes |
|---|---|---|
| `fix/audit2-security` | SEC-1, SEC-2, SEC-3(entropy), SEC-4, FE-1/MD-1 — 5 commits, 73 files/1,852 tests green | the security issues below |
| `fix/audit2-data` | DB-2, DB-6/7/8 (migration `10_integrity_constraints`), DB-4 — 3 commits, 74 files/1,847 tests green, zero drift | the data-integrity issues below |
| `docs/audit2-baseline` | Phase 0 discovery baseline (this folder), QA report 2026-09-16, sync kit | the docs issue below |
| `docs/readme-product-thesis` | README refresh (production-grade product thesis from the 2026-09-16 review) | the README issue below |

## How to run (owner, with a valid token)

```bash
# 1) authenticate (token needs repo + issues + PR rights on Roy-Wanyoike/Mjengo-OS)
gh auth login            # or: echo <TOKEN> | gh auth login --with-token

# 2) from the repo root (any clone that has the four branches):
bash scripts/github-sync.sh          # creates labels + issues (dedup by title),
                                      # pushes branches, opens PRs (Closes #N)
bash scripts/github-sync.sh --merge  # additionally merges the PRs (owner)
```

The script is **idempotent**: it searches existing issues/PRs before creating
anything (no duplicates), and skips steps already done. It never force-pushes
and never touches `main` directly.

## Issue set created by the script

Wave fixes (each gets issue → PR → auto-close):
`SEC-1` mutation-safety gate · `SEC-2` fallback-secret runtime restriction ·
`SEC-3` share-token CSPRNG entropy · `SEC-4` webhook fail-closed in
production · `FE-1/MD-1` demo-credentials gating · `DB-2` inventory
atomicity · `DB-6/7/8` integrity constraints + indexes · `DB-4` v1 money
audit trail · `DOC` Phase-0 baseline + QA report · `README` product-thesis
refresh.

Register issues (not started; bodies included in the script):
`DB-1` integer-cents money · `TEST-1` Playwright E2E · `SEC-6`
project-membership authz · `SEC-3r` share-link expiry · `SEC-5` next-auth
v5 plan · `DB-3` SQLite ledger enforcement · `DB-5` seed production guard ·
`API-3/4` bounded reads · `FE-3` i18n completion · `FE-4` supplier offline ·
`INF-7` backups/restore · `OBS-1/2` observability — full list with
priorities in `PENDING_WORK.md`.

## Verification after sync

1. CI runs (needs #98 billing unlock) — exact local substitutes:
   `bunx vitest run` · `bun run lint` · `bunx tsc --noEmit` ·
   `bunx prisma migrate diff --from-migrations prisma/migrations
   --to-schema-datamodel prisma/schema.prisma --shadow-database-url file:/tmp/shadow.db`
2. Review each PR diff (small, focused commits; every finding carries tests).
3. Merge (script `--merge` or manually); issues auto-close via `Closes #N`.
4. Post-merge: `git checkout main && git pull`, delete the four branches.
