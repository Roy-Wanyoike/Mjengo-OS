import { defineConfig } from 'vitest/config'
import base from './vitest.config.mts'
import { FINANCE_GATE_FENCE_TEST, FINANCE_GATE_TEST_FILES } from './tests/finance/gate-files'

/**
 * THE FINANCE GATE CONFIG (issue #215) — powers `bun run test:finance`:
 *
 *   bun run test:finance
 *     → vitest run -c vitest.financial.config.ts
 *     → exactly FINANCE_GATE_TEST_FILES (tests/finance/gate-files.ts — the
 *       explicit, commented, one-line-edit list of money-invariant suites)
 *       + the fence meta-test tests/finance/gate.test.ts, so the gate
 *       verifies its own file list on every run.
 *
 * Everything else (aliases, node env, single-fork execution, the
 * RATE_LIMIT_STORE=memory override, the console-noise filters) is inherited
 * from vitest.config.mts unchanged — the gate runs under the exact same
 * conditions as the full suite, just scoped to the money files.
 *
 * WHEN TO RUN IT (also documented in CONTRIBUTING.md + DEPLOYMENT.md):
 *   · before any release / deployment — the pre-release money check;
 *   · on every PR that touches the money path (ledger, wallet, escrow,
 *     daraja, payments, money routes) — seconds instead of the full suite;
 *   · `bun run test` still runs everything, gate included.
 *
 * ADDING A MONEY SUITE = a one-line edit in tests/finance/gate-files.ts
 * (the qualification rules + judgment calls are documented there; the fence
 * test fails if a new money-named tests/unit file is not consciously added
 * or judged out).
 */
export default defineConfig({
  resolve: base.resolve,
  test: {
    ...base.test,
    include: [...FINANCE_GATE_TEST_FILES, FINANCE_GATE_FENCE_TEST],
  },
})
