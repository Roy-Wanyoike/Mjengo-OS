/**
 * Website SITE_URL launch gate (issue #149 / audit WD-9). The site's
 * NEXT_PUBLIC_SITE_URL defaulting to the dev origin http://localhost:3001
 * was documented (Dockerfile, .env.example, SEO.md, lib/site.ts — MW-9) but
 * only as a footnote: whoever eventually deploys an INDEXED site had to
 * remember it. #149 promotes it to a launch gate. This file pins all three
 * layers against the REAL repo files (repo convention: the marketing site's
 * tests live in the root suite — vitest.config.ts aliases `@/lib/site` to
 * the site root, ADR 0003):
 *
 *  · the decision — lib/site.ts `siteUrlBuildWarning(env)` is pure on its
 *    env argument, so the whole matrix is pinned hermetically: it fires for
 *    the ONE combination that means "indexed site, localhost URLs"
 *    (production + standalone/no basePath + no usable SITE_URL — including
 *    a set-but-unparseable value, which normalizeOrigin silently falls back
 *    on exactly like an unset one) and stays silent everywhere else
 *    (integrated zero-override default = compose must build without noise;
 *    dev = localhost IS the honest dev origin; explicit localhost = an
 *    explicit operator choice, not a fallback);
 *  · the wiring — the REAL next.config.ts module is re-imported under
 *    stubbed env with a console spy (same posture as the execSync mock in
 *    website-sitemap.test.ts): the warning must come out of `next build`'s
 *    config load, not just exist as an unused function;
 *  · the docs truth — DEPLOYMENT.md §6.7 is the human launch checklist
 *    (the section a deployer actually reads, right after the §6.6 mode
 *    table), and SEO.md / .env.example / the Dockerfile stay in sync with
 *    the warning they describe. The issue's "build both modes" acceptance
 *    criterion is additionally drilled against real `next build` runs (see
 *    the PR description) — a unit test cannot run a compiler.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { siteUrlBuildWarning } from '@/lib/site'

const SITE_ROOT = fileURLToPath(new URL('../../mjengoos-website', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const NEXT_CONFIG_SRC = readFileSync(`${SITE_ROOT}/next.config.ts`, 'utf8')
const DEPLOYMENT_MD = readFileSync(`${REPO_ROOT}/DEPLOYMENT.md`, 'utf8')
const SEO_MD = readFileSync(`${SITE_ROOT}/SEO.md`, 'utf8')
const ENV_EXAMPLE = readFileSync(`${SITE_ROOT}/.env.example`, 'utf8')
const DOCKERFILE = readFileSync(`${SITE_ROOT}/Dockerfile`, 'utf8')

const STANDALONE_PROD = {
  NODE_ENV: 'production',
  NEXT_PUBLIC_BASE_PATH: undefined,
  NEXT_PUBLIC_SITE_URL: undefined,
}

// ---------------------------------------------- the decision (lib/site.ts)

describe('website siteUrlBuildWarning — the #149 decision matrix', () => {
  it('fires for THE combination: production + standalone + SITE_URL unset', () => {
    const warning = siteUrlBuildWarning(STANDALONE_PROD)

    expect(warning).not.toBeNull()
    expect(warning).toContain('[site-url]')
    expect(warning).toContain('NEXT_PUBLIC_SITE_URL not set')
  })

  it('fires when SITE_URL is set but unparseable — same silent fallback, same disaster', () => {
    // normalizeOrigin falls back on an unparseable value exactly like an
    // unset one, so the gate must treat it as unset (and say which value).
    const warning = siteUrlBuildWarning({
      ...STANDALONE_PROD,
      NEXT_PUBLIC_SITE_URL: 'yourdomain.example',
    })

    expect(warning).not.toBeNull()
    expect(warning).toContain('set to "yourdomain.example"')
    expect(warning).toContain('not a parseable absolute URL')
  })

  it('a whitespace-only SITE_URL counts as unset (trim parity with the fallback)', () => {
    const warning = siteUrlBuildWarning({
      ...STANDALONE_PROD,
      NEXT_PUBLIC_SITE_URL: '   ',
    })

    expect(warning).not.toBeNull()
    expect(warning).toContain('NEXT_PUBLIC_SITE_URL not set')
  })

  it('a whitespace-only base path counts as standalone (trim parity with normalizeBasePath)', () => {
    const warning = siteUrlBuildWarning({
      ...STANDALONE_PROD,
      NEXT_PUBLIC_BASE_PATH: '   ',
    })

    expect(warning).not.toBeNull()
  })

  it('silent when a usable SITE_URL is baked (standalone production build)', () => {
    expect(
      siteUrlBuildWarning({
        ...STANDALONE_PROD,
        NEXT_PUBLIC_SITE_URL: 'https://yourdomain.example',
      }),
    ).toBeNull()
    // Trailing slashes are stripped by the same trim normalizeOrigin applies.
    expect(
      siteUrlBuildWarning({
        ...STANDALONE_PROD,
        NEXT_PUBLIC_SITE_URL: 'https://yourdomain.example/',
      }),
    ).toBeNull()
  })

  it('silent for the integrated zero-override default — compose must build without noise (AC #3)', () => {
    // basePath set + SITE_URL empty + production: exactly what the Docker
    // builder stage bakes for `docker compose up` with no overrides.
    expect(
      siteUrlBuildWarning({
        NODE_ENV: 'production',
        NEXT_PUBLIC_BASE_PATH: '/website',
        NEXT_PUBLIC_SITE_URL: undefined,
      }),
    ).toBeNull()
  })

  it('a base path without the leading slash still counts as integrated', () => {
    // normalizeBasePath("website") → "/website" — same mode, same silence.
    expect(
      siteUrlBuildWarning({
        NODE_ENV: 'production',
        NEXT_PUBLIC_BASE_PATH: 'website',
        NEXT_PUBLIC_SITE_URL: undefined,
      }),
    ).toBeNull()
  })

  it('silent outside production — localhost IS the honest dev origin', () => {
    for (const nodeEnv of ['development', 'test', undefined]) {
      expect(siteUrlBuildWarning({ NODE_ENV: nodeEnv })).toBeNull()
    }
  })

  it('an explicit localhost SITE_URL is an explicit operator choice, not a fallback — silent', () => {
    // "http://localhost:3001" parses, so the origin is deliberately chosen
    // (e.g. an internal-only build); the gate watches the FALLBACK, and this
    // is not it. It still builds, still serves, and §6.7's sitemap curl
    // check is where an accidental localhost would be caught.
    expect(
      siteUrlBuildWarning({
        ...STANDALONE_PROD,
        NEXT_PUBLIC_SITE_URL: 'http://localhost:3001',
      }),
    ).toBeNull()
  })

  it('the message states the failure mode and the fix, and points at the launch gate', () => {
    const warning = siteUrlBuildWarning(STANDALONE_PROD)!

    // What breaks (the absolute-URL surface)…
    for (const fragment of ['sitemap.xml', 'canonicals', 'OG/Twitter', 'JSON-LD']) {
      expect(warning).toContain(fragment)
    }
    // …the concrete failure mode (crawlers told the real pages are localhost)…
    expect(warning).toContain('http://localhost:3001')
    expect(warning).toContain('localhost')
    // …and the fix: the build arg + the DEPLOYMENT.md launch gate, whose
    // section number must keep resolving (pinned against the real doc below).
    expect(warning).toContain('--build-arg NEXT_PUBLIC_SITE_URL=https://yourdomain.example')
    expect(warning).toContain('DEPLOYMENT.md §6.7')
    // Integrated + dev silence is part of the contract, so say so.
    expect(warning).toContain('stay silent by design')
  })
})

// ------------------------------------- the wiring (real next.config.ts)

describe('website next.config.ts — the warning is wired into next build (#149)', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SITE_URL
    delete process.env.NEXT_PUBLIC_BASE_PATH
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  /** Fresh evaluation of the REAL config module under a stubbed env. */
  async function loadNextConfig() {
    vi.resetModules()
    return import('../../mjengoos-website/next.config')
  }

  it('console.warns through the real config module for the risky combination', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('NODE_ENV', 'production')
    // SITE_URL and BASE_PATH stay unset (standalone, no origin).

    const config = await loadNextConfig()

    expect(config.default).toBeTruthy() // the module still exports a config
    const siteUrlCalls = warn.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('[site-url]'))
    expect(siteUrlCalls).toHaveLength(1)
    expect(siteUrlCalls[0]).toContain('NEXT_PUBLIC_SITE_URL not set')
  })

  it('the real config module stays silent when a usable SITE_URL is baked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://yourdomain.example')

    await loadNextConfig()

    expect(warn.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('[site-url]'))).toEqual([])
  })

  it('the real config module stays silent for the integrated default (compose posture)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/website')

    await loadNextConfig()

    expect(warn.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('[site-url]'))).toEqual([])
  })

  it('sources the decision from lib/site instead of re-implementing it (no drift)', () => {
    expect(NEXT_CONFIG_SRC).toContain('from "./lib/site"')
    expect(NEXT_CONFIG_SRC).toContain('siteUrlBuildWarning(process.env)')
  })
})

