'use client'

// Site Plan tab — phases + task management v2 (Doc A §11).
//
// Task cards carry priority, assignee, dependency, blocked (reason + who/when
// from the audit ledger) and verification surfaces; blocking goes through an
// explicit dialog because a reason is required. Filter chips (All / Blocked /
// Verified / Overdue / High+Urgent) scope the per-phase task lists.
// Honest client-side pre-validation mirrors the server guards (self-dependency,
// blocked-dependency, cycle depth ≤ 5) so refusals toast the real reason.
// Existing phase/progress UI is untouched.

import { useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Slider } from '@/frontend/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/frontend/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/frontend/ui/alert-dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/frontend/ui/accordion'
import {
  Plus, ListChecks, CheckCircle2, Circle, CircleDot, Ban, Trash2, Layers, Pencil, User, Link2, BadgeCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatKES } from '@/frontend/lib/format'
import { format, formatDistanceToNow } from 'date-fns'
import { useT } from '@/frontend/i18n/provider'
import type { TranslateFn } from '@/frontend/i18n/types'
import type { AuditEvent, Task } from '@prisma/client'

// i18n (issue #107): module-level label maps carry DICT KEYS rendered via
// t(); the status/priority VALUES are server data and never change. The
// status/priority KEY names (done, in_progress, …) never render raw.
const STATUS_ICON: Record<string, { icon: React.ComponentType<{ className?: string }>; labelKey: string }> = {
  done: { icon: CheckCircle2, labelKey: 'siteplan.status.done' },
  in_progress: { icon: CircleDot, labelKey: 'siteplan.status.inProgress' },
  blocked: { icon: Ban, labelKey: 'siteplan.status.blocked' },
  pending: { icon: Circle, labelKey: 'siteplan.status.pending' },
}

// ---------------- task v2 display helpers ----------------

const PRIORITY_META: Record<string, { labelKey: string; badge: string }> = {
  urgent: { labelKey: 'siteplan.priority.urgent', badge: 'bg-red-600 text-white' }, // destructive tone
  high: { labelKey: 'siteplan.priority.high', badge: 'bg-amber-100 text-amber-800 border-amber-300' }, // warning
  normal: { labelKey: 'siteplan.priority.normal', badge: 'bg-stone-100 text-stone-600' }, // default
  low: { labelKey: 'siteplan.priority.low', badge: 'bg-stone-50 text-stone-400 border-stone-200' }, // muted
}

/** Roles allowed to verify completed work — mirrors the server gate in lib/mjengo.ts. */
const VERIFY_ROLES: readonly string[] = ['contractor', 'admin', 'supervisor']

const PRIORITIES: Array<{ value: string; labelKey: string }> = [
  { value: 'low', labelKey: 'siteplan.priority.low' },
  { value: 'normal', labelKey: 'siteplan.priority.normal' },
  { value: 'high', labelKey: 'siteplan.priority.high' },
  { value: 'urgent', labelKey: 'siteplan.priority.urgent' },
]

type TaskFilter = 'all' | 'blocked' | 'verified' | 'overdue' | 'priority'

const FILTERS: Array<{ key: TaskFilter; labelKey: string }> = [
  { key: 'all', labelKey: 'siteplan.filter.all' },
  { key: 'blocked', labelKey: 'siteplan.filter.blocked' },
  { key: 'verified', labelKey: 'siteplan.filter.verified' },
  { key: 'overdue', labelKey: 'siteplan.filter.overdue' },
  { key: 'priority', labelKey: 'siteplan.filter.priority' },
]

function priorityOf(t: Task): string {
  return t.priority ?? 'normal' // tolerant of optimistically-created local rows
}

function isBlockedTask(t: Task): boolean {
  return t.status === 'blocked' || Boolean(t.blockedReason)
}

function isOverdueTask(t: Task, startOfToday: number): boolean {
  return Boolean(t.dueDate) && t.status !== 'done' && new Date(t.dueDate as unknown as string).getTime() < startOfToday
}

