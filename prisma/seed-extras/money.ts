// MjengoPay seed extras — escrow wallets, milestones (proof-of-work flow), variation
// orders, money notifications AND (F-MONEY) the double-entry ledger history +
// payment requests for the 3 demo projects. Standalone: run AFTER
// prisma/seed.ts (`bun prisma/seed-extras/money.ts`). Wipes ONLY the money,
// governance and ledger models it owns (EscrowWallet, Milestone,
// VariationOrder, Notification, PaymentRequest, LedgerEntry,
// LedgerTransaction, LedgerAccount, IdempotencyRecord, WalletAccount) so it is
// safe to re-run without touching the base seed.
//
// NOTE (resolved by the F-MONEY wave): seeded milestones now POST LEDGER ROWS —
// every escrow top-up debits the cash pool and credits ESCROW:<projectId>,
// every release debits ESCROW and credits EXPENSE:<projectId>. The
// "top-ups were invisible to the ledger" mystery from audit finding A-1 is
// gone: the EscrowWallet.balance projection is seeded to match the
// ledger-derived balance exactly (the consistency chip lands green). No legacy
// Transaction rows are seeded for the historical releases — the historical
// spend ledger is carried by the base seed; only NEW runtime releases write
// type:'milestone' Transaction rows (handled by src/lib/actions/money.ts).

import { PrismaClient } from '@prisma/client'
import { ensureForeignKeys } from '@/backend/lib/db'
import { fmtKes } from '@/backend/lib/money'
import { withLedgerMaintenance } from './ledger-maintenance'

const db = new PrismaClient()

function daysAgo(n: number, hour = 10, minute = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d
}

/**
 * Post a balanced double-entry ledger transaction with explicit entries.
 *
 * DB-3 (#124, migration 14): the seed no longer bypasses the ledger
 * invariants — it posts through the DB-enforced pending→posted gate (the
 * same lifecycle the TypeScript service uses). The migration-14 posting
 * trigger asserts Σdebits = Σcredits at the final UPDATE, so the seed can
 * no longer write unbalanced history even though it resolves accounts by
 * id and pins deterministic refs instead of calling the service. The
 * initial WIPE below still needs the documented maintenance exemption
 * (archival op — the SQLite twin of mjengo.allow_maintenance).
 */
async function postSeedLedger(input: {
  ref: string
  projectId: string
  description: string
  occurredAt: Date
  postedBy: string
  postedRole: string
  lines: Array<{ accountId: string; side: 'debit' | 'credit'; amount: bigint; memo?: string }>
}) {
  const pending = await db.ledgerTransaction.create({
    data: {
      ref: input.ref,
      projectId: input.projectId,
      description: input.description,
      occurredAt: input.occurredAt,
      postedBy: input.postedBy,
      postedRole: input.postedRole,
      status: 'pending',
    },
  })
  for (const l of input.lines) {
    await db.ledgerEntry.create({
      data: { txnId: pending.id, accountId: l.accountId, side: l.side, amount: l.amount, memo: l.memo ?? null },
    })
  }
  return db.ledgerTransaction.update({ where: { id: pending.id }, data: { status: 'posted' } })
}

