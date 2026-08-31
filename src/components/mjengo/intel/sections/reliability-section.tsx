'use client'

// Supplier reliability section — one card per supplier with the big score and
// the component breakdown bars (delivery accuracy / on-time / completion /
// disputes / response). Computed from ACTUAL platform transaction history —
// there are no anonymous ratings anywhere (Finder spec §16).

import { useMjengo } from '@/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, Truck, MapPin, ClipboardCheck } from 'lucide-react'
import type { ReliabilityComponent } from '@/modules/intel/types'

function scoreTone(score: number): string {
  if (score >= 75) return 'text-emerald-600'
  if (score >= 50) return 'text-amber-600'
  return 'text-red-600'
}

function barTone(value: number | null): string {
  if (value === null) return 'bg-stone-300'
  if (value >= 75) return 'bg-emerald-500'
  if (value >= 50) return 'bg-amber-500'
  return 'bg-red-500'
}

function ComponentBar({ c }: { c: ReliabilityComponent }) {
  const shown = c.value ?? 50 // neutral stand-in while no data exists
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-xs font-medium text-stone-700">
          {c.label}
          <span className="text-stone-400 font-normal"> · {Math.round(c.weight * 100)}%</span>
        </span>
        <span className={`text-xs font-bold tabular-nums ${c.value === null ? 'text-stone-400' : scoreTone(c.value)}`}>
          {c.value === null ? 'no data' : c.value}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-stone-200"
        role="meter"
        aria-valuenow={shown}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${c.label}: ${c.value === null ? 'no data yet' : `${c.value} of 100`}`}
      >
        <div className={`h-full rounded-full transition-all ${barTone(c.value)}`} style={{ width: `${shown}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-stone-400 leading-snug">{c.detail}</p>
    </div>
  )
}

export function ReliabilitySection() {
  const { data, dispatch, actionBusy, viewMode } = useMjengo()
  const reliability = data?.intel.reliability ?? []
  const isClient = viewMode === 'client'

  if (!data) return null

  return (
    <section aria-label="Supplier reliability">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardCheck className="w-4 h-4 text-stone-500" aria-hidden /> Supplier reliability
              </CardTitle>
              <CardDescription>
                0–100 from actual platform history — delivery accuracy, on-time, completion, disputes, response speed.
                <strong className="font-semibold text-stone-600"> No anonymous ratings.</strong>
              </CardDescription>
            </div>
            {!isClient && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={actionBusy !== null}
                onClick={() => void dispatch('reliability.recompute', {}, 'Recompute supplier reliability')}
              >
                <RefreshCw className={`w-4 h-4 ${actionBusy === 'Recompute supplier reliability' ? 'animate-spin' : ''}`} aria-hidden />
                Recompute
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {reliability.length === 0 ? (
            <p className="text-sm text-stone-500 py-6 text-center" role="status">No suppliers yet.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {reliability.map((s) => (
                <div key={s.supplierId} className="rounded-lg border border-stone-200 bg-white p-4" aria-label={`Reliability for ${s.businessName}`}>
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-stone-900 leading-snug">{s.businessName}</p>
                      <p className="flex items-center gap-1 text-[11px] text-stone-400 mt-0.5">
                        <MapPin className="w-3 h-3" aria-hidden /> {s.county}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-2xl font-bold tabular-nums leading-none ${scoreTone(s.score)}`} aria-label={`Reliability score ${s.score} of 100`}>
                        {s.score}
                      </p>
                      <p className="text-[10px] text-stone-400 mt-0.5">
                        was {s.storedScore}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 my-2.5">
                    <Badge variant="outline" className="text-[10px] font-medium text-stone-500 border-stone-200 gap-1">
                      <Truck className="w-3 h-3" aria-hidden /> {s.ordersCount} order{s.ordersCount === 1 ? '' : 's'}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] font-medium text-stone-500 border-stone-200">
                      {s.deliveriesCount} deliver{s.deliveriesCount === 1 ? 'y' : 'ies'}
                    </Badge>
                    {s.discrepanciesCount > 0 && (
                      <Badge variant="outline" className="text-[10px] font-medium text-amber-700 border-amber-200 bg-amber-50">
                        {s.discrepanciesCount} discrepanc{s.discrepanciesCount === 1 ? 'y' : 'ies'}
                      </Badge>
                    )}
                  </div>
                  <div className="space-y-3">
                    {s.components.map((c) => (
                      <ComponentBar key={c.key} c={c} />
                    ))}
                  </div>
                  <p className="mt-3 text-[11px] text-stone-400 leading-snug border-t border-stone-100 pt-2.5">{s.note}</p>
                </div>
              ))}
            </div>
          )}
          <p className="mt-4 text-[11px] text-stone-400 leading-relaxed">
            A component with no history yet counts as neutral (50) at its weight, so new suppliers trend toward the middle
            instead of 0 or 100. Weights: accuracy 35 · on-time 20 · completion 20 · disputes 15 · response 10.
          </p>
        </CardContent>
      </Card>
    </section>
  )
}
