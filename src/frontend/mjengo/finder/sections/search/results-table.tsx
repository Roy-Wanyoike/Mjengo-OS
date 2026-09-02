'use client'

// Finder search results — the comparison table (Finder spec §3/§4). BEST
// OVERALL is highlighted (amber/earth accent) and visually distinguished from
// CHEAPEST UNIT — the spec's loudest lesson: the cheapest unit price is not
// necessarily the cheapest landed cost. Per-row "Compare" expands the
// landed-cost breakdown (product + delivery + transport = total) with the
// weighted-score parts; "Add to Project Order" hands the line to the
// create-request dialog via the finder-link store.

import { useState } from 'react'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { ChevronDown, ChevronRight, MapPin, Plus, Scale, Trophy, Tag, AlertTriangle } from 'lucide-react'
import type { CompareRow } from '@/backend/modules/supply/types'
import { EmptyState } from '@/frontend/mjengo/uikit/empty-state'
import { EtaBadge, RatingBadge, ScoreBar, StockBadge, fmtKm, fmtQty, formatKes, PriceHistoryBadge, type PricePointLite } from './bits'

interface ResultsTableProps {
  rows: CompareRow[]
  siteLabel: string
  busy: boolean
  onAddToOrder: (row: CompareRow) => void
  /** Regional intel price observations matching the searched material (spec §30 price history). */
  priceHistory?: PricePointLite[]
}