async function main() {
  await ensureForeignKeys(db) // issue #135 / audit DB-12 — refuse to write with FK enforcement off
  // FK-safe wipe of ONLY the models this seed owns
  await db.notification.deleteMany()
  await db.paymentRequest.deleteMany()
  await db.variationOrder.deleteMany()
  // DrawPack pins milestones (one per release) — wipe packs before milestones
  await db.drawPack.deleteMany()
  await db.milestone.deleteMany()
  await db.escrowWallet.deleteMany()
  // DB-3 (#124): ledger rows are append-only at the DB level (migration 14) —
  // the wipe is the documented maintenance exemption (archival op), the
  // SQLite twin of mjengo.allow_maintenance. The flag is ALWAYS restored
  // (finally inside the helper) even if the wipe crashes mid-way.
  await withLedgerMaintenance(db, async () => {
    await db.ledgerEntry.deleteMany()
    await db.ledgerTransaction.deleteMany()
  })
  await db.ledgerAccount.deleteMany()
  await db.idempotencyRecord.deleteMany()
  // WalletAccounts are runtime-created (v1 API / wallet.create actions) — none
  // are seeded, so a clean re-run drops them together with their ledger rows.
  await db.walletAccount.deleteMany()

  const [p1, p2, p3] = await Promise.all([
    db.project.findFirst({ where: { name: { contains: 'Nyumba Yangu' } } }),
    db.project.findFirst({ where: { name: { contains: 'Kiambu Road' } } }),
    db.project.findFirst({ where: { name: { contains: 'Diani' } } }),
  ])
  if (!p1 || !p2 || !p3) throw new Error('Base projects missing — run `bun prisma/seed.ts` first')

  // Platform cash pools (mirrors modules/ledger/service.ts PLATFORM_ACCOUNTS)
  const cashMpesa = await db.ledgerAccount.create({
    data: { code: 'CASH_MPESA', name: 'Mobile Money Pool (simulated)', kind: 'asset', normalSide: 'debit', ownerType: 'platform' },
  })

  // Project chart of accounts
  const escrowFor = async (projectId: string) =>
    db.ledgerAccount.create({
      data: {
        code: `ESCROW:${projectId}`,
        name: `Project Escrow — ${projectId.slice(-6)}`,
        kind: 'liability',
        normalSide: 'credit',
        projectId,
        ownerType: 'project',
        ownerId: projectId,
      },
    })
  const expenseFor = async (projectId: string) =>
    db.ledgerAccount.create({
      data: {
        code: `EXPENSE:${projectId}`,
        name: `Project Expense — ${projectId.slice(-6)}`,
        kind: 'expense',
        normalSide: 'debit',
        projectId,
        ownerType: 'project',
        ownerId: projectId,
      },
    })

  // ============================== P1 — Nyumba Yangu ==============================
  const p1Escrow = await escrowFor(p1.id)
  const p1Expense = await expenseFor(p1.id)

  // Ledger history: top-up 2,000,000 → release 800,000 (Foundation) → derived 1,200,000
  await postSeedLedger({
    ref: 'LX-2026-000101',
    projectId: p1.id,
    description: 'Escrow top-up (MPESA-4RJ8XK2P) — mpesa',
    occurredAt: daysAgo(46, 9),
    postedBy: 'Amina (Client)',
    postedRole: 'client',
    lines: [
      { accountId: cashMpesa.id, side: 'debit', amount: 200000000n },
      { accountId: p1Escrow.id, side: 'credit', amount: 200000000n },
    ],
  })
  await postSeedLedger({
    ref: 'LX-2026-000102',
    projectId: p1.id,
    description: 'Milestone release — Foundation complete',
    occurredAt: daysAgo(21, 18),
    postedBy: 'Amina (Client)',
    postedRole: 'client',
    lines: [
      { accountId: p1Escrow.id, side: 'debit', amount: 80000000n },
      { accountId: p1Expense.id, side: 'credit', amount: 80000000n },
    ],
  })
  await db.escrowWallet.create({
    data: { projectId: p1.id, balance: 120000000n, ledgerAccountId: p1Escrow.id },
  })

  const [p1Photos, p1Phases] = await Promise.all([
    db.sitePhoto.findMany({ where: { projectId: p1.id }, orderBy: { createdAt: 'asc' } }),
    db.phase.findMany({ where: { projectId: p1.id }, orderBy: { order: 'asc' } }),
  ])
  const photo = (url: string) => p1Photos.find((ph) => ph.url === url)?.id ?? null
  const phase = (name: string) => p1Phases.find((ph) => ph.name === name)?.id ?? null

  const foundationEv = [photo('/photos/foundation-done.png'), photo('/photos/workers-onsite.png')]
    .filter((x): x is string => Boolean(x))
  const wallingEv = [photo('/photos/walling-progress.png'), photo('/photos/site-aerial.png')]
    .filter((x): x is string => Boolean(x))

  // Milestone 1 — Foundation complete: fully RELEASED ~3 weeks ago
  // (backed by ledger ref LX-2026-000102 above)
  const p1M1 = await db.milestone.create({
    data: {
      projectId: p1.id,
      phaseId: phase('Site Prep & Foundation'),
      name: 'Foundation complete',
      amount: 80000000n,
      status: 'released',
      evidencePhotoIds: JSON.stringify(foundationEv),
      requestedAt: daysAgo(23, 11),
      decidedAt: daysAgo(21, 18),
      decidedBy: 'Amina (Client)',
      decisionNote: 'Foundation inspected via photos — approved for release.',
      releasedAt: daysAgo(21, 18),
      createdAt: daysAgo(45, 9),
    },
  })

  // Milestone 2 — Walling to ring beam: evidence attached, release REQUESTED yesterday
  const p1M2 = await db.milestone.create({
    data: {
      projectId: p1.id,
      phaseId: phase('Walling'),
      name: 'Walling to ring beam',
      amount: 65000000n,
      status: 'release_requested',
      evidencePhotoIds: JSON.stringify(wallingEv),
      requestedAt: daysAgo(1, 16),
      createdAt: daysAgo(20, 9),
    },
  })

  // Milestone 3 — Roofing package: still LOCKED
  await db.milestone.create({
    data: {
      projectId: p1.id,
      phaseId: phase('Roofing'),
      name: 'Roofing package',
      amount: 50000000n,
      status: 'locked',
      evidencePhotoIds: '[]',
      createdAt: daysAgo(10, 9),
    },
  })

  // Variation 1 — APPROVED ~4 weeks ago (black cotton soil)
  await db.variationOrder.create({
    data: {
      projectId: p1.id,
      phaseId: phase('Site Prep & Foundation'),
      title: 'Black cotton soil — deeper foundation',
      description:
        'Excavation hit black cotton soil at 1.2m. Foundation deepened by 600mm with extra hardcore filling and blinding to guarantee bearing capacity. Quantities verified against delivery notes.',
      budgetImpact: 18000000n,
      status: 'approved',
      submittedBy: 'Mwangi Kariuki (Foreman)',
      decidedBy: 'Amina (Client)',
      decisionNote: 'Soil survey photos verified — unavoidable extra work.',
      decidedAt: daysAgo(28, 17),
      createdAt: daysAgo(30, 12),
    },
  })

  // Variation 2 — SUBMITTED 2 days ago (granite upgrade)
  await db.variationOrder.create({
    data: {
      projectId: p1.id,
      phaseId: phase('Finishing'),
      title: 'Kitchen counter granite upgrade',
      description:
        'Swap pre-priced engineered stone for 20mm granite slab with bullnose edging, as requested by the clients during finishing selection. Includes template, fabrication and fitting.',
      budgetImpact: 9500000n,
      status: 'submitted',
      submittedBy: 'Mwangi Kariuki (Foreman)',
      createdAt: daysAgo(2, 14),
    },
  })

  // Payment requests (F-MONEY): one PENDING (linked to the walling milestone),
  // one APPROVED awaiting payment.
  await db.paymentRequest.create({
    data: {
      requestCode: 'PR-2026-000001',
      projectId: p1.id,
      requestedByRole: 'contractor',
      requestedByName: 'Site Manager',
      description: 'Walling to ring beam — contractor payout on client release',
      amount: 65000000n,
      payee: 'Mwangi Kariuki (Foreman crew)',
      method: 'wallet',
      status: 'pending',
      relatedEntityType: 'milestone',
      relatedEntityId: p1M2.id,
      createdAt: daysAgo(1, 17),
    },
  })
  await db.paymentRequest.create({
    data: {
      requestCode: 'PR-2026-000002',
      projectId: p1.id,
      requestedByRole: 'contractor',
      requestedByName: 'Site Manager',
      description: 'Steel delivery transport — Kiambu Road to Kitengela (10-ton truck)',
      amount: 4500000n,
      payee: 'Mwangi Transport Ltd',
      method: 'mpesa',
      status: 'approved',
      decidedBy: 'Fatuma (Finance)',
      decidedAt: daysAgo(0, 9),
      decisionNote: 'Delivery note verified against PO-2026-000012 — approved for payment.',
      createdAt: daysAgo(1, 12),
    },
  })
  void p1M1

  // Notifications (unread, in-app) mirroring the live workflow
  await db.notification.create({
    data: {
      projectId: p1.id,
      kind: 'milestone',
      title: 'Release requested: Walling to ring beam',
      body: `Client approval needed for ${fmtKes(65_000_000n)} — ${wallingEv.length} evidence photo(s) attached`,
      recipient: p1.client,
      createdAt: daysAgo(1, 16, 5),
    },
  })
  await db.notification.create({
    data: {
      projectId: p1.id,
      kind: 'variation',
      title: 'Variation: Kitchen counter granite upgrade',
      body: `Budget impact ${fmtKes(9_500_000n)} — awaiting client decision`,
      recipient: p1.client,
      createdAt: daysAgo(2, 14, 5),
    },
  })
  await db.notification.create({
    data: {
      projectId: p1.id,
      kind: 'approval.requested',
      title: 'Payment request PR-2026-000001 awaiting approval',
      body: `${fmtKes(65_000_000n)} to Mwangi Kariuki (Foreman crew) — Walling to ring beam — contractor payout on client release`,
      recipient: p1.client,
      createdAt: daysAgo(1, 17, 5),
    },
  })

  // ========================= P2 — Kiambu Road Duplex =========================
  const p2Escrow = await escrowFor(p2.id)
  await postSeedLedger({
    ref: 'LX-2026-000201',
    projectId: p2.id,
    description: 'Escrow top-up (BANK-QN3RT7VK) — bank',
    occurredAt: daysAgo(12, 10),
    postedBy: 'Otieno (Client)',
    postedRole: 'client',
    lines: [
      { accountId: cashMpesa.id, side: 'debit', amount: 50000000n, memo: 'bank float settle (simulated)' },
      { accountId: p2Escrow.id, side: 'credit', amount: 50000000n },
    ],
  })
  await db.escrowWallet.create({
    data: { projectId: p2.id, balance: 50000000n, ledgerAccountId: p2Escrow.id },
  })
  const p2Phase = await db.phase.findFirst({ where: { projectId: p2.id }, orderBy: { order: 'asc' } })
  await db.milestone.create({
    data: {
      projectId: p2.id,
      phaseId: p2Phase?.id ?? null,
      name: 'Foundation package',
      amount: 70000000n, // > wallet balance — demonstrates the escrow gate honestly
      status: 'locked',
      evidencePhotoIds: '[]',
      createdAt: daysAgo(9, 9),
    },
  })

  // ============================== P3 — Diani Renovation ==============================
  const p3Escrow = await escrowFor(p3.id)
  const p3Expense = await expenseFor(p3.id)
  // fully released: top-up 2,520,000 → release 2,520,000 → derived 0
  await postSeedLedger({
    ref: 'LX-2026-000301',
    projectId: p3.id,
    description: 'Escrow top-up (MPESA-BD9W2LKM) — mpesa',
    occurredAt: daysAgo(190, 9),
    postedBy: 'Aisha (Client)',
    postedRole: 'client',
    lines: [
      { accountId: cashMpesa.id, side: 'debit', amount: 252000000n },
      { accountId: p3Escrow.id, side: 'credit', amount: 252000000n },
    ],
  })
  await postSeedLedger({
    ref: 'LX-2026-000302',
    projectId: p3.id,
    description: 'Milestone release — Renovation complete',
    occurredAt: daysAgo(60, 15),
    postedBy: 'Aisha (Client)',
    postedRole: 'client',
    lines: [
      { accountId: p3Escrow.id, side: 'debit', amount: 252000000n },
      { accountId: p3Expense.id, side: 'credit', amount: 252000000n },
    ],
  })
  await db.escrowWallet.create({
    data: { projectId: p3.id, balance: 0n, ledgerAccountId: p3Escrow.id },
  })
  const p3Photos = await db.sitePhoto.findMany({ where: { projectId: p3.id }, orderBy: { createdAt: 'asc' } })
  const p3Evidence = p3Photos.slice(0, 2).map((ph) => ph.id) // repainted walls + final walkthrough
  await db.milestone.create({
    data: {
      projectId: p3.id,
      phaseId: null,
      name: 'Renovation complete',
      amount: 252000000n,
      status: 'released',
      evidencePhotoIds: JSON.stringify(p3Evidence),
      requestedAt: daysAgo(62, 11),
      decidedAt: daysAgo(60, 15),
      decidedBy: 'Aisha (Client)',
      decisionNote: 'Final walkthrough passed — full release approved.',
      releasedAt: daysAgo(60, 15),
      createdAt: daysAgo(190, 9),
    },
  })

  console.log('Money seed extras complete:', {
    wallets: await db.escrowWallet.count(),
    milestones: await db.milestone.count(),
    variations: await db.variationOrder.count(),
    paymentRequests: await db.paymentRequest.count(),
    ledgerTxns: await db.ledgerTransaction.count(),
    ledgerEntries: await db.ledgerEntry.count(),
    notifications: await db.notification.count(),
  })
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
