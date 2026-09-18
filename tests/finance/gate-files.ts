/**
 * THE FINANCE GATE FILE LIST (issue #215) — the single source of truth for
 * `bun run test:finance` (vitest.financial.config.ts includes exactly these
 * files + the fence meta-test tests/finance/gate.test.ts, which keeps this
 * list honest — see below).
 *
 * WHAT THE GATE IS
 *
 * `bun run test:finance` is the one-command money-invariant release gate: the
 * suites that must be green before any release, and that a money-touching PR
 * can run alone (seconds) instead of the full suite. It answers one question:
 * "did the money core survive this change?"
 *
 * WHAT QUALIFIES A FILE FOR THE GATE (keep this honest — the list IS the
 * product; a file belongs here when a regression in it would mean one of):
 *
 *   · WRONG MONEY PARSED — the integer-cents arithmetic every amount flows
 *     through (money-core, money-bounds);
 *   · WRONG MONEY MOVED — double-entry posting/reversal balance, natural
 *     keys, idempotent replay, escrow projection restoration
 *     (ledger*, wallet-idempotency, wallet-realdb, escrow-reversal);
 *   · WRONG MONEY TRUSTED — provider callback verification/dedupe, source-IP
 *     allowlist, the end-to-end STK lifecycle (mpesa-daraja, daraja-*);
 *   · MONEY MACHINERY BLIND TO DRIFT — the reconciliation sweeps and drift
 *     alarms (daraja-reconcile, reconciliation-job);
 *   · WRONG MONEY RECONCILED — 3-way match consistency math, SQL-sum balance
 *     equivalence, the DB-level posting gate + append-only triggers
 *     (three-way, ledger-sql-sum, db-integrity-constraints' migration-14
 *     blocks);
 *   · WRONG MONEY SURFACED UNSAFELY — the v1 money routes + their role
 *     gates + their audit trails (v1-payments, v1-wallets, v1-money-audit,
 *     wallet-role-gates, money-actions-audit);
 *   · WRONG MONEY RELEASED — posting-seam cost codes and the release
 *     evidence freeze (reports-phase-codes, draw-pack);
 *   · THE MONEY WALK BROKEN END-TO-END (supply-chain-realdb);
 *   · THE MONEY MODEL TYPED WRONG IN THE TARGET DESIGN (supabase-design).
 *
 * JUDGMENT CALLS — files that LOOK money-adjacent but are deliberately NOT
 * gated (the fence test's MONEY_NAME_PATTERN forces every name-matching new
 * file to be either added here or given a documented reason there):
 *
 *   · reports-budget-variance — read-side rollups of ALREADY-POSTED money
 *     (spent/variance math for the QS report); nothing moves, trusts or
 *     reconciles. Covered by the full suite.
 *   · v1-milestones / v1-invoices — read-only route contracts (authz,
 *     pagination) over money state; the underlying projection invariants are
 *     pinned at service level by escrow-reversal / three-way.
 *   · quote-atomicity / quote-update-realdb — transactional discipline on
 *     quote editing (upstream of PO/invoice, no money semantics).
 *   · wallet-posture-banner — UI banner dismissal state (localStorage).
 *   · website-escrow-copy — marketing-site copy honesty.
 *   · inventory-reconciliation(-realdb) — STOCK reconciliation (counts),
 *     not money reconciliation (balances).
 *
 * ADDING A NEW MONEY SUITE = a ONE-LINE EDIT to the array below (then
 * `bun run test:finance` must stay green). The fence test fails loudly when:
 *   · a file in this list no longer exists (rename/typo rot);
 *   · a NEW tests/unit file whose name matches the money-family pattern is
 *     neither listed here nor judged out with a reason;
 *   · the issue-#215 minimum coverage set is ever dropped from the list.
 *
 * The array is SORTED (lexicographic, diff-friendly) and must stay sorted —
 * the fence test pins that too.
 */
