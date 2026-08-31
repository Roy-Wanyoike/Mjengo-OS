// MjengoOS v2 — Intel seed (F-1).
// Registered from prisma/seed.ts (seedIntel(db)); ALSO runnable standalone:
//   bun prisma/seed-extras/intel.ts   (run LAST — also emits notifications)
//
// Wipes ONLY the models it owns: RiskAssessment, IntelDigest, PricePoint, and
// Notifications of the v2 KINDS it seeds (approval.requested,
// delivery.discrepancy, invoice.submitted, price.alert) — other notification
// kinds (milestone, variation…) are left for their owners. This makes it safe
// to re-run AFTER seed-extras/money.ts, which wipes all notifications.

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

function daysAgo(n: number, hour = 10, minute = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d
}

/** ISO date of this week's Monday (digest weekStart convention). */
function thisMonday(): string {
  const d = new Date()
  const dow = (d.getDay() + 6) % 7 // Monday = 0
  d.setDate(d.getDate() - dow)
  return d.toISOString().slice(0, 10)
}

const V2_KINDS = ['approval.requested', 'delivery.discrepancy', 'invoice.submitted', 'price.alert']

export async function seedIntel(db: PrismaClient): Promise<void> {
  // FK-safe wipe of ONLY the models this seed owns
  await db.riskAssessment.deleteMany()
  await db.intelDigest.deleteMany()
  await db.pricePoint.deleteMany()
  await db.notification.deleteMany({ where: { kind: { in: V2_KINDS } } })

  const p1 = await db.project.findFirst({ where: { name: { contains: 'Nyumba Yangu' } } })
  if (!p1) throw new Error('Project 1 (Nyumba Yangu) missing — run `bun prisma/seed.ts` first')

  // ---------------- price points (cement + Y12 steel × 3 regions × 8 weeks) ----------------
  // Gentle upward trend, wobble included; 8 weekly points ending this week.
  const series: Array<[string, string, number[]]> = [
    // [material, region, prices oldest → newest]
    ['Cement 50kg', 'Nairobi', [728, 732, 731, 736, 741, 745, 748, 754]],
    ['Cement 50kg', 'Kiambu', [721, 724, 726, 725, 731, 736, 739, 744]],
    ['Cement 50kg', 'Machakos', [736, 739, 741, 745, 749, 753, 757, 764]],
    ['Steel bar Y12 (12m length)', 'Nairobi', [9420, 9460, 9490, 9510, 9580, 9640, 9690, 9780]],
    ['Steel bar Y12 (12m length)', 'Kiambu', [9380, 9410, 9440, 9470, 9520, 9580, 9620, 9720]],
    ['Steel bar Y12 (12m length)', 'Machakos', [9540, 9570, 9610, 9650, 9700, 9760, 9820, 9910]],
  ]
  for (const [materialName, region, prices] of series) {
    await db.pricePoint.createMany({
      data: prices.map((unitPrice, i) => ({
        materialName,
        region,
        unitPrice,
        recordedAt: daysAgo(7 * (prices.length - 1 - i), 11),
        source: 'seed',
      })),
    })
  }

  // ---------------- risk assessment (deterministic findings) ----------------
  await db.riskAssessment.create({
    data: {
      projectId: p1.id,
      computedAt: daysAgo(0, 8),
      overallScore: 58,
      findings: JSON.stringify([
        { rule: 'budget_pace', severity: 'warning', detail: 'Spend is 12% ahead of the linear plan for the current day count', score: 18 },
        { rule: 'delivery_discrepancy', severity: 'warning', detail: '1 of 2 recent deliveries closed with a quantity discrepancy (48 of 50 cement bags received)', score: 22 },
        { rule: 'attendance_verification', severity: 'info', detail: 'Some attendance rows are reported-only — no worker-side evidence recorded yet', score: 12 },
        { rule: 'pending_decisions', severity: 'info', detail: '2 decisions awaiting humans (material request approval + invoice decision)', score: 6 },
      ]),
      ruleVersion: 'v1',
    },
  })

  // ---------------- weekly digest (this week) ----------------
  await db.intelDigest.create({
    data: {
      projectId: p1.id,
      weekStart: thisMonday(),
      summary:
        'Walling at 68% · spend tracking 12% ahead of plan · one delivery discrepancy (48/50 bags) closed with the supplier notified · cement trending up ~3.5% regionally · ring-beam package (PO-2026-000012) in transit.',
      items: JSON.stringify([
        { kind: 'progress', title: 'Walling to ring beam at 68%', detail: 'Lintel steel on site; ring beam pour scheduled after the in-transit delivery lands.' },
        { kind: 'spend', title: 'Spend 12% ahead of linear plan', detail: 'Driven by early materials buys ahead of the cement price trend.' },
        { kind: 'discrepancy', title: 'Delivery discrepancy closed', detail: 'PO-2026-000009: 48 of 50 cement bags received — 2 missing, supplier notified, awaiting reconciliation.' },
        { kind: 'price_trend', title: 'Cement up ~3.5% over 8 weeks', detail: 'Nairobi 754 avg this week (from 728). Consider scheduling the next order early.' },
      ]),
      createdAt: daysAgo(0, 8, 30),
    },
  })

  // ---------------- notifications (new kinds, project 1) ----------------
  await db.notification.createMany({
    data: [
      {
        projectId: p1.id,
        kind: 'approval.requested',
        title: 'Approval needed: MR-1043',
        body: 'Ballast & river sand request (~KSh 29,300) is waiting for a contractor decision.',
        recipient: 'Site Manager',
        audienceRole: 'contractor',
        read: false,
        createdAt: daysAgo(2, 9, 30),
      },
      {
        projectId: p1.id,
        kind: 'delivery.discrepancy',
        title: 'Delivery discrepancy: PO-2026-000009',
        body: '48 of 50 cement bags received — 2 missing. Supplier notified; review required.',
        recipient: 'Site Manager',
        audienceRole: 'contractor',
        read: true,
        readAt: daysAgo(7, 10),
        createdAt: daysAgo(8, 14, 30),
      },
      {
        projectId: p1.id,
        kind: 'invoice.submitted',
        title: 'Invoice INV-2026-000031 submitted',
        body: 'KSh 138,500 from Kiambu Road Building Supplies — awaiting your decision.',
        recipient: 'Amina & Yusuf (Diaspora · Boston)',
        audienceRole: 'client',
        read: false,
        createdAt: daysAgo(1, 9, 30),
      },
      {
        projectId: p1.id,
        kind: 'price.alert',
        title: 'Cement price trending up',
        body: 'Nairobi cement is up ~3.5% over 8 weeks (728 → 754). Consider scheduling the next order early.',
        audienceRole: 'all',
        read: true,
        readAt: daysAgo(4, 16),
        createdAt: daysAgo(5, 12),
      },
    ],
  })

  console.log('seedIntel: 48 price points, 1 risk assessment (score 58), 1 digest, 4 notifications')
}

// Standalone runner (Bun): `bun prisma/seed-extras/intel.ts`
if ((import.meta as { main?: boolean }).main === true) {
  seedIntel(db)
    .catch((e) => { console.error(e); process.exit(1) })
    .finally(() => db.$disconnect())
}
