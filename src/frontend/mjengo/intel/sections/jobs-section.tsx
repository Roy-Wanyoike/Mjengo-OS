'use client'

// Background jobs section (spec §58) — the JobRecord queue surface.
//
// Lists this project's recent job runs (type, status, finishedAt, result or
// lastError) with on-demand trigger buttons: each enqueues a job and calls
// POST /api/jobs/run (the cron-callee endpoint) which drains the queue.
//
// HONEST copy: nothing schedules these jobs automatically in a bare `next
// dev` — they run on demand here. Production wiring exists: the compose
// `jobs-tick` sidecar / systemd timer / any cron calls POST /api/jobs/run
// with a JOBS_RUN_TOKEN bearer (see DEPLOYMENT.md §7.3).

import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Button } from '@/frontend/ui/button'
import {
  Radar, RefreshCw, Newspaper, Scale, CalendarClock, CheckCircle2, XCircle, Loader2, Clock,
} from 'lucide-react'
import { useT } from '@/frontend/i18n/provider'

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

// i18n (issue #107): `label` carries a DICT KEY rendered via t().
const RUN_BUTTONS: Array<{ type: string; label: string; Icon: typeof Radar }> = [
  { type: 'anomaly_scan', label: 'intel.jobs.run.anomalyScan', Icon: Radar },
  { type: 'digest.weekly', label: 'intel.jobs.run.weeklyDigest', Icon: Newspaper },
  { type: 'reconciliation', label: 'intel.jobs.run.reconciliation', Icon: Scale },
  { type: 'overdue.check', label: 'intel.jobs.run.overdueCheck', Icon: CalendarClock },
]

const TYPE_KEYS: Record<string, string> = {
  anomaly_scan: 'intel.jobs.type.anomalyScan',
  'digest.weekly': 'intel.jobs.type.weeklyDigest',
  'recap.daily': 'intel.jobs.type.dailyRecap',
  reconciliation: 'intel.jobs.type.reconciliation',
  'overdue.check': 'intel.jobs.type.overdueCheck',
  'budget.check': 'intel.jobs.type.budgetCheck',
}

function typeLabel(t: (key: string) => string, type: string): string {
  return TYPE_KEYS[type] ? t(TYPE_KEYS[type]) : type
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
  const t = useT()
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

  async function runJob(type: string, labelKey: string) {
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
          toast.error(t('intel.jobs.toast.failed', { label: t(labelKey), error: mine.lastError ?? t('intel.jobs.toast.seeRow') }))
        } else {
          toast.success(t('intel.jobs.toast.done', { label: t(labelKey) }))
        }
        await Promise.all([refreshList(), load()])
      } else {
        toast.error(json.error ?? t('intel.jobs.toast.runFailed'))
      }
    } catch {
      toast.error(t('intel.jobs.toast.network'))
    } finally {
      setBusyType(null)
    }
  }

  return (
    <section aria-label={t('intel.jobs.aria')}>
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarClock className="w-4 h-4 text-stone-500" aria-hidden /> {t('intel.jobs.title')}
              </CardTitle>
              <CardDescription>
                {t('intel.jobs.desc')}
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
                {busyType === type ? t('intel.jobs.running') : t(label)}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {listLoading ? (
            <div className="py-8 flex items-center justify-center gap-2 text-sm text-stone-400" role="status">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> {t('intel.jobs.loading')}
            </div>
          ) : jobs.length === 0 ? (
            <div className="py-8 flex flex-col items-center text-center gap-3" role="status">
              <div className="w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
                <Clock className="w-6 h-6 text-stone-400" />
              </div>
              <p className="text-sm text-stone-500 max-w-sm">
                {t('intel.jobs.empty')}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-stone-100" aria-label={t('intel.jobs.listAria')}>
              {jobs.map((job) => {
                const summary = resultSummary(job)
                return (
                  <li key={job.id} className="py-2.5 flex items-start gap-3">
                    <span className="mt-0.5"><StatusIcon status={job.status} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span className="text-sm font-medium text-stone-900">{typeLabel(t, job.type)}</span>
                        <span className="text-[10px] font-bold uppercase tracking-wide text-stone-400">
                          {job.status}{job.attempts > 1 ? ` · ${t('intel.jobs.attempts', { count: job.attempts })}` : ''}
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
            {t('intel.jobs.queueNote')}
          </p>
        </CardContent>
      </Card>
    </section>
  )
}
