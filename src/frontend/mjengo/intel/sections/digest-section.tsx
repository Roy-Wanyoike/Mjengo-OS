'use client'

// Weekly digest section — this week's IntelDigest card (summary + items) with
// a generate button; previous weeks collapse to one line each.

import { useState } from 'react'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Button } from '@/frontend/ui/button'
import { Badge } from '@/frontend/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/frontend/ui/collapsible'
import {
  Newspaper, RefreshCw, TrendingUp, ShieldAlert, Truck, Flag, ChevronRight, CalendarDays,
} from 'lucide-react'
import { parseDigestItems, type DigestItem } from '@/backend/modules/intel/types'

function mondayOfThisWeek(): string {
  const d = new Date()
  const dow = (d.getDay() + 6) % 7 // Monday = 0
  d.setDate(d.getDate() - dow)
  return d.toISOString().slice(0, 10)
}

function ItemIcon({ kind }: { kind: string }) {
  const cls = 'w-4 h-4 shrink-0'
  switch (kind) {
    case 'price_trend': return <TrendingUp className={`${cls} text-amber-600`} aria-hidden />
    case 'risk': return <ShieldAlert className={`${cls} text-stone-500`} aria-hidden />
    case 'procurement': return <Truck className={`${cls} text-stone-500`} aria-hidden />
    case 'milestone': return <Flag className={`${cls} text-amber-600`} aria-hidden />
    default: return <Newspaper className={`${cls} text-stone-400`} aria-hidden />
  }
}

function ItemList({ items }: { items: DigestItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-stone-400">No items recorded for this week.</p>
  }
  return (
    <ul className="space-y-2" aria-label="Digest items">
      {items.map((it, i) => (
        <li key={i} className="flex items-start gap-2.5">
          <span className="mt-0.5"><ItemIcon kind={it.kind} /></span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-stone-900 leading-snug">{it.title}</p>
            {it.detail && <p className="text-xs text-stone-500 mt-0.5 leading-relaxed">{it.detail}</p>}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function DigestSection() {
  const { data, dispatch, actionBusy, viewMode } = useMjengo()
  const [openWeek, setOpenWeek] = useState<string | null>(null)
  const digests = data?.intel.digests ?? []
  const isClient = viewMode === 'client'
  const thisWeek = mondayOfThisWeek()
  const current = digests.find((d) => d.weekStart === thisWeek) ?? null
  const previous = digests.filter((d) => d.weekStart !== thisWeek)

  if (!data) return null

  const weekLabel = (iso: string) => {
    try {
      return format(parseISO(iso), "EEEE d MMM yyyy")
    } catch {
      return iso
    }
  }

  return (
    <section aria-label="Weekly digest">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Newspaper className="w-4 h-4 text-stone-500" aria-hidden /> Weekly digest
              </CardTitle>
              <CardDescription>
                One deterministic roll-up per week (Monday-based): risk, price movements, procurement counts, milestones.
              </CardDescription>
            </div>
            {!isClient && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={actionBusy !== null}
                onClick={() => void dispatch('digest.generate', {}, 'Generate this week\u2019s digest')}
              >
                <RefreshCw className={`w-4 h-4 ${actionBusy === 'Generate this week\u2019s digest' ? 'animate-spin' : ''}`} aria-hidden />
                {current ? 'Regenerate' : 'Generate digest'}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          {current ? (
            <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-4" aria-label="Current week digest">
              <div className="flex flex-wrap items-center gap-2 mb-2.5">
                <Badge className="bg-stone-900 text-stone-50 text-[10px] gap-1">
                  <CalendarDays className="w-3 h-3" aria-hidden /> Week of {weekLabel(current.weekStart)}
                </Badge>
                <span className="text-[11px] text-stone-400">
                  generated {formatDistanceToNow(new Date(current.createdAt), { addSuffix: true })}
                </span>
              </div>
              <p className="text-sm text-stone-700 leading-relaxed mb-3">{current.summary}</p>
              <ItemList items={parseDigestItems(current.items)} />
            </div>
          ) : (
            <div className="py-8 flex flex-col items-center text-center gap-3" role="status">
              <div className="w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
                <Newspaper className="w-6 h-6 text-stone-400" />
              </div>
              <p className="text-sm text-stone-500 max-w-sm">
                No digest for the week of {weekLabel(thisWeek)} yet{!isClient && ' — hit "Generate digest"'}. It aggregates what already happened — nothing new is invented.
              </p>
            </div>
          )}

          {previous.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2">Previous weeks</p>
              <div className="space-y-1.5">
                {previous.map((d) => (
                  <Collapsible key={d.id} open={openWeek === d.id} onOpenChange={(v) => setOpenWeek(v ? d.id : null)}>
                    <CollapsibleTrigger className="w-full text-left rounded-lg border border-stone-200 bg-white px-3.5 py-2.5 min-h-11 flex items-center gap-2 hover:bg-stone-50 transition-colors">
                      <ChevronRight className={`w-4 h-4 text-stone-400 transition-transform ${openWeek === d.id ? 'rotate-90' : ''}`} aria-hidden />
                      <span className="text-sm font-medium text-stone-700">Week of {weekLabel(d.weekStart)}</span>
                      <span className="text-xs text-stone-400 truncate flex-1">{d.summary}</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="rounded-lg border border-stone-200 border-t-0 bg-stone-50/60 p-4 pt-3">
                        <p className="text-sm text-stone-600 leading-relaxed mb-3">{d.summary}</p>
                        <ItemList items={parseDigestItems(d.items)} />
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
