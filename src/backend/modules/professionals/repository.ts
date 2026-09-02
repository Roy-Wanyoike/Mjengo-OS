// Professionals directory module — data access.
//
// loadProfessionalsSlice(projectId) loads the GLOBAL directory (professionals
// are not project-scoped) with each professional's credential checks, plus the
// assignments that belong to THIS project's parcels.

import { db } from '@/backend/lib/db'
import type { ProfessionalsSlice, ProfessionalWithChecks, AssignmentDetail } from './types'

export async function loadProfessionalsSlice(projectId: string): Promise<ProfessionalsSlice> {
  const [professionals, assignments] = await Promise.all([
    db.professional.findMany({
      orderBy: [{ verificationState: 'desc' }, { name: 'asc' }],
      include: { credentialChecks: { orderBy: { recordedAt: 'desc' } } },
    }),
    db.parcelAssignment.findMany({
      where: { parcel: { projectId } },
      include: { parcel: true, professional: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  const countByPro = new Map<string, number>()
  for (const a of assignments) {
    countByPro.set(a.professionalId, (countByPro.get(a.professionalId) ?? 0) + 1)
  }

  const rows: ProfessionalWithChecks[] = professionals.map((p) => ({
    ...p,
    assignmentCount: countByPro.get(p.id) ?? 0,
  }))

  const assignmentRows: AssignmentDetail[] = assignments.map((a) => ({
    ...a,
    professionalName: a.professional.name,
    parcelPlotNumber: a.parcel.plotNumber,
    parcelCounty: a.parcel.county,
  }))

  return { professionals: rows, assignments: assignmentRows }
}
