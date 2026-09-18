/**
 * Website sitemap — dynamically derived lastModified (issue #143 / audit
 * WD-6) + the origin+basePath URL contract (MW-9, regression-guarding
 * #82 / PR #91: "sitemap still emits 24 correct origin+basePath URLs").
 *
 * app/sitemap.ts is a static route generated at build time; since #143 its
 * lastModified is a derivation ladder instead of a hand-bumped constant.
 * This file pins that ladder against the REAL module (repo convention: the
 * marketing site's tests live in the root suite — vitest.config.ts aliases
 * `@/lib/site` to the site root, ADR 0003):
 *
 *   1. SITEMAP_LAST_MODIFIED (ISO date) wins when set — the Docker path:
 *      the repo's .git never enters the image build context, so the date is
 *      injected as the SITEMAP_LAST_MODIFIED build ARG instead.
 *   2. Otherwise the last commit touching the site (`git log -1
 *      --format=%cI -- .`) — truthful per deploy: the date only moves when
 *      the site's source changes, so a rebuild stamps nothing new (the old
 *      reason a bare build-time `new Date()` was rejected).
 *   3. Neither (no git metadata AND no override) → lastModified is OMITTED
 *      from every entry — an honest absence beats a rotting constant
 *      (Google treats lastmod as optional; a made-up date trains crawlers
 *      the field is noise, which was the bug).
 *
 * Also pinned: changeFrequency is gone (the uniform "monthly" claim was
 * noise Google ignores — #143 acceptance criteria), and the exact 24-URL
 * census with priorities in both integrated (/website basePath) and
 * standalone serving modes.
 *
 * The one impure seam, execSync, is mocked (same posture as the console
 * spies in website-contact-route.test.ts) so the ladder is exercised
 * hermetically — no dependence on the host's git state or ambient env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The mocked git probe's per-test answer (read at call time, not mock time).
let gitResult: string
let gitError: Error | null
let gitCommands: string[]

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execSync: (command: string) => {
      gitCommands.push(command)
      if (gitError) throw gitError
      return gitResult
    },
  }
})

const GIT_ISO = '2026-09-19T08:09:10Z'
const OVERRIDE_ISO = '2025-01-02T03:04:05Z'
const INTEGRATED_ORIGIN = 'https://mjengos.example/website'

/** The 24 paths in order — the #82 / PR #91 census, regression-guarded verbatim. */
const EXPECTED_PATHS = [
  '',
  '/platform',
  '/solutions',
  '/solutions/client',
  '/solutions/site-supervisors',
  '/solutions/contractors',
  '/solutions/professionals',
  '/solutions/suppliers',
  '/solutions/finance',
  '/land-verification',
  '/professionals',
  '/materials',
  '/marketplace',
  '/wallet',
  '/ai',
  '/projects',
  '/pricing',
  '/about',
  '/contact',
  '/signup',
  '/resources',
  '/security',
  '/privacy',
  '/terms',
]

const EXPECTED_PRIORITIES = [
  1.0, 0.9, 0.8, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.9, 0.8, 0.8, 0.8, 0.8, 0.8,
  0.8, 0.8, 0.6, 0.7, 0.9, 0.6, 0.6, 0.4, 0.4,
]

type Entry = { url: string; priority?: number; lastModified?: Date; changeFrequency?: string }

async function loadSitemap(): Promise<Entry[]> {
  vi.resetModules()
  const mod = await import('../../mjengoos-website/app/sitemap')
  return mod.default() as Entry[]
}