export function SearchResultsTable({ rows, siteLabel, busy, onAddToOrder, priceHistory }: ResultsTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (!rows.length) {
    return (
      <EmptyState
        icon={MapPin}
        title="No suppliers match near this site"
        description="Try the material's short name (e.g. “cement”, “ballast”), widen the radius, or relax the delivery day."
      />
    )
  }

  const best = rows.find((r) => r.flags.bestOverall)
  const cheapest = rows.find((r) => r.flags.cheapestUnit)
  const sameRow = best && cheapest && best.supplierId === cheapest.supplierId

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {best && (
        <p className="text-xs text-stone-500">
          {sameRow ? (
            <>
              <Trophy className="mr-1 inline h-3.5 w-3.5 text-amber-600" aria-hidden />
              <span className="font-medium text-stone-700">{best.businessName}</span> is both the best overall AND the cheapest unit price — rare alignment.
            </>
          ) : (
            <>
              <Scale className="mr-1 inline h-3.5 w-3.5 text-amber-600" aria-hidden />
              Best overall <span className="font-medium text-stone-700">{best.businessName}</span> is NOT the cheapest unit price ({cheapest?.businessName} at {cheapest ? formatKes(cheapest.unitPrice) : '—'}) — total landed cost, distance, stock and reliability all count.
            </>
          )}
        </p>
      )}
      <PriceHistoryBadge points={priceHistory ?? []} />
      </div>

      <div className="overflow-x-auto rounded-md border border-stone-200">
        <table className="w-full min-w-[760px] text-sm">
          <caption className="sr-only">Supplier comparison ranked by weighted score — site: {siteLabel}</caption>
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
              <th scope="col" className="px-3 py-2 font-medium">Supplier</th>
              <th scope="col" className="px-2 py-2 font-medium">Distance</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Unit price</th>
              <th scope="col" className="px-2 py-2 font-medium">Stock</th>
              <th scope="col" className="px-2 py-2 font-medium">Delivery</th>
              <th scope="col" className="px-2 py-2 font-medium">Rating</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Landed total</th>
              {/* relative anchors the sr-only span inside the th — otherwise its
                  position:absolute containing block escapes the overflow-x-auto
                  wrapper and blows the page past a 390px viewport (17-orchestrator
                  Badge-quirk pattern) */}
              <th scope="col" className="relative px-3 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isExpanded = expanded === row.supplierId
              return (
                <FragmentRow
                  key={row.supplierId}
                  row={row}
                  isExpanded={isExpanded}
                  busy={busy}
                  onToggle={() => setExpanded(isExpanded ? null : row.supplierId)}
                  onAddToOrder={() => onAddToOrder(row)}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FragmentRow({
  row,
  isExpanded,
  busy,
  onToggle,
  onAddToOrder,
}: {
  row: CompareRow
  isExpanded: boolean
  busy: boolean
  onToggle: () => void
  onAddToOrder: () => void
}) {
  const best = row.flags.bestOverall
  return (
    <>
      <tr
        className={`border-b border-stone-100 transition last:border-0 ${best ? 'bg-amber-50/80 hover:bg-amber-50' : 'hover:bg-stone-50'}`}
      >
        <td className="px-3 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-stone-800">{row.businessName}</span>
            {best && (
              <Badge className="border-0 gap-1 bg-amber-600 text-white hover:bg-amber-600">
                <Trophy className="h-3 w-3" aria-hidden /> Best overall
              </Badge>
            )}
            {row.flags.cheapestUnit && (
              <Badge variant="outline" className="gap-1 text-[10px] font-medium text-emerald-800">
                <Tag className="h-3 w-3" aria-hidden /> Cheapest unit
              </Badge>
            )}
            <span className="block text-[11px] text-stone-400">
              {row.county}{row.town ? ` · ${row.town}` : ''} · {row.itemName}
            </span>
            {(row.category || row.brand) && (
              <span className="flex flex-wrap items-center gap-1 pt-0.5">
                {row.category && (
                  <Badge variant="outline" className="text-[9px] font-normal text-stone-500" title="Catalog category (spec §29)">
                    {row.category}
                  </Badge>
                )}
                {row.brand && (
                  <Badge variant="outline" className="text-[9px] font-normal text-stone-500" title="Brand (spec §29)">
                    {row.brand}
                  </Badge>
                )}
                {row.specification && <span className="text-[10px] text-stone-400">{row.specification}</span>}
              </span>
            )}
          </div>
        </td>
        <td className="whitespace-nowrap px-2 py-3 tabular-nums text-stone-700">{fmtKm(row.distanceKm)}</td>
        <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-stone-800">
          {formatKes(row.unitPrice)}
          <span className="block text-[10px] text-stone-400">per {row.unit}</span>
        </td>
        <td className="px-2 py-3"><StockBadge state={row.stockState} stockQty={row.stockQty} qty={row.qty} /></td>
        <td className="px-2 py-3"><EtaBadge tier={row.etaTier} /></td>
        <td className="px-2 py-3"><RatingBadge score={row.reliabilityScore} /></td>
        <td className="whitespace-nowrap px-2 py-3 text-right font-semibold tabular-nums text-stone-900">
          {formatKes(row.totalLanded)}
          {best && <span className="block text-[10px] font-medium text-amber-700">rank 1 · {Math.round(row.scores.total * 100)}/100</span>}
        </td>
        <td className="whitespace-nowrap px-3 py-3 text-right">
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-8 min-h-8 gap-1 px-2 text-xs"
              onClick={onToggle}
              aria-expanded={isExpanded}
              aria-label={`Compare landed-cost breakdown for ${row.businessName}`}
            >
              {isExpanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
              Compare
            </Button>
            <Button
              size="sm"
              className="h-8 min-h-8 gap-1 bg-amber-600 px-2 text-xs text-white hover:bg-amber-700"
              disabled={busy}
              onClick={onAddToOrder}
              aria-label={`Add ${fmtQty(row.qty)} ${row.unit} of ${row.itemName} from ${row.businessName} to a project order`}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden /> Order
            </Button>
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr className={`border-b border-stone-100 ${best ? 'bg-amber-50/50' : 'bg-stone-50/60'}`}>
          <td colSpan={8} className="px-3 py-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">Landed-cost breakdown — {fmtQty(row.qty)} {row.unit}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm tabular-nums">
                  <dt className="text-stone-500">Product cost</dt>
                  <dd className="text-right font-medium text-stone-800">{formatKes(row.productCost)}</dd>
                  <dt className="text-stone-500">Delivery fee{row.deliveryFee === 0 ? ' (waived — order qualifies)' : ''}</dt>
                  <dd className="text-right font-medium text-stone-800">{formatKes(row.deliveryFee)}</dd>
                  <dt className="text-stone-500">Transport surcharge{row.transportFee > 0 ? ` (~${formatKes(100)}/10 km)` : ''}</dt>
                  <dd className="text-right font-medium text-stone-800">{formatKes(row.transportFee)}</dd>
                  <dt className="border-t border-stone-200 pt-1 text-stone-700">Total landed cost</dt>
                  <dd className="border-t border-stone-200 pt-1 text-right text-base font-bold text-stone-900">{formatKes(row.totalLanded)}</dd>
                </dl>
                {!row.meetsMinOrder && (
                  <p className="flex items-center gap-1.5 pt-1 text-[11px] text-amber-800">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    Below {formatKes(row.minimumOrder)} minimum order (needs {fmtQty(row.minOrderQty)} {row.unit} min) — the supplier may decline to quote.
                  </p>
                )}
              </div>
              <ScoreBar row={row} />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
