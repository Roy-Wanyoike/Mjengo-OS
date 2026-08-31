'use client'

// Professionals directory section placeholder — agent 2-b replaces this file
// with the directory (filters by category/county/verification state),
// credential-check recording and parcel assignments.

import { Card, CardContent } from '@/components/ui/card'
import { UserCog } from 'lucide-react'

export function ProfessionalsSection() {
  return (
    <section aria-label="Professionals directory">
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-6 min-h-64 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
            <UserCog className="w-7 h-7 text-stone-500" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <h2 className="text-lg font-bold text-stone-900">Professionals directory — coming online</h2>
            <p className="text-sm text-stone-500 leading-relaxed">
              Surveyors, advocates, engineers and their recorded credential checks land here.
              This module is being wired up — data is already flowing.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
