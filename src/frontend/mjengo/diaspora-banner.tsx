'use client'

import { Eye, X } from 'lucide-react'

export interface DiasporaBannerProps {
  /** Provide to show an exit affordance (owner preview). Omitted on real share links. */
  onExit?: () => void
  /** Banner copy — defaults to the owner-preview wording. */
  label?: string
}

/**
 * Client banner. Render directly below the <Header /> — `top-[100px]` matches
 * the current sticky header height (4px bar + 56px row + ~40px tab nav).
 * Without `onExit` (public share link) it is informational only.
 */
export function DiasporaBanner({ onExit, label }: DiasporaBannerProps) {
  return (
    <div role="status" aria-live="polite" className="sticky top-[100px] z-30 bg-amber-500 text-stone-950 shadow-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 min-h-11 flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold min-w-0">
          <Eye className="w-4 h-4 shrink-0" aria-hidden />
          <span className="truncate">{label ?? 'Client preview — read-only view of live site data'}</span>
        </p>
        {onExit && (
          <button
            type="button"
            onClick={onExit}
            aria-label="Exit preview"
            className="flex items-center gap-1.5 h-11 px-3 rounded-lg text-sm font-bold hover:bg-stone-950/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-950 transition-colors shrink-0"
          >
            <X className="w-4 h-4" aria-hidden />
            <span className="hidden sm:inline">Exit preview</span>
          </button>
        )}
      </div>
    </div>
  )
}
