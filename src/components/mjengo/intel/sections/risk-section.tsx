'use client'

// Risk section placeholder — agent 2-e replaces this file with the risk
// engine view (overall score, rule findings, recompute button).

import { Card, CardContent } from '@/components/ui/card'
import { ShieldAlert } from 'lucide-react'

export function RiskSection() {
  return (
    <section aria-label="Project risk">
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-6 min-h-64 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
            <ShieldAlert className="w-7 h-7 text-stone-500" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <h2 className="text-lg font-bold text-stone-900">Risk signals — coming online</h2>
            <p className="text-sm text-stone-500 leading-relaxed">
              Deterministic risk rules over this project&apos;s real data land here.
              This module is being wired up — data is already flowing.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
