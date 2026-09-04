'use client'

// Land & Property tab — composition root: renders the parcels and
// professionals sections from ./land/sections/ (parcel grid + detail, the
// professionals trusted directory).
//
// Feature flag (spec §81, task 9-a): land_verification gates the PARCELS
// ladder — the land module (parcel lifecycle + title-search), whose actions
// (parcel.*, search.*) answer the uniform 403 for non-admin sessions while
// the flag is off. Non-admins get the honest notice below instead of the
// section; admins bypass (requireFlagOn rule) so they can toggle & test.
// The professionals directory is a SEPARATE module with no flag — it stays
// visible either way (hiding it behind land_verification would gate
// something the flag does not name — see flags.ts for the map).

import { useSession } from 'next-auth/react'
import { Landmark } from 'lucide-react'
import { Card, CardContent } from '@/frontend/ui/card'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { flagOnFor } from '@/frontend/mjengo/nav/tab-meta'
import { ParcelsSection } from '@/frontend/mjengo/land/sections/parcels-section'
import { ProfessionalsSection } from '@/frontend/mjengo/land/sections/professionals-section'

function LandVerificationDisabledNotice() {
  return (
    <Card className="border-amber-200 bg-amber-50 shadow-sm">
      <CardContent className="py-10 flex flex-col items-center justify-center text-center gap-3">
        <div className="w-12 h-12 rounded-2xl bg-amber-100 flex items-center justify-center" aria-hidden>
          <Landmark className="w-6 h-6 text-amber-600" />
        </div>
        <div className="max-w-md">
          <h2 className="text-base font-semibold text-stone-900">Land verification is off</h2>
          <p className="mt-1 text-sm text-stone-500 leading-relaxed" role="status">
            Disabled by feature flag (land_verification) — parcel records and the title-search ladder are closed
            for non-admin sessions. An admin can re-enable it from the Settings icon in the header. The
            professionals directory below is unaffected.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

export function LandTab() {
  const { data } = useMjengo()
  const { data: session } = useSession()
  // Admins bypass; flags not loaded yet → on (the ai_progress pattern).
  const landOn = flagOnFor(data?.intel?.flags, 'land_verification', session?.user?.role)
  return (
    <div className="space-y-6">
      {landOn ? <ParcelsSection /> : <LandVerificationDisabledNotice />}
      <ProfessionalsSection />
    </div>
  )
}
