# ADR 0003 — Repository topology: one repo, directory boundaries — not branches, not polyrepo

- **Status:** Accepted (2026-09-09)
- **Deciders:** Staff engineering (coordinator session)
- **Question raised by:** product owner — *"do we create other repos and shift the website, frontend, dashboard etc., or should we use different branches?"*

## Context

Mjengo-OS v0.2.5 ships **two deployables out of one repository**:

| Surface | Location | Service | Port |
|---|---|---|---|
| The app (owner dashboard, client surface, supplier portal, PWA mobile shell) | `src/` | app (standalone Next.js) | 3000 |
| The marketing website | `mjengoos-website/` | website (standalone Next.js) | 3001 |

They are already **separate build units**: two `package.json`s, two builds, two
Docker images, two compose services; the app proxies `/website/*` to the
website's origin (`WEBSITE_ORIGIN`). What they share is the repo's cross-cutting
contracts: the role/permission matrix (`src/shared/permissions.ts`), the
Prisma schema + Supabase target design (`prisma/`, `supabase/`), i18n policy,
pricing/copy truth, CI gates, deployment docs and the audit history
(96 merged PRs, 1,691 tests). The team operating all of it is effectively
one trusted circle.

The "frontend" and "dashboard" in the question are the same deployable as the
app — they share session auth, the zustand store, i18n dictionaries and the
API surface inside one Next.js build.

## Options considered

### Option A — different branches per surface (website on a branch, app on another)

**Rejected.** Branches are a *temporal* tool (versions of one tree over time);
surfaces are a *spatial* problem (different deployables). Permanent
per-surface branches would:

- turn every shared fix (security patch, role-matrix change, pricing copy)
  into a cherry-pick across long-lived branches that can never be merged;
- make releases branch-sync ceremonies with no CI able to gate cross-branch
  consistency;
- keep `git history` — our audit trail (repository forensics, "nothing lost
  in local history") — permanently fragmented.

There is no scenario where a directory wouldn't do the same job strictly
better. (Legitimate branch uses stay: short-lived feature/release branches,
exactly as the 40+ merged PRs already practice.)

### Option B — polyrepo: one repo per surface

Rejected **today**, revisit later. It buys deployment independence — which we
already have (two services, two images) — at the price of:

- shared-contract drift: no atomic PR can touch the app + website + schema
  together; cross-repo version pinning becomes a daily tax;
- duplicated scaffolding: CI, issue templates, deploy docs, security posture
  per repo;
- coordinated-release dances (N PRs, N merges) for one logical change;
- onboarding cost: N clones to run the product locally.

Polyrepo pays off when there are real **team boundaries** with different
release cadences and access needs. That isn't the current org shape.

### Option C — one repo, directory + service boundaries (chosen)

Keep the current topology: **one repository**, surfaces as directories,
deployables as separate services/images. This is what v0.2.5 already runs,
and the audit waves validated it — one PR (#92) could fix app robustness and
a11y while CI (`lint`/`tsc`/build) gated both apps from one place.

## Decision

1. **One repository.** The website, the app (frontend/dashboard/mobile
   shell), the shared contracts, the schema and the docs stay together.
2. **Branches remain temporal only** — feature/release branches per the
   issue → branch → PR protocol. Never per-surface permanent branches.
3. **Deployables stay separate services** (ports 3000/3001, two Docker
   images, `/website/*` proxy) — monorepo does not mean monolith.
4. **A new surface must start as a directory** in this repo (like
   `mjengoos-website/` did) with its own `package.json`, build and service
   entry, so it can be lifted out later without a big-bang migration.

## Consequences

- One clone runs the whole product; one PR can ship a cross-surface change
  atomically; one CI gate (when #98's account billing lockout is resolved)
  covers both apps.
- The repo is larger than any single surface needs — acceptable: clone size
  is seconds, and Bun workspaces-style `site:*` scripts already manage the
  two builds ergonomically.
- Supabase Phase-1/2 (ADR 0002 follow-ups) keep a single migration story
  shared by every surface.

## Revisit triggers — split a surface into its own repo when ANY of these hold

1. A **dedicated team** owns the marketing site with a materially different
   release cadence than the app.
2. The website needs **independent hosting** (edge/CDN platform, separate
   domain pipeline) where coupling it to app deploys creates friction, not
   safety.
3. **Access separation** becomes real (e.g. an agency touching only
   marketing copy should not see app code).
4. Repo cold-clone time becomes a measurable developer pain (minutes).

None of these are true today; each is cheap to detect later, and the
directory-with-own-package.json rule keeps the extraction mechanical.

## Related

- ADR 0001 (mobile scope — the native app would be the FIRST legitimate
  second repo, triggered by its revisit conditions)
- ADR 0002 (Supabase design — the schema the whole repo shares)
- `docker-compose.yml` (the two-service deployment this decision keeps)
- Issue #98 (CI account lockout — topology independent, evidence standard
  unchanged)
