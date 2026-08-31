// MjengoPay seed extras — escrow wallets, milestones (proof-of-work flow), variation
// orders and money notifications for the 3 demo projects. Standalone: run AFTER
// prisma/seed.ts (`bun prisma/seed-extras/money.ts`). Wipes ONLY the money &
// governance models (EscrowWallet, Milestone, VariationOrder, Notification) so it is
// safe to re-run without touching the base seed.
//
// NOTE (deliberate): seeded released milestones do NOT create Transactions — the
// historical seed already carries the ledger; only new runtime releases write
// type:'milestone' transactions (handled by src/lib/actions/money.ts).

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

function daysAgo(n: number, hour = 10, minute = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d
}

async function main() {
  // FK-safe wipe of ONLY the models this seed owns
  await db.notification.deleteMany()
  await db.variationOrder.deleteMany()
  await db.milestone.deleteMany()
  await db.escrowWallet.deleteMany()

  const [p1, p2, p3] = await Promise.all([
    db.project.findFirst({ where: { name: { contains: 'Nyumba Yangu' } } }),
    db.project.findFirst({ where: { name: { contains: 'Kiambu Road' } } }),
    db.project.findFirst({ where: { name: { contains: 'Diani' } } }),
  ])
  if (!p1 || !p2 || !p3) throw new Error('Base projects missing — run `bun prisma/seed.ts` first')

  // ============================== P1 — Nyumba Yangu ==============================
  await db.escrowWallet.create({ data: { projectId: p1.id, balance: 1_200_000 } })

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
  await db.milestone.create({
    data: {
      projectId: p1.id,
      phaseId: phase('Site Prep & Foundation'),
      name: 'Foundation complete',
      amount: 800_000,
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
  await db.milestone.create({
    data: {
      projectId: p1.id,
      phaseId: phase('Walling'),
      name: 'Walling to ring beam',
      amount: 650_000,
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
      amount: 500_000,
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
      budgetImpact: 180_000,
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
      budgetImpact: 95_000,
      status: 'submitted',
      submittedBy: 'Mwangi Kariuki (Foreman)',
      createdAt: daysAgo(2, 14),
    },
  })

  // Notifications (unread, in-app) mirroring the live workflow
  await db.notification.create({
    data: {
      projectId: p1.id,
      kind: 'milestone',
      title: 'Release requested: Walling to ring beam',
      body: `Client approval needed for KSh 650,000 — ${wallingEv.length} evidence photo(s) attached`,
      recipient: p1.client,
      createdAt: daysAgo(1, 16, 5),
    },
  })
  await db.notification.create({
    data: {
      projectId: p1.id,
      kind: 'variation',
      title: 'Variation: Kitchen counter granite upgrade',
      body: 'Budget impact KSh 95,000 — awaiting client decision',
      recipient: p1.client,
      createdAt: daysAgo(2, 14, 5),
    },
  })

  // ========================= P2 — Kiambu Road Duplex =========================
  await db.escrowWallet.create({ data: { projectId: p2.id, balance: 500_000 } })
  const p2Phase = await db.phase.findFirst({ where: { projectId: p2.id }, orderBy: { order: 'asc' } })
  await db.milestone.create({
    data: {
      projectId: p2.id,
      phaseId: p2Phase?.id ?? null,
      name: 'Foundation package',
      amount: 700_000, // > wallet balance — demonstrates the escrow gate honestly
      status: 'locked',
      evidencePhotoIds: '[]',
      createdAt: daysAgo(9, 9),
    },
  })

  // ============================== P3 — Diani Renovation ==============================
  await db.escrowWallet.create({ data: { projectId: p3.id, balance: 0 } })
  const p3Photos = await db.sitePhoto.findMany({ where: { projectId: p3.id }, orderBy: { createdAt: 'asc' } })
  const p3Evidence = p3Photos.slice(0, 2).map((ph) => ph.id) // repainted walls + final walkthrough
  await db.milestone.create({
    data: {
      projectId: p3.id,
      phaseId: null,
      name: 'Renovation complete',
      amount: 2_520_000,
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
    notifications: await db.notification.count(),
  })
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
