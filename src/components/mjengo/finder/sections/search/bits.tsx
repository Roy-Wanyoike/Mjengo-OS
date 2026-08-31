'use client'

// Shared display bits for the Finder search section — stock/ETA/score chips,
// distance + weight-part helpers. House style: stone + amber/earth palette,
// lucide icons, tabular numbers (money-tab / invoices-bits conventions).

import { Badge } from '@/components/ui/badge'
import { Gauge, Star, Truck, PackageX, PackageCheck, PackageMinus } from 'lucide-react'
import { formatKES } from '@/lib/format'
import type { CompareRow, EtaTier, StockState } from '@/modules/supply/types'

export const formatKes = formatKES

export function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function fmtKm(km: number | null): string {
  if (km === null) return '—'
  return `${km.toFixed(1)} km`
}

export function StockBadge({ state, stockQty, qty }: { state: StockState; stockQty: number; qty: number }) {
  if (state === 'full') {
    return (
      <Badge className="border-0 bg-emerald-100 text-emerald-800 gap-1 hover:bg-emerald-100" title={`Stock ${fmtQty(stockQty)}`}>
        <PackageCheck className="h-3 w-3" aria-hidden /> In stock
      </Badge>
    )
  }
  if (state === 'partial') {
    return (
      <Badge className="border-0 bg-amber-100 text-amber-900 gap-1 hover:bg-amber-100" title={`Stock ${fmtQty(stockQty)} of ${fmtQty(qty)} needed`}>
        <PackageMinus className="h-3 w-3" aria-hidden /> Partial
      </Badge>
    )
  }
  return (
    <Badge className="border-0 bg-stone-100 text-stone-500 gap-1 hover:bg-stone-100" title="No stock recorded">
      <PackageX className="h-3 w-3" aria-hidden /> Out of stock
    </Badge>
  )
}

const ETA_ICON: Record<EtaTier, string> = {
  'same day': 'bg-emerald-100 text-emerald-800',
  'next day': 'bg-amber-100 text-amber-900',
  '2+ days': 'bg-stone-100 text-stone-600',
}

export function EtaBadge({ tier }: { tier: EtaTier }) {
  return (
    <Badge className={`border-0 gap-1 hover:opacity-90 ${ETA_ICON[tier]}`} title="Estimated from the supplier's average response time (v1) — real ETA arrives with quotes">
      <Truck className="h-3 w-3" aria-hidden /> {tier}
    </Badge>
  )
}

/** Reliability chip — 0-100 from actual platform transaction history (§16). */
export function RatingBadge({ score }: { score: number }) {
  const tone = score >= 80 ? 'bg-emerald-100 text-emerald-800' : score >= 65 ? 'bg-amber-100 text-amber-900' : 'bg-stone-100 text-stone-600'
  return (
    <Badge className={`border-0 gap-1 hover:opacity-90 ${tone}`} title="Supplier reliability from delivery accuracy, on-time history, price consistency and disputes (platform transactions)">
      <Star className="h-3 w-3" aria-hidden /> {score}/100
    </Badge>
  )
}

/** The weighted-score bar with its five documented parts (§4). */
export function ScoreBar({ row }: { row: CompareRow }) {
  const pct = Math.round(row.scores.total * 100)
  const parts = [
    { label: 'Price', value: row.scores.price, weight: '0.45' },
    { label: 'Distance', value: row.scores.distance, weight: '0.15' },
    { label: 'Stock', value: row.scores.stock, weight: '0.15' },
    { label: 'Speed', value: row.scores.speed, weight: '0.10' },
    { label: 'Reliability', value: row.scores.reliability, weight: '0.15' },
  ]
  return (
    <div className="space-y-1.5 w-full max-w-xs">
      <div className="flex items-center gap-2 text-[11px] text-stone-500">
        <Gauge className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-stone-700">Weighted score</span>
        <span className="tabular-nums font-semibold text-stone-800">{pct}/100</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-stone-100"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Weighted score ${pct} of 100`}
      >
        <div className="h-full rounded-full bg-amber-600" style={{ width: `${pct}%` }} />
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-stone-500">
        {parts.map((p) => (
          <li key={p.label} className="flex justify-between tabular-nums">
            <span>{p.label} ×{p.weight}</span>
            <span className="text-stone-600">{Math.round(p.value * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export const DELIVERY_DAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'any', label: 'Any day' },
  { value: 'same_day', label: 'Same day' },
  { value: 'next_day', label: 'Next day' },
  { value: 'two_days', label: 'Within 2 days' },
]

export const RADIUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'any', label: 'Any distance' },
  { value: '5', label: 'Within 5 km' },
  { value: '10', label: 'Within 10 km' },
  { value: '25', label: 'Within 25 km' },
  { value: '50', label: 'Within 50 km' },
]