beforeEach(() => {
  gitResult = ''
  gitError = null
  gitCommands = []
  delete process.env.SITEMAP_LAST_MODIFIED
  delete process.env.NEXT_PUBLIC_SITE_URL
  delete process.env.NEXT_PUBLIC_BASE_PATH
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('website sitemap — lastModified derivation ladder (issue #143 / WD-6)', () => {
  it('derives the date from the last commit touching the site (git present, no override)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://mjengos.example')
    gitResult = `${GIT_ISO}\n`
    const entries = await loadSitemap()

    expect(gitCommands).toHaveLength(1)
    expect(gitCommands[0]).toContain('git log -1')
    expect(gitCommands[0]).toContain('-- .') // pathspec: the site subtree, not the whole repo
    expect(entries).toHaveLength(24)
    for (const entry of entries) {
      expect(entry.lastModified).toEqual(new Date(GIT_ISO))
    }
  })

  it('an empty git answer (no commits matched the pathspec) omits lastModified rather than guess', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://mjengos.example')
    gitResult = '\n'
    const entries = await loadSitemap()

    expect(entries).toHaveLength(24)
    for (const entry of entries) {
      expect('lastModified' in entry).toBe(false)
    }
  })

  it('SITEMAP_LAST_MODIFIED wins over git — the Docker build-ARG path', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://mjengos.example')
    vi.stubEnv('SITEMAP_LAST_MODIFIED', OVERRIDE_ISO)
    gitResult = `${GIT_ISO}\n`
    const entries = await loadSitemap()

    expect(gitCommands).toHaveLength(0) // the override short-circuits the git probe
    for (const entry of entries) {
      expect(entry.lastModified).toEqual(new Date(OVERRIDE_ISO))
    }
  })

  it('a set-but-unparseable override warns visibly, then falls back to git', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://mjengos.example')
    vi.stubEnv('SITEMAP_LAST_MODIFIED', 'yesterday-ish')
    gitResult = `${GIT_ISO}\n`
    const entries = await loadSitemap()

    for (const entry of entries) {
      expect(entry.lastModified).toEqual(new Date(GIT_ISO))
    }
    const msgs = warn.mock.calls.map((c) => c.join(' '))
    expect(msgs.some((m) => m.includes('SITEMAP_LAST_MODIFIED'))).toBe(true)
  })

  it('no git metadata and no override → lastModified omitted entirely (honest absence)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://mjengos.example')
    gitError = new Error('fatal: not a git repository (or any of the parent directories): .git')
    const entries = await loadSitemap()

    expect(entries).toHaveLength(24)
    for (const entry of entries) {
      expect('lastModified' in entry).toBe(false)
    }
  })

  it('changeFrequency is gone from every entry (uniform "monthly" was noise Google ignores)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://mjengos.example')
    gitResult = `${GIT_ISO}\n`
    const entries = await loadSitemap()

    for (const entry of entries) {
      expect('changeFrequency' in entry).toBe(false)
    }
  })
})

describe('website sitemap — URL contract (MW-9, regression-guard #82 / PR #91)', () => {
  it('integrated mode: 24 origin+basePath URLs — exact census, priorities, no double slashes', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://mjengos.example')
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/website')
    gitResult = `${GIT_ISO}\n`
    const entries = await loadSitemap()

    expect(entries.map((e) => e.url)).toEqual(EXPECTED_PATHS.map((p) => `${INTEGRATED_ORIGIN}${p}`))
    expect(entries[0].url).toBe(INTEGRATED_ORIGIN) // home = origin + basePath exactly, no trailing slash
    expect(new Set(entries.map((e) => e.url)).size).toBe(24)
    // No double slashes anywhere past the scheme (the MW-9 join is a plain concat)
    expect(entries.every((e) => !e.url.replace('https://', '').includes('//'))).toBe(true)
    expect(entries.map((e) => e.priority)).toEqual(EXPECTED_PRIORITIES)
  })

  it('standalone mode: bare-origin URLs, still the full 24-route census', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://site.example')
    gitResult = `${GIT_ISO}\n`
    const entries = await loadSitemap()

    expect(entries.map((e) => e.url)).toEqual(EXPECTED_PATHS.map((p) => `https://site.example${p}`))
    expect(entries[0].url).toBe('https://site.example')
    expect(entries).toHaveLength(24)
  })
})
