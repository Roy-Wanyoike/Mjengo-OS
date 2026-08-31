// Intel module — data access.
//
// loadIntelSlice(projectId) loads the project's latest risk assessment, its
// recent weekly digests, and the global price-point history (regional market
// intelligence is shared across projects).

import { db } from '@/lib/db'
import type { IntelSlice } from './types'

export async function loadIntelSlice(projectId: string): Promise<IntelSlice> {
  const [risk, digests, pricePoints] = await Promise.all([
    db.riskAssessment.findFirst({
      where: { projectId },
      orderBy: { computedAt: 'desc' },
    }),
    db.intelDigest.findMany({
      where: { projectId },
      orderBy: { weekStart: 'desc' },
      take: 8,
    }),
    db.pricePoint.findMany({
      orderBy: { recordedAt: 'desc' },
      take: 500,
    }),
  ])

  return { risk, digests, pricePoints }
}
