// MjengoOS v2 — Land & Property seed (F-1).
// Registered from prisma/seed.ts (seedLand(db)); ALSO runnable standalone:
//   bun prisma/seed-extras/land.ts   (run AFTER professionals.ts — assignments
//   reference the directory)
//
// Wipes ONLY the models it owns (ParcelAssignment, TitleSearch,
// ParcelDocument, LandParcel). Two parcels on project 1 (Nyumba Yangu):
//   · LR No. 2090/1234 (Karen, Nairobi) — VERIFIED: title deed transcription
//     consistent with the registry search; review completed.
//   · LR No. 11767/890 (Kiambu) — SEARCHING: search RECEIVED with a MISMATCH
//     between the deed transcription and the registry summary — flagged for
//     human review (honest language: anomaly, not accusation).

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

function daysAgo(n: number, hour = 10, minute = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d
}

export async function seedLand(db: PrismaClient): Promise<void> {
  // FK-safe wipe of ONLY the models this seed owns
  await db.parcelAssignment.deleteMany()
  await db.titleSearch.deleteMany()
  await db.parcelDocument.deleteMany()
  await db.landParcel.deleteMany()

  const p1 = await db.project.findFirst({ where: { name: { contains: 'Nyumba Yangu' } } })
  if (!p1) throw new Error('Project 1 (Nyumba Yangu) missing — run `bun prisma/seed.ts` first')

  const david = await db.professional.findFirst({ where: { name: 'David Otieno' } })
  const margaret = await db.professional.findFirst({ where: { name: 'Margaret Wanjiru' } })
  const collins = await db.professional.findFirst({ where: { name: 'Collins Mutua' } })
  if (!david || !margaret || !collins) {
    throw new Error('Professionals missing — run `bun prisma/seed-extras/professionals.ts` first')
  }

  // ---------------- Parcel 1 — VERIFIED (Karen) ----------------
  const parcel1 = await db.landParcel.create({
    data: {
      projectId: p1.id,
      plotNumber: 'LR No. 2090/1234',
      county: 'Nairobi',
      town: 'Karen',
      lat: -1.3197,
      lng: 36.7798,
      approxArea: '0.25 ha (approx)',
      tenureType: 'freehold',
      status: 'verified', // documents + registry result AGREE — record state only
      createdAt: daysAgo(40, 9),
    },
  })

  await db.parcelDocument.createMany({
    data: [
      {
        parcelId: parcel1.id,
        kind: 'title_deed',
        fileName: 'title-deed-2090-1234.pdf',
        storageKey: '/documents/p1/title-deed-2090-1234.pdf',
        extractedText:
          'TITLE DEED — Grant I.9572/123. All that piece of land containing by measurement 0.25 hectare or thereabouts situate in the District of Nairobi, Karen, known as LR No. 2090/1234. Registered proprietor: Yusuf A. (transcribed). Tenure: FREEHOLD. Encumbrances section: nil. In witness whereof the Registrar of Titles has hereunto set his hand and seal.',
        issuedOn: daysAgo(2380, 12), // ~2019
        createdAt: daysAgo(40, 10),
      },
      {
        parcelId: parcel1.id,
        kind: 'search_cert',
        fileName: 'official-search-cert-2090-1234.pdf',
        storageKey: '/documents/p1/official-search-cert-2090-1234.pdf',
        extractedText:
          'OFFICIAL SEARCH CERTIFICATE ref CS/2026/118842 — LR No. 2090/1234, Karen, Nairobi: freehold, approx 0.25 ha, registered proprietor as per registry record. No encumbrances shown as at the date of search.',
        issuedOn: daysAgo(38, 14),
        createdAt: daysAgo(38, 14),
      },
    ],
  })

  await db.titleSearch.create({
    data: {
      parcelId: parcel1.id,
      searchRef: 'CS/2026/118842',
      resultSummary:
        'Registry record for LR No. 2090/1234: freehold, approx 0.25 ha, Karen, Nairobi. Registered proprietor matches the deed transcription; no encumbrances shown.',
      transcriptionMatch: 'consistent',
      status: 'reviewed',
      requestedAt: daysAgo(39, 9),
      receivedAt: daysAgo(38, 14),
      reviewedAt: daysAgo(36, 11),
      createdAt: daysAgo(39, 9),
    },
  })

  await db.parcelAssignment.createMany({
    data: [
      {
        parcelId: parcel1.id,
        professionalId: david.id,
        role: 'surveyor',
        status: 'completed',
        note: 'Boundary beacons confirmed on site; survey sketch matched the registry map.',
        createdAt: daysAgo(35, 10),
      },
      {
        parcelId: parcel1.id,
        professionalId: collins.id,
        role: 'advocate',
        status: 'active',
        note: 'Preparing the land due-diligence opinion letter for the client.',
        createdAt: daysAgo(20, 11),
      },
    ],
  })

  // ---------------- Parcel 2 — SEARCHING with MISMATCH (Kiambu) ----------------
  const parcel2 = await db.landParcel.create({
    data: {
      projectId: p1.id,
      plotNumber: 'LR No. 11767/890',
      county: 'Kiambu',
      town: 'Kiambu',
      lat: -1.1714,
      lng: 36.8356,
      approxArea: '0.1 ha (approx)',
      tenureType: 'leasehold 99 years from 1988',
      status: 'searching',
      createdAt: daysAgo(12, 9),
    },
  })

  await db.parcelDocument.create({
    data: {
      parcelId: parcel2.id,
      kind: 'title_deed',
      fileName: 'title-deed-11767-890.pdf',
      storageKey: '/documents/p1/title-deed-11767-890.pdf',
      extractedText:
        'TITLE (LEASEHOLD) — All that piece of land containing by measurement 0.1 hectare or thereabouts situate in Kiambu known as LR No. 11767/890. Registered proprietor (transcribed): J. K. Mwangi. Leasehold for a term of 99 years from 1 January 1988. Encumbrances section: as per registry.',
      issuedOn: daysAgo(12800, 12), // ~1988-1990
      createdAt: daysAgo(12, 10),
    },
  })

  await db.titleSearch.create({
    data: {
      parcelId: parcel2.id,
      searchRef: 'CS/2026/119204',
      resultSummary:
        'Registry record for LR No. 11767/890: leasehold, approx 0.08 ha (differs from the 0.1 ha deed transcription), 45 years remaining on the term. Registered proprietor recorded as E. N. Wanjiku — DIFFERS from the deed transcription. Review required.',
      transcriptionMatch: 'mismatch',
      status: 'received',
      requestedAt: daysAgo(11, 9),
      receivedAt: daysAgo(3, 15),
      createdAt: daysAgo(11, 9),
    },
  })

  await db.parcelAssignment.create({
    data: {
      parcelId: parcel2.id,
      professionalId: margaret.id,
      role: 'surveyor',
      status: 'active',
      note: 'Commissioned to re-establish beacons once the registry mismatch is reviewed.',
      createdAt: daysAgo(2, 10),
    },
  })

  console.log('seedLand: 2 parcels (1 verified, 1 searching w/ mismatch), 3 documents, 2 searches, 3 assignments')
}

// Standalone runner (Bun): `bun prisma/seed-extras/land.ts`
if ((import.meta as { main?: boolean }).main === true) {
  seedLand(db)
    .catch((e) => { console.error(e); process.exit(1) })
    .finally(() => db.$disconnect())
}
