'use client'

// Land & Property tab (placeholder — agent 2-a replaces parcels-section, 2-b
// replaces professionals-section; this file stays the composition root).
// Sections: parcels + professionals directory.

import { ParcelsSection } from '@/frontend/mjengo/land/sections/parcels-section'
import { ProfessionalsSection } from '@/frontend/mjengo/land/sections/professionals-section'

export function LandTab() {
  return (
    <div className="space-y-6">
      <ParcelsSection />
      <ProfessionalsSection />
    </div>
  )
}
