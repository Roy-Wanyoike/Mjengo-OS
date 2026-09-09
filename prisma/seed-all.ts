/**
 * One-command full demo seed — `bun run seed` (from a migrated/`db push`-ed DB).
 *
 * Chains prisma/seed.ts + the six standalone seed-extras in the dependency
 * order the scripts themselves declare (each header documents what it needs
 * and what it wipes):
 *
 *   1. seed.ts          base rows (3 demo projects, phases, tasks, workers,
 *                       attendance, materials, deliveries, transactions,
 *                       photos, alerts, recaps) + inline, in order:
 *                       professionals → land → supply → invoices → intel
 *   2. users.ts         7 demo login accounts (wipes ONLY User; needs the
 *                       base projects)
 *   3. tasks.ts         task v2 depth — priorities, assignees, blockers
 *                       (looks up base rows by NAME)
 *   4. domain.ts        worker depth, delivery driver leg, team roster
 *                       (needs workers + PO-2026-000009 from the base seed)
 *   5. evidence.ts      zones, photo comments, notifications, audit events
 *   6. money.ts         escrow, milestones, variation orders, ledger,
 *                       payment requests — wipes ALL notifications (it owns
 *                       the money kinds), so it runs AFTER evidence
 *   7. intel.ts         RE-RUN: money wiped every notification, and intel
 *                       wipes ONLY its own 4 kinds (approval.requested,
 *                       delivery.discrepancy, invoice.submitted, price.alert)
 *                       — re-running restores those while leaving money's
 *                       milestone/variation notifications in place
 *   8. trust.ts         fundi attendance trust history + kiosk PINs (touches
 *                       only Attendance + Worker.pin — safe to run last)
 *
 * Every script is still standalone-runnable for partial re-seeds; each wipes
 * only the models it owns. This runner just chains them in the right order
 * and stops at the first failure.
 */
import { spawnSync } from 'node:child_process'

const steps: Array<{ script: string; note: string }> = [
  { script: 'prisma/seed.ts', note: 'base projects/phases/tasks/workers/materials + professionals → land → supply → invoices → intel' },
  { script: 'prisma/seed-extras/users.ts', note: '7 demo login accounts' },
  { script: 'prisma/seed-extras/tasks.ts', note: 'priorities, assignees, blockers' },
  { script: 'prisma/seed-extras/domain.ts', note: 'worker depth, driver leg, team roster' },
  { script: 'prisma/seed-extras/evidence.ts', note: 'zones, photo comments, notifications, audit' },
  { script: 'prisma/seed-extras/money.ts', note: 'escrow, milestones, ledger, payment requests' },
  { script: 'prisma/seed-extras/intel.ts', note: 're-run — restore intel notifications money wiped (kind-scoped)' },
  { script: 'prisma/seed-extras/trust.ts', note: 'attendance trust history + kiosk PINs' },
]

let failed = false
for (const { script, note } of steps) {
  console.log(`\n▶ ${script}  (${note})`)
  const result = spawnSync('bun', [script], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`\n✗ seed chain failed at ${script} (exit ${result.status ?? 'signal ' + result.signal})`)
    failed = true
    break
  }
}

if (!failed) {
  console.log(
    '\n✓ Full demo seed complete — sign in with contractor@mjengo.os / mjengo2026 ' +
      '(all demo accounts are listed in README.md).',
  )
}
process.exit(failed ? 1 : 0)
