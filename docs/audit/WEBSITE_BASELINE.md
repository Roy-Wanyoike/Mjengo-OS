# Website / Marketing Baseline Audit — Mjengo-OS

- **Agent**: 2-c — Website/Marketing Baseline Lead (re-audit, Phase 0.5 website half)
- **Date**: 2026-09-16 · **Repo**: `main @ 8b0003a` · **Scope**: `mjengoos-website/**` (read-only research; no installs/builds/servers run)
- **Prior claims under test** (docs/QA-REPORT-2026-09-10.md §8): "19 routes render; sitemap/robots/metadata OK; contact form has a real, hardened endpoint; honesty sweeps hold."
- **Verdict in one line**: prior QA claims **verified** — 19 routes + 404 + 1 API route, all links resolve, contact endpoint hardened as claimed, honesty posture exceptionally strong; residual risk is *operational* (lead pipeline, analytics vacuum), not correctness.

---

## 1. Route inventory (19 pages + 404 + 1 API)

Verified by enumerating `mjengoos-website/app/**/page.tsx` (19 files) + `app/not-found.tsx` + `app/api/contact/route.ts`. `app/solutions/[slug]/page.tsx` statically generates 6 slugs via `generateStaticParams()` from `data/roles.ts` (client, site-supervisors, contractors, professionals, suppliers, finance) — matches the 6 `/solutions/*` entries in `app/sitemap.ts`.

| # | Route | Purpose | Nav | Footer | Classification |
|---|-------|---------|-----|--------|----------------|
| 1 | `/` (`app/page.tsx`) | Homepage — 19 composed sections (§10) | logo link | brand block | WORKING |
| 2 | `/platform` | Full platform tour: 10-module grid, 3 deep dives | NAV_ITEMS[0] | Platform col | WORKING |
| 3 | `/solutions` | Role index — 6 role cards | NAV_ITEMS[1] | Platform col | WORKING |
| 4 | `/solutions/[slug]` ×6 | Per-role pains/gains, surface preview (DemoChip) | via cards | — | WORKING (mockup demo-labelled) |
| 5 | `/land-verification` | 5-stage workflow, Property Passport, honesty block | NAV_ITEMS[2] | Platform col | WORKING |
| 6 | `/professionals` | Professional network "being built" | footer only (MW-12) | Platform col | WORKING |
| 7 | `/marketplace` | Supplier interface: quote→delivery loop | NAV_ITEMS[3] | Platform col | WORKING |
| 8 | `/materials` | Price transparency + comparison tables | footer only (MW-12 note in `data/nav.ts:4-7`) | Platform col | WORKING |
| 9 | `/wallet` | Financial trail, not-a-bank honesty band | NAV_ITEMS[4] | Platform col | WORKING |
| 10 | `/ai` | AI capabilities (SEE/LISTEN/UNDERSTAND/DETECT) + governance | NAV_ITEMS[5] | Platform col | WORKING (pilot-labelled) |
| 11 | `/projects` | Lifecycle: timeline, monitoring, handover artifacts | — | Resources col | WORKING |
| 12 | `/pricing` | 3 tiers + always-included + FAQ | — | Resources col | WORKING |
| 13 | `/about` | Why, principles, "live today" honesty list | — | Company col | WORKING |
| 14 | `/contact` | ContactForm → `/api/contact` + JSON-LD | — | Resources col | WORKING |
| 15 | `/signup` | Early-access request (ContactForm, source=signup) | navbar "Get Started" | — | WORKING (request-access form, not account creation — intentional pilot posture) |
| 16 | `/resources` | Tours + product FAQ + docs-status honesty block | NAV_ITEMS[6] | Resources col | WORKING |
| 17 | `/security` | Security practices + "no certifications claimed" | — | Company col | WORKING |
| 18 | `/privacy` | Privacy policy (last updated 9 Sep 2026) | — | Legal col | WORKING |
| 19 | `/terms` | Terms of service (last updated 9 Sep 2026) | — | Legal col | WORKING |
| — | 404 `app/not-found.tsx` | Branded 404, noindex, links home + /platform | — | — | WORKING |
| — | `POST /api/contact` | Real endpoint (see §3) | — | — | WORKING |

No MISSING/MOCK-DEMO *pages*. Product-UI previews inside pages are demo-labelled (see §5). Nav has 7 flat items (`data/nav.ts:8-16`); every footer target (`data/nav.ts:19-56`) maps to a real route. `/professionals`, `/materials`, `/projects`, `/pricing`, `/about`, `/security`, `/privacy`, `/terms` are footer/sitemap-discoverable only — intentional (MW-12).

