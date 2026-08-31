'use client'

// Finder search section placeholder — agent 2-c replaces this file with
// "Find Materials Near This Site": material + qty → nearby suppliers, total
// landed cost compare + weighted ranking (Best Overall, not just cheapest).

import { Card, CardContent } from '@/components/ui/card'
import { PackageSearch } from 'lucide-react'

export function SearchSection() {
  return (
    <section aria-label="Find materials">
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-6 min-h-64 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
            <PackageSearch className="w-7 h-7 text-stone-500" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <h2 className="text-lg font-bold text-stone-900">Find Materials — coming online</h2>
            <p className="text-sm text-stone-500 leading-relaxed">
              Search suppliers near this site and compare total landed cost.
              This module is being wired up — data is already flowing.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
