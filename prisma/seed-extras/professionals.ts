// MjengoOS v2 — Professionals directory seed (F-1).
// Registered from prisma/seed.ts (seedProfessionals(db)); ALSO runnable
// standalone:  bun prisma/seed-extras/professionals.ts
//
// Wipes ONLY the models it owns (CredentialCheck, ParcelAssignment,
// Professional) so it is safe to re-run. Honest data: verificationState is a
// platform ladder (0-6) from recorded checks — one entry carries a recorded
// "licence expired — renewal pending" finding, exactly as found.

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

function daysAgo(n: number, hour = 10, minute = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d
}

export async function seedProfessionals(db: PrismaClient): Promise<void> {
  // FK-safe wipe of ONLY the models this seed owns
  await db.credentialCheck.deleteMany()
  await db.parcelAssignment.deleteMany() // assignments reference professionals
  await db.professional.deleteMany()

  // ---------------- directory (6 professionals, mixed ladders) ----------------
  const pros = await Promise.all([
    db.professional.create({
      data: {
        name: 'David Otieno',
        category: 'surveyor',
        organisation: 'Otieno & Partners Land Surveyors',
        phone: '0722451188',
        email: 'david@otienosurvey.co.ke',
        county: 'Nairobi',
        licenceNumber: 'EBK/LS/1982',
        licenceBody: 'EBK',
        verificationState: 5,
        reliabilityScore: 88,
        notes: 'EBK-registered land surveyor. 2 credential checks recorded — registry lookup consistent + client references confirmed.',
        createdAt: daysAgo(120, 9),
      },
    }),
    db.professional.create({
      data: {
        name: 'Margaret Wanjiru',
        category: 'surveyor',
        organisation: 'Wanjiru Geospatial Ltd',
        phone: '0718663900',
        email: 'mwangiru@wanjirugeo.co.ke',
        county: 'Kiambu',
        licenceNumber: 'EBK/LS/2310',
        licenceBody: 'EBK',
        verificationState: 2,
        reliabilityScore: 61,
        notes: 'Licence copy reviewed; EBK registry confirmation still pending.',
        createdAt: daysAgo(34, 11),
      },
    }),
    db.professional.create({
      data: {
        name: 'Collins Mutua',
        category: 'advocate',
        organisation: 'Mutua & Associates Advocates',
        phone: '0733004721',
        email: 'collins@mutuaadvocates.co.ke',
        county: 'Nairobi',
        licenceNumber: 'LSK/P/999/2014',
        licenceBody: 'LSK',
        verificationState: 4,
        reliabilityScore: 82,
        notes: 'Conveyancing + land due diligence. LSK registry lookup consistent.',
        createdAt: daysAgo(88, 9),
      },
    }),
    db.professional.create({
      data: {
        name: 'Eng. Peter Kamau',
        category: 'engineer',
        organisation: 'Kamau Structural Engineering',
        phone: '0722991540',
        email: 'peter@kamause.co.ke',
        county: 'Nairobi',
        licenceNumber: 'EBK/EN/1123',
        licenceBody: 'EBK',
        verificationState: 3,
        reliabilityScore: 72,
        notes: 'Structural engineer. Reference calls confirmed on 2 completed bungalows.',
        createdAt: daysAgo(60, 10),
      },
    }),
    db.professional.create({
      data: {
        name: 'Grace Achieng',
        category: 'qty_surveyor',
        organisation: 'Achieng Quantity Surveying',
        phone: '0790556612',
        email: 'grace@achiengqs.co.ke',
        county: 'Nairobi',
        licenceNumber: 'BORAQS/QS/4552',
        licenceBody: 'BORAQS',
        verificationState: 1,
        reliabilityScore: 55,
        notes: 'New to the directory — details captured, no credential checks recorded yet.',
        createdAt: daysAgo(9, 14),
      },
    }),
    db.professional.create({
      data: {
        name: 'Arch. Susan Njeri',
        category: 'architect',
        organisation: 'Njeri Design Studio',
        phone: '0711224800',
        email: 'susan@njeridesign.co.ke',
        county: 'Nairobi',
        licenceNumber: 'BORAQS/AR/2087',
        licenceBody: 'BORAQS',
        verificationState: 4,
        reliabilityScore: 78,
        notes: 'Experienced architect (3 platform projects). Latest credential check recorded a finding — see below; renewal receipt awaited before any further state change.',
        createdAt: daysAgo(75, 9),
      },
    }),
  ])

  const [david, margaret, collins, peter, , susan] = pros

  // ---------------- recorded credential checks ----------------
  await db.credentialCheck.createMany({
    data: [
      // David Otieno — EBK-registered surveyor, 2 checks
      {
        professionalId: david.id,
        checkedBy: 'Site Manager',
        method: 'registry_lookup',
        finding: 'EBK register shows licence EBK/LS/1982 active, category "Land Surveyor". Name and licence number match the directory entry.',
        recordedAt: daysAgo(118, 12),
      },
      {
        professionalId: david.id,
        checkedBy: 'Site Manager',
        method: 'reference_call',
        finding: 'Called 2 past clients — both confirmed boundary beacons and survey sketches delivered on time. No discrepancies reported.',
        recordedAt: daysAgo(110, 15),
      },
      // Margaret Wanjiru — document reviewed only
      {
        professionalId: margaret.id,
        checkedBy: 'Site Manager',
        method: 'document_review',
        finding: 'Licence copy provided and legible; EBK registry confirmation still pending — recorded as unverified until the lookup completes.',
        recordedAt: daysAgo(30, 11),
      },
      // Collins Mutua — LSK lookup
      {
        professionalId: collins.id,
        checkedBy: 'Site Manager',
        method: 'registry_lookup',
        finding: 'LSK membership current (Advocate No. P.999/2014) with a valid practising certificate on file.',
        recordedAt: daysAgo(80, 10),
      },
      // Eng. Peter Kamau — reference call
      {
        professionalId: peter.id,
        checkedBy: 'Site Manager',
        method: 'reference_call',
        finding: 'Reference call confirmed structural work on 2 completed bungalows (Runda + Nyali). One client noted slow reporting on the final snag list.',
        recordedAt: daysAgo(50, 16),
      },
      // Arch. Susan Njeri — the honest finding
      {
        professionalId: susan.id,
        checkedBy: 'Site Manager',
        method: 'document_review',
        finding: 'BORAQS practising licence expired — renewal pending. Recorded as found; renewal receipt awaited before any further verification steps.',
        recordedAt: daysAgo(4, 9),
      },
    ],
  })

  console.log('seedProfessionals: 6 professionals, 6 credential checks')
}

// Standalone runner (Bun): `bun prisma/seed-extras/professionals.ts`
if ((import.meta as { main?: boolean }).main === true) {
  seedProfessionals(db)
    .catch((e) => { console.error(e); process.exit(1) })
    .finally(() => db.$disconnect())
}
