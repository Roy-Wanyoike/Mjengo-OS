'use client'

// Finder invoices section placeholder — agent 2-d replaces this file with the
// invoice lifecycle: draft → submitted → client decision → paid (with method +
// reference → Transaction ledger entry), the 3-way match warning and the
// printable invoice view.

import { Card, CardContent } from '@/components/ui/card'
import { ReceiptText } from 'lucide-react'

export function InvoicesSection() {
  return (
    <section aria-label="Supplier invoices">
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-6 min-h-64 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
            <ReceiptText className="w-7 h-7 text-stone-500" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <h2 className="text-lg font-bold text-stone-900">Invoices — coming online</h2>
            <p className="text-sm text-stone-500 leading-relaxed">
              Supplier invoices, client decisions and payment records land here.
              This module is being wired up — data is already flowing.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
