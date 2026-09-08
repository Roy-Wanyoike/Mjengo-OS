'use client'

// Intel tab — deterministic intelligence over this project's real rows:
// risk engine (5 rules), the MjengoScore contractor trust score, weekly
// digest, regional price trends, supplier reliability from actual transaction
// history, and the procurement cover check. Every number is traceable;
// nothing is "AI-guessed". W6-2 adds the weekly TRUST digest (bilingual
// EN/SW row-composed text + TTS voice note) — the AI surface with the same
// rule: the model only reads the deterministic text aloud.

import { RiskSection } from '@/frontend/mjengo/intel/sections/risk-section'
import { ScoreSection } from '@/frontend/mjengo/intel/sections/score-section'
import { DigestSection } from '@/frontend/mjengo/intel/sections/digest-section'
import { TrustDigestSection } from '@/frontend/mjengo/intel/sections/trust-digest-section'
import { PricesSection } from '@/frontend/mjengo/intel/sections/prices-section'
import { ReliabilitySection } from '@/frontend/mjengo/intel/sections/reliability-section'
import { SuggestionsSection } from '@/frontend/mjengo/intel/sections/suggestions-section'
import { JobsSection } from '@/frontend/mjengo/intel/sections/jobs-section'

export function IntelTab() {
  return (
    <div className="space-y-6">
      <RiskSection />
      <ScoreSection />
      <DigestSection />
      <TrustDigestSection />
      <PricesSection />
      <ReliabilitySection />
      <SuggestionsSection />
      <JobsSection />
    </div>
  )
}
