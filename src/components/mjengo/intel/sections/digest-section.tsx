'use client'

// Weekly digest section placeholder — agent 2-e replaces this file with the
// weekly IntelDigest view (progress, spend, prices, pending decisions).

import { Card, CardContent } from '@/components/ui/card'
import { Newspaper } from 'lucide-react'

export function DigestSection() {
  return (
    <section aria-label="Weekly digest">
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-6 min-h-64 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
            <Newspaper className="w-7 h-7 text-stone-500" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <h2 className="text-lg font-bold text-stone-900">Weekly digest — coming online</h2>
            <p className="text-sm text-stone-500 leading-relaxed">
              The weekly project digest lands here.
              This module is being wired up — data is already flowing.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
