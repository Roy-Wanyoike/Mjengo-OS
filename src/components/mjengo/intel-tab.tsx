'use client'

// Intel tab — deterministic intelligence over this project's real rows:
// risk engine (5 rules), weekly digest, regional price trends, supplier
// reliability from actual transaction history, and the procurement cover
// check. Every number is traceable; nothing is "AI-guessed".

import { RiskSection } from '@/components/mjengo/intel/sections/risk-section'
import { DigestSection } from '@/components/mjengo/intel/sections/digest-section'
import { PricesSection } from '@/components/mjengo/intel/sections/prices-section'
import { ReliabilitySection } from '@/components/mjengo/intel/sections/reliability-section'
import { SuggestionsSection } from '@/components/mjengo/intel/sections/suggestions-section'
import { JobsSection } from '@/components/mjengo/intel/sections/jobs-section'

export function IntelTab() {
  return (
    <div className="space-y-6">
      <RiskSection />
      <DigestSection />
      <PricesSection />
      <ReliabilitySection />
      <SuggestionsSection />
      <JobsSection />
    </div>
  )
}
