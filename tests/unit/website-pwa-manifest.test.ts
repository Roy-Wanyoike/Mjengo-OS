/**
 * Website PWA basics (issue #142 / audit WD-5). The marketing site shipped
 * public/icons/icon-512.png with nothing referencing it, no
 * manifest.webmanifest, and SEO.md claiming "icons (favicon.ico + 192/512
 * PNGs)" — three small gaps in one place. This file pins the WIRE decision
 * (the issue's recommended path) against the REAL files:
 *
 *  · manifest.webmanifest reality — parse the actual public/ file: site
 *    identity matches lib/site.ts (no drift between the static manifest and
 *    the site config), theme_color === the layout's viewport themeColor,
 *    background_color === the paper token from globals.css, standalone
 *    display, and RELATIVE start_url/scope/icon srcs — the one-file-both-
 *    modes property that lets the same manifest serve `/` (standalone) and
 *    `/website` (integrated) without a build-time bake;
 *  · integrated-mode icon resolution — every manifest icon src, resolved
 *    against BOTH a root manifest URL and a /website manifest URL (how the
 *    browser resolves them), strips the serving prefix and lands on a REAL
 *    file in public/ — the "no icon-512.png reference regressions in
 *    integrated /website mode" acceptance criterion, proven from the repo
 *    files rather than a live server;
 *  · layout wiring — metadata.manifest and every icon href go through
 *    asset() because Next passes manifest/icon hrefs through VERBATIM (only
 *    canonicals/OG/Twitter get the metadataBase pathname join — verified
 *    against next@16.1.1's resolve-metadata.js: icons hit resolveIcons,
 *    manifest hits convertUrlsToStrings, neither joins). A bare
 *    "/manifest.webmanifest" in integrated mode would point at the OS
 *    app's OWN root manifest (id "/") — the wrong app's install metadata;
 *  · the icon PNGs are real PNGs at their declared sizes (IHDR parse);
 *  · SEO.md tells the truth — the manifest + 512 story it now documents
 *    instead of the pre-#142 "192/512 PNGs" claim that drifted from reality.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SITE } from '@/lib/site'

const SITE_ROOT = fileURLToPath(new URL('../../mjengoos-website', import.meta.url))
const PUBLIC_ROOT = `${SITE_ROOT}/public`

const MANIFEST = JSON.parse(
  readFileSync(`${PUBLIC_ROOT}/manifest.webmanifest`, 'utf8'),
) as {
  name: string
  short_name: string
  description: string
  id: string
  lang: string
  start_url: string
  scope: string
  display: string
  background_color: string
  theme_color: string
  icons: { src: string; sizes: string; type: string; purpose: string }[]
}
const LAYOUT_SRC = readFileSync(`${SITE_ROOT}/app/layout.tsx`, 'utf8')
const GLOBALS_CSS = readFileSync(`${SITE_ROOT}/styles/globals.css`, 'utf8')
const SEO_MD = readFileSync(`${SITE_ROOT}/SEO.md`, 'utf8')

/** PNG IHDR dimensions (bytes 16..24, big-endian) after the 8-byte signature. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a') // PNG signature
  expect(buf.readUInt32BE(8)).toBe(13) // IHDR chunk length
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// ---------------------------------------------- manifest.webmanifest (#142)

describe('website public/manifest.webmanifest — installable, mode-agnostic (#142)', () => {
  it('declares the site identity and matches lib/site.ts (no drift)', () => {
    expect(MANIFEST.short_name).toBe('MjengoOS')
    expect(MANIFEST.name).toBe('MjengoOS — Build with evidence.')
    // The manifest is a static file; SITE.description is the single source of
    // truth for the site's description — they must never diverge silently.
    expect(MANIFEST.description).toBe(SITE.description)
    expect(MANIFEST.lang).toBe('en')
  })

  it('pins theme_color to the layout viewport themeColor and background to the paper token', () => {
    // AC: theme color matches viewport.themeColor #123C32 (forest-800).
    expect(MANIFEST.theme_color).toBe('#123C32')
    expect(LAYOUT_SRC).toContain('themeColor: "#123C32"')
    // Splash background = the site's paper page background, straight from
    // globals.css — not a hand-copied hex that can drift.
    const paper = GLOBALS_CSS.match(/--color-paper:\s*(#[0-9a-fA-F]{6})/)
    expect(paper).not.toBeNull()
    expect(MANIFEST.background_color).toBe(paper![1].toLowerCase())
  })

  it('uses RELATIVE start_url/scope/id — one manifest serves / and /website', () => {
    // Relative members resolve against the manifest's own URL, so the same
    // static file is correct for a standalone deployment (manifest at
    // /manifest.webmanifest, scope /) AND integrated mode (at
    // /website/manifest.webmanifest, scope /website/ — never the OS app's
    // root). Absolute values here would only ever be right for one mode.
    expect(MANIFEST.start_url).toBe('./')
    expect(MANIFEST.scope).toBe('./')
    expect(MANIFEST.id).toBe('./')
    expect(MANIFEST.display).toBe('standalone')
  })

  it('declares exactly the 192 and 512 icons with relative srcs', () => {
    expect(MANIFEST.icons).toHaveLength(2)
    const bySize = Object.fromEntries(MANIFEST.icons.map((i) => [i.sizes, i]))
    expect(bySize['192x192']).toMatchObject({
      src: 'icons/icon-192.png',
      type: 'image/png',
      purpose: 'any',
    })
    expect(bySize['512x512']).toMatchObject({
      src: 'icons/icon-512.png',
      type: 'image/png',
      purpose: 'any',
    })
    for (const icon of MANIFEST.icons) expect(icon.src.startsWith('/')).toBe(false)
  })

  it('every icon src resolves to a REAL public file under BOTH serving paths', () => {
    // How browsers resolve manifest members: URL-parse src against the
    // manifest URL. Standalone: manifest at the root. Integrated: under
    // /website (the OS app proxies /website/* to the site verbatim). Both
    // must strip back to the same physical file in public/.
    for (const manifestUrl of [
      'https://site.example.com/manifest.webmanifest',
      'https://app.example.com/website/manifest.webmanifest',
    ]) {
      for (const icon of MANIFEST.icons) {
        const resolved = new URL(icon.src, manifestUrl).pathname
        const physical = resolved.replace(/^\/website/, '')
        expect(readFileSync(`${PUBLIC_ROOT}${physical}`).length).toBeGreaterThan(0)
      }
    }
  })
})

// ---------------------------------------------- layout wiring (#142)

describe('website app/layout.tsx — manifest + icons wired through asset() (#142)', () => {
  it('sets metadata.manifest basePath-aware', () => {
    // Next emits the manifest href VERBATIM (no metadataBase join), so a bare
    // "/manifest.webmanifest" under /website would fetch the OS app's own
    // root manifest. asset() carries the serving prefix; standalone (""
    // basePath) keeps the bare path byte-identical to the pre-#142 icons.
    expect(LAYOUT_SRC).toContain('manifest: asset("/manifest.webmanifest")')
  })

  it('references favicon, 192 AND 512 icons through asset()', () => {
    expect(LAYOUT_SRC).toContain('url: asset("/favicon.ico"), sizes: "48x48"')
    expect(LAYOUT_SRC).toContain('url: asset("/icons/icon-192.png"), sizes: "192x192", type: "image/png"')
    expect(LAYOUT_SRC).toContain('url: asset("/icons/icon-512.png"), sizes: "512x512", type: "image/png"')
    expect(LAYOUT_SRC).toContain(
      'apple: [{ url: asset("/icons/icon-192.png"), sizes: "192x192", type: "image/png" }]',
    )
    // No icon href may bypass asset(): every "/icons/…" and the manifest path
    // appear exactly once more OUTSIDE the asset() call sites than inside —
    // simpler: no unprefixed literal remains anywhere in the metadata block.
    const bare = LAYOUT_SRC.match(/url: "\/(?:favicon\.ico|icons\/[^"]+)"/g) ?? []
    expect(bare).toEqual([])
  })
})

// ---------------------------------------------- the icon files are real

describe('website public/icons — real PNGs at the declared sizes', () => {
  it('icon-192.png is a 192×192 PNG and icon-512.png a 512×512 PNG', () => {
    const sizes = pngSize(readFileSync(`${PUBLIC_ROOT}/icons/icon-192.png`))
    expect(sizes).toEqual({ width: 192, height: 192 })
    const big = pngSize(readFileSync(`${PUBLIC_ROOT}/icons/icon-512.png`))
    expect(big).toEqual({ width: 512, height: 512 })
  })
})

// ---------------------------------------------- SEO.md truth (#142)

describe('website SEO.md — icon/manifest story matches reality', () => {
  it('documents the manifest and the full favicon/192/512 icon set', () => {
    // Pre-#142 drift: "icons (favicon.ico + 192/512 PNGs)" while the 512 was
    // referenced by nothing and no manifest existed. The doc now names both.
    expect(SEO_MD).toContain('manifest.webmanifest')
    expect(SEO_MD).toContain('favicon.ico + 192/512 PNGs')
    expect(SEO_MD).toContain('#123C32')
  })

  it('documents the asset() story for icons/manifest (Next passes them verbatim)', () => {
    expect(SEO_MD).toContain('asset()')
  })
})
