'use client'

// Supplier reliability section — one card per supplier with the big score and
// the component breakdown bars (delivery accuracy / on-time / completion /
// disputes / response). Computed from ACTUAL platform transaction history —
// there are no anonymous ratings anywhere (Finder spec §16).

import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Button } from '@/frontend/ui/button'
import { Badge } from '@/frontend/ui/badge'
import { RefreshCw, Truck, MapPin, ClipboardCheck } from 'lucide-react'
import { useT } from '@/frontend/i18n/provider'
import type { ReliabilityComponent } from '@/backend/modules/intel/types'

function scoreTone(score: number): string {
  // FE-4 (issue #80): amber-700 as text on white (4.52:1) — the old
  // amber-600 scored 3.19:1 (icons keep amber-600: non-text 3:1 is fine).
  if (score >= 75) return 'text-emerald-600'
  if (score >= 50) return 'text-amber-700'
  return 'text-red-600'
}

function barTone(value: number | null): string {
  if (value === null) return 'bg-stone-300'
  if (value >= 75) return 'bg-emerald-500'
  if (value >= 50) return 'bg-amber-500'
  return 'bg-red-500'
}

function ComponentBar({ c }: { c: ReliabilityComponent }) {
  const t = useT()
  const shown = c.value ?? 50 // neutral stand-in while no data exists
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-xs font-medium text-stone-700">
          {c.label}
          <span className="text-stone-400 font-normal"> · {Math.round(c.weight * 100)}%</span>
        </span>
        <span className={`text-xs font-bold tabular-nums ${c.value === null ? 'text-stone-400' : scoreTone(c.value)}`}>
          {c.value === null ? t('intel.reliability.noData') : c.value}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-stone-200"
        role="meter"
        aria-valuenow={shown}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t('intel.reliability.componentAria', { label: c.label, value: c.value === null ? t('intel.reliability.noDataYet') : t('intel.reliability.valueAria', { value: c.value }) })}
      >
        <div className={`h-full rounded-full transition-all ${barTone(c.value)}`} style={{ width: `${shown}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-stone-400 leading-snug">{c.detail}</p>
    </div>
  )
}

export function ReliabilitySection() {
  const { data, dispatch, actionBusy, viewMode } = useMjengo()
  const t = useT()
  const reliability = data?.intel.reliability ?? []
  const isClient = viewMode === 'client'

  if (!data) return null

  return (
    <section aria-label={t('intel.reliability.aria')}>
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardCheck className="w-4 h-4 text-stone-500" aria-hidden /> {t('intel.reliability.title')}
              </CardTitle>
              <CardDescription>
                {t('intel.reliability.desc')}
              </CardDescription>
            </div>
            {!isClient && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={actionBusy !== null}
                onClick={() => void dispatch('reliability.recompute', {}, t('intel.reliability.recomputeAudit'))}
              >
                <RefreshCw className={`w-4 h-4 ${actionBusy === t('intel.reliability.recomputeAudit') ? 'animate-spin' : ''}`} aria-hidden />
                {t('intel.reliability.recompute')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {reliability.length === 0 ? (
            <p className="text-sm text-stone-500 py-6 text-center" role="status">{t('intel.reliability.empty')}</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {reliability.map((s) => (
                <div key={s.supplierId} className="rounded-lg border border-stone-200 bg-white p-4" aria-label={t('intel.reliability.cardAria', { name: s.businessName })}>
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-stone-900 leading-snug">{s.businessName}</p>
                      <p className="flex items-center gap-1 text-[11px] text-stone-400 mt-0.5">
                        <MapPin className="w-3 h-3" aria-hidden /> {s.county}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-2xl font-bold tabular-nums leading-none ${scoreTone(s.score)}`} aria-label={t('intel.reliability.scoreAria', { score: s.score })}>
                        {s.score}
                      </p>
                      <p className="text-[10px] text-stone-400 mt-0.5">
                        {t('intel.reliability.was')} {s.storedScore}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 my-2.5">
                    <Badge variant="outline" className="text-[10px] font-medium text-stone-500 border-stone-200 gap-1">
                      <Truck className="w-3 h-3" aria-hidden /> {t(s.ordersCount === 1 ? 'intel.reliability.orderOne' : 'intel.reliability.orderMany', { count: s.ordersCount })}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] font-medium text-stone-500 border-stone-200">
                      {t(s.deliveriesCount === 1 ? 'intel.reliability.deliveryOne' : 'intel.reliability.deliveryMany', { count: s.deliveriesCount })}
                    </Badge>
                    {s.discrepanciesCount > 0 && (
                      <Badge variant="outline" className="text-[10px] font-medium text-amber-700 border-amber-200 bg-amber-50">
                        {t(s.discrepanciesCount === 1 ? 'intel.reliability.discrepancyOne' : 'intel.reliability.discrepancyMany', { count: s.discrepanciesCount })}
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
            {t('intel.reliability.neutralNote')}
          </p>
        </CardContent>
      </Card>
    </section>
  )
}