// ------------------------------------------ the docs truth (#149, AC #1)

describe('website launch-gate docs — the section a deployer actually reads', () => {
  it('DEPLOYMENT.md §6.7 carries the launch checklist with the failure mode spelled out', () => {
    // The gate sits directly after the §6.6 mode table — the website
    // deployer's path through the doc — under an unmissable title.
    expect(DEPLOYMENT_MD).toContain(
      '### 6.7 Website launch gate — SITE_URL before an indexed site (issue #149)',
    )
    // The checklist line itself: SET it, at BUILD time, to the browsed-at
    // origin — with the rebuild-not-re-run nuance that bites NEXT_PUBLIC_*.
    expect(DEPLOYMENT_MD).toContain('`NEXT_PUBLIC_SITE_URL` is set at **build** time')
    expect(DEPLOYMENT_MD).toContain('rebuilding the image')
    // The failure mode, spelled out (not just "set the var").
    expect(DEPLOYMENT_MD).toContain('tell crawlers the real')
    // Verify-the-bake step: check the artifact, not the intention.
    expect(DEPLOYMENT_MD).toContain('curl https://yourdomain.example/sitemap.xml')
    // The build-time backstop is documented next to the checklist.
    expect(DEPLOYMENT_MD).toContain('`[site-url]`')
  })

  it('SEO.md — the deployment note now names the gate, not just the fallback', () => {
    // Pre-#149 the note only warned about the fallback; it must now point
    // at the warning + checklist that enforce it.
    expect(SEO_MD).toContain('launch gate, not a footnote')
    expect(SEO_MD).toContain('`[site-url]`')
    expect(SEO_MD).toContain('DEPLOYMENT.md §6.7')
  })

  it('.env.example points at the launch gate from the variable it documents', () => {
    expect(ENV_EXAMPLE).toContain('Launch gate (issue #149)')
    expect(ENV_EXAMPLE).toContain('DEPLOYMENT.md §6.7')
  })

  it('the Dockerfile builder notes where the warning will appear', () => {
    expect(DOCKERFILE).toContain('[site-url]')
    expect(DOCKERFILE).toContain('stays silent by design')
  })

  it('the §6.7 the warning text cites is a real DEPLOYMENT.md section (no dangling pointer)', () => {
    // The warning message hard-cites "DEPLOYMENT.md §6.7" — pin that the
    // heading exists so the citation can never rot into a dead reference.
    expect(DEPLOYMENT_MD).toMatch(/^### 6\.7 /m)
  })
})
