'use client'

// Finder procurement dashboard section placeholder — agent 2-c replaces this
// file with Required / Purchased / Committed / Remaining (KES), pending
// requests, pending approvals, orders in transit, deliveries today, price
// alerts and supplier issues (+ BOQ remaining + procurement suggestions).

import { Card, CardContent } from '@/components/ui/card'
import { LayoutGrid } from 'lucide-react'

export function DashboardSection() {
  return (
    <section aria-label="Procurement dashboard">
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-6 min-h-64 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
            <LayoutGrid className="w-7 h-7 text-stone-500" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <h2 className="text-lg font-bold text-stone-900">Procurement dashboard — coming online</h2>
            <p className="text-sm text-stone-500 leading-relaxed">
              Committed spend, pending approvals and orders in transit land here.
              This module is being wired up — data is already flowing.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
