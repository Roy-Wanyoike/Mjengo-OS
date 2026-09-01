// Domain seed (B1-DOMAIN, backend wave): the three backend-wave domain
// surfaces on the Nyumba Yangu demo project —
//   1. §14 worker record depth (Ali Hassan + Joseph Mwenda full profiles)
//   2. §26 delivery driver leg (the PO-2026-000009 truck en route)
//   3. §33 project team roster (contractor rep / supervisor / QS / surveyor)
//
// Standalone + IDEMPOTENT (name-based check-before-write) — safe to re-run
// anytime; never deletes or resets anything. Run:
//   bun prisma/seed-extras/domain.ts
// Base seed (`bun prisma/seed.ts`) must have run first (projects + workers);
// PO-2026-000009 comes from prisma/seed-extras/supply.ts.

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function seedWorkerProfile(name: string, profile: Record<string, string | null>) {
  const worker = await db.worker.findFirst({ where: { name } })
  if (!worker) {
    console.log(`  ⚠ worker "${name}" not found — run the base seed first (skipped)`)
    return
  }
  const alreadySeeded = Object.entries(profile).every(
    ([field, value]) => (worker as unknown as Record<string, unknown>)[field] === value,
  )
  if (alreadySeeded) {
    console.log(`  · ${name}: profile already in place (skipped)`)
    return
  }
  await db.worker.update({ where: { id: worker.id }, data: profile })
  console.log(`  ✓ ${name}: profile depth seeded — ${Object.keys(profile).join(', ')}`)
}

async function main() {
  const project = await db.project.findFirst({ where: { name: { contains: 'Nyumba Yangu' } } })
  if (!project) throw new Error('Base projects missing — run `bun prisma/seed.ts` first')

  console.log(`Domain seed — ${project.name}`)

  // 1) Worker record depth (Doc A §14) --------------------------------------
  console.log('§14 worker profiles:')
  await seedWorkerProfile('Ali Hassan', {
    idNumber: '28472913',
    employmentType: 'casual',
    skills: JSON.stringify(['Masonry', 'Plastering']),
    emergencyContactName: 'Fatuma Hassan',
    emergencyContactPhone: '0733111222',
  })
  await seedWorkerProfile('Joseph Mwenda', {
    idNumber: '31290457',
    employmentType: 'contract',
    skills: JSON.stringify(['Site Clearance', 'Concrete Mixing', 'Steel Fixing']),
    emergencyContactName: 'Mary Mwenda',
    emergencyContactPhone: '0720998877',
  })

  // 2) Delivery driver leg (Doc A §26) — PO-2026-000009's truck en route ----
  console.log('§26 driver leg:')
  const po = await db.purchaseOrder.findFirst({ where: { orderCode: 'PO-2026-000009', projectId: project.id } })
  if (!po) {
    console.log('  ⚠ PO-2026-000009 not found — run `bun prisma/seed-extras/supply.ts` first (skipped)')
  } else {
    const delivery = await db.orderDelivery.findFirst({ where: { orderId: po.id } })
    if (!delivery) {
      console.log('  ⚠ PO-2026-000009 has no delivery row (skipped)')
    } else if (delivery.driverName === 'David Kimani' && delivery.status === 'in_transit') {
      console.log('  · David Kimani is already en route (skipped)')
    } else {
      const now = Date.now()
      await db.orderDelivery.update({
        where: { id: delivery.id },
        data: {
          driverName: 'David Kimani',
          driverPhone: '0711223344',
          vehicleReg: 'KDA 123J',
          departedAt: new Date(now - 60 * 60 * 1000),
          etaAt: new Date(now + 2 * 60 * 60 * 1000),
          status: 'in_transit',
          // Re-staging the demo truck as en route: the August discrepancy
          // story on this row is superseded (history lives in the audit
          // ledger); the receipt fields reset so the receive flow can replay.
          receivedAt: null,
          receivedBy: null,
          note: 'Truck en route — David Kimani · KDA 123J. ETA on site in ~2h.',
        },
      })
      console.log('  ✓ PO-2026-000009 delivery: David Kimani · 0711223344 · KDA 123J — in_transit, ETA +2h')
    }
  }

  // 3) Project team roster (Doc A §33) ---------------------------------------
  console.log('§33 team roster:')
  const roster: Array<{ name: string; role: string; phone: string; email?: string; note: string }> = [
    {
      name: 'Site Manager',
      role: 'contractor',
      phone: '0722111222',
      email: 'contractor@mjengo.os',
      note: 'Contractor representative — demo login contractor@mjengo.os',
    },
    {
      name: 'Wanjiru',
      role: 'supervisor',
      phone: '0733444555',
      email: 'supervisor@mjengo.os',
      note: 'Site supervisor — daily site oversight',
    },
    {
      name: 'Kariuki',
      role: 'qs',
      phone: '0711222333',
      email: 'qs@mjengo.os',
      note: 'Quantity surveyor — BOQ + valuations',
    },
    {
      name: 'Njoroge (Surveyor)',
      role: 'surveyor',
      phone: '0799888777',
      note: 'Land surveyor — beacons + setting out',
    },
  ]
  for (const member of roster) {
    const exists = await db.projectTeam.findFirst({
      where: { projectId: project.id, name: member.name, role: member.role },
    })
    if (exists) {
      console.log(`  · ${member.name} (${member.role}) already on the roster (skipped)`)
      continue
    }
    await db.projectTeam.create({
      data: {
        projectId: project.id,
        name: member.name,
        role: member.role,
        phone: member.phone,
        email: member.email ?? null,
        note: member.note,
      },
    })
    console.log(`  ✓ ${member.name} (${member.role}) added — ${member.phone}`)
  }

  // Summary printout ----------------------------------------------------------
  const workers = await db.worker.findMany({
    where: { name: { in: ['Ali Hassan', 'Joseph Mwenda'] } },
    select: { name: true, idNumber: true, employmentType: true, skills: true, emergencyContactName: true, emergencyContactPhone: true },
  })
  const team = await db.projectTeam.findMany({
    where: { projectId: project.id },
    select: { name: true, role: true, phone: true },
    orderBy: { joinedAt: 'asc' },
  })
  const liveDelivery = po
    ? await db.orderDelivery.findFirst({ where: { orderId: po.id }, select: { driverName: true, status: true, etaAt: true } })
    : null
  console.log('\nSummary:')
  console.log(`  workers with full §14 profiles : ${workers.length}`)
  for (const w of workers) {
    console.log(`    ${w.name} — ${w.employmentType}, skills ${w.skills}, ID ${w.idNumber}, emergency ${w.emergencyContactName} ${w.emergencyContactPhone}`)
  }
  console.log(`  PO-2026-000009 driver leg      : ${liveDelivery ? `${liveDelivery.driverName} · ${liveDelivery.status} · ETA ${liveDelivery.etaAt?.toISOString()}` : 'n/a'}`)
  console.log(`  project team roster (§33)      : ${team.length} members`)
  for (const t of team) {
    console.log(`    ${t.name} — ${t.role} — ${t.phone}`)
  }
  console.log('Domain seed done.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
