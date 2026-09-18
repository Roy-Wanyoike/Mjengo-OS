'use client'

// Professionals — project parcel assignments summary. One honest list:
// professional · role · parcel · record state (INVITED → ACTIVE → DONE) with
// inline update/remove for the site team. Clients see the record, not the
// controls (also enforced server-side — no professionals action is in
// CLIENT_ACTIONS).
//
// All copy flows through useT() (land.pros.asg.* — issue #125); enum labels
// reuse the land.assignStatus / land.assignRole families.

import { useState } from 'react'
import { useT } from '@/frontend/i18n/provider'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Users, Trash2 } from 'lucide-react'
import { dateShort } from '@/frontend/lib/format'
import { cn } from '@/frontend/lib/utils'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import type { AssignmentDetail, AssignmentRole } from '@/backend/modules/professionals/types'
import { toast } from 'sonner'

const STATUS_PILLS: Record<string, string> = {
  invited: 'bg-amber-100 text-amber-800',
  active: 'bg-emerald-100 text-emerald-800',
  done: 'bg-stone-200 text-stone-700',
  completed: 'bg-stone-200 text-stone-700',
  withdrawn: 'bg-rose-100 text-rose-800',
}

function StatusPill({ status }: { status: string }) {
  const t = useT()
  return (
    <Badge className={cn('border-0 text-[10px] font-semibold shrink-0', STATUS_PILLS[status] ?? 'bg-stone-100 text-stone-600')}>
      {t(`land.assignStatus.${status}`)}
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
  const t = useT()
  const [busy, setBusy] = useState(false)

  const selectValue = assignment.status === 'completed' ? 'done' : assignment.status
  const selectable = ['invited', 'active', 'done'].includes(selectValue)

  async function setStatus(status: string) {
    if (status === selectValue) return
    setBusy(true)
    const ok = await dispatch('assignment.update', { id: assignment.id, status }, t('land.pros.asg.audit.mark', {
      name: assignment.professionalName,
      status: t(`land.assignStatus.${status}`),
      plot: assignment.parcelPlotNumber,
    }))
    setBusy(false)
    if (ok) {
      toast.success(online
        ? t('land.pros.asg.toast.marked', { status: t(`land.assignStatus.${status === 'completed' ? 'done' : status}`) })
        : t('field.savedQueued', { count: outbox.length + 1 }))
    } else {
      toast.error(t('land.pros.asg.toast.markFailed'))
    }
  }

  async function remove() {
    setBusy(true)
    const ok = await dispatch('assignment.remove', { id: assignment.id }, t('land.pros.asg.audit.remove', { name: assignment.professionalName, plot: assignment.parcelPlotNumber }))
    setBusy(false)
    onArm(null)
    if (ok) {
      toast.success(online ? t('land.pros.asg.toast.removed') : t('field.savedQueued', { count: outbox.length + 1 }))
    } else {
      toast.error(t('land.pros.asg.toast.removeFailed'))
    }
  }

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-stone-200 bg-white p-2.5 min-w-0 relative" role="listitem">
      <StatusPill status={assignment.status} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-stone-800 truncate">
          {assignment.professionalName}
          <span className="font-normal text-stone-500">
            {' '}· {t(`land.assignRole.${assignment.role as AssignmentRole}`)}
          </span>
        </p>
        <p className="text-[11px] text-stone-500 truncate">
          {assignment.parcelPlotNumber} · {assignment.parcelCounty} · {t('land.pros.asg.recorded', { date: dateShort(assignment.createdAt) })}
          {assignment.note ? ` — ${assignment.note}` : ''}
        </p>
      </div>
      {canEdit && (
        <div className="flex items-center gap-1.5 shrink-0">
          {selectable && (
            <Select value={selectValue} onValueChange={(v) => void setStatus(v)} disabled={busy}>
              <SelectTrigger className="h-8 w-[104px] text-[11px]" aria-label={t('land.pros.asg.statusAria', { name: assignment.professionalName, plot: assignment.parcelPlotNumber })}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="invited">{t('land.assignStatus.invited')}</SelectItem>
                <SelectItem value="active">{t('land.assignStatus.active')}</SelectItem>
                <SelectItem value="done">{t('land.assignStatus.done')}</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Button
            size="icon"
            variant="ghost"
            className={cn('h-8 w-8', armed ? 'text-rose-600 hover:bg-rose-50' : 'text-stone-400 hover:text-rose-600')}
            disabled={busy}
            aria-label={armed
              ? t('land.pros.asg.confirmRemoveAria', { name: assignment.professionalName, plot: assignment.parcelPlotNumber })
              : t('land.pros.asg.removeAria', { name: assignment.professionalName, plot: assignment.parcelPlotNumber })}
            onClick={() => (armed ? void remove() : onArm(assignment.id))}
          >
            <Trash2 className="w-4 h-4" aria-hidden />
          </Button>
        </div>
      )}
      {armed && <span className="sr-only">{t('land.pros.asg.confirmHint')}</span>}
    </div>
  )
}

export function AssignmentsSummary({ assignments, canEdit }: { assignments: AssignmentDetail[]; canEdit: boolean }) {
  const t = useT()
  const [armedId, setArmedId] = useState<string | null>(null)

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base sm:text-lg text-stone-900 flex items-center gap-2">
          <Users className="h-5 w-5 text-stone-500" aria-hidden />
          {t('land.pros.asg.title')}
          <Badge variant="outline" className="text-[10px] font-medium text-stone-600 border-stone-300">
            {t('land.pros.asg.onRecord', { count: assignments.length })}
          </Badge>
        </CardTitle>
        <CardDescription>
          {t('land.pros.asg.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {assignments.length ? (
          <div className="max-h-72 overflow-y-auto pr-2 -mr-2 space-y-2" role="list" aria-label={t('land.pros.asg.scrollAria')}>
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
            {t('land.pros.asg.empty')}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
