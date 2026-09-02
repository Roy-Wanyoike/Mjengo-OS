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
import type { AuditEvent, Task } from '@prisma/client'

const STATUS_ICON: Record<string, React.ReactNode> = {
  done: <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-label="done" />,
  in_progress: <CircleDot className="w-4 h-4 text-amber-600" aria-label="in progress" />,
  blocked: <Ban className="w-4 h-4 text-red-600" aria-label="blocked" />,
  pending: <Circle className="w-4 h-4 text-stone-300" aria-label="pending" />,
}

// ---------------- task v2 display helpers ----------------

const PRIORITY_META: Record<string, { label: string; badge: string }> = {
  urgent: { label: 'Urgent', badge: 'bg-red-600 text-white' }, // destructive tone
  high: { label: 'High', badge: 'bg-amber-100 text-amber-800 border-amber-300' }, // warning
  normal: { label: 'Normal', badge: 'bg-stone-100 text-stone-600' }, // default
  low: { label: 'Low', badge: 'bg-stone-50 text-stone-400 border-stone-200' }, // muted
}

/** Roles allowed to verify completed work — mirrors the server gate in lib/mjengo.ts. */
const VERIFY_ROLES: readonly string[] = ['contractor', 'admin', 'supervisor']

const PRIORITIES: Array<{ value: string; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

type TaskFilter = 'all' | 'blocked' | 'verified' | 'overdue' | 'priority'

const FILTERS: Array<{ key: TaskFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'verified', label: 'Verified' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'priority', label: 'High + Urgent' },
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
  const meta = PRIORITY_META[priority] ?? PRIORITY_META.normal
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 border-0 ${meta.badge}`}>
      {meta.label}
    </span>
  )
}

function VerifiedBadge({ name, at }: { name: string; at: Date | string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 shrink-0" title={`Verified by ${name}`}>
      <BadgeCheck className="w-3 h-3" aria-hidden />
      Verified by {name} · {formatDistanceToNow(new Date(at), { addSuffix: true })}
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
): string | null {
  if (taskId && blockedById === taskId) return 'A task cannot depend on itself — pick a different blocker'
  const target = tasks.find((t) => t.id === blockedById)
  if (!target) return 'Dependency not found — refresh and try again'
  if (target.status === 'blocked' || target.blockedById) {
    return `Cannot depend on "${target.title}" — that task is itself blocked. Dependencies must point at unblocked work.`
  }
  let current = target
  for (let depth = 1; depth <= 5 && current.blockedById; depth++) {
    if (taskId && current.id === taskId) return 'Dependency cycle rejected — this link would loop back to the task'
    const next = tasks.find((t) => t.id === current.blockedById)
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
      toast.error('Pick a phase and type a task title')
      return
    }
    if (addBlockedBy !== 'none') {
      const problem = dependencyProblem(null, addBlockedBy, allTasks)
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
      toast.success(online ? 'Task added' : `Task saved on-device — queued (${outbox.length + 1})`)
      setAddTitle('')
      setAddPriority('normal')
      setAddAssignee('none')
      setAddDue('')
      setAddBlockedBy('none')
      setAddOpen(false)
    } else {
      toast.error('Failed to add task — the server refused it (bad phase, assignee or dependency)')
    }
  }

  async function saveEdit() {
    if (!editTask) return
    if (!editTitle.trim()) { toast.error('Task title cannot be empty'); return }
    if (editBlockedBy !== 'none') {
      const problem = dependencyProblem(editTask.id, editBlockedBy, allTasks)
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
      toast.success(online ? 'Task updated' : `Edit saved on-device — queued (${outbox.length + 1})`)
      setEditTask(null)
    } else {
      toast.error('Could not update the task — the server refused it (assignee or dependency)')
    }
  }

  async function confirmBlock() {
    if (!blockTask) return
    if (!blockReason.trim()) {
      toast.error('A block reason is required — record why work stopped')
      return
    }
    if (blockDep !== 'none') {
      const problem = dependencyProblem(blockTask.id, blockDep, allTasks)
      if (problem) { toast.error(problem); return }
    }
    const ok = await dispatch('task.block', {
      id: blockTask.id,
      reason: blockReason.trim(),
      blockedById: blockDep === 'none' ? undefined : blockDep,
    }, `Block "${blockTask.title}"`)
    if (ok) {
      toast.success(online ? `"${blockTask.title}" marked blocked` : `Block saved on-device — queued (${outbox.length + 1})`)
      setBlockTask(null)
    } else {
      toast.error('Could not block the task — the server refused it (reason or dependency)')
    }
  }

  async function unblockTask(t: Task) {
    const ok = await dispatch('task.unblock', { id: t.id }, `Unblock "${t.title}"`)
    if (ok) toast.success(online ? `"${t.title}" unblocked — work can resume` : `Unblock queued (${outbox.length + 1})`)
    else toast.error('Could not unblock the task')
  }

  async function completeTask(t: Task) {
    if (isBlockedTask(t)) { toast.error(`"${t.title}" is blocked${t.blockedReason ? `: ${t.blockedReason}` : ''} — unblock it before completing`); return }
    if (t.blockedById) {
      const blocker = taskById.get(t.blockedById)
      if (blocker && blocker.status !== 'done') {
        toast.error(`Cannot complete "${t.title}" — it depends on "${blocker.title}", which is not done yet`)
        return
      }
    }
    const ok = await dispatch('task.complete', { id: t.id }, `Complete "${t.title}"`)
    if (ok) toast.success(online ? `"${t.title}" completed — ready for verification` : `Completion queued (${outbox.length + 1})`)
    else toast.error('Could not complete the task — the server refused it (blocked or unfinished dependency)')
  }

  async function verifyTask(t: Task) {
    if (t.status !== 'done') { toast.error(`Only completed work can be verified — "${t.title}" is ${t.status.replace('_', ' ')}`); return }
    const ok = await dispatch('task.verify', { id: t.id }, `Verify "${t.title}"`)
    if (ok) toast.success(online ? `"${t.title}" verified` : `Verification queued (${outbox.length + 1})`)
    else toast.error('Could not verify — the server refused it (status or role)')
  }

  async function confirmDeleteTask() {
    if (!deleteTask) return
    const ok = await dispatch('task.delete', { id: deleteTask.id }, `Delete task "${deleteTask.title}"`)
    if (ok) toast.success(`Task "${deleteTask.title}" deleted`)
    else toast.error('Could not delete the task')
    setDeleteTask(null)
  }

  async function addPhase() {
    const budget = Number(phaseBudget)
    if (!phaseName.trim()) { toast.error('Phase name is required'); return }
    if (!phaseBudget || Number.isNaN(budget) || budget < 0) { toast.error('Budget must be 0 or more'); return }
    setPhaseBusy(true)
    const ok = await dispatch('phase.create', { name: phaseName.trim(), budget: Math.round(budget) }, `Add phase "${phaseName.trim()}"`)
    setPhaseBusy(false)
    if (ok) {
      toast.success(online ? `Phase "${phaseName.trim()}" added to the plan` : `Phase saved on-device — queued (${outbox.length})`)
      setPhaseOpen(false); setPhaseName(''); setPhaseBudget('')
    } else {
      toast.error('Failed to add phase')
    }
  }

  return (
    <div className="space-y-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-lg text-stone-900 flex items-center gap-2">
              <ListChecks className="w-5 h-5 text-amber-600" aria-hidden /> Build plan — {data.project.name}
            </CardTitle>
            <CardDescription>
              {data.phases.length} phases · {counts.all} tasks{counts.blocked > 0 ? ` · ${counts.blocked} blocked` : ''}{counts.overdue > 0 ? ` · ${counts.overdue} overdue` : ''} · edits work offline and sync later
            </CardDescription>
          </div>
          {!isClient && (
            <Button size="sm" className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white shrink-0" onClick={() => { setAddPhaseId(data.phases[0]?.id ?? ''); setAddOpen(true) }}>
              <Plus className="w-4 h-4" aria-hidden /> Task
            </Button>
          )}
        </CardHeader>
        <CardContent className="pt-0 pb-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter tasks">
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
                  {f.label} <span className={`tabular-nums ${active ? 'text-amber-400' : 'text-stone-400'}`}>{filterCount(f.key)}</span>
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
                        {phase.status.replace('_', ' ')}
                      </Badge>
                    </div>
                    <p className="text-xs text-stone-500 mt-0.5">
                      {phase.tasks.filter((t) => t.status === 'done').length}/{phase.tasks.length} tasks done · budget {formatKES(phase.budget, true)} · progress {phase.progress}%
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
                          {STATUS_ICON[task.status] ?? STATUS_ICON.pending}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap min-w-0">
                              <p className={`text-sm font-medium ${done ? 'text-stone-400 line-through' : 'text-stone-800'}`}>{task.title}</p>
                              <PriorityBadge priority={priorityOf(task)} />
                              {task.verifiedAt && task.verifiedByName ? (
                                <VerifiedBadge name={task.verifiedByName} at={task.verifiedAt as unknown as string} />
                              ) : done ? (
                                <span className="text-[11px] text-stone-400">awaiting verification</span>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mt-1 text-[11px] text-stone-400">
                              <span>{task.progress}% complete</span>
                              {task.dueDate && (
                                <span className={overdue ? 'text-red-600 font-semibold' : 'text-stone-400'}>
                                  Due {format(new Date(task.dueDate as unknown as string), 'd MMM')}{overdue ? ' · overdue' : ''}
                                </span>
                              )}
                              {worker && (
                                <span className="inline-flex items-center gap-1 text-stone-600 bg-white border border-stone-200 rounded-full px-2 py-0.5" title={`${worker.name} · ${worker.role}`}>
                                  <User className="w-3 h-3" aria-hidden /> {worker.name}
                                </span>
                              )}
                              {blocker && (
                                <span className="inline-flex items-center gap-1 text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5" title={`Depends on: ${blocker.title} (${blocker.status.replace('_', ' ')})`}>
                                  <Link2 className="w-3 h-3" aria-hidden /> blocked by {blocker.title}
                                </span>
                              )}
                            </div>
                            {blocked && (
                              <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs" role="alert">
                                <div className="flex items-start gap-2">
                                  <Ban className="w-3.5 h-3.5 text-red-600 mt-0.5 shrink-0" aria-hidden />
                                  <div className="min-w-0 flex-1">
                                    <p className="font-medium text-red-800">
                                      Blocked{blockEvent ? ` by ${blockEvent.actor}` : ''}{blockEvent ? ` · ${formatDistanceToNow(new Date(blockEvent.createdAt), { addSuffix: true })}` : ''}
                                    </p>
                                    <p className="text-red-700 mt-0.5 leading-snug break-words">
                                      {task.blockedReason ?? 'No reason recorded — add one via Block so the team knows why work stopped.'}
                                    </p>
                                  </div>
                                  {!isClient && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 gap-1.5 border-red-300 text-red-700 hover:bg-red-100 hover:text-red-800 shrink-0"
                                      onClick={() => void unblockTask(task)}
                                      aria-label={`Unblock ${task.title}`}
                                    >
                                      Unblock
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
                            aria-label={`Progress for ${task.title}`}
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
                            <SelectTrigger size="sm" className="w-32 bg-white text-xs h-8" aria-label={`Status for ${task.title}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="pending">Pending</SelectItem>
                              <SelectItem value="in_progress">In progress</SelectItem>
                              <SelectItem value="done">Done</SelectItem>
                              <SelectItem value="blocked">Blocked…</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {!done && !blocked && !isClient && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-9 gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                                onClick={() => void completeTask(task)}
                                aria-label={`Mark ${task.title} complete`}
                              >
                                <CheckCircle2 className="w-4 h-4" aria-hidden /> Complete
                              </Button>
                            )}
                            {done && !task.verifiedAt && canVerify && !isClient && (
                              <Button
                                size="sm"
                                className="h-9 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                                onClick={() => void verifyTask(task)}
                                aria-label={`Verify ${task.title}`}
                              >
                                <BadgeCheck className="w-4 h-4" aria-hidden /> Verify
                              </Button>
                            )}
                            {!done && !blocked && !isClient && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-9 w-9 p-0 text-stone-400 hover:text-red-700 hover:bg-red-50"
                                onClick={() => openBlock(task)}
                                aria-label={`Block ${task.title}`}
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
                                aria-label={`Edit task ${task.title}`}
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
                                aria-label={`Delete task ${task.title}`}
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
                      No tasks yet — add the first one.
                    </p>
                  )}
                  {phase.tasks.length > 0 && visibleTasks.length === 0 && (
                    <p className="text-sm text-stone-400 py-3 text-center border border-dashed border-stone-200 rounded-lg">
                      {phase.tasks.length} task{phase.tasks.length === 1 ? '' : 's'} in this phase — none match the “{FILTERS.find((f) => f.key === filter)?.label}” filter.
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
          aria-label="Add a phase to the build plan"
        >
          <Layers className="w-4 h-4" aria-hidden /> Add phase
        </Button>
      )}

      {/* Add task dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Add task to plan</DialogTitle>
            <DialogDescription>Priority, assignee, deadline and an optional dependency. Works offline — the action syncs when you reconnect.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 max-h-[70vh] overflow-y-auto">
            <div className="space-y-2">
              <Label htmlFor="phase">Phase</Label>
              <Select value={addPhaseId} onValueChange={setAddPhaseId}>
                <SelectTrigger id="phase"><SelectValue placeholder="Choose phase" /></SelectTrigger>
                <SelectContent>
                  {data.phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.order}. {p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="title">Task</Label>
              <Input id="title" value={addTitle} onChange={(e) => setAddTitle(e.target.value)} placeholder="e.g. Cast ring beam — order ready-mix" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Select value={addPriority} onValueChange={setAddPriority}>
                  <SelectTrigger id="priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="assignee">Assignee</Label>
                <Select value={addAssignee} onValueChange={setAddAssignee}>
                  <SelectTrigger id="assignee"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {data.workers.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="due">Due date</Label>
              <Input id="due" type="date" value={addDue} onChange={(e) => setAddDue(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="blockedby">Blocked by (optional dependency)</Label>
              <Select value={addBlockedBy} onValueChange={setAddBlockedBy}>
                <SelectTrigger id="blockedby"><SelectValue placeholder="No dependency" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No dependency</SelectItem>
                  {addPhaseId && dependencyCandidates(addPhaseId).map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.title} ({t.status.replace('_', ' ')})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-stone-400">The task waits on this one. Dependencies must point at unblocked work (max 5 levels).</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={() => void addTask()} className="bg-amber-600 hover:bg-amber-700 text-white">Add task</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit task dialog */}
      <Dialog open={Boolean(editTask)} onOpenChange={(v) => !v && setEditTask(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Edit task</DialogTitle>
            <DialogDescription>Update the details — the audit ledger records every change.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 max-h-[70vh] overflow-y-auto">
            <div className="space-y-2">
              <Label htmlFor="edit-title">Task</Label>
              <Input id="edit-title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-priority">Priority</Label>
                <Select value={editPriority} onValueChange={setEditPriority}>
                  <SelectTrigger id="edit-priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-assignee">Assignee</Label>
                <Select value={editAssignee} onValueChange={setEditAssignee}>
                  <SelectTrigger id="edit-assignee"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {data.workers.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-due">Due date</Label>
              <Input id="edit-due" type="date" value={editDue} onChange={(e) => setEditDue(e.target.value)} />
            </div>
            {editTask && (
              <div className="space-y-2">
                <Label htmlFor="edit-blockedby">Blocked by (dependency)</Label>
                <Select value={editBlockedBy} onValueChange={setEditBlockedBy}>
                  <SelectTrigger id="edit-blockedby"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No dependency</SelectItem>
                    {(data.phases.find((p) => p.id === editTask.phaseId)?.tasks ?? [])
                      .filter((t) => t.status !== 'blocked' && !t.blockedById && t.status !== 'done')
                      .map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.id === editTask.id ? `${t.title} (this task)` : t.title}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-stone-400">A task cannot depend on itself or on blocked work — the domain layer refuses and explains.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTask(null)}>Cancel</Button>
            <Button onClick={() => void saveEdit()} className="bg-amber-600 hover:bg-amber-700 text-white">Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Block task dialog — a reason is required */}
      <Dialog open={Boolean(blockTask)} onOpenChange={(v) => !v && setBlockTask(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Block “{blockTask?.title}”</DialogTitle>
            <DialogDescription>Record why work stopped — the reason, date and your name go to the audit ledger.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="block-reason">Reason (required)</Label>
              <Input
                id="block-reason"
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                placeholder="e.g. Waiting for ring-beam timber delivery from Juja"
                maxLength={500}
              />
            </div>
            {blockTask && dependencyCandidates(blockTask.phaseId, blockTask.id).length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="block-dep">Depends on (optional)</Label>
                <Select value={blockDep} onValueChange={setBlockDep}>
                  <SelectTrigger id="block-dep"><SelectValue placeholder="No dependency" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No dependency</SelectItem>
                    {dependencyCandidates(blockTask.phaseId, blockTask.id).map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.title} ({t.status.replace('_', ' ')})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-stone-400">Link the task this one is waiting on. The banner will show “blocked by” its title.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBlockTask(null)}>Cancel</Button>
            <Button onClick={() => void confirmBlock()} className="gap-1.5 bg-red-600 hover:bg-red-700 text-white">
              <Ban className="w-4 h-4" aria-hidden /> Block task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add phase dialog */}
      <Dialog open={phaseOpen} onOpenChange={setPhaseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Add phase</DialogTitle>
            <DialogDescription>A new phase is appended to the end of the build plan. Works offline.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="phase-name">Phase name</Label>
              <Input id="phase-name" value={phaseName} onChange={(e) => setPhaseName(e.target.value)} placeholder="e.g. External Works & Landscaping" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phase-budget">Phase budget (KSh)</Label>
              <Input id="phase-budget" type="number" min="0" value={phaseBudget} onChange={(e) => setPhaseBudget(e.target.value)} placeholder="e.g. 350000" />
              {phaseBudget && !Number.isNaN(Number(phaseBudget)) && Number(phaseBudget) >= 0 && (
                <p className="text-xs text-stone-500">{formatKES(Number(phaseBudget))} added to the project budget</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPhaseOpen(false)} disabled={phaseBusy}>Cancel</Button>
            <Button onClick={() => void addPhase()} disabled={phaseBusy} className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white">
              <Layers className="w-4 h-4" aria-hidden /> Add phase
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete task confirmation */}
      <AlertDialog open={Boolean(deleteTask)} onOpenChange={(v) => !v && setDeleteTask(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTask?.title}” will be removed from the plan. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmDeleteTask()}
              className="bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500"
            >
              Delete task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
