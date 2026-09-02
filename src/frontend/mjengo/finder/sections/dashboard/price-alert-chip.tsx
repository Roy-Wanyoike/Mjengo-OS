'use client'

// Price alert chip (Finder §17/§20 — read-only): 30-day delta for a material
// from the intel module's PricePoints (seeded data), computed with the pure
// priceDelta() the module shares. Read-only by design — trends belong to the
// Intel tab (agent 2-e); this chip surfaces the headline number next to
// purchasing decisions.

import { TrendingDown, TrendingUp } from 'lucide-react'
import { Badge } from '@/frontend/ui/badge'
import { priceDelta } from '@/backend/modules/supply/insights'
import type { PricePoint } from '@prisma/client'

export function PriceAlertChip({ pricePoints }: { pricePoints: PricePoint[] }) {
  // recordedAt arrives as an ISO string over the payload API (JSON) — normalize
  const cement = priceDelta(
    pricePoints.map((p) => ({ ...p, recordedAt: new Date(p.recordedAt).toISOString() })),
    'cement',
    30,
  )
  if (!cement) return null
  const up = cement.pct > 0
  return (
    <Badge
      variant="outline"
      // whitespace-normal + shrink override the Badge base (whitespace-nowrap
      // shrink-0) so the chip wraps on narrow screens instead of blowing the
      // card-header grid track past the viewport (the 390px overflow case).
      className={`gap-1 whitespace-normal text-left font-normal ${up ? 'border-orange-200 bg-orange-50 text-orange-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}
      title={`Avg across regions: ${cement.from} → ${cement.to} over the last ${cement.windowDays} days (intel price points)`}
    >
      {up ? <TrendingUp className="h-3 w-3" aria-hidden /> : <TrendingDown className="h-3 w-3" aria-hidden />}
      Cement {up ? '+' : ''}{cement.pct}% over 30d — consider scheduling orders early
    </Badge>
  )
}
