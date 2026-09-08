'use client'

// MjengoScore section (issue W3-3) — the deterministic contractor trust score:
// score ring, confidence + rule version, the six-component breakdown (each
// traceable to real rows) and the recompute button. HONESTY: the score
// describes, humans decide — it gates nothing, approves nothing, and is
// recomputed only on the explicit action below. A young/empty project shows
// an honest low-confidence state (null components + explanation), never a
// fake 0 or 100.

import { useMemo } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { useT } from '@/frontend/i18n/provider'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Button } from '@/frontend/ui/button'
import { Badge } from '@/frontend/ui/badge'
import { RefreshCw, Gauge, History, Radar, ShieldCheck } from 'lucide-react'
import { parseScoreComponents, type ScoreComponent } from '@/backend/modules/intel/types'

/** Trust-score ring (mirrors bits.tsx ScoreRing geometry; trust labels). */
function TrustRing({ score, label }: { score: number; label: string }) {
  const r = 46
  const circumference = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score))
  const color = score >= 75 ? '#059669' : score >= 50 ? '#d97706' : '#dc2626'
  return (
    <div className="relative w-28 h-28 shrink-0" role="img" aria-label={`MjengoScore ${score} of 100 — ${label}`}>
      <svg viewBox="0 0 110 110" className="w-full h-full -rotate-90">
        <circle cx="55" cy="55" r={r} fill="none" stroke="#e7e5e4" strokeWidth="10" />
        <circle
          cx="55" cy="55" r={r} fill="none" stroke={color} strokeWidth="10"
          strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - pct / 100)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold tabular-nums text-stone-900" aria-hidden>{score}</span>
        <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color }} aria-hidden>{label}</span>
      </div>
    </div>
  )
}

function confidenceTone(confidence: string): string {
  if (confidence === 'high') return 'bg-emerald-100 text-emerald-700 border-emerald-200'
  if (confidence === 'medium') return 'bg-amber-100 text-amber-800 border-amber-200'
  return 'bg-stone-100 text-stone-600 border-stone-200'
}

function ComponentRow({ c }: { c: ScoreComponent }) {
  const t = useT()
  const hasData = c.value !== null
  return (
    <li className="rounded-lg border border-stone-200 bg-stone-50/60 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-mono font-semibold text-stone-500 bg-stone-100 border border-stone-200 rounded px-1.5 py-0.5">
          {t(`score.comp.${c.key}`)}
        </span>
        <Badge variant="outline" className="text-[10px] font-medium text-stone-500 border-stone-200">
          {t('score.weight', { w: c.weight })}
        </Badge>
        {hasData ? (
          <span className="text-sm font-semibold tabular-nums text-stone-900">{c.value}/100</span>
        ) : (
          <span className="text-xs italic text-stone-400">{t('score.noData')}</span>
        )}
        {hasData && c.deduction !== null && c.deduction > 0 && (
          <span className="text-[11px] font-semibold tabular-nums text-red-600">
            {t('score.deduction', { d: c.deduction })}
          </span>
        )}
      </div>
      {c.evidence && (
        <p className="mt-1.5 text-[11px] text-stone-400 flex items-center gap-1">
          <Radar className="w-3 h-3 shrink-0" aria-hidden />
          <span className="truncate" title={c.evidence}>{t('score.evidence')}: {c.evidence}</span>
        </p>
      )}
    </li>
  )
}

export function ScoreSection() {
  const { data, dispatch, actionBusy, viewMode } = useMjengo()
  const t = useT()
  const score = data?.intel?.score ?? null
  const components = useMemo(() => (score ? parseScoreComponents(score.components) : []), [score])
  const isClient = viewMode === 'client'

  if (!data) return null

  const ringLabel =
    score?.score === null || score?.score === undefined
      ? ''
      : score.score >= 75
        ? t('score.ring.trusted')
        : score.score >= 50
          ? t('score.ring.building')
          : t('score.ring.needsProof')

  return (
    <section aria-label="Contractor trust score">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Gauge className="w-4 h-4 text-stone-500" aria-hidden /> {t('score.title')}
              </CardTitle>
              <CardDescription>{t('score.desc')}</CardDescription>
            </div>
            {!isClient && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={actionBusy !== null}
                onClick={() => void dispatch('score.recompute', {}, t('score.recompute'))}
              >
                <RefreshCw className={`w-4 h-4 ${actionBusy === t('score.recompute') ? 'animate-spin' : ''}`} aria-hidden />
                {t('score.recompute')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {!score ? (
            <div className="py-10 flex flex-col items-center text-center gap-3" role="status">
              <div className="w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
                <ShieldCheck className="w-6 h-6 text-stone-400" aria-hidden />
              </div>
              <p className="text-sm text-stone-500 max-w-sm">
                {t('score.none')}{!isClient ? ` — ${t('score.noneHint')}` : ''} {t('score.honesty')}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row items-start gap-5">
                {score.score !== null ? (
                  <TrustRing score={score.score} label={ringLabel} />
                ) : (
                  <div
                    className="w-28 h-28 shrink-0 rounded-full border-[10px] border-stone-200 flex items-center justify-center"
                    role="img"
                    aria-label={t('score.noScoreTitle')}
                  >
                    <span className="text-2xl font-bold text-stone-400" aria-hidden>—</span>
                  </div>
                )}
                <div className="min-w-0 space-y-2 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[10px] font-medium text-stone-500 border-stone-200">
                      {t('score.rules', { version: score.ruleVersion.replace(/^v/, '') })}
                    </Badge>
                    <Badge variant="outline" className={`text-[10px] font-bold uppercase tracking-wide border ${confidenceTone(score.confidence)}`}>
                      {t('score.confidence')} {t(`score.confidence.${score.confidence}`)}
                    </Badge>
                    <span className="text-xs text-stone-400">
                      {t('score.computedAgo')} {formatDistanceToNow(new Date(score.computedAt), { addSuffix: true })}
                    </span>
                    <span className="text-xs text-stone-400" aria-label={t('score.confidenceHint', { n: components.filter((c) => c.value !== null).length })}>
                      · {t('score.confidenceHint', { n: components.filter((c) => c.value !== null).length })}
                    </span>
                  </div>
                  {score.score === null ? (
                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
                      <strong className="font-semibold">{t('score.noScoreTitle')}.</strong> {score.notes ?? ''}
                    </p>
                  ) : (
                    <p className="text-sm text-stone-600 leading-relaxed">
                      {t('score.honesty')}
                    </p>
                  )}
                  <p className="text-[11px] text-stone-400 flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5" aria-hidden />
                    {t('score.history')}
                  </p>
                </div>
              </div>

              {components.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2">{t('score.components')}</p>
                  <ul className="space-y-2.5" aria-label={t('score.components')}>
                    {components.map((c) => (
                      <ComponentRow key={c.key} c={c} />
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
