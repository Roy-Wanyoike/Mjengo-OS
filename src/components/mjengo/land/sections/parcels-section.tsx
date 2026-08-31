'use client'

// Parcels section placeholder — agent 2-a replaces this file with the parcel
// list + detail timeline, document attach, title-search flow, transcription
// consistency check and the Property Passport card.

import { Card, CardContent } from '@/components/ui/card'
import { Landmark } from 'lucide-react'

export function ParcelsSection() {
  return (
    <section aria-label="Land parcels">
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-6 min-h-64 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
            <Landmark className="w-7 h-7 text-stone-500" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <h2 className="text-lg font-bold text-stone-900">Land &amp; Property — coming online</h2>
            <p className="text-sm text-stone-500 leading-relaxed">
              Parcels, title-deed documents and registry searches land here.
              This module is being wired up — data is already flowing.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
