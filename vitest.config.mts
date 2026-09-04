import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration — starter suite (Task 5-e).
 *
 *  · path alias `@/` → `./src/` (mirrors tsconfig.json `paths`, so tests import
 *    application modules exactly like production code does);
 *  · node environment: the seams under test are pure/shared/server modules,
 *    no DOM needed;
 *  · conservative execution for the 4GB CI/dev box: one fork, no file
 *    parallelism, tests inside a file run sequentially.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
  },
})
