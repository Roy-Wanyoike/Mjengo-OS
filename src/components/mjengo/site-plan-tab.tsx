'use client'

import { useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Plus, ListChecks, CheckCircle2, Circle, CircleDot, Ban, Trash2, Layers } from 'lucide-react'
import { toast } from 'sonner'
import { formatKES } from '@/lib/format'

const STATUS_ICON: Record<string, React.ReactNode> = {
  done: <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-label="done" />,
  in_progress: <CircleDot className="w-4 h-4 text-amber-600" aria-label="in progress" />,
  blocked: <Ban className="w-4 h-4 text-red-600" aria-label="blocked" />,
  pending: <Circle className="w-4 h-4 text-stone-300" aria-label="pending" />,
}

export function SitePlanTab() {
  const { data, dispatch, online, outbox, viewMode } = useMjengo()
  const [addOpen, setAddOpen] = useState(false)
  const [addPhaseId, setAddPhaseId] = useState<string>('')
  const [addTitle, setAddTitle] = useState('')
  const [phaseOpen, setPhaseOpen] = useState(false)
  const [phaseBusy, setPhaseBusy] = useState(false)
  const [phaseName, setPhaseName] = useState('')
  const [phaseBudget, setPhaseBudget] = useState('')
  const [deleteTask, setDeleteTask] = useState<{ id: string; title: string } | null>(null)

  if (!data) return null
  const isClient = viewMode === 'client'

  async function addTask() {
    if (!addTitle.trim() || !addPhaseId) {
      toast.error('Pick a phase and type a task title')
      return
    }
    const ok = await dispatch('task.create', { phaseId: addPhaseId, title: addTitle.trim() }, `Add task "${addTitle.trim()}"`)
    if (ok) {
      toast.success(online ? 'Task added' : `Task saved on-device — queued (${outbox.length + 1})`)
      setAddTitle('')
      setAddOpen(false)
    } else {
      toast.error('Failed to add task')
    }
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
              {data.phases.length} phases · {data.phases.reduce((s, p) => s + p.tasks.length, 0)} tasks · edits work offline and sync later
            </CardDescription>
          </div>
          {!isClient && (
            <Button size="sm" className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white shrink-0" onClick={() => { setAddPhaseId(data.phases[0]?.id ?? ''); setAddOpen(true) }}>
              <Plus className="w-4 h-4" aria-hidden /> Task
            </Button>
          )}
        </CardHeader>
      </Card>

      <Accordion type="multiple" defaultValue={[data.phases.find((p) => p.status === 'in_progress')?.id ?? data.phases[0]?.id]} className="space-y-4">
        {data.phases.map((phase) => (
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
                {phase.tasks.map((task) => (
                  <div key={task.id} className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                      {STATUS_ICON[task.status]}
                      <div className="min-w-0">
                        <p className={`text-sm font-medium truncate ${task.status === 'done' ? 'text-stone-400 line-through' : 'text-stone-800'}`}>{task.title}</p>
                        <p className="text-[11px] text-stone-400">{task.progress}% complete</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 sm:w-80">
                      <Slider
                        value={[task.progress]}
                        max={100}
                        step={5}
                        onValueCommit={([v]) => void dispatch('task.update', { id: task.id, progress: v }, `Update "${task.title}" to ${v}%`)}
                        disabled={task.status === 'done' || isClient}
                        aria-label={`Progress for ${task.title}`}
                        className="flex-1 data-[disabled]:opacity-40"
                      />
                      <Select
                        value={task.status}
                        onValueChange={(v) => void dispatch('task.update', { id: task.id, status: v }, `Set "${task.title}" ${v}`)}
                        disabled={isClient}
                      >
                        <SelectTrigger size="sm" className="w-32 bg-white text-xs h-8" aria-label={`Status for ${task.title}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pending">Pending</SelectItem>
                          <SelectItem value="in_progress">In progress</SelectItem>
                          <SelectItem value="done">Done</SelectItem>
                          <SelectItem value="blocked">Blocked</SelectItem>
                        </SelectContent>
                      </Select>
                      {!isClient && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-11 w-11 -mr-1 shrink-0 text-stone-400 hover:text-red-600 hover:bg-red-50 sm:h-9 sm:w-9 sm:mr-0"
                          onClick={() => setDeleteTask({ id: task.id, title: task.title })}
                          aria-label={`Delete task ${task.title}`}
                        >
                          <Trash2 className="w-4 h-4" aria-hidden />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {phase.tasks.length === 0 && (
                  <p className="text-sm text-stone-400 py-3 text-center border border-dashed border-stone-200 rounded-lg">
                    No tasks yet — add the first one.
                  </p>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
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
            <DialogDescription>Works offline — the action syncs when you reconnect.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={() => void addTask()} className="bg-amber-600 hover:bg-amber-700 text-white">Add task</Button>
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
