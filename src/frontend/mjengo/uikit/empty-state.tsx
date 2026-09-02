'use client'

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Shared empty-state primitive (W3-F2 · MjengoOS UI kit).
 *
 * One consistent, honest "nothing here yet" rendering for every surface:
 * icon in a muted circle, a medium-weight title, an optional muted
 * description and an optional action button. Purely presentational —
 * no fetching, no data derivation. No emoji (Doc B tone: plain words).
 *
 * `compact` (py-8) fits empty states INSIDE tables and card bodies where
 * the default (py-12) would push the layout around.
 */
export interface EmptyStateProps {
  /** Lucide glyph shown inside the muted circle (omitted → no circle). */
  icon?: LucideIcon
  /** Headline, e.g. "No deliveries yet" (required). */
  title: string
  /** One-line honest explanation of why it's empty / what to do next. */
  description?: string
  /** Usually a Button — the "do something about it" affordance. */
  action?: ReactNode
  /** Tighter vertical padding for in-table / in-card empty rows. */
  compact?: boolean
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={`flex flex-col items-center justify-center gap-3 px-4 text-center ${
        compact ? 'py-8' : 'py-12'
      }`}
    >
      {Icon && (
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted"
          aria-hidden
        >
          <Icon className="h-6 w-6 text-muted-foreground" />
        </span>
      )}
      <div className="max-w-md space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && (
          <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  )
}
