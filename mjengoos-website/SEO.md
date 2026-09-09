# MjengoOS Website — SEO

## Metadata system

- **Root** (`app/layout.tsx`): `metadataBase` = `NEXT_PUBLIC_SITE_URL` **joined
  with the serving base path** (`NEXT_PUBLIC_BASE_PATH`, `/website` in
  integrated mode) — so canonicals, OG/Twitter images and icons carry the
  `/website` prefix when the site is proxied. Title template `%s — MjengoOS`,
  site description, keywords, Open Graph (1200×630 `og.png`), Twitter card,
  robots `index,follow`, icons (favicon.ico + 192/512 PNGs), themeColor
  `#123C32`
- **Per page**: every route exports `metadata` with `title`, `description`,
  and `alternates.canonical` (root-relative; resolved against metadataBase)
- **404**: `app/not-found.tsx` exports metadata (title + `noindex`)

## Search infrastructure

| File | Serves |
|---|---|
| `app/sitemap.ts` | `/sitemap.xml` — 24 routes with priorities (home 1.0, platform 0.9, signup 0.9 …). URLs = origin + basePath; `lastModified` is a fixed build-date constant (`SITE_LAST_MODIFIED`), bumped when page content actually changes |
| `app/robots.ts` | `/robots.txt` — allow all, disallow `/api/`, sitemap link (origin + basePath) |

**Deployment note:** `NEXT_PUBLIC_SITE_URL` is inlined at build time — a Docker
build must pass it as the `NEXT_PUBLIC_SITE_URL` build arg (see
`.env.example`), or every absolute URL falls back to `http://localhost:3001`.

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
- Semantic HTML throughout (one `h1` per page, hierarchical `h2/h3`,
  landmark regions, `section[aria-label]`)
