'use client'

// Professionals — project parcel assignments summary. One honest list:
// professional · role · parcel · record state (INVITED → ACTIVE → DONE) with
// inline update/remove for the site team. Clients see the record, not the
// controls (also enforced server-side — no professionals action is in
// CLIENT_ACTIONS).

import { useState } from 'react'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Users, Trash2 } from 'lucide-react'
import { dateShort } from '@/frontend/lib/format'
import { cn } from '@/frontend/lib/utils'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import {
  ASSIGNMENT_ROLE_LABELS,
  type AssignmentDetail,
  type AssignmentRole,
} from '@/backend/modules/professionals/types'
import { toast } from 'sonner'

const STATUS_PILLS: Record<string, string> = {
  invited: 'bg-amber-100 text-amber-800',
  active: 'bg-emerald-100 text-emerald-800',
  done: 'bg-stone-200 text-stone-700',
  completed: 'bg-stone-200 text-stone-700',
  withdrawn: 'bg-rose-100 text-rose-800',
}

const STATUS_TEXT: Record<string, string> = {
  invited: 'Invited',
  active: 'Active',
  done: 'Done',
  completed: 'Done',
  withdrawn: 'Withdrawn',
}

function StatusPill({ status }: { status: string }) {
  return (
    <Badge className={cn('border-0 text-[10px] font-semibold shrink-0', STATUS_PILLS[status] ?? 'bg-stone-100 text-stone-600')}>
      {STATUS_TEXT[status] ?? status}
    </Badge>
  )
}

function AssignmentRow({
  assignment,
  canEdit,
  armed,
  onArm,
}: {
  assignment: AssignmentDetail
  canEdit: boolean
  armed: boolean
  onArm: (id: string | null) => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const [busy, setBusy] = useState(false)

  const selectValue = assignment.status === 'completed' ? 'done' : assignment.status
  const selectable = ['invited', 'active', 'done'].includes(selectValue)

  async function setStatus(status: string) {
    if (status === selectValue) return
    setBusy(true)
    const ok = await dispatch('assignment.update', { id: assignment.id, status }, `Mark ${assignment.professionalName} ${status} on ${assignment.parcelPlotNumber}`)
    setBusy(false)
    if (ok) {
      toast.success(online ? `Assignment marked ${status}` : `Saved on-device — queued (${outbox.length + 1})`)
    } else {
      toast.error('Could not update the assignment status')
    }
  }

  async function remove() {
    setBusy(true)
    const ok = await dispatch('assignment.remove', { id: assignment.id }, `Remove ${assignment.professionalName} from ${assignment.parcelPlotNumber}`)
    setBusy(false)
    onArm(null)
    if (ok) {
      toast.success(online ? 'Assignment removed — audit history preserved' : `Saved on-device — queued (${outbox.length + 1})`)
    } else {
      toast.error('Could not remove the assignment')
    }
  }

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-stone-200 bg-white p-2.5 min-w-0 relative" role="listitem">
      <StatusPill status={assignment.status} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-stone-800 truncate">
          {assignment.professionalName}
          <span className="font-normal text-stone-500">
            {' '}· {ASSIGNMENT_ROLE_LABELS[assignment.role as AssignmentRole] ?? assignment.role}
          </span>
        </p>
        <p className="text-[11px] text-stone-500 truncate">
          {assignment.parcelPlotNumber} · {assignment.parcelCounty} · recorded {dateShort(assignment.createdAt)}
          {assignment.note ? ` — ${assignment.note}` : ''}
        </p>
      </div>
      {canEdit && (
        <div className="flex items-center gap-1.5 shrink-0">
          {selectable && (
            <Select value={selectValue} onValueChange={(v) => void setStatus(v)} disabled={busy}>
              <SelectTrigger className="h-8 w-[104px] text-[11px]" aria-label={`Status for ${assignment.professionalName} on ${assignment.parcelPlotNumber}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="invited">Invited</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="done">Done</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Button
            size="icon"
            variant="ghost"
            className={cn('h-8 w-8', armed ? 'text-rose-600 hover:bg-rose-50' : 'text-stone-400 hover:text-rose-600')}
            disabled={busy}
            aria-label={armed ? `Confirm removing ${assignment.professionalName} from ${assignment.parcelPlotNumber}` : `Remove ${assignment.professionalName} from ${assignment.parcelPlotNumber}`}
            onClick={() => (armed ? void remove() : onArm(assignment.id))}
          >
            <Trash2 className="w-4 h-4" aria-hidden />
          </Button>
        </div>
      )}
      {armed && <span className="sr-only">Press the button again to confirm</span>}
    </div>
  )
}

export function AssignmentsSummary({ assignments, canEdit }: { assignments: AssignmentDetail[]; canEdit: boolean }) {
  const [armedId, setArmedId] = useState<string | null>(null)

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base sm:text-lg text-stone-900 flex items-center gap-2">
          <Users className="h-5 w-5 text-stone-500" aria-hidden />
          Parcel assignments
          <Badge variant="outline" className="text-[10px] font-medium text-stone-600 border-stone-300">
            {assignments.length} on record
          </Badge>
        </CardTitle>
        <CardDescription>
          Who is engaged on which parcel — honest record states (Invited → Active → Done), never engagement claims
          beyond the platform.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {assignments.length ? (
          <div className="max-h-72 overflow-y-auto pr-2 -mr-2 space-y-2" role="list" aria-label="Parcel assignments, scrollable">
            {assignments.map((a) => (
              <AssignmentRow
                key={a.id}
                assignment={a}
                canEdit={canEdit}
                armed={armedId === a.id}
                onArm={setArmedId}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-stone-500 py-3">
            No assignments recorded yet — invite a surveyor or advocate onto a parcel from the directory below.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
