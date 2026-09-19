/**
 * Issue #185 (audit register TEST-4) — coverage tooling fences.
 *
 * `bun run test:coverage` is a config, not code, so its contract can regress
 * the quiet way: a threshold glob silently deleted in a merge conflict, a
 * script renamed, a CI artifact step dropped, the docs drifting from the
 * config. This suite pins every load-bearing piece of the #185 contract:
 *
 *   · vitest.config.mts LOADS (the suite imports it — a syntax/shape error
 *     in the config fails here, not only at coverage time) and carries the
 *     exact coverage block the issue demands: provider v8, reporters
 *     [text, lcov], include scoped to the src/** TypeScript sources, the
 *     generated ui/ scaffolding excluded;
 *   · THE FLOOR SET IS EXPLICIT — the threshold globs in the config must
 *     equal the documented critical-module list below (money path,
 *     sync/outbox core, guard/auth seams), every floor has both lines and
 *     branches, and there is NO repo-wide floor (the ui/app-router surface
 *     would make one noise — measured 50.01/38.08 on main @b035c74);
 *   · GLOB ROT FAILS LOUDLY — every threshold glob must match at least one
 *     real file under src/ (vitest summarizes an empty group to 0% and fails
 *     the run; this fence catches the rename/move at plain `bun run test`
 *     time, without paying the coverage runtime);
 *   · the script exists and is exactly `vitest run --coverage`, with the
 *     provider installed as a devDependency next to vitest itself;
 *   · CI runs the coverage variant and uploads the report (test.yml);
 *   · the docs that must explain it (README, CONTRIBUTING) still do.
 *
 * Changing the floor set is a ONE-FILE-PLUS-THIS-FILE edit, exactly like the
 * finance gate's gate-files.ts: the point is not to forbid change, it is to
 * make unconscious change impossible.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import picomatch from 'picomatch'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The #185 critical-module floor set (measure-first on main @b035c74, 143
 * files / 3,159 tests — measured values in the vitest.config.mts table).
 * Keep in sync with the config's `coverage.thresholds` — the set-equality
 * tests below fail both ways (floor added to the config without a home
 * here, or removed there while still documented here).
 */
const CRITICAL_THRESHOLD_GLOBS = [
  // money path (issue: wallet/ledger/supply "at minimum")
  'src/backend/modules/wallet/**',
  'src/backend/modules/ledger/**',
  'src/backend/modules/supply/**',
  'src/backend/modules/invoices/**',
  'src/backend/lib/money*.ts',
  'src/backend/lib/idempotency.ts',
  // sync / outbox core
  'src/backend/api/sync.ts',
  'src/frontend/lib/outbox.ts',
  // guard / auth seams
  'src/backend/lib/guard.ts',
  'src/backend/lib/auth.ts',
  'src/backend/lib/next-auth-guard.ts',
  'src/backend/lib/membership-scope.ts',
  'src/shared/permissions.ts',
] as const

/** vitest reserves these keys for GLOBAL thresholds + options — a floor-set
 * config must use none of them (no repo-wide floor, no autoUpdate). */
const RESERVED_THRESHOLD_KEYS = [
  'branches',
  'functions',
  'lines',
  'statements',
  'perFile',
  'autoUpdate',
  '100',
]

/** All files under src/ as repo-relative POSIX paths (threshold glob space). */
function walkSrc(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(relative(REPO_ROOT, full).split(sep).join('/'))
    }
  }
  walk(join(REPO_ROOT, 'src'))
  return out
}

const srcFiles = walkSrc()

/** Whitespace-flattened text (line-wrap-proof prose pins, 28-b convention). */
const flat = (p: string) =>
  readFileSync(join(REPO_ROOT, p), 'utf8').replace(/\s+/g, ' ')

