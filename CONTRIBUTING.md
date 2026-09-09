# Contributing to MjengoOS

Thanks for helping build an evidence-based construction OS for Kenya. This
guide covers the day-to-day workflow. What the product *is* lives in the
[README](./README.md); how it's built lives in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Setting up

Follow the [one-command quickstart](./README.md#quick-start) in the README:

```bash
bun install
cp .env.example .env        # set NEXTAUTH_SECRET: openssl rand -hex 32
bunx prisma generate
bunx prisma migrate deploy  # or: bunx prisma db push
bun run seed                # demo data — the DB ships empty
bun run dev                 # -> http://localhost:3000
```

The demo sign-in accounts (`contractor@mjengo.os`, `admin@mjengo.os`, …) are
**intentional seed data** created by `prisma/seed-extras/users.ts` so the full
role matrix is explorable — they are not a credential leak. Don't report them
(see [SECURITY.md](./SECURITY.md#demo-credentials-are-intentional)).

## Branches

Branch from `main` and name by intent:

| Prefix | Use | Example |
|---|---|---|
| `feat/` | new capability | `feat/ussd-attendance` |
| `fix/` | bug fix | `fix/login-lockout` |
| `chore/` | tooling, deps, repo hygiene | `chore/gitignore-hygiene` |
| `docs/` | documentation only | `docs/readme-polish` |

## Commits

Conventional commits, imperative subject, ≤ 72 characters:

```
feat(wallet): escrow release gated on photo proof
fix(sync): reject stale outbox versions (keep-server)
docs(readme): correct the Prisma model count to 61
```

## Before you open a PR

Run the same gates CI runs:

```bash
bun run lint          # eslint — 0 errors, 0 warnings
bunx tsc --noEmit     # strict typecheck, 0 errors
bun run test          # vitest — the full unit suite (1,513 tests / 54 files)
```

All three must pass locally. CI re-runs lint and the strict typecheck on
every push/PR and adds a real production build (it does not run the vitest
suite — that's the local gate, and every merge to `main` re-ran it in full).
Touching the marketing site (`mjengoos-website/`)? Also run `bun run
site:lint` and `bun run site:typecheck`.

## Pull requests

- **Small and single-purpose** — one branch, one concern. If the diff sprawls,
  split it into stacked PRs.
- **Tests land with the code, in the same branch** — new behavior is pinned
  by new tests before it merges (the suite grew 495 → 1,513 tests across
  waves 1–6; every merge re-ran the full suite).
- **Linked to an issue** — open or comment on one first, so the *why* is
  recorded before the *how*.
- **Left open for review** — every change lands through a reviewed, CI-gated
  PR; don't expect direct commits to `main`.
- **Honest scope** — state what works, what's simulated and what's deferred.
  This repo's culture is *reported vs verified, everywhere*; PRs follow it.

## Parallel work (waves & worktrees)

Several features are often built at once, in isolation, then merged
sequentially — that is how waves 3–6 were built. The working method:

- Build each feature in its own **git worktree** off `main`
  (`git worktree add ../wt-<task> -b feat/<name>`), so parallel branches
  never step on each other's working files.
- **One feature owns one file area** per wave — the branch plan keeps file
  ownership disjoint (e.g. only one branch touches `schema.prisma`, only one
  touches the i18n dictionaries).
- When two branches must touch the same file, **append at the end** — new
  i18n keys go at the bottom of the dictionary files under a comment header,
  which keeps the merge conflict trivial.
- Re-run the full gate (lint + typecheck + tests) in the worktree before
  committing; merge with `--no-ff` and re-run the whole suite once more on
  `main` after the merge.
- External services only ever appear as **honest seams** (env-gated,
  fail-closed): no feature needs outside credentials to build or test, and
  nothing pretends to be live when it isn't.

## Security

Found something security-sensitive? **Do not open a public issue** — follow
the disclosure policy in [SECURITY.md](./SECURITY.md): GitHub Security
Advisories, coordinated disclosure, acknowledgement within 72 hours.

## License

By contributing you agree that your work ships under the repository's
[MIT license](./LICENSE).
