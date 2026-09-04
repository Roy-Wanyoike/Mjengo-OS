'use client'

// Land & Property tab — composition root: renders the parcels and
// professionals sections from ./land/sections/ (parcel grid + detail, the
// professionals trusted directory).

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