## 2. CTA / link audit

**App connector** (`components/app-link.tsx`): "Sign in" resolves `NEXT_PUBLIC_APP_URL` → else `http://localhost:3000` when browsed from `localhost:3001` → else same-origin `/` (integrated gateway mode). It points at the **real OS app**; hydration-safe via `useSyncExternalStore`. No placeholder URLs anywhere (the old `hello@mjengoos.example.com` was removed — `lib/site.ts:53-60` documents it; `SITE.contactEmail` renders a mailto only when `NEXT_PUBLIC_CONTACT_EMAIL` is set, else the honest "no public mailbox yet" panel, `app/contact/page.tsx:141-154`).

**Internal links**: every `Button href=`, `SiteLink href=`, `NavLink href=` (grep of all `*.tsx`) resolves to one of the 19 routes — **zero broken internal links**. `components/button.tsx:36` — every CTA is a real `<Link>`, no JS-routing buttons. All hero CTAs (`sections/hero.tsx:58-68`) → `/signup` + `/platform`.

**CTA map (major)**: hero → `/signup`,`/platform` · every page closes with a cta-band → `/signup` + `/contact` (or `/pricing`,`/materials`,`/professionals`,`/solutions` variants — all valid) · pricing tiers → `/signup` (Early Access) and `/contact` (Team/Portfolio) · signup page → `/contact` ("Book a walkthrough") · solutions → `/contact` · wallet → `/signup`+`/contact` · resources tours → 6 internal routes.

**External links**: **none**. Only conditional `mailto:` (3 sites, gated on `SITE.contactEmail`). Zero third-party scripts/fonts (fonts are `next/font/google` self-hosted at build).

**Gateway quirk (LOW, WD-4)**: `Button` and `not-found.tsx` use plain `next/link`, not `SiteLink` — they don't preserve the `?XTransformPort=3001` preview param (sandbox preview only; production integrated/standalone modes unaffected) — **FIXED 2026-09-25 via #139: `Button` is now a client component rendering through the shared `useGatewayPort` hook (extracted from `site-link.tsx` into `lib/use-gateway-port.ts`) + `withGatewayPort`, and the 404 page's plain `/platform` link is a `SiteLink`; every CTA/404 link now preserves the param post-mount exactly like nav/footer links (param-less on SSR and first client render — no hydration mismatch, strict no-op when the param is absent; verified by a hydrated dev-session walk — hero/pricing-tier/cta-band/404 links all keep the param, console clean — and a `next build`+`start` smoke with zero `XTransformPort` occurrences in the served HTML)**.

## 3. Signup + contact forms and lead storage (DEPLOYMENT §6.3 claim)

- Both pages render the shared `components/contact-form.tsx` with per-source config (`app/contact/page.tsx:72-81`, `app/signup/page.tsx:59-68`). Submit → `fetch(\`${NEXT_PUBLIC_BASE_PATH}/api/contact\`)` (`contact-form.tsx:53`) — basePath-aware for `/website` proxy mode.
- **`app/api/contact/route.ts` — real and hardened, as claimed**:
  - Origin/Referer same-site gate (403 on mismatch; absent headers pass for curl/tests) — `route.ts:92-118,150-156`
  - Rate limit 5/hour; XFF trusted only with `TRUST_PROXY` (else one shared bucket — deliberate fail-closed) — `route.ts:51-83`
  - 16KB raw-body cap checked before `JSON.parse` (Content-Length honored + re-verified) — `route.ts:46-47,166-187`
  - Honeypot `companyWebsite` (hidden input `contact-form.tsx:97-106`; server rejects filled ones) — `route.ts:196-200`
  - Manual validation (no zod — regex `EMAIL_RE`/`PHONE_RE`, length caps, per-source rules: message ≥10 chars for contact, role required for signup) — `route.ts:120-148`
  - No third party contacted. **Storage**: append to `data/submissions.json`, capped at 500 entries (oldest dropped) — `route.ts:207-236`. Gitignored (`mjengoos-website/.gitignore`), Docker volume `website-data` → `/app/data` (Dockerfile:92, compose:91).
- **Retrieval (§6.3, DEPLOYMENT.md:295-324)**: verified — local path, `docker compose exec website cat /app/data/submissions.json`, retention warning ("dropped leads are gone for good; retrieve on a cadence"). Residual risks → WD-1, WD-11.

## 4. Pricing vs product posture

