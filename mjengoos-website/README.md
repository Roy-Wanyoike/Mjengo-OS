# MjengoOS — Marketing Website

The marketing site for **MjengoOS** — *Build with evidence.*

An independent Next.js application, completely isolated from the main MjengoOS
product (which lives in the repository root). It shares the repo but nothing
else: its own `package.json`, config, dependencies and dev-server port.

---

## Quick start

```bash
cd mjengoos-website
bun install            # once
cp .env.example .env   # recommended — sets NEXT_PUBLIC_BASE_PATH=/website
bun run dev            # http://localhost:3001/website
```

> The web app (repo root, port 3000) proxies `/website/*` here, so the
> site is best previewed at **`http://localhost:3000/website`** — one origin
> for the whole product. The website server must be running for that path
> to respond.

**Serving modes:** the sandbox runs this site in production mode
(`bun run build` once, then `bun run start` — ~180 MB RAM) because two
Turbopack *dev* servers exceed the box's 3.9 GB and the OOM killer reaps
them (that is what kept taking the site and app down). After editing
website files: rebuild and restart — and kill the old server **by port**
(`ss -tlnp | grep :3001` → kill that PID; the process renames itself to
`next-server`, so `pkill -f "next start"` misses it and leaves a stale
manifest serving 500s).

Production build (uses the repo-standard standalone flow):

```bash
bun run build          # next build
bun run start          # next start -p 3001
```

Quality gates:

```bash
bun run lint           # eslint — 0 errors, 0 warnings required
bun run typecheck      # tsc --noEmit — 0 errors required
```

> The main MjengoOS application keeps running on port **3000** — nothing in
> this folder touches it.

---

## Environment variables

All optional — the site runs with none set.

| Variable | Purpose | Default |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for SEO metadata + sitemap | `http://localhost:3001` |
| `NEXT_PUBLIC_BASE_PATH` | Serve the site under a prefix (integrated mode: proxied by the web app at `/website`) | unset (standalone) |
| `NEXT_PUBLIC_APP_URL` | Where "Sign in" points (the MjengoOS app) | auto: `http://localhost:3000` when the site itself is served from localhost:3001, otherwise `/` (same-origin gateway) |
| `NEXT_PUBLIC_ANALYTICS_ENDPOINT` | Optional analytics sink — tracked events are POSTed here as JSON via `sendBeacon` | unset → dev-only console logging |

## Sign-in behavior (website → web app connection)

The navbar **Sign in** button resolves its target at click time:

1. `NEXT_PUBLIC_APP_URL` if set (standalone deployments).
2. `http://localhost:3000` when the website itself is browsed directly from
   local dev (`localhost:3001`) — the web app's dev server.
3. Otherwise the bare `/` — in the integrated mode the website is proxied by
   the web app at `/website`, so `/` IS the web app's login screen: same
   origin, same session cookie domain. The login screen links back to
   `/website`, closing the loop.

### Why the proxy (and not `?XTransformPort` browsing)

The single-origin preview gateway reliably serves only the default route
(port 3000). Requesting a second app's pages via the `XTransformPort` query
parameter loads the HTML, but the browser then requests that app's
`/_next/*` assets **without** the parameter — the gateway routes those to
the default app and they fail, leaving an unstyled, non-hydrated page.
Proxying `/website/*` through the web app (rewrites in the root
`next.config.ts` + `basePath` here) keeps every request on one origin, so
pages, assets, hydration and the website's own API all work.

The analytics layer is **provider-agnostic by design**: no vendor SDK, no
cookies, no PII. See `lib/analytics.ts` for the event list.

---

## Architecture

```text
mjengoos-website/
├── app/                  Next.js App Router pages
│   ├── page.tsx          Homepage — 17 composed sections
│   ├── layout.tsx        Root layout: fonts, metadata, navbar/footer, analytics
│   ├── (14 route dirs)   platform, solutions/[slug], land-verification,
│   │                     professionals, materials, marketplace, wallet, ai,
│   │                     projects, pricing, about, contact, signup,
│   │                     resources, security, privacy, terms
│   ├── api/contact/      Form endpoint: validation + rate limit + JSON store
│   ├── sitemap.ts        24-route sitemap.xml
│   ├── robots.ts         robots.txt
│   └── not-found.tsx     404 page
├── components/           Shared design-system components (button, badge,
│   │                     navbar, footer, reveal, counter, page-hero, …)
│   └── product/          Product mockups (hero dashboard)
├── sections/             Homepage sections (one file per section)
├── lib/                  utils, site config, analytics abstraction
├── data/                 nav, roles, pricing content
├── types/                shared TypeScript types
├── styles/globals.css    design tokens + reveal system + map motifs
└── public/               images (real, optimized), icons, favicon
```

**Composition model**: the homepage is assembled from self-contained section
components in `sections/`; subpages reuse `PageHero`/`PageSection` scaffolding
plus colocated components in each route folder.

**Design system**: documented in [`DESIGN_SYSTEM.md`](./DESIGN_SYSTEM.md).
SEO: documented in [`SEO.md`](./SEO.md).

### The gateway-port quirk (sandbox preview)

In this sandbox, a Caddy gateway proxies a single public port. Requests
carrying `?XTransformPort=3001` are routed to this website; the bare `/`
goes to the main app on port 3000. All internal links use `SiteLink`, which
transparently preserves the `XTransformPort` query parameter across
navigation (via `useSyncExternalStore`, hydration-safe). Standalone
deployments are unaffected.

### Integration with the main application

The website is a **frontend-only** consumer of public information. The only
backend surface is its own `/api/contact` route (submissions stored in
`data/submissions.json` — gitignored runtime data). "Sign in" links point to
the app via `NEXT_PUBLIC_APP_URL`. No database, no auth, no SDK usage.

---

## Deployment

Any Node host or container:

```bash
bun install
bun run build
bun run start   # port 3001 — front with nginx/Caddy/CDN as desired
```

Set `NEXT_PUBLIC_SITE_URL` to the public origin and `NEXT_PUBLIC_APP_URL`
to the app's public origin (e.g. `https://app.mjengoos.com`).

---

## Content principles

- **Honesty over hype** — no fake testimonials, no invented statistics, no
  fake customers, no certification claims. Every demo UI carries an
  "Example · Demo data" chip.
- **Verification language is precise** — submitted / reviewed / professionally
  verified / officially verified are never conflated; MjengoOS never claims
  government verification.
- **AI is advisory** — every AI path ends in human review; copy says so.
- **Not-a-bank** — wallet copy states plainly that MjengoOS records payments;
  it does not hold money.
