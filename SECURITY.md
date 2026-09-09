# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `main` branch (latest release) | ✅ |
| anything else (old forks, feature branches) | ❌ |

MjengoOS is a young project — only the tip of `main` receives security fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue for anything security-sensitive.**

Instead, use **GitHub Security Advisories**: go to this repository's
**Security → Advisories → "Report a vulnerability"** tab
(`https://github.com/Roy-Wanyoike/Mjengo-OS/security/advisories/new`).
Reports sent that way reach the maintainer privately and support coordinated
disclosure. If that path is unavailable to you, the repo README lists a
private contact preference.

Please include, where possible:

- a minimal reproduction (request/response pairs, URLs, payloads)
- the affected surface (see Scope below)
- your assessment of impact and suggested severity

### Response expectations

- **Acknowledgement within 72 hours** (usually much faster).
- Triage, severity rating and a fix-or-wontfix decision communicated through
  the private advisory thread.
- Credit in the release notes if you wish (opt-in; your choice).

## Scope

In scope:

- the **web application** (`src/`, served on port 3000 — UI, session handling,
  share-link access)
- the **HTTP API** (`src/app/api/**`, incl. `/api/v1` and the AI routes)
- the **marketing website** (`mjengoos-website/`, port 3001 / `/website`)
- infrastructure files in this repo (Dockerfile, docker-compose, workflows)

Out of scope (by design — documented in the README's honesty notes):

- the **simulated payment rails** — no real money moves; the
  `PaymentProvider` seam is intentionally a `SimulatedProvider`
- AI route behavior when the app runs outside its original sandbox without
  real AI credentials
- volumetric/DoS-only findings against a single-instance SQLite deployment
  (the known single-instance rate-limit limitation is documented in
  `src/backend/lib/rate-limit.ts` and ARCHITECTURE.md)

## Demo credentials are intentional

The accounts in `README.md` (`contractor@mjengo.os` … `admin@mjengo.os`) are
**seeded demo data**, created by `prisma/seed-extras/users.ts` so the whole
role matrix is explorable immediately. They are not a credential leak; do not
report them. A real deployment creates its own users and never seeds.

## Hardening already in place

Recruiters and reviewers can verify: per-route rate limiting + login lockout
(`src/backend/lib/rate-limit.ts`), login-timing equalization and scrypt
password hashing (`src/backend/lib/auth.ts`), error redaction on public
routes, zod-validated inputs, `Idempotency-Key` dedupe on money routes,
crypto-random 96-bit share tokens, fail-closed role guards
(`src/backend/lib/guard.ts`) mirrored client-side, and PR-only `main` with CI
quality gates.
