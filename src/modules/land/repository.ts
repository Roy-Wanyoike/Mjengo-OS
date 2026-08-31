// Land & Property module — data access.
//
// loadLandSlice(projectId) fetches every parcel for the project with its
// documents, registry searches and assignments (professional inlined as a
// display summary). Keep queries simple: one include-tree per root row.

import { db } from '@/lib/db'
import type { LandSlice, ParcelDetail, AssignmentSummary } from './types'

export async function loadLandSlice(projectId: string): Promise<LandSlice> {
  const parcels = await db.landParcel.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    include: {
      documents: { orderBy: { createdAt: 'desc' } },
      searches: { orderBy: { createdAt: 'desc' } },
      assignments: {
        include: { professional: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  const details: ParcelDetail[] = parcels.map((p) => ({
    ...p,
    assignments: p.assignments.map(
      (a): AssignmentSummary => ({
        ...a,
        professionalName: a.professional.name,
        professionalCategory: a.professional.category,
      }),
    ),
  }))

  return { parcels: details }
}