export const FINANCE_GATE_TEST_FILES: readonly string[] = [
  'tests/unit/daraja-ip-allowlist.test.ts', // webhook source-IP gate (fail-closed)
  'tests/unit/daraja-lifecycle.test.ts', // the STK story end-to-end: crash/miss covered, never invented money
  'tests/unit/daraja-reconcile.test.ts', // pending-intent sweep + both-direction dedupe + drainer
  'tests/unit/db-integrity-constraints.test.ts', // migration 14: DB-level posting gate, append-only, CHECKs
  'tests/unit/draw-pack.test.ts', // release evidence freeze — one pack, zero new money (W4-1)
  'tests/unit/escrow-reversal.test.ts', // reversals restore the ESCROW projection (issue #213)
  'tests/unit/idempotency-scope-realdb.test.ts', // composite UNIQUE (principal, scope, key) on real SQLite
  'tests/unit/idempotency-scope.test.ts', // principal-scoped idempotency keyspace — the /api/actions half (SEC-10)
  'tests/unit/ledger-realdb.test.ts', // the posting engine on a real migrated SQLite (triggers, uniques, $tx)
  'tests/unit/ledger-sql-sum.test.ts', // SQL Σdebit/Σcredit == the JS reduce it replaced (issue #144)
  'tests/unit/ledger.test.ts', // balanced posts, immutability, posting idempotency (stub)
  'tests/unit/money-actions-audit.test.ts', // milestone/variation/payment decisions audit their money refs (#218)
  'tests/unit/money-bounds.test.ts', // parse bounds: >2-dp refused, ≤2-dp accepted (lib/money-bounds)
  'tests/unit/money-core.test.ts', // integer-cents core: parse/round-trip/exact sums (lib/money)
  'tests/unit/mpesa-daraja.test.ts', // callback dedupe/verification/amount-trust, refund seam
  'tests/unit/reconciliation-job.test.ts', // scheduled sweep + escrow projection drift alarm (issue #212)
  'tests/unit/reports-phase-codes.test.ts', // phase cost-codes at the posting seam + honest attribution
  'tests/unit/supabase-design.test.ts', // money typing (integer cents, balanced triggers) in the Supabase design
  'tests/unit/supply-chain-realdb.test.ts', // RFQ → quote → PO → delivery → invoice → 3-way → ledger, end to end
  'tests/unit/three-way.test.ts', // PO ↔ invoice ↔ delivery match — the invoice.pay gate
  'tests/unit/v1-money-audit.test.ts', // every v1 money mutation writes its AuditEvent (DB-4)
  'tests/unit/v1-payments.test.ts', // POST /api/v1/payments — roles, resolve-first, Idempotency-Key
  'tests/unit/v1-wallets.test.ts', // the wallet family REST contract incl. deposit/withdraw/transfer
  'tests/unit/wallet-idempotency.test.ts', // natural keys + replay-before-balance + 409 fingerprints
  'tests/unit/wallet-realdb.test.ts', // the wallet service on a real migrated SQLite
  'tests/unit/wallet-role-gates.test.ts', // who may dispatch money actions (BE-2/BE-7/BE-8)
]

/**
 * The fence test itself — shipped INSIDE the gate so `bun run test:finance`
 * verifies its own file list every time it runs (vitest.financial.config.ts
 * appends this to the include list).
 */
export const FINANCE_GATE_FENCE_TEST = 'tests/finance/gate.test.ts' as const

/**
 * The issue-#215 minimum coverage set — the acceptance-criteria floor the
 * fence test pins can never be dropped from the gate (balanced-ledger posting
 * + reversal, wallet retry idempotency + natural keys, Daraja callback dedupe
 * + verification, reconcile sweep both-direction dedupe, 3-way consistency
 * math, v1 payments/wallets route layer + Idempotency-Key, role gates).
 */
export const FINANCE_GATE_AC_MINIMUM: readonly string[] = [
  'tests/unit/ledger.test.ts',
  'tests/unit/wallet-idempotency.test.ts',
  'tests/unit/mpesa-daraja.test.ts',
  'tests/unit/daraja-reconcile.test.ts',
  'tests/unit/three-way.test.ts',
  'tests/unit/v1-payments.test.ts',
  'tests/unit/v1-wallets.test.ts',
  'tests/unit/wallet-role-gates.test.ts',
]

/**
 * The money-family NAME pattern for tests/unit files. Purely a rot tripwire:
 * any NEW file matching it must join FINANCE_GATE_TEST_FILES or carry a
 * documented reason in MONEY_NAME_JUDGED_OUT. Deliberately over-inclusive —
 * it exists to force a conscious one-line decision, not to classify by
 * heuristic (the gate list itself is explicit, per the issue's acceptance
 * criteria: "explicit list in config, not filename heuristics").
 */
export const MONEY_NAME_PATTERN = /(money|ledger|wallet|escrow|daraja|mpesa|idempoten|reconcil|payment|three-way|draw-pack|supply-chain)/i

/**
 * Name-matching files JUDGED OUT of the gate, each with its reason — the
 * documented half of the honest enumeration (the fence test fails if an
 * entry here stops existing, so judgments can't rot either).
 */
export const MONEY_NAME_JUDGED_OUT: Readonly<Record<string, string>> = {
  'tests/unit/inventory-reconciliation.test.ts':
    'stock reconciliation (counts on hand), not money reconciliation (balances)',
  'tests/unit/inventory-reconciliation-realdb.test.ts':
    'stock reconciliation (counts on hand), not money reconciliation (balances)',
  'tests/unit/wallet-posture-banner.test.ts':
    'UI banner dismissal state (localStorage persistence) — presentation, no money semantics',
  'tests/unit/website-escrow-copy.test.ts':
    'marketing-site copy honesty — words about money, not money movement',
}
