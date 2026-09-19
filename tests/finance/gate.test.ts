/**
 * THE FINANCE GATE FENCE (issue #215) — the meta-test that keeps
 * `bun run test:finance` honest. The gate's file list lives in
 * ./gate-files.ts (single source of truth, shared with
 * vitest.financial.config.ts); this file runs INSIDE the gate (and the full
 * suite) and fails loudly the moment that list rots:
 *
 *   · a gated file stops existing (rename/typo silently shrinking the gate);
 *   · the list loses its sorted/duplicate-free shape (diff-friendly by
 *     contract);
 *   · a NEW tests/unit file whose NAME says money (money/ledger/wallet/
 *     escrow/daraja/mpesa/idempoten/reconcil/payment/three-way/draw-pack/
 *     supply-chain) is neither gated nor judged out with a written reason —
 *     adding a money suite must be a conscious one-line decision, never an
 *     accident the gate silently absorbs;
 *   · a judgment-out entry stops existing or loses its reason (judgments
 *     are documentation, and documentation must not rot either);
 *   · the issue-#215 acceptance-criteria minimum coverage ever drops out;
 *   · the vitest config wiring drifts from the list (the executed-file set
 *     must BE the intended set).
 *
 * This is the "tiny meta-test" the issue's testing requirements sanction:
 * "verify by running the command and asserting the executed-file list
 * matches the intended set".
 *
 * ONE HONEST LIMIT (by construction): a config edit that removes THIS file
 * from the gate's include cannot be caught by the gate itself — a test that
 * doesn't run can't fail. The full suite (`bun run test`, whose include
 * pattern sweeps every test file under tests/) always runs this fence, so
 * the wiring pin above is enforced there; release procedure
 * (CONTRIBUTING/DEPLOYMENT) runs both.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FINANCE_GATE_AC_MINIMUM,
  FINANCE_GATE_FENCE_TEST,
  FINANCE_GATE_TEST_FILES,
  MONEY_NAME_JUDGED_OUT,
  MONEY_NAME_PATTERN,
} from './gate-files'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const unitDir = join(repoRoot, 'tests', 'unit')

describe('#215 finance gate — the fence (the gate checks its own list)', () => {
  it('every gated file exists — a rename or typo cannot silently shrink the gate', () => {
    const missing = FINANCE_GATE_TEST_FILES.filter((f) => !existsSync(join(repoRoot, f)))
    expect(
      missing,
      'finance gate list rot — these files no longer exist; update tests/finance/gate-files.ts',
    ).toEqual([])
  })

  it('the list is sorted and duplicate-free (diff-friendly by contract)', () => {
    expect(FINANCE_GATE_TEST_FILES, 'no duplicate gate entries').toEqual([
      ...new Set(FINANCE_GATE_TEST_FILES),
    ])
    const sorted = [...FINANCE_GATE_TEST_FILES].sort()
    // Point at the FIRST out-of-order entry so a fix is a one-line move.
    const firstOffender = FINANCE_GATE_TEST_FILES.find((f, i) => f !== sorted[i])
    expect(
      firstOffender ?? '(sorted)',
      `gate list must stay lexicographically sorted — "${firstOffender}" is out of place`,
    ).toBe('(sorted)')
  })

  it('every money-NAMED tests/unit file is either gated or judged out with a reason', () => {
    const onDisk = readdirSync(unitDir).filter((f) => f.endsWith('.test.ts'))
    expect(onDisk.length, 'sanity: the tests/unit directory was found').toBeGreaterThan(100)
    const unaccounted = onDisk
      .map((f) => `tests/unit/${f}`)
      .filter(
        (rel) =>
          MONEY_NAME_PATTERN.test(rel) &&
          !FINANCE_GATE_TEST_FILES.includes(rel) &&
          !(rel in MONEY_NAME_JUDGED_OUT),
      )
    expect(
      unaccounted,
      'new money-named suite(s) not accounted for — add them to FINANCE_GATE_TEST_FILES ' +
        '(one line in tests/finance/gate-files.ts) or record a judgment-out reason in ' +
        'MONEY_NAME_JUDGED_OUT. The gate must absorb new money suites CONSCIOUSLY.',
    ).toEqual([])
  })

  it('the judged-out ledger stays honest — entries exist, reasons present, none gated', () => {
    for (const [rel, reason] of Object.entries(MONEY_NAME_JUDGED_OUT)) {
      expect(existsSync(join(repoRoot, rel)), `judged-out entry ${rel} no longer exists — remove the stale judgment`).toBe(true)
      expect(reason.trim().length, `judged-out entry ${rel} needs a written reason`).toBeGreaterThan(10)
      expect(
        FINANCE_GATE_TEST_FILES,
        `${rel} is BOTH gated and judged out — pick one`,
      ).not.toContain(rel)
    }
  })

  it('the issue-#215 minimum coverage set is present (the AC floor)', () => {
    const dropped = FINANCE_GATE_AC_MINIMUM.filter((f) => !FINANCE_GATE_TEST_FILES.includes(f))
    expect(
      dropped,
      'these files are the acceptance-criteria floor of the finance gate — they cannot be dropped',
    ).toEqual([])
  })

  it('the config wiring runs exactly the gate list + this fence test (executed set == intended set)', async () => {
    const cfg = (await import('../../vitest.financial.config.ts')).default
    expect(cfg.test?.include).toEqual([...FINANCE_GATE_TEST_FILES, FINANCE_GATE_FENCE_TEST])
  })
})
