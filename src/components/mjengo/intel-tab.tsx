'use client'

// Intel tab (placeholder — agent 2-e replaces this file and its sections with
// the risk engine view, weekly digest and regional price trends).

import { RiskSection } from '@/components/mjengo/intel/sections/risk-section'
import { DigestSection } from '@/components/mjengo/intel/sections/digest-section'
import { PricesSection } from '@/components/mjengo/intel/sections/prices-section'

export function IntelTab() {
  return (
    <div className="space-y-6">
      <RiskSection />
      <PricesSection />
      <DigestSection />
    </div>
  )
}
