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
bun run test          # vitest — the full unit suite
```

All three must pass locally; CI runs them again on every push/PR. Touching
the marketing site (`mjengoos-website/`)? Also run `bun run site:lint` and
`bun run site:typecheck`.

## Pull requests

- **Small and single-purpose** — one branch, one concern. If the diff sprawls,
  split it into stacked PRs.
- **Linked to an issue** — open or comment on one first, so the *why* is
  recorded before the *how*.
- **Left open for review** — every change lands through a reviewed, CI-gated
  PR; don't expect direct commits to `main`.
- **Honest scope** — state what works, what's simulated and what's deferred.
  This repo's culture is *reported vs verified, everywhere*; PRs follow it.

## Security

Found something security-sensitive? **Do not open a public issue** — follow
the disclosure policy in [SECURITY.md](./SECURITY.md): GitHub Security
Advisories, coordinated disclosure, acknowledgement within 72 hours.

## License

By contributing you agree that your work ships under the repository's
[MIT license](./LICENSE).
