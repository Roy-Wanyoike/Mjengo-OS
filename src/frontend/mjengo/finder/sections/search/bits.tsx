'use client'

// Shared display bits for the Finder search section — stock/ETA/score chips,
// distance + weight-part helpers. House style: stone + amber/earth palette,
// lucide icons, tabular numbers (money-tab / invoices-bits conventions).

import { Badge } from '@/frontend/ui/badge'
import { Gauge, Star, Truck, PackageX, PackageCheck, PackageMinus, LineChart } from 'lucide-react'
import { formatKES, dateShort } from '@/frontend/lib/format'
import { useT } from '@/frontend/i18n/provider'
import type { CompareRow, EtaTier, StockState } from '@/backend/modules/supply/types'

export const formatKes = formatKES

/** One regional price observation for the searched material (intel PricePoint). */
export interface PricePointLite {
  unitPrice: number
  region: string
  recordedAt: string | Date
}

export function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function fmtKm(km: number | null): string {
  if (km === null) return '—'
  return `${km.toFixed(1)} km`
}

export function StockBadge({ state, stockQty, qty }: { state: StockState; stockQty: number; qty: number }) {
  const t = useT()
  if (state === 'full') {
    return (
      <Badge className="border-0 bg-emerald-100 text-emerald-800 gap-1 hover:bg-emerald-100" title={t('finder.stock.fullTitle', { qty: fmtQty(stockQty) })}>
        <PackageCheck className="h-3 w-3" aria-hidden /> {t('finder.stock.full')}
      </Badge>
    )
  }
  if (state === 'partial') {
    return (
      <Badge className="border-0 bg-amber-100 text-amber-900 gap-1 hover:bg-amber-100" title={t('finder.stock.partialTitle', { stock: fmtQty(stockQty), qty: fmtQty(qty) })}>
        <PackageMinus className="h-3 w-3" aria-hidden /> {t('finder.stock.partial')}
      </Badge>
    )
  }
  return (
    <Badge className="border-0 bg-stone-100 text-stone-500 gap-1 hover:bg-stone-100" title={t('finder.stock.outTitle')}>
      <PackageX className="h-3 w-3" aria-hidden /> {t('finder.stock.out')}
    </Badge>
  )
}

const ETA_ICON: Record<EtaTier, string> = {
  'same day': 'bg-emerald-100 text-emerald-800',
  'next day': 'bg-amber-100 text-amber-900',
  '2+ days': 'bg-stone-100 text-stone-600',
}

const ETA_KEY: Record<EtaTier, string> = {
  'same day': 'finder.eta.sameDay',
  'next day': 'finder.eta.nextDay',
  '2+ days': 'finder.eta.twoDays',
}

export function EtaBadge({ tier }: { tier: EtaTier }) {
  const t = useT()
  return (
    <Badge className={`border-0 gap-1 hover:opacity-90 ${ETA_ICON[tier]}`} title={t('finder.eta.title')}>
      <Truck className="h-3 w-3" aria-hidden /> {t(ETA_KEY[tier])}
    </Badge>
  )
}

/** Reliability chip — 0-100 from actual platform transaction history (§16). */
export function RatingBadge({ score }: { score: number }) {
  const t = useT()
  const tone = score >= 80 ? 'bg-emerald-100 text-emerald-800' : score >= 65 ? 'bg-amber-100 text-amber-900' : 'bg-stone-100 text-stone-600'
  return (
    <Badge className={`border-0 gap-1 hover:opacity-90 ${tone}`} title={t('finder.rating.title')}>
      <Star className="h-3 w-3" aria-hidden /> {score}/100
    </Badge>
  )
}

/** Price-history chip (spec §30): regional PricePoint observations for the
 *  searched material — last price + region, full list on hover/focus. */
export function PriceHistoryBadge({ points }: { points: PricePointLite[] }) {
  const t = useT()
  if (!points.length) return null
  const last = points[0]
  const avg = points.reduce((s, p) => s + p.unitPrice, 0) / points.length
  const detail = points
    .slice(0, 6)
    .map((p) => `${p.region}: ${formatKes(p.unitPrice)} (${dateShort(p.recordedAt)})`)
    .join('\n')
  return (
    <Badge
      variant="outline"
      className="gap-1 text-[10px] font-medium text-stone-500"
      title={t('finder.priceHistory.title', { count: points.length, avg: formatKes(avg), detail })}
    >
      <LineChart className="h-3 w-3" aria-hidden /> {t(points.length === 1 ? 'finder.priceHistory.badgeOne' : 'finder.priceHistory.badgeMany', { count: points.length, price: formatKes(last.unitPrice), region: last.region })}
    </Badge>
  )
}

/** The weighted-score bar with its five documented parts (§4). */
export function ScoreBar({ row }: { row: CompareRow }) {
  const t = useT()
  const pct = Math.round(row.scores.total * 100)
  const parts = [
    { label: t('finder.score.price'), value: row.scores.price, weight: '0.45' },
    { label: t('finder.score.distance'), value: row.scores.distance, weight: '0.15' },
    { label: t('finder.score.stock'), value: row.scores.stock, weight: '0.15' },
    { label: t('finder.score.speed'), value: row.scores.speed, weight: '0.10' },
    { label: t('finder.score.reliability'), value: row.scores.reliability, weight: '0.15' },
  ]
  return (
    <div className="space-y-1.5 w-full max-w-xs">
      <div className="flex items-center gap-2 text-[11px] text-stone-500">
        <Gauge className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-stone-700">{t('finder.score.title')}</span>
        <span className="tabular-nums font-semibold text-stone-800">{pct}/100</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-stone-100"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t('finder.score.aria', { pct })}
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

// i18n (issue #107): `label` carries a DICT KEY rendered via t().
export const DELIVERY_DAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'any', label: 'finder.day.any' },
  { value: 'same_day', label: 'finder.day.same' },
  { value: 'next_day', label: 'finder.day.next' },
  { value: 'two_days', label: 'finder.day.two' },
]

export const RADIUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'any', label: 'finder.radius.any' },
  { value: '5', label: 'finder.radius.km5' },
  { value: '10', label: 'finder.radius.km10' },
  { value: '25', label: 'finder.radius.km25' },
  { value: '50', label: 'finder.radius.km50' },
]
