'use client'

// Professionals — the honest verification ladder (7 rungs, 0-6).
//
// A row of seven segments: filled up to the achieved level, the achieved rung
// highlighted, the rest muted. Hovering/focusing a rung shows what it means.
// The caption always pairs the level with the COUNT of recorded checks — the
// number of checks is the fact; the label is only our shorthand for it.

import { VERIFICATION_LADDER, checksRecordedLabel } from '@/modules/professionals/types'
import { cn } from '@/lib/utils'
import { ShieldCheck } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function VerificationLadder({
  state,
  checkCount,
  className,
}: {
  state: number
  checkCount: number
  className?: string
}) {
  const level = Math.min(6, Math.max(0, Math.round(state)))
  const rung = VERIFICATION_LADDER[level]

  return (
    <div className={cn('min-w-0', className)}>
      <TooltipProvider delayDuration={120}>
        <div
          className="flex items-center gap-1"
          role="img"
          aria-label={`Verification ladder: ${rung.label} (level ${level} of 6) — ${checksRecordedLabel(checkCount)}`}
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
                    {r.level} · {r.label}
                    {i === level && ' — current'}
                  </p>
                  <p className="text-stone-500">{r.hint}</p>
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
          <span className="font-medium text-stone-700">{rung.label}</span>
          <span className="text-stone-400"> · </span>
          {checksRecordedLabel(checkCount)}
        </span>
      </p>
    </div>
  )
}
