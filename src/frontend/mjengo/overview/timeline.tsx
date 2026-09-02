'use client'

// Unified Activity Timeline (W3-F1 · spec §44 Project → Activity).
//
// Fed ENTIRELY by the project payload's `auditEvents` slice (src/backend/lib/mjengo
// getProjectPayload already ships it) — no extra fetch, no new API. The admin
// Audit tab is the deep drill-down; this is the at-a-glance river of what
// happened on this project, newest first, for every owner role.

import { useMemo, useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Badge } from '@/frontend/ui/badge'
import {
  History, Truck, Banknote, UserCheck, Flag, FileDiff, Lock, Camera, MessageSquare,
  Download, HardHat, ReceiptText, Share2, KeyRound, Boxes, ClipboardList, Wallet,
  BookOpen, ListChecks, Users, TriangleAlert, Bell, Map,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { dateShort, timeEAT } from '@/frontend/lib/format'

/** Kind → icon (unknown kinds fall back to the history glyph). */
const KIND_ICONS: Record<string, { icon: LucideIcon; tint: string }> = {
  delivery: { icon: Truck, tint: 'text-stone-500' },
  wage: { icon: Banknote, tint: 'text-amber-600' },
  attendance: { icon: UserCheck, tint: 'text-stone-500' },
  milestone: { icon: Flag, tint: 'text-amber-600' },
  variation: { icon: FileDiff, tint: 'text-amber-600' },
  escrow: { icon: Lock, tint: 'text-emerald-600' },
  photo: { icon: Camera, tint: 'text-stone-500' },
  comment: { icon: MessageSquare, tint: 'text-stone-500' },
  export: { icon: Download, tint: 'text-stone-400' },
  project: { icon: HardHat, tint: 'text-amber-600' },
  expense: { icon: ReceiptText, tint: 'text-red-600' },
  share: { icon: Share2, tint: 'text-stone-500' },
  auth: { icon: KeyRound, tint: 'text-stone-500' },
  inventory: { icon: Boxes, tint: 'text-stone-500' },
  boq: { icon: ClipboardList, tint: 'text-stone-500' },
  payment: { icon: Wallet, tint: 'text-emerald-600' },
  wallet: { icon: Wallet, tint: 'text-emerald-600' },
  ledger: { icon: BookOpen, tint: 'text-emerald-600' },
  task: { icon: ListChecks, tint: 'text-stone-500' },
  phase: { icon: ListChecks, tint: 'text-stone-500' },
  material: { icon: Boxes, tint: 'text-stone-500' },
  consumption: { icon: Boxes, tint: 'text-stone-500' },
  worker: { icon: Users, tint: 'text-stone-500' },
  alert: { icon: TriangleAlert, tint: 'text-red-600' },
  notification: { icon: Bell, tint: 'text-stone-400' },
  site_map: { icon: Map, tint: 'text-stone-500' },
}

function kindIcon(kind: string) {
  return KIND_ICONS[kind] ?? { icon: History, tint: 'text-stone-400' }
}

/** Role badge tint (mirrors header UserChip role colors). */
function roleBadgeClass(role: string): string {
  if (role === 'admin') return 'bg-stone-800 text-stone-100 hover:bg-stone-800 border-0'
  if (role === 'client') return 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-0'
  if (role === 'system' || role === 'ai') return 'bg-stone-100 text-stone-600 hover:bg-stone-100 border-0'
  return 'bg-amber-100 text-amber-900 hover:bg-amber-100 border-0'
}

/** Compact timeline entry shape (a subset of the prisma AuditEvent row). */
export interface TimelineEvent {
  id: string
  kind: string
  actor: string
  role: string
  summary: string
  /** ISO string — normalized from the payload row at sort time. */
  createdAt: string
}

const COLLAPSED_COUNT = 20

export function ActivityTimeline() {
  const events = useMjengo((s) => s.data?.auditEvents ?? null)
  const [expanded, setExpanded] = useState(false)

  // Newest first (payload order is not guaranteed on the client — sort here),
  // collapsed shows the latest 20 only.
  const ordered = useMemo(() => {
    if (!events) return []
    return [...events]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        actor: e.actor,
        role: e.role,
        summary: e.summary,
        createdAt: String(e.createdAt),
      })) as TimelineEvent[]
  }, [events])

  // Graceful degrade: no auditEvents slice (or empty) → render nothing at all
  if (!events || ordered.length === 0) return null

  const visible = expanded ? ordered : ordered.slice(0, COLLAPSED_COUNT)
  const hidden = ordered.length - visible.length

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
          <History className="w-5 h-5 text-amber-600" aria-hidden /> Project activity
        </CardTitle>
        <CardDescription>
          Every recorded action on this build — the same trail the admin Audit tab
          drills into. Newest first · {ordered.length} event{ordered.length === 1 ? '' : 's'}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol
          className="relative max-h-96 overflow-y-auto pr-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full"
          aria-label="Project activity timeline"
        >
          {visible.map((ev, i) => {
            const { icon: KindIcon, tint } = kindIcon(ev.kind)
            const last = i === visible.length - 1 && hidden === 0
            const danger = tint === 'text-red-600'
            return (
              <li key={ev.id} className="relative flex gap-3">
                {/* Vertical rail: icon node + connecting line */}
                <span aria-hidden className={`relative shrink-0 w-8 flex justify-center ${last ? '' : 'pb-4'}`}>
                  <span className={`w-7 h-7 rounded-full border flex items-center justify-center z-10 ${danger ? 'bg-red-50 border-red-200' : 'bg-stone-50 border-stone-200'} ${tint}`}>
                    <KindIcon className="w-3.5 h-3.5" aria-hidden />
                  </span>
                  {!last && <span className="absolute top-7 bottom-0 w-px bg-stone-200" aria-hidden />}
                </span>
                <div className={`min-w-0 flex-1 ${last ? '' : 'pb-4'} pt-0.5`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-stone-400 tabular-nums whitespace-nowrap">
                      {dateShort(ev.createdAt)} · {timeEAT(ev.createdAt)}
                    </span>
                    <Badge className={`text-[10px] ${roleBadgeClass(ev.role)}`}>{ev.role}</Badge>
                  </div>
                  <p className="text-sm text-stone-700 mt-0.5 leading-snug">{ev.summary}</p>
                  <p className="text-[11px] text-stone-400 mt-0.5">
                    {ev.actor} · <span className="capitalize">{ev.kind.replace(/_/g, ' ')}</span>
                  </p>
                </div>
              </li>
            )
          })}
        </ol>

        {ordered.length > COLLAPSED_COUNT && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="mt-3 w-full min-h-11 text-sm font-semibold text-stone-600 hover:text-stone-900 border border-stone-200 rounded-lg hover:bg-stone-50 transition-colors"
          >
            {expanded ? 'Show latest 20 only' : `Show all activity (${hidden} more)`}
          </button>
        )}
      </CardContent>
    </Card>
  )
}
