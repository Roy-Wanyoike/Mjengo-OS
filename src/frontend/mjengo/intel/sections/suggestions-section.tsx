'use client'

// Procurement suggestions (Finder spec §19, lite) — a deterministic cover
// check: for every price-tracked material, is there an OPEN request or PO
// naming it? Uncovered materials get a plain-language nudge. Informational
// only — nothing is created automatically. AI recommends, humans decide.

import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Badge } from '@/frontend/ui/badge'
import { Lightbulb, CheckCircle2, CircleAlert, PackageSearch } from 'lucide-react'
import { useT } from '@/frontend/i18n/provider'

export function SuggestionsSection() {
  const { data } = useMjengo()
  const t = useT()
  const suggestions = data?.intel.suggestions ?? []

  if (!data) return null

  return (
    <section aria-label={t('intel.suggestions.aria')}>
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="w-4 h-4 text-amber-500" aria-hidden /> {t('intel.suggestions.title')}
          </CardTitle>
          <CardDescription>
            {t('intel.suggestions.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {suggestions.length === 0 ? (
            <div className="py-6 flex flex-col items-center text-center gap-2" role="status">
              <PackageSearch className="w-6 h-6 text-stone-300" aria-hidden />
              <p className="text-sm text-stone-500 max-w-sm">
                {t('intel.suggestions.empty')}
              </p>
            </div>
          ) : (
            <ul className="space-y-2" aria-label={t('intel.suggestions.listAria')}>
              {suggestions.map((s) => (
                <li
                  key={s.materialName}
                  className={`rounded-lg border p-3.5 flex items-start gap-2.5 ${
                    s.status === 'covered' ? 'border-stone-200 bg-stone-50/60' : 'border-amber-200 bg-amber-50/60'
                  }`}
                >
                  {s.status === 'covered' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" aria-hidden />
                  ) : (
                    <CircleAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-stone-900">{s.materialName}</span>
                      <Badge
                        variant="outline"
                        className={`text-[10px] font-bold uppercase ${
                          s.status === 'covered'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-amber-200 bg-amber-100 text-amber-800'
                        }`}
                      >
                        {s.status === 'covered' ? t('intel.suggestions.covered') : t('intel.suggestions.noCover')}
                      </Badge>
                    </div>
                    <p className="text-xs text-stone-600 mt-1 leading-relaxed">
                      {s.status === 'covered' ? s.coverDetail : s.hint}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-stone-400 leading-relaxed">
            {t('intel.suggestions.ruleNote')}
          </p>
        </CardContent>
      </Card>
    </section>
  )
}
