'use client'

// Professionals — the honest verification ladder (7 rungs, 0-6).
//
// A row of seven segments: filled up to the achieved level, the achieved rung
// highlighted, the rest muted. Hovering/focusing a rung shows what it means.
// The caption always pairs the level with the COUNT of recorded checks — the
// number of checks is the fact; the label is only our shorthand for it.
//
// Labels/hints resolve through the land.ladder.* dict family (issue #125) —
// the backend VERIFICATION_LADDER rows stay the source of rung STRUCTURE.

import { VERIFICATION_LADDER } from '@/backend/modules/professionals/types'
import { useT } from '@/frontend/i18n/provider'
import { cn } from '@/frontend/lib/utils'
import { ShieldCheck } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/frontend/ui/tooltip'

/** "3 checks recorded" phrasing for the card footer (dict twins — the backend
 *  checksRecordedLabel helper is EN-only, so this renders the localized pair). */
function useChecksRecordedLabel() {
  const t = useT()
  return (n: number) => (n === 1 ? t('land.ladder.checksOne', { n }) : t('land.ladder.checksMany', { n }))
}

export function VerificationLadder({
  state,
  checkCount,
  className,
}: {
  state: number
  checkCount: number
  className?: string
}) {
  const t = useT()
  const checksLabel = useChecksRecordedLabel()
  const level = Math.min(6, Math.max(0, Math.round(state)))
  const rungLabel = t(`land.ladder.${level}.label`)

  return (
    <div className={cn('min-w-0', className)}>
      <TooltipProvider delayDuration={120}>
        <div
          className="flex items-center gap-1"
          role="img"
          aria-label={t('land.ladder.aria', { label: rungLabel, level, checks: checksLabel(checkCount) })}
        >
          {VERIFICATION_LADDER.map((r, i) => {
            const achieved = i <= level
            const current = i === level
            return (
              <Tooltip key={r.level}>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      'h-1.5 flex-1 min-w-0 rounded-full transition-colors',
                      current
                        ? 'bg-amber-600'
                        : achieved
                          ? 'bg-amber-300'
                          : 'bg-stone-200',
                      current && 'ring-2 ring-amber-600/20',
                    )}
                    tabIndex={-1}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs max-w-52">
                  <p className="font-semibold">
                    {t('land.ladder.rungTitle', { n: r.level, label: t(`land.ladder.${r.level}.label`) })}
                    {i === level && t('land.ladder.current')}
                  </p>
                  <p className="text-stone-500">{t(`land.ladder.${r.level}.hint`)}</p>
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </TooltipProvider>
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-stone-500">
        <ShieldCheck
          className={cn('w-3.5 h-3.5 shrink-0', level >= 4 ? 'text-amber-600' : 'text-stone-400')}
          aria-hidden
        />
        <span className="truncate">
          <span className="font-medium text-stone-700">{rungLabel}</span>
          <span className="text-stone-400"> · </span>
          {checksLabel(checkCount)}
        </span>
      </p>
    </div>
  )
}
