# MjengoOS Website — SEO

## Metadata system

- **Root** (`app/layout.tsx`): `metadataBase` from `NEXT_PUBLIC_SITE_URL`,
  title template `%s — MjengoOS`, site description, keywords, Open Graph
  (1200×630 `og.png`), Twitter card, robots `index,follow`, icons (favicon.ico
  + 192/512 PNGs), themeColor `#123C32`
- **Per page**: every route exports `metadata` with `title`, `description`,
  and `alternates.canonical` (absolute via metadataBase)

## Search infrastructure

| File | Serves |
|---|---|
| `app/sitemap.ts` | `/sitemap.xml` — 24 routes with priorities (home 1.0, platform 0.9, signup 0.9 …) |
| `app/robots.ts` | `/robots.txt` — allow all, disallow `/api/`, sitemap link |

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
  `/api/`
- OG image `/images/og.png` is a real 1200×630 PNG (39KB)
- Semantic HTML throughout (one `h1` per page, hierarchical `h2/h3`,
  landmark regions, `section[aria-label]`)