function PriorityBadge({ priority }: { priority: string }) {
  const t = useT()
  const meta = PRIORITY_META[priority] ?? PRIORITY_META.normal
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 border-0 ${meta.badge}`}>
      {t(meta.labelKey)}
    </span>
  )
}

function VerifiedBadge({ name, at }: { name: string; at: Date | string }) {
  const t = useT()
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 shrink-0" title={t('siteplan.verifiedBy', { name })}>
      <BadgeCheck className="w-3 h-3" aria-hidden />
      {t('siteplan.verifiedBy', { name })} · {formatDistanceToNow(new Date(at), { addSuffix: true })}
    </span>
  )
}

/**
 * Client-side dependency guard — mirrors the server's assertDependencyOk:
 * no self-dependency, no depending on blocked work, cycle depth ≤ 5.
 * Returns the honest refusal message, or null when the link is fine.
 */
function dependencyProblem(
  taskId: string | null,
  blockedById: string,
  tasks: Array<{ id: string; title: string; status: string; blockedById?: string | null }>,
  t: TranslateFn,
): string | null {
  if (taskId && blockedById === taskId) return t('siteplan.dep.self')
  const target = tasks.find((tk) => tk.id === blockedById)
  if (!target) return t('siteplan.dep.notFound')
  if (target.status === 'blocked' || target.blockedById) {
    return t('siteplan.dep.blockedTarget', { title: target.title })
  }
  let current = target
  for (let depth = 1; depth <= 5 && current.blockedById; depth++) {
    if (taskId && current.id === taskId) return t('siteplan.dep.cycle')
    const next = tasks.find((tk) => tk.id === current.blockedById)
    if (!next) break
    current = next
  }
  return null
}

/** The most recent 'task.block' audit row for a task — who blocked it and when. */
function blockEventFor(taskId: string, events: AuditEvent[]): AuditEvent | undefined {
  return events.find((e) => e.entityId === taskId && e.meta?.includes('"task.block"'))
}

// ---------------- main tab ----------------

export function SitePlanTab() {
  const { data, dispatch, online, outbox, viewMode } = useMjengo()
  const { data: session } = useSession()
  const t = useT()
  const sessionRole = String(session?.user?.role ?? '')
  const canVerify = VERIFY_ROLES.includes(sessionRole)

  const [filter, setFilter] = useState<TaskFilter>('all')
  const [addOpen, setAddOpen] = useState(false)
  const [addPhaseId, setAddPhaseId] = useState<string>('')
  const [addTitle, setAddTitle] = useState('')
  const [addPriority, setAddPriority] = useState('normal')
  const [addAssignee, setAddAssignee] = useState('none')
  const [addDue, setAddDue] = useState('')
  const [addBlockedBy, setAddBlockedBy] = useState('none')
  const [phaseOpen, setPhaseOpen] = useState(false)
  const [phaseBusy, setPhaseBusy] = useState(false)
  const [phaseName, setPhaseName] = useState('')
  const [phaseBudget, setPhaseBudget] = useState('')
  const [deleteTask, setDeleteTask] = useState<{ id: string; title: string } | null>(null)
  const [editTask, setEditTask] = useState<Task | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editPriority, setEditPriority] = useState('normal')
  const [editAssignee, setEditAssignee] = useState('none')
  const [editDue, setEditDue] = useState('')
  const [editBlockedBy, setEditBlockedBy] = useState('none')
  const [blockTask, setBlockTask] = useState<{ id: string; title: string; phaseId: string } | null>(null)
  const [blockReason, setBlockReason] = useState('')
  const [blockDep, setBlockDep] = useState('none')

  const startOfToday = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }, [])

  /** Localized status label (`in_progress` → the dict's in-progress word). */
  const statusLabel = (s: string) => t(s === 'in_progress' ? 'siteplan.status.inProgress' : `siteplan.status.${s}`)

  const allTasks = useMemo(() => data?.phases.flatMap((p) => p.tasks) ?? [], [data])
  const taskById = useMemo(() => new Map(allTasks.map((t) => [t.id, t] as const)), [allTasks])
  const workerById = useMemo(() => new Map((data?.workers ?? []).map((w) => [w.id, w] as const)), [data])

  const counts = useMemo(() => {
    const blocked = allTasks.filter((t) => isBlockedTask(t)).length
    const verified = allTasks.filter((t) => Boolean(t.verifiedAt)).length
    const overdue = allTasks.filter((t) => isOverdueTask(t, startOfToday)).length
    const hot = allTasks.filter((t) => ['high', 'urgent'].includes(priorityOf(t))).length
    return { all: allTasks.length, blocked, verified, overdue, hot }
  }, [allTasks, startOfToday])

  if (!data) return null
  const isClient = viewMode === 'client'

  const filterCount = (key: TaskFilter): number =>
    key === 'all' ? counts.all : key === 'blocked' ? counts.blocked : key === 'verified' ? counts.verified : key === 'overdue' ? counts.overdue : counts.hot

  const matchesFilter = (t: Task): boolean => {
    switch (filter) {
      case 'blocked': return isBlockedTask(t)
      case 'verified': return Boolean(t.verifiedAt)
      case 'overdue': return isOverdueTask(t, startOfToday)
      case 'priority': return ['high', 'urgent'].includes(priorityOf(t))
      default: return true
    }
  }

  /** Dependency candidates for a dialog: same phase, unblocked, not done. */
  const dependencyCandidates = (phaseId: string, excludeId?: string, includeSelf = false): Task[] =>
    (data.phases.find((p) => p.id === phaseId)?.tasks ?? []).filter(
      (t) => t.status !== 'blocked' && !t.blockedById && t.status !== 'done' && (includeSelf || t.id !== excludeId),
    )

  function openEdit(t: Task) {
    setEditTask(t)
    setEditTitle(t.title)
    setEditPriority(t.priority ?? 'normal')
    setEditAssignee(t.assignedToId ?? 'none')
    setEditDue(t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : '')
    setEditBlockedBy(t.blockedById ?? 'none')
  }

  function openBlock(t: Task) {
    setBlockTask({ id: t.id, title: t.title, phaseId: t.phaseId })
    setBlockReason('')
    setBlockDep('none')
  }

  async function addTask() {
    if (!addTitle.trim() || !addPhaseId) {
      toast.error(t('siteplan.toast.pickPhaseTitle'))
      return
    }
    if (addBlockedBy !== 'none') {
      const problem = dependencyProblem(null, addBlockedBy, allTasks, t)
      if (problem) { toast.error(problem); return }
    }
    const ok = await dispatch('task.create', {
      phaseId: addPhaseId,
      title: addTitle.trim(),
      priority: addPriority,
      assignedToId: addAssignee === 'none' ? null : addAssignee,
      dueDate: addDue ? new Date(addDue).toISOString() : null,
      blockedById: addBlockedBy === 'none' ? null : addBlockedBy,
    }, `Add task "${addTitle.trim()}"`)
    if (ok) {
      toast.success(online ? t('siteplan.toast.taskAdded') : t('siteplan.toast.taskQueued', { count: outbox.length + 1 }))
      setAddTitle('')
      setAddPriority('normal')
      setAddAssignee('none')
      setAddDue('')
      setAddBlockedBy('none')
      setAddOpen(false)
    } else {
      toast.error(t('siteplan.toast.taskAddFailed'))
    }
  }

  async function saveEdit() {
    if (!editTask) return
    if (!editTitle.trim()) { toast.error(t('siteplan.toast.titleEmpty')); return }
    if (editBlockedBy !== 'none') {
      const problem = dependencyProblem(editTask.id, editBlockedBy, allTasks, t)
      if (problem) { toast.error(problem); return }
    }
    const ok = await dispatch('task.update', {
      id: editTask.id,
      title: editTitle.trim(),
      priority: editPriority,
      assignedToId: editAssignee === 'none' ? null : editAssignee,
      dueDate: editDue ? new Date(editDue).toISOString() : null,
      blockedById: editBlockedBy === 'none' ? null : editBlockedBy,
    }, `Edit task "${editTitle.trim()}"`)
    if (ok) {
      toast.success(online ? t('siteplan.toast.taskUpdated') : t('siteplan.toast.editQueued', { count: outbox.length + 1 }))
      setEditTask(null)
    } else {
      toast.error(t('siteplan.toast.taskUpdateFailed'))
    }
  }

  async function confirmBlock() {
    if (!blockTask) return
    if (!blockReason.trim()) {
      toast.error(t('siteplan.toast.blockReasonRequired'))
      return
    }
    if (blockDep !== 'none') {
      const problem = dependencyProblem(blockTask.id, blockDep, allTasks, t)
      if (problem) { toast.error(problem); return }
    }
    const ok = await dispatch('task.block', {
      id: blockTask.id,
      reason: blockReason.trim(),
      blockedById: blockDep === 'none' ? undefined : blockDep,
    }, `Block "${blockTask.title}"`)
    if (ok) {
      toast.success(online ? t('siteplan.toast.blockedOk', { title: blockTask.title }) : t('siteplan.toast.blockQueued', { count: outbox.length + 1 }))
      setBlockTask(null)
    } else {
      toast.error(t('siteplan.toast.blockFailed'))
    }
  }

  async function unblockTask(tk: Task) {
    const ok = await dispatch('task.unblock', { id: tk.id }, `Unblock "${tk.title}"`)
    if (ok) toast.success(online ? t('siteplan.toast.unblockedOk', { title: tk.title }) : t('siteplan.toast.unblockQueued', { count: outbox.length + 1 }))
    else toast.error(t('siteplan.toast.unblockFailed'))
  }

  async function completeTask(tk: Task) {
    if (isBlockedTask(tk)) { toast.error(t('siteplan.toast.blockedComplete', { title: tk.title, reason: tk.blockedReason ? `: ${tk.blockedReason}` : '' })); return }
    if (tk.blockedById) {
      const blocker = taskById.get(tk.blockedById)
      if (blocker && blocker.status !== 'done') {
        toast.error(t('siteplan.toast.depNotDone', { title: tk.title, blocker: blocker.title }))
        return
      }
    }
    const ok = await dispatch('task.complete', { id: tk.id }, `Complete "${tk.title}"`)
    if (ok) toast.success(online ? t('siteplan.toast.completedOk', { title: tk.title }) : t('siteplan.toast.completeQueued', { count: outbox.length + 1 }))
    else toast.error(t('siteplan.toast.completeFailed'))
  }

  async function verifyTask(tk: Task) {
    if (tk.status !== 'done') { toast.error(t('siteplan.toast.verifyNotDone', { title: tk.title, status: statusLabel(tk.status) })); return }
    const ok = await dispatch('task.verify', { id: tk.id }, `Verify "${tk.title}"`)
    if (ok) toast.success(online ? t('siteplan.toast.verifiedOk', { title: tk.title }) : t('siteplan.toast.verifyQueued', { count: outbox.length + 1 }))
    else toast.error(t('siteplan.toast.verifyFailed'))
  }

  async function confirmDeleteTask() {
    if (!deleteTask) return
    const ok = await dispatch('task.delete', { id: deleteTask.id }, `Delete task "${deleteTask.title}"`)
    if (ok) toast.success(t('siteplan.toast.deletedOk', { title: deleteTask.title }))
    else toast.error(t('siteplan.toast.deleteFailed'))
    setDeleteTask(null)
  }

  async function addPhase() {
    const budget = Number(phaseBudget)
    if (!phaseName.trim()) { toast.error(t('siteplan.toast.phaseNameRequired')); return }
    if (!phaseBudget || Number.isNaN(budget) || budget < 0) { toast.error(t('siteplan.toast.phaseBudgetInvalid')); return }
    setPhaseBusy(true)
    const ok = await dispatch('phase.create', { name: phaseName.trim(), budget: Math.round(budget) }, `Add phase "${phaseName.trim()}"`)
    setPhaseBusy(false)
    if (ok) {
      toast.success(online ? t('siteplan.toast.phaseAdded', { name: phaseName.trim() }) : t('siteplan.toast.phaseQueued', { count: outbox.length }))
      setPhaseOpen(false); setPhaseName(''); setPhaseBudget('')
    } else {
      toast.error(t('siteplan.toast.phaseAddFailed'))
    }
  }

  return (
    <div className="space-y-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-lg text-stone-900 flex items-center gap-2">
              <ListChecks className="w-5 h-5 text-amber-600" aria-hidden /> {t('siteplan.title', { name: data.project.name })}
            </CardTitle>
            <CardDescription>
              {t('siteplan.desc', {
                phases: data.phases.length,
                tasks: counts.all,
                blocked: counts.blocked > 0 ? t('siteplan.desc.blocked', { count: counts.blocked }) : '',
                overdue: counts.overdue > 0 ? t('siteplan.desc.overdue', { count: counts.overdue }) : '',
              })}
            </CardDescription>
          </div>
          {!isClient && (
            <Button size="sm" className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white shrink-0" onClick={() => { setAddPhaseId(data.phases[0]?.id ?? ''); setAddOpen(true) }}>
              <Plus className="w-4 h-4" aria-hidden /> {t('siteplan.taskButton')}
            </Button>
          )}
        </CardHeader>
        <CardContent className="pt-0 pb-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('siteplan.filterAria')}>
            {FILTERS.map((f) => {
              const active = filter === f.key
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(f.key)}
                  className={`h-9 px-3 rounded-full text-xs font-medium border transition-colors ${
                    active
                      ? 'bg-stone-900 text-white border-stone-900 hover:bg-stone-800'
                      : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50 hover:text-stone-900'
                  }`}
                >
                  {t(f.labelKey)} <span className={`tabular-nums ${active ? 'text-amber-400' : 'text-stone-400'}`}>{filterCount(f.key)}</span>
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <Accordion type="multiple" defaultValue={[data.phases.find((p) => p.status === 'in_progress')?.id ?? data.phases[0]?.id]} className="space-y-4">
        {data.phases.map((phase) => {
          const visibleTasks = phase.tasks.filter(matchesFilter)
          return (
            <AccordionItem key={phase.id} value={phase.id} className="border border-stone-200 rounded-xl bg-white shadow-sm overflow-hidden">
              <AccordionTrigger className="hover:no-underline px-5 py-4 hover:bg-stone-50">
                <div className="flex items-center gap-3 flex-1 text-left min-w-0">
                  <span className="w-8 h-8 rounded-lg bg-stone-900 text-amber-400 font-bold flex items-center justify-center text-sm shrink-0" aria-hidden>
                    {phase.order}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-stone-900">{phase.name}</span>
                      <Badge className={`text-[10px] border-0 ${phase.status === 'done' ? 'bg-emerald-100 text-emerald-800' : phase.status === 'in_progress' ? 'bg-amber-100 text-amber-800' : 'bg-stone-100 text-stone-500'}`}>
                        {statusLabel(phase.status)}
                      </Badge>
                    </div>
                    <p className="text-xs text-stone-500 mt-0.5">
                      {t('siteplan.phase.tasksDone', { done: phase.tasks.filter((task) => task.status === 'done').length, total: phase.tasks.length, budget: formatKES(phase.budget, true), pct: phase.progress })}
                    </p>
                  </div>
                  <div className="w-24 sm:w-40 shrink-0" aria-hidden>
                    <div className="h-2 bg-stone-200 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${phase.status === 'done' ? 'bg-emerald-600' : 'bg-amber-500'}`} style={{ width: `${phase.progress}%` }} />
                    </div>
                  </div>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-5 pb-5 pt-0">
                <div className="space-y-2.5">
                  {visibleTasks.map((task) => {
                    const done = task.status === 'done'
                    const blocked = isBlockedTask(task)
                    const overdue = isOverdueTask(task, startOfToday)
                    const worker = task.assignedToId ? workerById.get(task.assignedToId) : undefined
                    const blocker = task.blockedById ? taskById.get(task.blockedById) : undefined
                    const blockEvent = blocked ? blockEventFor(task.id, data.auditEvents) : undefined
                    return (
                      <div
                        key={task.id}
                        className={`flex flex-col gap-3 rounded-lg border p-3 ${blocked ? 'border-red-200 bg-red-50/50' : 'border-stone-200 bg-stone-50/60'}`}
                      >
                        <div className="flex items-start gap-2.5">
                          {(() => {
                            const entry = STATUS_ICON[task.status] ?? STATUS_ICON.pending
                            const StatusIcon = entry.icon
                            return <StatusIcon className={task.status === 'done' ? 'w-4 h-4 text-emerald-600' : task.status === 'in_progress' ? 'w-4 h-4 text-amber-600' : task.status === 'blocked' ? 'w-4 h-4 text-red-600' : 'w-4 h-4 text-stone-300'} aria-label={t(entry.labelKey)} />
                          })()}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap min-w-0">
                              <p className={`text-sm font-medium ${done ? 'text-stone-400 line-through' : 'text-stone-800'}`}>{task.title}</p>
                              <PriorityBadge priority={priorityOf(task)} />
                              {task.verifiedAt && task.verifiedByName ? (
                                <VerifiedBadge name={task.verifiedByName} at={task.verifiedAt as unknown as string} />
                              ) : done ? (
                                <span className="text-[11px] text-stone-400">{t('siteplan.task.awaitingVerification')}</span>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mt-1 text-[11px] text-stone-400">
                              <span>{t('siteplan.task.progress', { pct: task.progress })}</span>
                              {task.dueDate && (
                                <span className={overdue ? 'text-red-600 font-semibold' : 'text-stone-400'}>
                                  {t('siteplan.task.due', { date: format(new Date(task.dueDate as unknown as string), 'd MMM') })}{overdue ? t('siteplan.task.overdue') : ''}
                                </span>
                              )}
                              {worker && (
                                <span className="inline-flex items-center gap-1 text-stone-600 bg-white border border-stone-200 rounded-full px-2 py-0.5" title={`${worker.name} · ${worker.role}`}>
                                  <User className="w-3 h-3" aria-hidden /> {worker.name}
                                </span>
                              )}
                              {blocker && (
                                <span className="inline-flex items-center gap-1 text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5" title={t('siteplan.task.dependsOn', { title: blocker.title, status: statusLabel(blocker.status) })}>
                                  <Link2 className="w-3 h-3" aria-hidden /> {t('siteplan.task.blockedBy', { title: blocker.title })}
                                </span>
                              )}
                            </div>
                            {blocked && (
                              <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs" role="alert">
                                <div className="flex items-start gap-2">
                                  <Ban className="w-3.5 h-3.5 text-red-600 mt-0.5 shrink-0" aria-hidden />
                                  <div className="min-w-0 flex-1">
                                    <p className="font-medium text-red-800">
                                      {t('siteplan.blocked.title')}{blockEvent ? t('siteplan.blocked.by', { actor: blockEvent.actor }) : ''}{blockEvent ? ` · ${formatDistanceToNow(new Date(blockEvent.createdAt), { addSuffix: true })}` : ''}
                                    </p>
                                    <p className="text-red-700 mt-0.5 leading-snug break-words">
                                      {task.blockedReason ?? t('siteplan.blocked.noReason')}
                                    </p>
                                  </div>
                                  {!isClient && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 gap-1.5 border-red-300 text-red-700 hover:bg-red-100 hover:text-red-800 shrink-0"
                                      onClick={() => void unblockTask(task)}
                                      aria-label={t('siteplan.task.unblockAria', { title: task.title })}
                                    >
                                      {t('siteplan.task.unblock')}
                                    </Button>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                          <Slider
                            value={[task.progress]}
                            max={100}
                            step={5}
                            onValueCommit={([v]) => void dispatch('task.update', { id: task.id, progress: v }, `Update "${task.title}" to ${v}%`)}
                            disabled={done || isClient}
                            aria-label={t('siteplan.task.progressAria', { title: task.title })}
                            className="flex-1 data-[disabled]:opacity-40"
                          />
                          <Select
                            value={task.status}
                            onValueChange={(v) => {
                              if (v === 'blocked') { openBlock(task); return }
                              void dispatch('task.update', { id: task.id, status: v }, `Set "${task.title}" ${v}`)
                            }}
                            disabled={isClient}
                          >
                            <SelectTrigger size="sm" className="w-32 bg-white text-xs h-8" aria-label={t('siteplan.task.statusAria', { title: task.title })}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="pending">{t('siteplan.status.pending')}</SelectItem>
                              <SelectItem value="in_progress">{t('siteplan.status.inProgress')}</SelectItem>
                              <SelectItem value="done">{t('siteplan.status.done')}</SelectItem>
                              <SelectItem value="blocked">{t('siteplan.status.blocked')}…</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {!done && !blocked && !isClient && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-9 gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                                onClick={() => void completeTask(task)}
                                aria-label={t('siteplan.task.completeAria', { title: task.title })}
                              >
                                <CheckCircle2 className="w-4 h-4" aria-hidden /> {t('siteplan.task.complete')}
                              </Button>
                            )}
                            {done && !task.verifiedAt && canVerify && !isClient && (
                              <Button
                                size="sm"
                                className="h-9 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                                onClick={() => void verifyTask(task)}
                                aria-label={t('siteplan.task.verifyAria', { title: task.title })}
                              >
                                <BadgeCheck className="w-4 h-4" aria-hidden /> {t('siteplan.task.verify')}
                              </Button>
                            )}
                            {!done && !blocked && !isClient && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-9 w-9 p-0 text-stone-400 hover:text-red-700 hover:bg-red-50"
                                onClick={() => openBlock(task)}
                                aria-label={t('siteplan.task.blockAria', { title: task.title })}
                              >
                                <Ban className="w-4 h-4" aria-hidden />
                              </Button>
                            )}
                            {!isClient && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-9 w-9 p-0 text-stone-400 hover:text-stone-900 hover:bg-stone-100"
                                onClick={() => openEdit(task)}
                                aria-label={t('siteplan.task.editAria', { title: task.title })}
                              >
                                <Pencil className="w-4 h-4" aria-hidden />
                              </Button>
                            )}
                            {!isClient && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-9 w-9 p-0 text-stone-400 hover:text-red-600 hover:bg-red-50"
                                onClick={() => setDeleteTask({ id: task.id, title: task.title })}
                                aria-label={t('siteplan.task.deleteAria', { title: task.title })}
                              >
                                <Trash2 className="w-4 h-4" aria-hidden />
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {phase.tasks.length === 0 && (
                    <p className="text-sm text-stone-400 py-3 text-center border border-dashed border-stone-200 rounded-lg">
                      {t('siteplan.phase.empty')}
                    </p>
                  )}
                  {phase.tasks.length > 0 && visibleTasks.length === 0 && (
                    <p className="text-sm text-stone-400 py-3 text-center border border-dashed border-stone-200 rounded-lg">
                      {t(phase.tasks.length === 1 ? 'siteplan.phase.noMatch.one' : 'siteplan.phase.noMatch.many', {
                        count: phase.tasks.length,
                        filter: t(FILTERS.find((f) => f.key === filter)?.labelKey ?? 'siteplan.filter.all'),
                      })}
                    </p>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>
          )
        })}
      </Accordion>

      {/* Add phase (owner only) */}
      {!isClient && (
        <Button
          variant="outline"
          className="w-full gap-1.5 min-h-11 border-dashed border-stone-300 text-stone-600 hover:text-stone-900 hover:bg-stone-50"
          onClick={() => setPhaseOpen(true)}
          aria-label={t('siteplan.addPhaseAria')}
        >
          <Layers className="w-4 h-4" aria-hidden /> {t('siteplan.addPhase')}
        </Button>
      )}

      {/* Add task dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('siteplan.addTask.title')}</DialogTitle>
            <DialogDescription>{t('siteplan.addTask.desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 max-h-[70vh] overflow-y-auto">
            <div className="space-y-2">
              <Label htmlFor="phase">{t('siteplan.addTask.phase')}</Label>
              <Select value={addPhaseId} onValueChange={setAddPhaseId}>
                <SelectTrigger id="phase"><SelectValue placeholder={t('siteplan.addTask.phasePh')} /></SelectTrigger>
                <SelectContent>
                  {data.phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.order}. {p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="title">{t('siteplan.addTask.task')}</Label>
              <Input id="title" value={addTitle} onChange={(e) => setAddTitle(e.target.value)} placeholder={t('siteplan.addTask.taskPh')} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="priority">{t('siteplan.addTask.priority')}</Label>
                <Select value={addPriority} onValueChange={setAddPriority}>
                  <SelectTrigger id="priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => <SelectItem key={p.value} value={p.value}>{t(p.labelKey)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="assignee">{t('siteplan.addTask.assignee')}</Label>
                <Select value={addAssignee} onValueChange={setAddAssignee}>
                  <SelectTrigger id="assignee"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('siteplan.addTask.unassigned')}</SelectItem>
                    {data.workers.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="due">{t('siteplan.addTask.due')}</Label>
              <Input id="due" type="date" value={addDue} onChange={(e) => setAddDue(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="blockedby">{t('siteplan.addTask.blockedBy')}</Label>
              <Select value={addBlockedBy} onValueChange={setAddBlockedBy}>
                <SelectTrigger id="blockedby"><SelectValue placeholder={t('siteplan.addTask.noDependency')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('siteplan.addTask.noDependency')}</SelectItem>
                  {addPhaseId && dependencyCandidates(addPhaseId).map((tk) => (
                    <SelectItem key={tk.id} value={tk.id}>{tk.title} ({statusLabel(tk.status)})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-stone-400">{t('siteplan.addTask.dependencyHint')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>{t('siteplan.addTask.cancel')}</Button>
            <Button onClick={() => void addTask()} className="bg-amber-600 hover:bg-amber-700 text-white">{t('siteplan.addTask.submit')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit task dialog */}
      <Dialog open={Boolean(editTask)} onOpenChange={(v) => !v && setEditTask(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('siteplan.editTask.title')}</DialogTitle>
            <DialogDescription>{t('siteplan.editTask.desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 max-h-[70vh] overflow-y-auto">
            <div className="space-y-2">
              <Label htmlFor="edit-title">{t('siteplan.addTask.task')}</Label>
              <Input id="edit-title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-priority">{t('siteplan.addTask.priority')}</Label>
                <Select value={editPriority} onValueChange={setEditPriority}>
                  <SelectTrigger id="edit-priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => <SelectItem key={p.value} value={p.value}>{t(p.labelKey)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-assignee">{t('siteplan.addTask.assignee')}</Label>
                <Select value={editAssignee} onValueChange={setEditAssignee}>
                  <SelectTrigger id="edit-assignee"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('siteplan.addTask.unassigned')}</SelectItem>
                    {data.workers.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-due">{t('siteplan.addTask.due')}</Label>
              <Input id="edit-due" type="date" value={editDue} onChange={(e) => setEditDue(e.target.value)} />
            </div>
            {editTask && (
              <div className="space-y-2">
                <Label htmlFor="edit-blockedby">{t('siteplan.editTask.blockedBy')}</Label>
                <Select value={editBlockedBy} onValueChange={setEditBlockedBy}>
                  <SelectTrigger id="edit-blockedby"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('siteplan.addTask.noDependency')}</SelectItem>
                    {(data.phases.find((p) => p.id === editTask.phaseId)?.tasks ?? [])
                      .filter((tk) => tk.status !== 'blocked' && !tk.blockedById && tk.status !== 'done')
                      .map((tk) => (
                        <SelectItem key={tk.id} value={tk.id}>{tk.id === editTask.id ? t('siteplan.editTask.thisTask', { title: tk.title }) : tk.title}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-stone-400">{t('siteplan.editTask.dependencyHint')}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTask(null)}>{t('siteplan.editTask.cancel')}</Button>
            <Button onClick={() => void saveEdit()} className="bg-amber-600 hover:bg-amber-700 text-white">{t('siteplan.editTask.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Block task dialog — a reason is required */}
      <Dialog open={Boolean(blockTask)} onOpenChange={(v) => !v && setBlockTask(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('siteplan.blockTask.title', { title: blockTask?.title ?? '' })}</DialogTitle>
            <DialogDescription>{t('siteplan.blockTask.desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="block-reason">{t('siteplan.blockTask.reason')}</Label>
              <Input
                id="block-reason"
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                placeholder={t('siteplan.blockTask.reasonPh')}
                maxLength={500}
              />
            </div>
            {blockTask && dependencyCandidates(blockTask.phaseId, blockTask.id).length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="block-dep">{t('siteplan.blockTask.dependsOn')}</Label>
                <Select value={blockDep} onValueChange={setBlockDep}>
                  <SelectTrigger id="block-dep"><SelectValue placeholder={t('siteplan.addTask.noDependency')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('siteplan.addTask.noDependency')}</SelectItem>
                    {dependencyCandidates(blockTask.phaseId, blockTask.id).map((tk) => (
                      <SelectItem key={tk.id} value={tk.id}>{tk.title} ({statusLabel(tk.status)})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-stone-400">{t('siteplan.blockTask.dependencyHint')}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBlockTask(null)}>{t('siteplan.blockTask.cancel')}</Button>
            <Button onClick={() => void confirmBlock()} className="gap-1.5 bg-red-600 hover:bg-red-700 text-white">
              <Ban className="w-4 h-4" aria-hidden /> {t('siteplan.blockTask.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add phase dialog */}
      <Dialog open={phaseOpen} onOpenChange={setPhaseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('siteplan.phaseDialog.title')}</DialogTitle>
            <DialogDescription>{t('siteplan.phaseDialog.desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="phase-name">{t('siteplan.phaseDialog.name')}</Label>
              <Input id="phase-name" value={phaseName} onChange={(e) => setPhaseName(e.target.value)} placeholder={t('siteplan.phaseDialog.namePh')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phase-budget">{t('siteplan.phaseDialog.budget')}</Label>
              <Input id="phase-budget" type="number" min="0" value={phaseBudget} onChange={(e) => setPhaseBudget(e.target.value)} placeholder={t('siteplan.phaseDialog.budgetPh')} />
              {phaseBudget && !Number.isNaN(Number(phaseBudget)) && Number(phaseBudget) >= 0 && (
                <p className="text-xs text-stone-500">{t('siteplan.phaseDialog.budgetPreview', { amount: formatKES(Number(phaseBudget)) })}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPhaseOpen(false)} disabled={phaseBusy}>{t('siteplan.phaseDialog.cancel')}</Button>
            <Button onClick={() => void addPhase()} disabled={phaseBusy} className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white">
              <Layers className="w-4 h-4" aria-hidden /> {t('siteplan.phaseDialog.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete task confirmation */}
      <AlertDialog open={Boolean(deleteTask)} onOpenChange={(v) => !v && setDeleteTask(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('siteplan.deleteTask.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('siteplan.deleteTask.desc', { title: deleteTask?.title ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('siteplan.deleteTask.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmDeleteTask()}
              className="bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500"
            >
              {t('siteplan.deleteTask.submit')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
