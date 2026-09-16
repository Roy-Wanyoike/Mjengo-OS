# MjengoOS — Technology & Dependency Baseline (Phase 0.2)

Baseline: `main @ 8b0003a`; declared deps from `package.json` (root) and
`mjengoos-website/package.json`; usage verified against source imports by the
baseline auditors.

## Runtime stack (verified in source)

| Layer | Declared | Actually used | Notes |
|---|---|---|---|
| Framework | next ^16.1.1 | ✅ App Router, route handlers, standalone build | `next.config.ts` (output standalone, headers) |
| Language | typescript ^5 (strict) | ✅ `tsc --noEmit` gate green | |
| React | react/react-dom ^19 | ✅ | next-auth v4 pairing is cast-shimmed (SEC-5) |
| Runtime/PM | bun 1.3 (dev/test), node 20-slim (container) | ✅ | dev script tees dev.log |
| Styling | tailwindcss ^4 + tw-animate-css | ✅ | tailwind.config.ts + postcss |
| UI kit | 30+ @radix-ui packages, lucide-react, sonner, vaul, cmdk, recharts, embla | ✅ shadcn-style `src/frontend/ui` | |
| Forms/validation | react-hook-form, @hookform/resolvers, zod ^4, ajv | ✅ zod in v1 handlers; ajv for OpenAPI-adjacent schemas | |
| State | zustand ^5, @tanstack/react-query/table | ✅ zustand store `use-mjengo.ts` | |
| ORM/DB | prisma ^6 + @prisma/client, better-sqlite3 ^12 | ✅ 68-model schema, 11 migrations | SQLite file via `DATABASE_URL` |
| Auth | next-auth ^4.24.15 | ✅ credentials provider, JWT sessions, custom guards | v4-on-Next-16 flagged (SEC-5) |
| AI | z-ai-web-dev-sdk ^0.0.18 | ✅ `lib/ai.ts` + `modules/ai/provider.ts`, flag-gated, 20 s cap | honest "AI unavailable" when unconfigured |
| Money | custom Daraja client (fetch) | ✅ `modules/wallet/daraja*.ts`, sandbox env-gated | no SDK dep — deliberate |
| Notifications | web-push ^3.6.7 | ✅ VAPID-gated | AT SMS via fetch |
| Docs/PDF | jspdf, pdfjs-dist? (pdf-text via lib) | ✅ draw-pack PDFs, text extraction | |
| Media | sharp ^0.34.5 | ✅ image pipeline | |
| i18n | custom dicts (en/sw) + compile-time parity gate | ✅ 2,049 keys per locale | next-intl declared but the app uses its own dicts |
| Tests | vitest ^5 | ✅ 71 files / 1,811 tests at baseline | node env, no coverage config |
| Lint | eslint ^9 + eslint-config-next | ✅ exit 0 | |

## Declared-but-notably-unused / duplicate

- `next-intl` — declared; app ships its own i18n (website uses neither) →
  cleanup candidate (P3).
- `lodash` + `lodash-es` both present; `uuid` + `nanoid` + `cuid` (Prisma)
  overlap — P3 cleanup.
- `effect`, `flatted`, `deepmerge-ts`, `defu`, `@humanfs/node`, `@mdxeditor`,
  `prismjs`, `react-syntax-highlighter` — spot-checks found no hot-path imports
  in the OS app; likely transitive/legacy leftovers → P3 audit issue.
- No abandoned security-critical packages found; `better-sqlite3` native build
  works under bun (gates green).

## Version posture

No upgrades were made this wave (rule: upgrade only with concrete
security/compat reasons). Flagged for the register:
- **next-auth v4 → v5/beta** migration plan (SEC-5) — P2.
- Watch: `@prisma/client` 6.x minors, `next` 16.x patches.

## Container/CI tooling

- Dockerfiles (root + website): bun builder → node:20-slim runtime, non-root,
  `prisma migrate deploy` on boot, standalone server. Verified sane by infra
  auditor.
- CI: 3 GitHub Actions workflows (lint+tsc+build / vitest / docker build) —
  definitions correct, **never executed** (account billing lock, issue #98);
  local gates are the documented substitute.
