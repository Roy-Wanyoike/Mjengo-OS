# MjengoOS Website — SEO

## Metadata system

- **Root** (`app/layout.tsx`): `metadataBase` = `NEXT_PUBLIC_SITE_URL` **joined
  with the serving base path** (`NEXT_PUBLIC_BASE_PATH`, `/website` in
  integrated mode) — so canonicals and OG/Twitter images carry the
  `/website` prefix when the site is proxied. Icons and the manifest link
  are passed through verbatim by Next, so each goes through `asset()` for
  the same prefix. Title template `%s — MjengoOS`, site description,
  keywords, Open Graph (1200×630 `og.png`), Twitter card, robots
  `index,follow`, icons (favicon.ico + 192/512 PNGs via `asset()`),
  `manifest.webmanifest` (192+512 icons, theme `#123C32` over the paper
  `#f3f2ee` background, standalone display, relative `start_url`/`scope`/
  icon srcs so one file serves `/` and `/website` alike), themeColor
  `#123C32`
- **Per page**: every route exports `metadata` with `title`, `description`,
  and `alternates.canonical` (root-relative; resolved against metadataBase)
- **404**: `app/not-found.tsx` exports metadata (title + `noindex`)

## Search infrastructure

| File | Serves |
|---|---|
| `app/sitemap.ts` | `/sitemap.xml` — 24 routes with priorities (home 1.0, platform 0.9, signup 0.9 …). URLs = origin + basePath. `lastModified` is derived at build time (issue #143, audit WD-6), never hand-bumped: `SITEMAP_LAST_MODIFIED` override → last commit that touched the site (`git log -1 --format=%cI -- .`) → omitted entirely when neither is available. `changeFrequency` is removed — a uniform "monthly" claim was noise, and Google ignores the element |
| `app/robots.ts` | `/robots.txt` — allow all, disallow `/api/`, sitemap link (origin + basePath) |

**Deployment note:** `NEXT_PUBLIC_SITE_URL` is inlined at build time — a Docker
build must pass it as the `NEXT_PUBLIC_SITE_URL` build arg (see
`.env.example`), or every absolute URL falls back to `http://localhost:3001`.
Since issue #149 this is a launch gate, not a footnote: a production
**standalone** build (no base path) with no usable value prints a loud
`[site-url]` warning at build time, and DEPLOYMENT.md §6.7 carries the
"set it before serving an indexed site" launch checklist (integrated-mode
and dev builds stay silent by design).

**Sitemap date note:** `lastModified` is derived at build time — from the
last commit that touched `mjengoos-website/` when building inside a checkout,
or from the `SITEMAP_LAST_MODIFIED` build ARG in Docker (the repo's `.git` is
outside the image build context; the Dockerfile documents the one-line
`--build-arg` form). With neither available the sitemap omits `lastModified`
(honest absence) rather than stamp a made-up date.

## Structured data

- `/contact`: JSON-LD `ContactPage` (name + description)

## Target keywords (woven, not stuffed)

- construction management Kenya · construction project management
- construction software Africa · project monitoring
- land verification Kenya · construction procurement
- construction materials prices · construction project tracking
- contractor management

These appear naturally in page copy, headings and metadata — one strong
placement per page, no repetition stuffing.

## Verification

- Every route returns 200 with a unique `<title>` and canonical link
- `curl localhost:3001/sitemap.xml` lists all 24 routes; robots.txt disallows
  `/api/` (in integrated mode both live under `/website`)
- OG image `/images/og.png` is a real 1200×630 PNG (39KB)
- `curl localhost:3001/manifest.webmanifest` returns the manifest (in
  integrated mode: `/website/manifest.webmanifest`); its icon URLs are
  relative, so they resolve under either serving path — no 404s in the
  network log
- Semantic HTML throughout (one `h1` per page, hierarchical `h2/h3`,
  landmark regions, `section[aria-label]`)
