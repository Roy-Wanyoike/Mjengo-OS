// Notification Center seed — in-app notifications for the 3 demo projects.
// Standalone; wipes ONLY the Notification table and is safe to re-run.
// Run AFTER prisma/seed-extras/money.ts (which also seeds a couple of live
// workflow notifications and wipes Notification on its own re-run).
import { PrismaClient } from '@prisma/client'
import { ensureForeignKeys } from '@/backend/lib/db'
import { fmtKes } from '@/backend/lib/money'

const db = new PrismaClient()

/** Timestamp `days` ago at a realistic EAT site hour. */
function daysAgo(n: number, hour = 10, minute = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d
}

/** Sibling agents may be writing to the same SQLite file — retry on SQLITE_BUSY. */
async function withBusyRetry(fn: () => Promise<void>, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      await fn()
      return
    } catch (e) {
      if (i >= attempts || !String(e).includes('SQLITE_BUSY')) throw e
      await new Promise((r) => setTimeout(r, 250 * i))
    }
  }
}

async function main() {
  await ensureForeignKeys(db) // issue #135 / audit DB-12 — refuse to write with FK enforcement off
  await db.notification.deleteMany()

  const [p1, p2, p3] = await Promise.all([
    db.project.findFirst({ where: { name: { contains: 'Nyumba Yangu' } } }),
    db.project.findFirst({ where: { name: { contains: 'Kiambu Road' } } }),
    db.project.findFirst({ where: { name: { contains: 'Diani' } } }),
  ])
  if (!p1 || !p2 || !p3) throw new Error('Base projects missing — run `bun prisma/seed.ts` first')

  // 13 notifications across the 3 projects — every kind, mixed read/unread,
  // spread over the last 7 days. Kenyan site copy, honestly phrased.
  const rows = [
    // ---------------- P1 — Nyumba Yangu — 3BR Bungalow ----------------
    { projectId: p1.id, kind: 'recap', title: 'Daily recap · Day 62', body: `Walling at 62% — 14 fundis on site across 3 zones. ${fmtKes(4_180_000n)} wages, all attendance verified.`, recipient: p1.client, read: false, createdAt: daysAgo(0, 18, 30) },
    { projectId: p1.id, kind: 'variation', title: 'Variation VO-002 awaiting your approval', body: `Kitchen counter granite upgrade — budget impact ${fmtKes(9_500_000n)}. Approve or reject in the Money tab.`, recipient: p1.client, read: false, createdAt: daysAgo(1, 16, 5) },
    { projectId: p1.id, kind: 'anomaly', title: 'Cement price +8% vs Kiambu benchmark', body: `Simba Cement 42.5N quoted at ${fmtKes(84_500n)}/bag vs ${fmtKes(78_000n)} benchmark. Consider the Ruiru depot before ordering.`, recipient: null, read: false, createdAt: daysAgo(2, 11, 20) },
    { projectId: p1.id, kind: 'attendance', title: 'Muster exception logged', body: "Joseph Mwangi absent with reason 'funeral upcountry' — payroll flag cleared by supervisor.", recipient: null, read: false, createdAt: daysAgo(3, 8, 45) },
    { projectId: p1.id, kind: 'milestone', title: 'Milestone approved: Foundation package', body: `Client approved release of ${fmtKes(65_000_000n)} — 8 evidence photos attached to the milestone.`, recipient: p1.client, read: true, createdAt: daysAgo(4, 15, 10) },
    { projectId: p1.id, kind: 'comment', title: 'New comment on site photo', body: "Site Manager: 'Ring beam curing looks good — keep the formwork on for 7 days.'", recipient: null, read: true, createdAt: daysAgo(5, 13, 25) },

    // ---------------- P2 — Kiambu Road Duplex ----------------
    { projectId: p2.id, kind: 'recap', title: 'Daily recap · Day 23', body: 'Foundation excavation 35% complete — 9 fundis, no exceptions. Ballast lorry expected tomorrow 7am.', recipient: p2.client, read: false, createdAt: daysAgo(0, 18, 15) },
    { projectId: p2.id, kind: 'invoice', title: 'Invoice INV-0031 received', body: `Devki Steel — D12 deformed bars, 2 tonnes, ${fmtKes(26_700_000n)}. Due in 14 days, awaiting your review.`, recipient: null, read: false, createdAt: daysAgo(1, 9, 40) },
    { projectId: p2.id, kind: 'system', title: 'Escrow top-up confirmed', body: `${fmtKes(50_000_000n)} received from client. Wallet balance updated — the Foundation package is now fundable.`, recipient: p2.client, read: false, createdAt: daysAgo(2, 17, 0) },
    { projectId: p2.id, kind: 'milestone', title: 'Milestone locked: Foundation package', body: `${fmtKes(70_000_000n)} locked — release needs evidence photos and client approval. Above current wallet balance.`, recipient: p2.client, read: true, createdAt: daysAgo(6, 12, 30) },

    // ---------------- P3 — Diani Beach Bungalow Renovation ----------------
    { projectId: p3.id, kind: 'milestone', title: 'Milestone locked: Roofing package', body: `${fmtKes(42_000_000n)} locked in escrow pending evidence of old roof removal and truss installation.`, recipient: p3.client, read: false, createdAt: daysAgo(1, 14, 55) },
    { projectId: p3.id, kind: 'share', title: 'Virtual Site Visit opened', body: 'Client viewed the site via share link — 6 new photos and the latest daily recap seen.', recipient: null, read: true, createdAt: daysAgo(3, 20, 10) },
    { projectId: p3.id, kind: 'variation', title: 'Variation VO-001 decided', body: `Client rejected the rooftop pergola addition (${fmtKes(18_000_000n)}). Works continue per the original plan.`, recipient: p3.client, read: true, createdAt: daysAgo(7, 10, 15) },
  ]

  for (const row of rows) {
    await db.notification.create({ data: row })
  }

  const unread = rows.filter((r) => !r.read).length
  console.log(`Notifications: ${rows.length} seeded (${unread} unread) across 3 projects.`)
  console.log('Notification seed done.')
}

withBusyRetry(main)
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
