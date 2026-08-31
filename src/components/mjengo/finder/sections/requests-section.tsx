'use client'

// Finder requests section placeholder — agent 2-c replaces this file with the
// purchase-request flow: create/submit, approval rules engine + decisions,
// quotes, PO lifecycle (approve → send → confirm → dispatch) and delivery
// receive with evidence (photos/GPS + per-line counts → discrepancy).

import { Card, CardContent } from '@/components/ui/card'
import { ClipboardList } from 'lucide-react'

export function RequestsSection() {
  return (
    <section aria-label="Requests, approvals, orders and delivery">
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-6 min-h-64 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
            <ClipboardList className="w-7 h-7 text-stone-500" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <h2 className="text-lg font-bold text-stone-900">Requests &amp; Orders — coming online</h2>
            <p className="text-sm text-stone-500 leading-relaxed">
              Purchase requests, approvals, purchase orders and verified deliveries land here.
              This module is being wired up — data is already flowing.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
