import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration — starter suite (Task 5-e).
 *
 *  · path alias `@/` → `./src/` (mirrors tsconfig.json `paths`, so tests import
 *    application modules exactly like production code does);
 *  · path alias `@/lib/site` → `./mjengoos-website/lib/site` — the marketing
 *    website (mjengoos-website/) is a separate Next.js app whose own tsconfig
 *    maps `@/*` → the SITE root, and its tests live in THIS suite (repo
 *    convention, docs/adr/0003), so the website modules imported here must
 *    resolve their `@/lib/site` specifier against the site root exactly like
 *    the site's build does. Specific key FIRST (aliases match in order);
 *    every other `@/…` keeps meaning `./src/`;
 *  · node environment: the seams under test are pure/shared/server modules,
 *    no DOM needed;
 *  · conservative execution for the 4GB CI/dev box: one fork, no file
 *    parallelism, tests inside a file run sequentially.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@/lib/site': fileURLToPath(new URL('./mjengoos-website/lib/site', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    // Hermetic store for every module-level rate-limit/lockout wiring (issue
    // #158 made the multi-process SQLite store the DEFAULT): unit tests run on
    // the in-memory stores so bucket/lockout state can never leak across test
    // files or runs via a persisted db/ratelimit.db. The default wiring and
    // its failure ladder are pinned EXPLICITLY (temp-file sqlite, vi.resetModules
    // re-imports) in tests/unit/rate-limit-store.test.ts — this override only
    // fixes what the rest of the suite runs on.
    env: { RATE_LIMIT_STORE: 'memory' },
  },
})
