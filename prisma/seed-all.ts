/**
 * One-command full demo seed — `bun run seed` (from a migrated/`db push`-ed DB).
 *
 * Chains prisma/seed.ts + the seven standalone seed-extras in the dependency
 * order the scripts themselves declare (each header documents what it needs
 * and what it wipes):
 *
 *   1. seed.ts          base rows (3 demo projects, phases, tasks, workers,
 *                       attendance, materials, deliveries, transactions,
 *                       photos, alerts, recaps) + inline, in order:
 *                       professionals → land → supply → invoices → intel
 *   2. users.ts         7 demo login accounts (wipes ONLY User; needs the
 *                       base projects)
 *   3. memberships.ts   SEC-6 (#174) site-team project grants — every
 *                       supervisor/procurement/qs/finance user on every
 *                       project (wipes ONLY ProjectMembership; needs users
 *                       + projects; the single-org accepted-risk posture,
 *                       see SECURITY.md)
 *   4. tasks.ts         task v2 depth — priorities, assignees, blockers
 *                       (looks up base rows by NAME)
 *   5. domain.ts        worker depth, delivery driver leg, team roster
 *                       (needs workers + PO-2026-000009 from the base seed)
 *   6. evidence.ts      zones, photo comments, notifications, audit events
 *   7. money.ts         escrow, milestones, variation orders, ledger,
 *                       payment requests — wipes ALL notifications (it owns
 *                       the money kinds), so it runs AFTER evidence
 *   8. intel.ts         RE-RUN: money wiped every notification, and intel
 *                       wipes ONLY its own 4 kinds (approval.requested,
 *                       delivery.discrepancy, invoice.submitted, price.alert)
 *                       — re-running restores those while leaving money's
 *                       milestone/variation notifications in place
 *   9. trust.ts         fundi attendance trust history + kiosk PINs (touches
 *                       only Attendance + Worker.pin — safe to run last)
 *
 * Every script is still standalone-runnable for partial re-seeds; each wipes
 * only the models it owns. This runner just chains them in the right order
 * and stops at the first failure.
 *
 * Production guard (#126/#180): the chain REFUSES to run when
 * NODE_ENV=production unless I_HAVE_BACKED_UP_AND_WANT_TO_SEED_PRODUCTION=1
 * is set (and even then only against a local SQLite file: DATABASE_URL —
 * prisma/seed-guard.ts holds the rules; the admin demo account additionally
 * needs SEED_DEMO_ADMIN=1, see prisma/seed-extras/users.ts).
 */
import { PrismaClient } from '@prisma/client'
import { spawnSync } from 'node:child_process'

import { ensureForeignKeys } from '@/backend/lib/db'
import { assertSeedAllowed } from './seed-guard'

assertSeedAllowed()

// Issue #135 (audit DB-12): assert SQLite FK enforcement BEFORE the chain
// runs. Each child script re-asserts on its own connection; this guards the
// runner's own connection and fails the whole chain up front when
// `PRAGMA foreign_keys` cannot be enabled — the seeds' deleteMany/create
// ordering leans on the schema's Cascade/Restrict semantics.
const bootDb = new PrismaClient()
await ensureForeignKeys(bootDb)
await bootDb.$disconnect()

const steps: Array<{ script: string; note: string; wipes: string }> = [
  {
    script: 'prisma/seed.ts',
    note: 'base projects/phases/tasks/workers/materials + professionals → land → supply → invoices → intel',
    wipes:
      'ALL base + inline-extras tables: Notification, SiteZone, PhotoComment, VariationOrder, DrawPack, Milestone, EscrowWallet, AuditEvent, Recap, Transaction, Alert, SitePhoto, Consumption, Delivery, Attendance, Material, Worker, Task, Phase, Project + every model the inline professionals/land/supply/invoices/intel seeds own (Professional, LandParcel, Supplier, PurchaseOrder, Invoice, Ledger…)',
  },
  {
    script: 'prisma/seed-extras/users.ts',
    note: '7 demo login accounts',
    wipes: 'User (all login accounts)',
  },
  {
    script: 'prisma/seed-extras/memberships.ts',
    note: 'SEC-6 (#174) site-team project grants (single-org posture)',
    wipes: 'ProjectMembership (all grant rows)',
  },
  {
    script: 'prisma/seed-extras/tasks.ts',
    note: 'priorities, assignees, blockers',
    wipes: 'the task-v2 tasks it owns (matched by title) + their AuditEvent rows',
  },
  {
    script: 'prisma/seed-extras/domain.ts',
    note: 'worker depth, driver leg, team roster',
    wipes: 'nothing (idempotent check-before-write)',
  },
  {
    script: 'prisma/seed-extras/evidence.ts',
    note: 'zones, photo comments, notifications, audit',
    wipes: 'PhotoComment, SiteZone, Notification (all kinds)',
  },
  {
    script: 'prisma/seed-extras/money.ts',
    note: 'escrow, milestones, ledger, payment requests',
    wipes:
      'Notification + all money/ledger models: PaymentRequest, VariationOrder, DrawPack, Milestone, EscrowWallet, LedgerEntry, LedgerTransaction, LedgerAccount, IdempotencyRecord, WalletAccount',
  },
  {
    script: 'prisma/seed-extras/intel.ts',
    note: 're-run — restore intel notifications money wiped (kind-scoped)',
    wipes: 'RiskAssessment, IntelDigest, PricePoint + its own 4 Notification kinds',
  },
  {
    script: 'prisma/seed-extras/trust.ts',
    note: 'attendance trust history + kiosk PINs',
    wipes: 'Attendance rows of the 3 seeded projects (scoped) + Worker.pin',
  },
]

// Destructive-wipe summary (#126): printed BEFORE anything runs, so the
// operator sees exactly what is about to be deleted. (An interactive
// confirmation is deliberately NOT used — CI runs the chain non-interactively.)
console.log(
  '\n⚠  DESTRUCTIVE SEED — each step below DELETES ALL ROWS in the tables it owns\n' +
    '   before writing fresh demo data (nothing is merged):\n' +
    steps.map((s) => `     ${s.script.padEnd(32)} ${s.wipes}`).join('\n'),
)

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
