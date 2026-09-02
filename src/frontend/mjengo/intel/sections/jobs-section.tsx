'use client'

// Background jobs section (spec §58) — the JobRecord queue surface.
//
// Lists this project's recent job runs (type, status, finishedAt, result or
// lastError) with on-demand trigger buttons: each enqueues a job and calls
// POST /api/jobs/run (the cron-callee endpoint) which drains the queue.
//
// HONEST copy: nothing schedules these jobs automatically today — they run
// on demand here; in production a scheduler (cron) would call the run route
// on an interval.

import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Button } from '@/frontend/ui/button'
import {
  Radar, RefreshCw, Newspaper, Scale, CalendarClock, CheckCircle2, XCircle, Loader2, Clock,
} from 'lucide-react'

interface JobRow {
  id: string
  type: string
  status: string // queued | running | done | failed
  projectId: string | null
  result: string | null
  attempts: number
  lastError: string | null
  finishedAt: string | null
  createdAt: string
}

const RUN_BUTTONS: Array<{ type: string; label: string; Icon: typeof Radar }> = [
  { type: 'anomaly_scan', label: 'Run anomaly scan', Icon: Radar },
  { type: 'digest.weekly', label: 'Run weekly digest', Icon: Newspaper },
  { type: 'reconciliation', label: 'Run reconciliation', Icon: Scale },
  { type: 'overdue.check', label: 'Run overdue check', Icon: CalendarClock },
]

const TYPE_LABELS: Record<string, string> = {
  anomaly_scan: 'Anomaly scan',
  'digest.weekly': 'Weekly digest',
  'recap.daily': 'Daily recap',
  reconciliation: 'Reconciliation',
  'overdue.check': 'Overdue check',
  'budget.check': 'Budget check',
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'done') return <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" aria-label="done" />
  if (status === 'failed') return <XCircle className="w-4 h-4 text-red-600 shrink-0" aria-label="failed" />
  if (status === 'running') return <Loader2 className="w-4 h-4 text-amber-600 shrink-0 animate-spin" aria-label="running" />
  return <Clock className="w-4 h-4 text-stone-400 shrink-0" aria-label="queued" />
}

/** One-line summary of a job's JSON result (honest, from the row itself). */
function resultSummary(job: JobRow): string | null {
  if (job.lastError) return job.lastError
  if (!job.result) return null
  try {
    const parsed = JSON.parse(job.result) as Record<string, unknown>
    if (job.type === 'anomaly_scan') {
      const alerts = Array.isArray(parsed.alerts) ? parsed.alerts.length : 0
      return `${alerts} alert(s) created — ${String(parsed.summary ?? '').slice(0, 160)}`
    }
    if (job.type === 'digest.weekly') return String(parsed.summary ?? '').slice(0, 200)
    if (job.type === 'recap.daily') return `Day ${String(parsed.day ?? '?')} recap written (${String(parsed.content ?? '').length} chars)`
    if (job.type === 'reconciliation') {
      return parsed.consistent === true
        ? `Ledger consistent — drift KSh 0`
        : `Drift KSh ${String(parsed.drift ?? '?')} — ${String(parsed.note ?? '').slice(0, 160)}`
    }
    if (job.type === 'overdue.check') {
      const overdue = Array.isArray(parsed.overdueTasks) ? parsed.overdueTasks.length : 0
      const absent = Array.isArray(parsed.absentWorkers) ? parsed.absentWorkers.length : 0
      return `${overdue} overdue task(s), ${absent} absent worker(s)`
    }
    if (job.type === 'budget.check') {
      return `Pace ${String(parsed.pacePct ?? '?')}% of budget — ${String(parsed.level ?? 'ok')}`
    }
    return JSON.stringify(parsed).slice(0, 160)
  } catch {
    return job.result.slice(0, 160)
  }
}

export function JobsSection() {
  const { data, viewMode, load } = useMjengo()
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [busyType, setBusyType] = useState<string | null>(null)
  const isClient = viewMode === 'client'
  const projectId = data?.project?.id

  const refreshList = useCallback(async () => {
    if (!projectId) return
    try {
      const res = await fetch(`/api/jobs/run?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store' })
      const json = await res.json()
      if (json.ok) setJobs(json.jobs as JobRow[])
    } catch {
      // listing is best-effort — the buttons surface their own errors
    } finally {
      setListLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    setListLoading(true)
    void refreshList()
  }, [refreshList])

  if (!data || isClient) return null

  async function runJob(type: string, label: string) {
    setBusyType(type)
    try {
      const res = await fetch('/api/jobs/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, projectId }),
      })
      const json = await res.json()
      if (json.ok) {
        const mine = (json.results ?? []).find((r: { type: string }) => r.type === type)
        if (mine?.status === 'failed') {
          toast.error(`${label} failed — ${mine.lastError ?? 'see the job row'}`)
        } else {
          toast.success(`${label} — done`)
        }
        await Promise.all([refreshList(), load()])
      } else {
        toast.error(json.error ?? 'Job run failed')
      }
    } catch {
      toast.error('Network error — could not reach the job runner')
    } finally {
      setBusyType(null)
    }
  }

  return (
    <section aria-label="Background jobs">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarClock className="w-4 h-4 text-stone-500" aria-hidden /> Background jobs
              </CardTitle>
              <CardDescription>
                Anomaly scans, digests, reconciliation and schedule checks run as queued jobs (JobRecord).
                Jobs run on demand here — a scheduler (cron) would call POST /api/jobs/run in production.
              </CardDescription>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            {RUN_BUTTONS.map(({ type, label, Icon }) => (
              <Button
                key={type}
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={busyType !== null}
                onClick={() => void runJob(type, label)}
              >
                <Icon className={`w-4 h-4 ${busyType === type ? 'animate-pulse' : ''}`} aria-hidden />
                {busyType === type ? 'Running…' : label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {listLoading ? (
            <div className="py-8 flex items-center justify-center gap-2 text-sm text-stone-400" role="status">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Loading job history…
            </div>
          ) : jobs.length === 0 ? (
            <div className="py-8 flex flex-col items-center text-center gap-3" role="status">
              <div className="w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
                <Clock className="w-6 h-6 text-stone-400" />
              </div>
              <p className="text-sm text-stone-500 max-w-sm">
                No jobs have run yet — use a button above. Every run is recorded here with its result or error.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-stone-100" aria-label="Recent job runs">
              {jobs.map((job) => {
                const summary = resultSummary(job)
                return (
                  <li key={job.id} className="py-2.5 flex items-start gap-3">
                    <span className="mt-0.5"><StatusIcon status={job.status} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span className="text-sm font-medium text-stone-900">{typeLabel(job.type)}</span>
                        <span className="text-[10px] font-bold uppercase tracking-wide text-stone-400">
                          {job.status}{job.attempts > 1 ? ` · ${job.attempts} attempts` : ''}
                        </span>
                        {job.finishedAt && (
                          <span className="text-xs text-stone-400">
                            {formatDistanceToNow(new Date(job.finishedAt), { addSuffix: true })}
                          </span>
                        )}
                      </div>
                      {summary && (
                        <p className={`text-xs mt-0.5 leading-relaxed ${job.status === 'failed' ? 'text-red-600' : 'text-stone-500'}`}>
                          {summary}
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          <p className="text-[11px] text-stone-400 mt-3 flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3" aria-hidden />
            Queue lives in SQLite (JobRecord rows). Handler failures are recorded, never silent.
          </p>
        </CardContent>
      </Card>
    </section>
  )
}