`app/pricing/page.tsx` + `data/pricing.ts`: Early Access tier highlighted "Current stage" (free during pilot, ≤3 projects soft limit, Nairobi & Kiambu first); **Team (KES 15,000/project/month) and Portfolio (custom) are explicitly footnoted "Indicative — final pricing will be published before the pilot ends"**. FAQ states wallet holds no money, M-Pesa initiation "in sandbox testing; production transfers are not enabled yet". This is consistent with the single-operator/Kenya-sandbox rails posture in the OS app (wallet = ledger + ESCROW ledger account, Daraja sandbox — `src/backend/modules/wallet/daraja.ts`, `src/backend/api/v1/project-escrow.ts`). One wording tension: "Escrow-style releases" (WD-3). Pricing tables are list-based (a11y-safe), `lg:grid-cols-3` responsive.

## 5. SEO status

- **`app/layout.tsx:20-65`**: `metadataBase` = `SITE.url + SITE.basePath` (MW-9 aware); title template `%s — MjengoOS`; 9 keywords; OG 1200×630 `/images/og.png` (real file, `public/images/og.png`); Twitter `summary_large_image`; robots index/follow; icons favicon.ico + icon-192.png; `viewport.themeColor #123C32`. Every page exports `metadata` with unique title/description + `alternates.canonical`. 404 is noindex.
- **`app/sitemap.ts`**: 24 URLs (19 routes incl. 6 slugs) with priorities; `lastModified` frozen constant `2026-09-09` (WD-6). **`app/robots.ts`**: allow all, disallow `/api/`, sitemap link — both join origin+basePath correctly.
- **Structured data**: JSON-LD `ContactPage` only (`app/contact/page.tsx:33-48`). No Organization/Product schema — optional gap.
- **Analytics (`lib/analytics.ts`)**: provider-agnostic `track()`; events `{event, props, ts, url}`; **no cookies, no PII, no vendor SDK**. With `NEXT_PUBLIC_ANALYTICS_ENDPOINT` unset (current default), production **collects nothing** — console.debug dev-only (`analytics.ts:60-68`). → WD-2.
- Icons: `public/icons/icon-512.png` shipped but **unreferenced**; SEO.md:10 claims "192/512 PNGs" wired; no `manifest.webmanifest` (root app has one, website doesn't) → WD-5.

## 6. Honesty sweep (verified — holds)

- **No traction/customer claims**: greps for "trusted by / customers / thousands / users worldwide / backed by / N+ projects" → **zero matches**. `sections/trust-strip.tsx:6-7` explicitly: "no fake logos, no fake numbers". `app/about/page.tsx:228-231`: "We don't publish usage numbers because there aren't usage numbers worth publishing yet."
- **AI marked pilot**: `/ai` hero: "flag-gated and opt-in, off by default… enabled per project during the pilot" (`app/ai/page.tsx:30-33`); same on `/pricing` (line 35), `/about` (233-237), homepage AI section; governance band: "AI never independently makes high-risk financial, legal or engineering decisions" (`app/ai/components/governance-band.tsx:27-32`).
- **Simulated/sandbox rails labelled**: USSD — `/about` "the current *384# line runs as a simulator" (`app/about/page.tsx:255-257`; app side `src/app/api/ussd/route.ts:25-45` confirms simulation). M-Pesa — "sandbox testing; production transfers are not enabled yet" on `/wallet` honesty band (`honesty-band.tsx:28`), `/pricing` FAQ (`data/pricing.ts:88`), `/resources` FAQ (line 92), `/terms` (line 81), `/privacy` (151).
- **Demo-labelled UI**: `DemoChip` ("Example · Demo data", `components/badge.tsx:79-85`) on every mockup — hero dashboard, wallet, marketplace, materials, roles, AI capabilities, timelines, passports (grep: 30+ usages).
- **Not-a-bank / not-a-government**: `app/wallet/components/honesty-band.tsx:20-29`; land verification honesty block ("We do not verify titles… no government integration", `app/land-verification/components/honesty-block.tsx:11-28`); security page: "holds no compliance certifications today" (`app/security/page.tsx:174-177`).
- **Marketed-vs-real cross-check**: `/about` "Live in the product today" list (lines 88-99) maps to real OS-app surfaces (v1 API family, evidence/upload routes, attendance+USSD PIN, invoices/M-Pesa references, land module, notify module, AI routes flag-gated, SW offline sync, supplier portal/supply orders, `/api/v1/*` + openapi.json). Only wording flag: WD-3 "Escrow-style".

## 7. A11y + responsive basics (hero, pricing, forms)

Skip-link (`app/layout.tsx:82-87`); `nav aria-label` + `aria-current` on active links (`components/site-link.tsx:82`); mobile menu with `aria-expanded/controls` + Escape + scroll-lock (`components/navbar.tsx:25-36`); focus-visible rings on all buttons; `prefers-reduced-motion` kill-switch (`styles/globals.css:125-133`, `components/reveal.tsx:26-29`, `components/counter.tsx:36-39`); pricing FAQ accordion uses real buttons + `aria-expanded/controls` + labelled regions + `inert` collapsed panels (`app/pricing/components/faq-accordion.tsx:29-56`); form fields labelled with `htmlFor`, errors `role="alert"` + `aria-invalid` (`components/contact-form.tsx:108-160,221-226`); `sr-only "Status:"` in verification badges; ≥44px mobile targets; `min-w-0` overflow guards (`components/reveal.tsx:51-55`); hero/pricing/forms all `sm:`/`lg:` grid breakpoints. **Strong** — no findings.

## 8. Deployment

`mjengoos-website/Dockerfile`: multi-stage (bun:1 → node:20-slim deps `bun install --frozen-lockfile` → builder `next build` with the three `NEXT_PUBLIC_*` as **build ARGs**, defaults = integrated mode `/website` + `/` + empty SITE_URL) → runner node:20-slim, non-root `node`, **standalone** `output` (`next.config.ts:17`), `PORT=3001` EXPOSE, `CMD ["node","server.js"]`, `/app/data` writable for submissions. Compose: `website` service internal 3001 only behind the app's `/website/*` rewrite (`WEBSITE_ORIGIN=http://website:3001`), `website-data` volume, fetch-based healthcheck. `.dockerignore` excludes `.env*`/`data`/logs. Security headers (nosniff, referrer-policy, DNS-prefetch) via `next.config.ts:30-42`. All verified against DEPLOYMENT.md §6.5-6.6. CI has a dedicated `website-build` workflow job (DEPLOYMENT.md:220).

## 9. Findings

| ID | Sev | Finding | Evidence | Proposed issue title |
|----|-----|---------|----------|----------------------|
| WD-1 | MEDIUM | Contact endpoint's default (no-TRUST_PROXY) posture is ONE global 5/hour bucket for all visitors — a small lead burst 429s everyone; limit is in-memory (resets on restart); and submissions past the 500-cap are silently dropped. Fail-closed by design and documented, but during onboarding bursts real leads can be lost with no signal. | `app/api/contact/route.ts:51-83,223-227`; `.env.example:41-50` | "Contact form: shared 5/hr rate-limit bucket can 429 legitimate leads; add per-IP trusted-proxy guidance or queue overflow" |
| WD-2 | MEDIUM | Analytics sink unconfigured → in production the site collects **nothing** (no page views, no funnel events); `signup_started`/`signup_completed`/`hero_cta_clicked` all no-op. Launching paid acquisition without measurement. | `lib/analytics.ts:35,60-68`; `.env.example:29-32` | "Website: configure analytics collector (or remove dead event surface) before launch — zero traffic/funnel measurement today" |
| WD-3 | LOW | "Escrow-style milestone releases" (3 marketing spots) vs `/wallet` "There is no escrow custody" — hedged but tension-prone; app implements an ESCROW ledger account + approval gates, not custody. Suggest "approval-gated milestone releases". | `data/roles.ts:32`; `app/platform/components/module-grid.tsx:64-65`; `app/platform/components/approvals-deep-dive.tsx:20`; vs `app/wallet/components/honesty-band.tsx:26` | "Website copy: replace 'Escrow-style releases' with 'approval-gated releases' to match the not-a-bank disclosure" |
| WD-4 | LOW | `Button`/`not-found` use plain `next/link`, not `SiteLink` — drop the `?XTransformPort` gateway param in sandbox preview on hard navigation/refresh. Preview-env-only; production unaffected. — **FIXED 2026-09-25 via #139: `useGatewayPort` extracted to `lib/use-gateway-port.ts`; `Button` became a client component composing it with `withGatewayPort` (string hrefs only; UrlObject/external pass through); 404's plain `/platform` link became a `SiteLink`; `ActionButton` (form submits) untouched** | `components/button.tsx:39`; `app/not-found.tsx:26-31`; vs `components/site-link.tsx:36-59` | "Website: route CTA Button/not-found links through SiteLink to preserve gateway preview param" — done via #139 |
| WD-5 | LOW | `public/icons/icon-512.png` unreferenced (layout references only favicon + 192); SEO.md claims "192/512 PNGs"; no `manifest.webmanifest` for the website. | `app/layout.tsx:58-64`; `SEO.md:10`; `ls public/icons/` | "Website PWA basics: wire icon-512 + add manifest.webmanifest; fix SEO.md icon claim" |
| WD-6 | LOW | Sitemap `lastModified` is a frozen constant (2026-09-09) that must be hand-bumped per deploy; `changeFrequency: "monthly"` for all pages regardless of reality. | `app/sitemap.ts:10,49-51` | "Sitemap: automate/verify lastModified bump (stale since 2026-09-09)" |
| WD-11 | LOW | Backup guidance (DEPLOYMENT §7.2) covers SQLite + uploads volume but **not** the `website-data` leads volume (plaintext PII). | `DEPLOYMENT.md:450-463` vs `:280,309` | "Add website-data (submissions.json) to the documented backup set — it is leads/PII" |
| WD-7 | INFO | Signup form's role `<select>` has no client `required` (form is `noValidate`); server enforces and returns a field error — UX-only. | `components/contact-form.tsx:93,126-131`; `app/api/contact/route.ts:143-145` | — |
| WD-8 | INFO | Dead analytics event `demo_requested` in the Config union/type — no demo-request flow exists anymore. | `components/contact-form.tsx:23`; `lib/analytics.ts:25` | — |
| WD-9 | INFO | `NEXT_PUBLIC_SITE_URL` omitted at build → all absolute URLs fall back to `http://localhost:3001` (documented in Dockerfile/.env.example as MW-9; watch item for whoever deploys an indexed site). | `lib/site.ts:36`; `Dockerfile:60-67` | — |

**Contradictions vs prior QA report**: none material. Every §8 claim re-verified true. Nuances the prior report omitted: the single-bucket rate limit (WD-1), the analytics vacuum (WD-2), escrow-style wording (WD-3), leads volume absent from backup guidance (WD-11).

## Worklog entry (Task 2-c)

- Re-audited `mjengoos-website/**` read-only at `main @ 8b0003a`: enumerated all 19 `app/**/page.tsx` routes + `not-found.tsx` + `POST /api/contact` — all present and content-complete (classification: 19/19 WORKING; no missing or dead routes).
- Verified CTA/link graph: every internal `Button`/`SiteLink`/`NavLink`/footer href resolves; **zero external links** (only conditional `mailto:` behind `NEXT_PUBLIC_CONTACT_EMAIL`); "Sign in" (`app-link.tsx`) correctly targets the real OS app (env → localhost:3000 dev → same-origin `/`), no placeholder URLs.
- Confirmed the contact/signup forms submit to the real hardened `app/api/contact/route.ts`: Origin gate, 5/hr rate limit (TRUST_PROXY-aware), 16KB pre-parse body cap, honeypot, manual validation (no zod — regex + caps; adequate). Leads persist to gitignored `data/submissions.json` (500-cap); DEPLOYMENT §6.3 retrieval instructions verified accurate.
- SEO verified: per-page canonicals + metadata, 24-URL sitemap (19 routes incl. 6 slugs), robots disallow `/api/`, real 1200×630 OG image, basePath-aware absolute URLs; analytics is cookie/PII-free but **collects nothing in production** (WD-2, MEDIUM).
- Honesty sweep **passes**: zero traction/customer claims; AI consistently "pilot / opt-in / flag-gated / off by default"; USSD simulator and M-Pesa sandbox disclosed on 6+ pages; every product mockup carries the DemoChip; /about "live today" list cross-checks against real OS-app surfaces.
- Findings raised: WD-1 (MEDIUM, shared rate-limit bucket can 429 real leads + silent 500-cap drops), WD-2 (MEDIUM, no analytics sink), WD-3/4/5/6/11 (LOW: "escrow-style" wording vs not-a-bank band, Button drops gateway preview param, icon-512/manifest gap, frozen sitemap date, leads volume missing from backup guidance), WD-7/8/9 (INFO).
- Deployment verified: multi-stage Dockerfile → standalone non-root runner on :3001, build-ARG serving modes (integrated `/website` default / standalone domain), compose website service + `website-data` volume + healthcheck, CI `website-build` job.
- Deliverable written to `docs/audit/WEBSITE_BASELINE.md`; no existing files modified (READ-ONLY task).
