'use client'

// USSD simulation tab (placeholder — agent 2-f replaces this file with the
// phone-frame *384# menu → PIN → attendance muster simulator, labeled
// SIMULATION, creating real Attendance rows via the existing action).

import { Card, CardContent } from '@/components/ui/card'
import { Phone } from 'lucide-react'

export function UssdTab() {
  return (
    <div className="space-y-6">
      <section aria-label="USSD simulation">
        <Card className="border-stone-200 shadow-sm">
          <CardContent className="p-6 min-h-64 flex flex-col items-center justify-center text-center gap-4">
            <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
              <Phone className="w-7 h-7 text-stone-500" />
            </div>
            <div className="space-y-1.5 max-w-md">
              <h2 className="text-lg font-bold text-stone-900">USSD muster line — coming online</h2>
              <p className="text-sm text-stone-500 leading-relaxed">
                The *384# attendance simulation for feature phones lands here.
                This module is being wired up — data is already flowing.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
