# MjengoOS — Repository Inventory (Phase 0.1)

Baseline: `main @ 8b0003a` (2026-09-16 fresh clone). 176 commits, 3 authors
(Roy Wanyoike 34, agent "Z User" 141, ImgBot 1), no tags/releases, one branch
(`main`) on origin, clean working tree, 28 MB.

## Monorepo layout

```
mjengo-os/
├── src/app/                  # Next.js 16 App Router (the OS)
│   ├── page.tsx, layout.tsx, error.tsx, global-error.tsx
│   └── api/                  # ~60 route paths (thin) → src/backend/api/**
│       ├── (legacy) actions, sync, projects, project, share, supplier,
│       │   search, notifications, audit, flags, upload/{,confirm,presign,re-sign},
│       │   push/{subscribe,unsubscribe}, reports/budget-variance, health,
│       │   auth/[...nextauth], jobs/run, ussd, whatsapp, openapi.json,
│       │   webhooks/daraja/{,[secret]}
│       ├── ai/               # voice-log, parse-text, analyze-photo,
│       │                     # authenticity-screen, recap, anomaly-scan,
│       │                     # extract-document
│       └── v1/               # 27 documented REST paths (projects + subresources,
│                             # wallets, payments, supply orders, milestones,
│                             # tasks, workers, invoices …)
├── src/backend/
│   ├── api/ + api/v1/        # real handlers (zod/ajv validation, guards)
│   ├── actions/              # server action appliers (land, inventory, invoices,
│   │                         # evidence, wallet, money, intel, supply, trust, ai,
│   │                         # professionals)
│   ├── modules/              # events, reports, inventory, intel, ai, notify,
│   │                         # ledger, invoices, wallet (Daraja + reconcile),
│   │                         # documents, professionals, land, supply, jobs,
│   │                         # drawpack
│   └── lib/                  # auth/guard/route-kit, mutation-safety (this wave),
│                             # rate-limit (+sqlite), storage (s3/sigv4/local),
│                             # audit, pii-scrub, perceptual-hash, pdf-text,
│                             # jobs-token, ai, mjengo (boot), db
├── src/frontend/
│   ├── mjengo/               # workspace app: 13 owner tabs + supplier portal +
│   │                         # auth login + share client view; cmdk palette;
│   │                         # finder / land / intel section trees; offline-boot,
│   │                         # sw-handlers, sync-outbox-panel
│   ├── ui/                   # shadcn-style component set
│   ├── hooks/ (use-mjengo store), i18n/ (en/sw dicts + parity gate), mobile/nav
├── src/shared/               # permissions.ts (UX role map), client-actions,
│                             # supplier-actions
├── mjengoos-website/         # separate Next.js marketing site (19 routes,
│                             # own Dockerfile, sections/, components/, data/,
│                             # app/api/contact)
├── prisma/                   # schema.prisma (68 models), migrations 0..10
│                             # (10 added this wave), seed-all.ts + seed-extras/*
├── supabase/                 # target-state design: 0001_schema.sql (68 tables),
│                             # 0002_rls.sql (69 tables, 233 policies),
│                             # 0003_platform.sql (storage/realtime/pg_cron)
├── docs/                     # ADR-0001..0003, PRODUCT-BLUEPRINT, RELEASE-NOTES,
│   ├── audit/                # ← this baseline set (+ 2026-09-10 QA report,
│   │                         #   GITHUB-HANDOFF [superseded], backlog, wave6-plan)
│   └── screenshots/          # verification evidence images
├── tests/unit/               # 74 files (this wave: +3) — vitest, node env
├── deploy/systemd/           # mjengo-jobs service + 5-min timer
├── Dockerfile, docker-compose.yml (os + website + jobs), DEPLOYMENT.md,
├── SECURITY.md, CONTRIBUTING.md, ARCHITECTURE.md, LICENSE (MIT)
└── public/                   # PWA manifest, sw.js, offline.html, icons, photos
```

## Git forensics highlights

- Prior engineering waves are fully landed on `main` through PRs (#85, #86–#89,
  #90–#93, #96, #101, #112–#117 …); `refs/pull/*` fetched for cross-checking.
- Honest-open external seams tracked as issues: **#40** USSD telco gateway,
  **#41** native app (ADR-0001), **#43** M-Pesa production certification,
  **#98** CI billing lock (owner action).
- 2026-09-10 hygiene wave deleted 64 stale branches after `git-cherry` proved
  zero unique work; one local-only destructive commit (97792e0) verified
  redundant and discarded. No secrets in history (full-refs scan, prior wave —
  re-confirmed by mock/demo sweep term hits this wave).
- This wave adds three branches (not yet pushed): `fix/audit2-security`,
  `fix/audit2-data`, `docs/audit2-baseline` (+ a README refresh branch — see
  `PENDING_WORK.md`).
