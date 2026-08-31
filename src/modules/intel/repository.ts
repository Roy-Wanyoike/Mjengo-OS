// Intel module — data access.
//
// loadIntelSlice(projectId) loads the project's latest risk assessment, its
// recent weekly digests, and the global price-point history (regional market
// intelligence is shared across projects), then computes the read-side rows
// (price trends, procurement cover suggestions, supplier reliability
// breakdowns) so the client never derives numbers itself.

import { db } from '@/lib/db'
import { computeSuggestions, type SuggestionDoc } from './engine'
import { priceTrends, openProcurementDocs, reliabilityBreakdowns } from './service'
import type { IntelSlice } from './types'

export async function loadIntelSlice(projectId: string): Promise<IntelSlice> {
  const [risk, digests, pricePoints, trends, docs, reliability] = await Promise.all([
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
    priceTrends(),
    openProcurementDocs(projectId),
    reliabilityBreakdowns(),
  ])

  // §19-lite cover check over every price-tracked material.
  const trackedMaterials = Array.from(new Set(trends.map((t) => t.materialName)))
  const suggestions = computeSuggestions(trackedMaterials, docs as SuggestionDoc[])

  return { risk, digests, pricePoints, priceTrends: trends, suggestions, reliability }
}
