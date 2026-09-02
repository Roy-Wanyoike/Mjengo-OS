'use client'

// Risk section — the deterministic risk engine view: overall score ring,
// rule findings (rule tag · severity chip · title · message · evidence) and
// the recompute button. Every number traces back to real rows.

import { useMemo } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Button } from '@/frontend/ui/button'
import { Badge } from '@/frontend/ui/badge'
import { RefreshCw, ShieldAlert, Info, AlertTriangle, TriangleAlert, History, Radar } from 'lucide-react'
import { parseRiskFindings, RULE_LABELS, type FindingSeverity } from '@/backend/modules/intel/types'
import { SeverityChip, ScoreRing } from '@/frontend/mjengo/intel/bits'

function SeverityIcon({ severity }: { severity: FindingSeverity }) {
  if (severity === 'critical') return <TriangleAlert className="w-4 h-4 text-red-600 shrink-0" aria-hidden />
  if (severity === 'warning') return <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" aria-hidden />
  return <Info className="w-4 h-4 text-stone-400 shrink-0" aria-hidden />
}

export function RiskSection() {
  const { data, dispatch, actionBusy, viewMode } = useMjengo()
  const intel = data?.intel
  const risk = intel?.risk ?? null
  const findings = useMemo(() => (risk ? parseRiskFindings(risk.findings) : []), [risk])
  const isClient = viewMode === 'client'

  if (!data) return null

  return (
    <section aria-label="Project risk">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldAlert className="w-4 h-4 text-stone-500" aria-hidden /> Project risk
              </CardTitle>
              <CardDescription>
                5 deterministic rules over this project&apos;s live rows — budget pace, schedule, procurement, price trend, attendance.
              </CardDescription>
            </div>
            {!isClient && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={actionBusy !== null}
                onClick={() => void dispatch('risk.recompute', {}, 'Recompute risk now')}
              >
                <RefreshCw className={`w-4 h-4 ${actionBusy === 'Recompute risk now' ? 'animate-spin' : ''}`} aria-hidden />
                Recompute now
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {!risk ? (
            <div className="py-10 flex flex-col items-center text-center gap-3" role="status">
              <div className="w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
                <Radar className="w-6 h-6 text-stone-400" />
              </div>
              <p className="text-sm text-stone-500 max-w-sm">
                No risk assessment yet{!isClient && ' — run "Recompute now" to score the live data'}. Findings describe patterns, never people.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row items-start gap-5">
                <ScoreRing score={risk.overallScore} />
                <div className="min-w-0 space-y-2 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[10px] font-medium text-stone-500 border-stone-200">
                      rules v{risk.ruleVersion.replace(/^v/, '')}
                    </Badge>
                    <span className="text-xs text-stone-400">
                      computed {formatDistanceToNow(new Date(risk.computedAt), { addSuffix: true })}
                    </span>
                    <span className="text-xs text-stone-400" aria-label={`${findings.length} findings`}>
                      · {findings.length} finding{findings.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="text-sm text-stone-600 leading-relaxed">
                    Score = 100 minus severity weights (info 5 · warning 15 · critical 30, floored at 0). Higher is calmer —
                    the same rows always produce the same score, so every finding can be traced back to its rule.
                  </p>
                  <p className="text-[11px] text-stone-400 flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5" aria-hidden />
                    Every recompute is stored — the latest result wins here; history stays queryable.
                  </p>
                </div>
              </div>

              {findings.length === 0 ? (
                <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700" role="status">
                  No rule findings — the live rows are inside every threshold right now.
                </p>
              ) : (
                <ul className="space-y-2.5" aria-label="Risk findings">
                  {findings.map((f, i) => (
                    <li key={`${f.rule}-${i}`} className="rounded-lg border border-stone-200 bg-stone-50/60 p-3.5">
                      <div className="flex items-start gap-2.5">
                        <SeverityIcon severity={f.severity} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[10px] font-mono font-semibold text-stone-500 bg-stone-100 border border-stone-200 rounded px-1.5 py-0.5">
                              {RULE_LABELS[f.rule] ?? f.rule}
                            </span>
                            <SeverityChip severity={f.severity} />
                            <span className="text-sm font-semibold text-stone-900">{f.title}</span>
                          </div>
                          {f.message && <p className="mt-1.5 text-sm text-stone-600 leading-relaxed">{f.message}</p>}
                          {f.evidence && (
                            <p className="mt-1.5 text-[11px] text-stone-400 flex items-center gap-1">
                              <Radar className="w-3 h-3 shrink-0" aria-hidden />
                              <span className="truncate" title={f.evidence}>Evidence: {f.evidence}</span>
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