describe('issue #185 — vitest coverage config', () => {
  it('vitest.config.mts loads and carries the coverage block', async () => {
    const base = (await import('../../vitest.config.mts')).default
    expect(base.test).toBeTruthy()
    const cov = (base.test as { coverage?: Record<string, unknown> }).coverage
    expect(cov, 'coverage block present in vitest.config.mts').toBeTruthy()
    expect(cov!.provider).toBe('v8')
    expect(cov!.reporter).toEqual(['text', 'lcov'])
    expect(cov!.include).toEqual(['src/**/*.{ts,tsx}'])
    expect(cov!.exclude).toEqual(['src/frontend/ui/**'])
  })

  it('the include glob matches every TS source under src/ (and the css/markdown files are not in scope)', () => {
    const isMatch = picomatch('src/**/*.{ts,tsx}')
    const tsFiles = srcFiles.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    expect(tsFiles.length).toBeGreaterThan(300)
    expect(srcFiles.filter((f) => isMatch(f)).length).toBe(tsFiles.length)
    // the five non-source files under src/ (globals.css + four READMEs) stay
    // out — they parse-fail noisily as coverage inputs and mean nothing
    expect(srcFiles.filter((f) => !isMatch(f))).toEqual([
      'src/app/globals.css',
      'src/backend/README.md',
      'src/frontend/README.md',
      'src/mobile/README.md',
      'src/shared/README.md',
    ])
  })

  it('the ui/ exclusion and the include glob both match real files (no rot)', () => {
    const uiFiles = srcFiles.filter((f) =>
      picomatch('src/frontend/ui/**')(f),
    )
    expect(uiFiles.length, 'generated ui/ scaffolding exists to exclude').toBeGreaterThan(10)
    const srcMatched = srcFiles.filter((f) => picomatch('src/**')(f))
    expect(srcMatched.length).toBe(srcFiles.length)
  })

  it('threshold globs are exactly the documented critical-module set', async () => {
    const base = (await import('../../vitest.config.mts')).default
    const cov = (base.test as { coverage?: { thresholds?: Record<string, unknown> } }).coverage
    const thresholds = cov!.thresholds!
    const globKeys = Object.keys(thresholds).filter(
      (k) => !RESERVED_THRESHOLD_KEYS.includes(k),
    )
    expect(new Set(globKeys)).toEqual(new Set([...CRITICAL_THRESHOLD_GLOBS]))
  })

  it('every floor sets both lines and branches, within 0..100', async () => {
    const base = (await import('../../vitest.config.mts')).default
    const cov = (base.test as { coverage?: { thresholds?: Record<string, unknown> } }).coverage
    const thresholds = cov!.thresholds!
    for (const glob of CRITICAL_THRESHOLD_GLOBS) {
      const t = thresholds[glob] as { lines?: number; branches?: number }
      expect(t, `floor entry for ${glob}`).toBeTruthy()
      expect(Number.isFinite(t.lines)).toBe(true)
      expect(Number.isFinite(t.branches)).toBe(true)
      expect(t.lines!).toBeGreaterThan(0)
      expect(t.branches!).toBeGreaterThan(0)
      expect(t.lines!).toBeLessThanOrEqual(100)
      expect(t.branches!).toBeLessThanOrEqual(100)
    }
  })

  it('no global (repo-wide) threshold and no autoUpdate — floors are reviewed edits', async () => {
    const base = (await import('../../vitest.config.mts')).default
    const cov = (base.test as { coverage?: { thresholds?: Record<string, unknown> } }).coverage
    const thresholds = cov!.thresholds!
    for (const key of RESERVED_THRESHOLD_KEYS) {
      expect(
        thresholds[key],
        `thresholds.${key} must stay unset (per-module floors only, ${key === 'autoUpdate' ? 'ratchet is a conscious PR edit' : 'no repo-wide floor'})`,
      ).toBeUndefined()
    }
  })

  it('GLOB ROT FENCE: every threshold glob matches at least one real src/ file', () => {
    for (const glob of CRITICAL_THRESHOLD_GLOBS) {
      const isMatch = picomatch(glob)
      const matched = srcFiles.filter((f) => isMatch(f))
      expect(
        matched.length,
        `threshold glob ${glob} matches real files (vitest summarizes an empty group to 0% and fails the coverage run)`,
      ).toBeGreaterThan(0)
    }
  })

  it('package.json: test:coverage script + coverage provider devDependency', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['test:coverage']).toBe('vitest run --coverage')
    expect(pkg.devDependencies['@vitest/coverage-v8']).toBeTruthy()
    expect(pkg.devDependencies['vitest']).toBeTruthy()
  })

  it('the coverage provider is installed in node_modules (not just declared)', () => {
    expect(
      existsSync(join(REPO_ROOT, 'node_modules/@vitest/coverage-v8/package.json')),
      '@vitest/coverage-v8 installed — plain `bun run test` keeps working without it, but test:coverage needs it',
    ).toBe(true)
  })

  it('test.yml runs the coverage variant and uploads the report artifact', () => {
    const wf = flat('.github/workflows/test.yml')
    expect(wf).toContain('bun run test:coverage')
    expect(wf).toContain('actions/upload-artifact')
    expect(wf).toContain('path: coverage/')
    expect(wf).toContain('if-no-files-found: warn')
    expect(wf).toContain('if: always()')
  })

  it('coverage/ output is gitignored (reports are artifacts, never commits)', () => {
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')
    expect(gitignore).toMatch(/^\/coverage$/m)
  })
})

describe('issue #185 — coverage documentation stays in sync', () => {
  it('CONTRIBUTING explains how to run it and the ratchet convention', () => {
    const doc = flat('CONTRIBUTING.md')
    expect(doc).toContain('bun run test:coverage')
    expect(doc).toContain('ratchet')
    expect(doc.toLowerCase()).toContain('coverage floor')
  })

  it('README documents the coverage run and the floor scope', () => {
    const doc = flat('README.md')
    expect(doc).toContain('bun run test:coverage')
    expect(doc).toContain('coverage floor')
    // the honest-scope statement: floors are critical-module only
    expect(doc).toContain('money path')
  })
})
