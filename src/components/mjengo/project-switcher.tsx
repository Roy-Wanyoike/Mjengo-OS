'use client'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Building2, Check, ChevronDown, Plus, ShieldAlert } from 'lucide-react'
import { formatKES } from '@/lib/format'
import type { ProjectListItem } from '@/lib/mjengo'

// Re-export for compatibility with existing import sites
export type { ProjectListItem }

export interface ProjectSwitcherProps {
  projects: ProjectListItem[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
}

function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case 'active':
      return { label: 'active', className: 'bg-amber-500/10 text-amber-600 border-amber-500/30' }
    case 'completed':
      return { label: 'completed', className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' }
    default:
      return { label: status === 'on_hold' ? 'on hold' : status, className: 'bg-stone-100 text-stone-500 border-stone-200' }
  }
}

export function ProjectSwitcher({ projects, activeId, onSelect, onCreate }: ProjectSwitcherProps) {
  const active = projects.find((p) => p.id === activeId) ?? null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Switch project — current: ${active?.name ?? 'none'}`}
        className="flex items-center gap-2 min-w-0 h-9 px-2.5 rounded-lg bg-stone-900 border border-stone-800 text-stone-200 hover:bg-stone-800 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <Building2 className="w-4 h-4 text-amber-500 shrink-0" aria-hidden />
        <span className="text-sm font-medium truncate max-w-28 sm:max-w-44">{active?.name ?? 'Select project'}</span>
        <ChevronDown className="w-4 h-4 text-stone-500 shrink-0" aria-hidden />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="w-80 sm:w-96 max-h-96 overflow-y-auto rounded-xl border-stone-200 p-0
          [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent
          [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full"
      >
        <DropdownMenuLabel className="px-3 pt-3 pb-1.5 text-xs font-semibold uppercase tracking-wide text-stone-400">
          Projects · {projects.length}
        </DropdownMenuLabel>

        {projects.length === 0 && (
          <p className="px-3 py-6 text-sm text-stone-400 text-center">No projects yet — create your first one below.</p>
        )}

        {projects.map((p) => {
          const isActive = p.id === activeId
          const badge = statusBadge(p.status)
          return (
            <DropdownMenuItem
              key={p.id}
              onSelect={() => onSelect(p.id)}
              className="flex flex-col items-stretch gap-1 px-3 py-2.5 rounded-lg focus:bg-stone-100 cursor-pointer"
              aria-label={`Open project ${p.name}, ${p.progressPct}% complete`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {isActive ? (
                  <Check className="w-4 h-4 text-amber-600 shrink-0" aria-hidden />
                ) : (
                  <span className="w-4 h-4 shrink-0" aria-hidden />
                )}
                <span className="text-sm font-semibold text-stone-800 truncate">{p.name}</span>
                <span className={`ml-auto shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-md border ${badge.className}`}>
                  {badge.label}
                </span>
              </div>

              <div className="pl-6 flex items-center gap-1.5 min-w-0">
                <span className="text-[11px] text-stone-500 truncate">
                  {[p.location, p.client].filter(Boolean).join(' · ')}
                </span>
                {p.unackedAlerts > 0 && (
                  <span
                    className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 rounded-md px-1.5 py-0.5"
                    aria-label={`${p.unackedAlerts} unacknowledged alerts`}
                  >
                    <ShieldAlert className="w-3 h-3" aria-hidden />
                    {p.unackedAlerts}
                  </span>
                )}
              </div>

              <div className="pl-6 text-[11px] text-stone-400 tabular-nums">
                {p.progressPct}% · {formatKES(p.budgetSpent, true)} / {formatKES(p.budgetTotal, true)}
              </div>
            </DropdownMenuItem>
          )
        })}

        <DropdownMenuSeparator className="bg-stone-200" />
        <DropdownMenuItem
          onSelect={onCreate}
          className="mt-1 mb-1 mx-1 rounded-lg px-3 py-2.5 text-sm font-semibold text-amber-700 focus:bg-amber-50 focus:text-amber-800 cursor-pointer gap-2"
          aria-label="Create a new project"
        >
          <span className="w-5 h-5 rounded-md bg-amber-500 text-stone-950 flex items-center justify-center shrink-0" aria-hidden>
            <Plus className="w-3.5 h-3.5" />
          </span>
          New project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
