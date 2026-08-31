'use client'

// Price trends section placeholder — agent 2-e replaces this file with
// regional price bands + trends per material (Nairobi / Kiambu / Machakos).

import { Card, CardContent } from '@/components/ui/card'
import { TrendingUp } from 'lucide-react'

export function PricesSection() {
  return (
    <section aria-label="Price trends">
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-6 min-h-64 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
            <TrendingUp className="w-7 h-7 text-stone-500" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <h2 className="text-lg font-bold text-stone-900">Price intelligence — coming online</h2>
            <p className="text-sm text-stone-500 leading-relaxed">
              Regional material price trends land here.
              This module is being wired up — data is already flowing.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
