'use client'

import { useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import type { ProjectSummary, WorkerWithAttendance } from '@/lib/mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  AddWorkerDialog, EditWorkerDialog,
  type AddWorkerPayload, type EditWorkerPayload, type EditWorkerData,
} from '@/components/mjengo/worker-dialogs'
import { downloadCSV, attendanceCSV, projectFilePrefix } from '@/components/mjengo/export-utils'
import {
  Users, LogIn, LogOut, Phone, Smartphone, MapPin, Wallet, UserPlus, BadgeCheck, Pencil, Download,
  ShieldCheck, CircleAlert, AlertTriangle, ClipboardList, ClipboardCheck, Loader2, ShieldAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatKES, timeEAT, dateShort } from '@/lib/format'

// ---------------- shared bits ----------------

const SCROLLBAR = '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full'

const STATUS_LABELS: Record<string, string> = {
  present: 'Present', half_day: 'Half day', absent: 'Absent', excused: 'Excused',
}

const EXCEPTION_REASONS: Array<{ value: string; label: string }> = [
  { value: 'phone_damaged', label: 'Phone damaged' },
  { value: 'battery_dead', label: 'Battery dead' },
  { value: 'network', label: 'Network issue' },
  { value: 'forgot', label: 'Worker forgot' },
  { value: 'new_worker', label: 'New worker' },
  { value: 'emergency', label: 'Emergency' },
  { value: 'other', label: 'Other' },
]

function reasonLabel(v?: string | null): string {
  return EXCEPTION_REASONS.find((r) => r.value === v)?.label ?? (v || 'Exception')
}

/** EAT "today" — mirrors the server's todayStr() so lookups match todayStatus. */
function todayEAT(): string {
  const d = new Date()
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10)
}

function initials(name: string) {
  return name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()
}

function last7Days(): string[] {
  const out: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    out.push(d.toISOString().slice(0, 10))
  }
  return out.reverse()
}

/** Evidence-level badge: 🟢 verified · 🟡 reported · 🟠 exception · ⚪ none */
function VerificationBadge({ verification, exceptionReason, compact = false }: { verification: string | null; exceptionReason?: string | null; compact?: boolean }) {
  const t = compact ? 'text-[9px]' : 'text-[10px]'
  if (verification === 'verified') {
    return <Badge className={`bg-emerald-100 text-emerald-800 border-0 gap-1 ${t} hover:bg-emerald-100`} title="Worker self check-in — app, USSD or kiosk PIN evidence"><ShieldCheck className="w-3 h-3" aria-hidden />Verified</Badge>
  }
  if (verification === 'reported') {
    return <Badge className={`bg-amber-100 text-amber-800 border-0 gap-1 ${t} hover:bg-amber-100`} title="Manager-recorded — reported, not verified"><CircleAlert className="w-3 h-3" aria-hidden />Reported</Badge>
  }
  if (verification === 'exception') {
    return <Badge className={`bg-orange-100 text-orange-800 border-0 gap-1 ${t} hover:bg-orange-100`} title={`Exception: ${reasonLabel(exceptionReason)}`}><AlertTriangle className="w-3 h-3" aria-hidden />Exception</Badge>
  }
  return <Badge className={`bg-stone-100 text-stone-500 border-0 gap-1 ${t} hover:bg-stone-100`} title="No verification evidence">—</Badge>
}

/** Progress ring for the 0-100 attendance reliability score. */
function ReliabilityRing({ score }: { score: number | null }) {
  const C = 2 * Math.PI * 26
  const color = score === null ? 'stroke-stone-300'
    : score >= 80 ? 'stroke-emerald-500' : score >= 50 ? 'stroke-amber-500' : 'stroke-orange-500'
  return (
    <div
      className="relative w-16 h-16 shrink-0"
      role="img"
      aria-label={score === null ? 'No attendance history yet' : `Attendance reliability ${score} of 100`}
    >
      <svg viewBox="0 0 64 64" className="w-16 h-16 -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r="26" fill="none" strokeWidth="7" className="stroke-stone-200" />
        <circle
          cx="32" cy="32" r="26" fill="none" strokeWidth="7" strokeLinecap="round"
          className={color}
          strokeDasharray={score === null ? `0 ${C}` : `${(score / 100) * C} ${C}`}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-stone-900 tabular-nums">
        {score === null ? '—' : score}
      </span>
    </div>
  )
}

/**
 * Labour Summary — reported vs verified presence for the remote owner.
 * Exported separately so the share view / overview can embed it.
 */
export function LabourSummaryCard({ summary, workers }: { summary: ProjectSummary; workers: WorkerWithAttendance[] }) {
  const v = summary.fundisVerified
  const r = summary.fundisReported
  const e = summary.fundisException
  const recorded = v + r + e
  const rate = recorded > 0 ? Math.round((v / recorded) * 100) : null
  const weekWages = workers.reduce((s, w) => s + w.weekEarnings, 0)

  // Attendance reliability: share of 'verified' among all non-absent records
  // in the last 30 days (uses the per-worker attendance history in the payload).
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  let nonAbsent = 0
  let verified = 0
  for (const w of workers) {
    for (const a of w.attendances) {
      if (a.status === 'absent' || a.status === 'excused') continue
      nonAbsent++
      if (a.verification === 'verified') verified++
    }
  }
  const reliability = nonAbsent > 0 ? Math.round((verified / nonAbsent) * 100) : null

  return (
    <Card className="border-stone-200 shadow-sm" aria-label="Labour summary">
      <CardHeader className="pb-3">
        <CardTitle className="text-base text-stone-900 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-700" aria-hidden /> Labour summary — workforce trust
        </CardTitle>
        <CardDescription>Reported vs verified presence. Payroll only releases freely on verified records.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <div className="flex flex-wrap items-center gap-2" aria-label="Today's evidence levels">
            <Badge className="bg-emerald-100 text-emerald-800 border-0 gap-1 hover:bg-emerald-100"><ShieldCheck className="w-3 h-3" aria-hidden />{v} Verified</Badge>
            <Badge className="bg-amber-100 text-amber-800 border-0 gap-1 hover:bg-amber-100"><CircleAlert className="w-3 h-3" aria-hidden />{r} Reported</Badge>
            <Badge className="bg-orange-100 text-orange-800 border-0 gap-1 hover:bg-orange-100"><AlertTriangle className="w-3 h-3" aria-hidden />{e} Exception</Badge>
          </div>

          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <div>
              <p className="text-[11px] text-stone-500">Verification rate (today)</p>
              <p className="text-lg font-bold text-stone-900 tabular-nums">{rate === null ? '—' : `${rate}%`}</p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">Verified wages</p>
              <p className="text-lg font-bold text-emerald-700 tabular-nums">{formatKES(summary.wagesVerified)}</p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">Pending review</p>
              <p className="text-lg font-bold text-amber-600 tabular-nums">{formatKES(summary.wagesPendingReview)}</p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">This week (wages)</p>
              <p className="text-lg font-bold text-stone-900 tabular-nums">{formatKES(weekWages)}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 ml-auto">
            <ReliabilityRing score={reliability} />
            <div>
              <p className="text-[11px] text-stone-500">Verification rate (30d)</p>
              <p className="text-sm font-semibold text-stone-800 tabular-nums">
                {reliability === null ? '—' : `${reliability}/100`}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------- payroll gate result ----------------

interface PayrollResult {
  blocked: boolean
  paid?: number
  amount: number
  forced?: boolean
  date?: string
  /** Ledger transaction ref for the posted wage payout (F-MONEY). */
  ledgerRef?: string
  requiringReview?: Array<{ workerId: string; name?: string; reason?: string | null }>
  reviewAmount?: number
}

// ---------------- main tab ----------------

export function FundisTab() {
  const { data, dispatch, online, outbox, viewMode, load } = useMjengo()
  const [addOpen, setAddOpen] = useState(false)
  const [addBusy, setAddBusy] = useState(false)
  const [editWorker, setEditWorker] = useState<EditWorkerData | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editBusy, setEditBusy] = useState(false)

  // Daily muster
  const [musterOpen, setMusterOpen] = useState(false)
  const [musterRows, setMusterRows] = useState<Record<string, string>>({})
  const [musterBusy, setMusterBusy] = useState(false)
  const [wasMusterOpen, setWasMusterOpen] = useState(false)

  // Exception dialog
  const [exceptionFor, setExceptionFor] = useState<WorkerWithAttendance | null>(null)
  const [exReason, setExReason] = useState('')
  const [exNote, setExNote] = useState('')
  const [exBusy, setExBusy] = useState(false)

  // Override-with-reason dialog
  const [overrideFor, setOverrideFor] = useState<{ worker: WorkerWithAttendance; to: string } | null>(null)
  const [overrideReason, setOverrideReason] = useState('')
  const [overrideBusy, setOverrideBusy] = useState(false)

  // Payroll gate
  const [gate, setGate] = useState<PayrollResult | null>(null)
  const [payrollBusy, setPayrollBusy] = useState(false)
  const [confirmForce, setConfirmForce] = useState(false)

  if (!data) return null
  const days = last7Days()
  const today = todayEAT()
  const isClient = viewMode === 'client'

  // Prefill muster rows whenever the dialog opens (adjust-state-during-render pattern)
  if (musterOpen !== wasMusterOpen) {
    setWasMusterOpen(musterOpen)
    if (musterOpen) {
      const rows: Record<string, string> = {}
      for (const w of data.workers) if (w.active) rows[w.id] = w.todayStatus.status ?? 'present'
      setMusterRows(rows)
    }
  }

  async function checkIn(workerId: string, workerName: string) {
    const ok = await dispatch('attendance.checkin', { workerId, toggle: 'in', method: 'app' }, `Check in ${workerName}`)
    if (ok) toast.success(online ? `${workerName} checked in — evidence level recorded on the attendance row` : `Checked in on-device — queued (${outbox.length})`)
    else toast.error('Check-in failed')
  }

  async function checkOut(workerId: string, workerName: string) {
    const ok = await dispatch('attendance.checkin', { workerId, toggle: 'out' }, `Check out ${workerName}`)
    if (ok) toast.success(`${workerName} checked out`)
    else toast.error('Check-out failed')
  }

  /** Status edits go through the override flow (reason required, history preserved). */
  function requestStatusChange(worker: WorkerWithAttendance, to: string) {
    if (worker.todayStatus.status === to) return
    setOverrideReason('')
    setOverrideFor({ worker, to })
  }

  async function confirmOverride() {
    if (!overrideFor) return
    const { worker, to } = overrideFor
    const reason = overrideReason.trim()
    if (!reason) return
    const attId = worker.attendances.find((a) => a.date === today)?.id
    setOverrideBusy(true)
    try {
      const ok = attId
        ? await dispatch('attendance.override', { id: attId, to, reason, by: 'Site Manager' }, `${worker.name} → ${STATUS_LABELS[to]}`)
        : await dispatch('attendance.record', { records: JSON.stringify([{ workerId: worker.id, status: to }]), verification: 'reported', recordedBy: 'Site Manager' }, `Record ${worker.name} ${STATUS_LABELS[to]}`)
      if (ok) {
        toast.success(`${worker.name}: ${STATUS_LABELS[to]} — override logged`)
        setOverrideFor(null)
        setOverrideReason('')
      } else {
        toast.error('Override failed')
      }
    } finally {
      setOverrideBusy(false)
    }
  }

  async function saveMuster() {
    const records = Object.entries(musterRows).map(([workerId, status]) => ({ workerId, status }))
    if (!records.length) return
    setMusterBusy(true)
    try {
      const ok = await dispatch(
        'attendance.record',
        { records: JSON.stringify(records), verification: 'reported', recordedBy: 'Site Manager' },
        'Save daily muster',
      )
      if (ok) {
        toast.success(`Muster saved — ${records.length} crew records (manager-reported)`)
        setMusterOpen(false)
      } else {
        toast.error('Muster save failed')
      }
    } finally {
      setMusterBusy(false)
    }
  }

  async function saveException() {
    if (!exceptionFor || !exReason) return
    setExBusy(true)
    try {
      const ok = await dispatch(
        'attendance.exception',
        { workerId: exceptionFor.id, reason: exReason, note: exNote.trim() || undefined },
        `Log exception for ${exceptionFor.name}`,
      )
      if (ok) {
        toast.success(`Exception logged — ${exceptionFor.name} (${reasonLabel(exReason)})`)
        setExceptionFor(null)
        setExReason('')
        setExNote('')
      } else {
        toast.error('Could not log exception')
      }
    } finally {
      setExBusy(false)
    }
  }

  /**
   * THE GATE: wages.pay (F-MONEY) — direct POST because the UI needs the blocked
   * payload (list of records requiring review) to render the warning dialog.
   * The payout posts a balanced ledger entry (costCode 'wages') through the
   * payment-provider seam — simulated rails, honestly labelled.
   */
  async function runPayroll(force = false) {
    if (!data) return
    if (!online) {
      toast.error('Payroll needs a connection — money actions are online-only')
      return
    }
    setPayrollBusy(true)
    setGate(null)
    try {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'wages.pay', payload: { force }, projectId: data.project.id }),
      })
      const json = await res.json()
      if (!json.ok) {
        toast.error(json.error ?? 'Payroll failed')
        return
      }
      const result = json.result as PayrollResult
      if (result.blocked) {
        setGate(result)
      } else if ((result.paid ?? 0) > 0) {
        toast.success(
          result.forced
            ? `Payroll forced through — ${result.paid} fundis paid ${formatKES(result.amount)} (exceptions stay on record; ledger ${result.ledgerRef ?? '—'})`
            : `Paid ${result.paid} fundis — ${formatKES(result.amount)} recorded on the ledger${result.ledgerRef ? ` (${result.ledgerRef})` : ''} (simulated rails)`,
        )
      } else {
        toast.info('Nothing to pay — no unpaid wages for today')
      }
      await load()
    } catch {
      toast.error('Payroll failed — network error')
    } finally {
      setPayrollBusy(false)
    }
  }

  async function addFundi(payload: AddWorkerPayload): Promise<boolean> {
    setAddBusy(true)
    try {
      return await dispatch('worker.create', payload, `Add fundi ${payload.name}`)
    } finally {
      setAddBusy(false)
    }
  }

  async function saveFundi(payload: EditWorkerPayload): Promise<boolean> {
    if (!editWorker) return false
    setEditBusy(true)
    try {
      return await dispatch('worker.update', { id: editWorker.id, ...payload }, `Edit fundi ${payload.name}`)
    } finally {
      setEditBusy(false)
    }
  }

  function exportAttendance() {
    if (!data) return
    const filename = `${projectFilePrefix(data)}-attendance.csv`
    downloadCSV(filename, attendanceCSV(data))
    toast.success(`${filename} downloaded`)
  }

  function openEdit(worker: WorkerWithAttendance) {
    setEditWorker({
      id: worker.id, name: worker.name, role: worker.role, phone: worker.phone,
      dailyRate: worker.dailyRate, active: worker.active, hasPin: Boolean(worker.pin),
    })
    setEditOpen(true)
  }

  const activeWorkers = data.workers.filter((w) => w.active)
  const musterStatuses = ['present', 'half_day', 'absent', 'excused'] as const
  const activeSeg: Record<string, string> = {
    present: 'bg-emerald-600 text-white',
    half_day: 'bg-amber-500 text-white',
    absent: 'bg-red-600 text-white',
    excused: 'bg-stone-700 text-white',
  }

  return (
    <div className="space-y-6">
      {/* Labour summary — reported vs verified (owner + client view) */}
      <LabourSummaryCard summary={data.summary} workers={data.workers} />

      {/* Today bar */}
      <Card className="border-stone-200 shadow-sm bg-gradient-to-r from-stone-900 to-stone-800 text-stone-100">
        <CardContent className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 py-5">
          <div className="flex items-center gap-6 flex-wrap">
            <div>
              <p className="text-xs text-stone-400 flex items-center gap-1"><Users className="w-3.5 h-3.5" aria-hidden /> On site today</p>
              <p className="text-3xl font-bold tabular-nums">{data.summary.fundisToday}<span className="text-lg text-stone-400 font-medium">/{data.summary.fundisExpected}</span></p>
            </div>
            <div className="h-10 w-px bg-stone-700 hidden sm:block" aria-hidden />
            <div>
              <p className="text-xs text-stone-400 flex items-center gap-1"><Wallet className="w-3.5 h-3.5" aria-hidden /> Wages today</p>
              <p className="text-xl font-bold tabular-nums text-amber-400">{formatKES(data.summary.wagesToday)}</p>
            </div>
            <div className="h-10 w-px bg-stone-700 hidden sm:block" aria-hidden />
            <div>
              <p className="text-xs text-stone-400">Unpaid to date</p>
              <p className="text-xl font-bold tabular-nums">{formatKES(data.summary.wagesUnpaid)}</p>
            </div>
          </div>
          {!isClient && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="gap-1.5 border-stone-600 bg-stone-900 text-stone-200 hover:bg-stone-800 hover:text-white" onClick={() => setMusterOpen(true)}>
                <ClipboardList className="w-4 h-4" aria-hidden /> Daily muster
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 border-stone-600 bg-stone-900 text-stone-200 hover:bg-stone-800 hover:text-white" onClick={() => setAddOpen(true)}>
                <UserPlus className="w-4 h-4" aria-hidden /> Add fundi
              </Button>
              <Button
                size="sm"
                className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={() => void runPayroll(false)}
                disabled={data.summary.wagesToday <= 0 || payrollBusy}
              >
                {payrollBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <BadgeCheck className="w-4 h-4" aria-hidden />}
                Run payroll
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Worker cards */}
      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" aria-label="Crew">
        {data.workers.map((w) => {
          const t = w.todayStatus
          const isUssd = t.method === 'ussd'
          const present = t.status === 'present' || t.status === 'half_day'
          const isException = t.verification === 'exception'
          return (
            <Card key={w.id} className={`border shadow-sm ${present ? 'border-emerald-200' : 'border-stone-200'} ${isException ? 'ring-1 ring-orange-300' : ''}`}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <Avatar className="w-11 h-11 border border-stone-200">
                    <AvatarFallback className={present ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-500'}>
                      {initials(w.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-stone-900 text-sm">{w.name}</p>
                      {present && <Badge className="bg-emerald-100 text-emerald-800 border-0 text-[10px] hover:bg-emerald-100">on site</Badge>}
                      {t.status === 'absent' && <Badge className="bg-red-100 text-red-700 border-0 text-[10px] hover:bg-red-100">absent</Badge>}
                      {t.status === 'excused' && <Badge className="bg-stone-200 text-stone-700 border-0 text-[10px] hover:bg-stone-200">excused</Badge>}
                      {!w.active && <Badge className="bg-stone-100 text-stone-500 border-0 text-[10px] hover:bg-stone-100">inactive</Badge>}
                    </div>
                    <p className="text-xs text-stone-500">{w.role} · {formatKES(w.dailyRate)}/day</p>
                    <p className="text-[11px] text-stone-400 flex items-center gap-1 mt-0.5">
                      <Phone className="w-3 h-3" aria-hidden /> {w.phone || 'no phone'}
                      {w.pin && <span className="ml-1 inline-flex items-center gap-0.5 text-stone-400" title="Has kiosk PIN"><ShieldCheck className="w-3 h-3" aria-hidden />PIN</span>}
                    </p>
                  </div>
                  {!isClient && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-11 w-11 -mr-1.5 shrink-0 text-stone-400 hover:text-stone-800 hover:bg-stone-100 sm:h-9 sm:w-9 sm:mr-0"
                      onClick={() => openEdit(w)}
                      aria-label={`Edit ${w.name}`}
                    >
                      <Pencil className="w-4 h-4" aria-hidden />
                    </Button>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2">
                  <VerificationBadge verification={t.verification} exceptionReason={t.exceptionReason} />
                  <span className="font-semibold text-stone-700 tabular-nums text-xs">{formatKES(t.wage)}{t.paid ? ' · paid' : ''}</span>
                </div>

                <div className="rounded-lg bg-stone-50 border border-stone-100 px-3 py-2 text-xs flex items-center justify-between gap-2">
                  {present ? (
                    <span className="text-stone-600 flex items-center gap-1.5 flex-wrap">
                      <MapPin className="w-3.5 h-3.5 text-emerald-600" aria-hidden />
                      In {timeEAT(t.checkIn)}
                      {t.checkOut ? ` · Out ${timeEAT(t.checkOut)}` : ''}
                      {isUssd && <Badge className="bg-violet-100 text-violet-800 border-0 text-[9px] hover:bg-violet-100"><Smartphone className="w-2.5 h-2.5" aria-hidden /> USSD</Badge>}
                    </span>
                  ) : t.status === 'absent' ? (
                    <span className="text-red-600">Marked absent</span>
                  ) : t.status === 'excused' ? (
                    <span className="text-stone-500">Excused (no wage)</span>
                  ) : (
                    <span className="text-stone-400">Not checked in</span>
                  )}
                  {isException && <span className="text-[10px] text-orange-700 truncate" title={t.exceptionReason ? reasonLabel(t.exceptionReason) : undefined}>{t.exceptionReason ? reasonLabel(t.exceptionReason) : 'needs review'}</span>}
                </div>

                {!isClient && (
                  <div className="flex items-center gap-2">
                    {!t.status || t.status === 'absent' || t.status === 'excused' ? (
                      <Button size="sm" className="h-9 gap-1.5 flex-1 bg-amber-600 hover:bg-amber-700 text-white" onClick={() => void checkIn(w.id, w.name)}>
                        <LogIn className="w-3.5 h-3.5" aria-hidden /> Check in
                      </Button>
                    ) : !t.checkOut ? (
                      <Button size="sm" variant="outline" className="h-9 gap-1.5 flex-1" onClick={() => void checkOut(w.id, w.name)}>
                        <LogOut className="w-3.5 h-3.5" aria-hidden /> Check out
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" className="h-9 gap-1.5 flex-1" disabled>
                        <BadgeCheck className="w-3.5 h-3.5" aria-hidden /> Day closed
                      </Button>
                    )}
                    <Select value={t.status ?? undefined} onValueChange={(v) => requestStatusChange(w, v)}>
                      <SelectTrigger size="sm" className="w-28 h-9 bg-white text-xs" aria-label={`Attendance status for ${w.name}`}>
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="present">Present</SelectItem>
                        <SelectItem value="half_day">Half day</SelectItem>
                        <SelectItem value="absent">Absent</SelectItem>
                        <SelectItem value="excused">Excused</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon"
                      variant="outline"
                      className={`h-9 w-9 shrink-0 ${isException ? 'border-orange-300 text-orange-700 hover:bg-orange-50' : 'text-stone-500 hover:bg-stone-100'}`}
                      onClick={() => { setExReason(''); setExNote(''); setExceptionFor(w) }}
                      aria-label={`Log attendance exception for ${w.name}`}
                      title="Log attendance exception (present, but no check-in evidence)"
                    >
                      <AlertTriangle className="w-4 h-4" aria-hidden />
                    </Button>
                  </div>
                )}
                <p className="text-[11px] text-stone-400 text-right">This week: {formatKES(w.weekEarnings)}</p>
              </CardContent>
            </Card>
          )
        })}
      </section>

      {/* Attendance heat table */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-lg text-stone-900">Attendance — last 7 days</CardTitle>
            <CardDescription>App check-ins + USSD (*384*88#) for feature phones</CardDescription>
          </div>
          <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={exportAttendance} aria-label="Export attendance and wages as CSV">
            <Download className="w-4 h-4" aria-hidden /> <span className="hidden sm:inline">Export CSV</span>
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Fundi</TableHead>
                {days.map((d) => (
                  <TableHead key={d} className="text-center text-[10px]">{dateShort(d)}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.workers.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="font-medium text-stone-800 whitespace-nowrap text-sm">{w.name}</TableCell>
                  {days.map((d) => {
                    const a = w.attendances.find((x) => x.date === d)
                    let cls = 'bg-stone-100 text-stone-300'
                    let label = '—'
                    if (a?.status === 'present') { cls = 'bg-emerald-100 text-emerald-700'; label = 'P' }
                    else if (a?.status === 'half_day') { cls = 'bg-amber-100 text-amber-700'; label = 'H' }
                    else if (a?.status === 'absent') { cls = 'bg-red-100 text-red-600'; label = 'A' }
                    else if (a?.status === 'excused') { cls = 'bg-stone-200 text-stone-600'; label = 'E' }
                    if (a && a.verification === 'exception') cls += ' ring-1 ring-orange-400'
                    return (
                      <TableCell key={d} className="text-center p-1">
                        <span
                          className={`inline-flex w-7 h-7 items-center justify-center rounded-md text-[11px] font-bold ${cls}`}
                          title={`${w.name} — ${dateShort(d)}: ${a?.status ?? 'no record'}${a?.verification ? ` (${a.verification})` : ''}`}
                        >
                          {label}
                        </span>
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap gap-4 mt-3 text-[11px] text-stone-500">
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-100 inline-block" aria-hidden /> Present</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-100 inline-block" aria-hidden /> Half day</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-100 inline-block" aria-hidden /> Absent</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-stone-200 inline-block" aria-hidden /> Excused</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-stone-100 inline-block" aria-hidden /> No record</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded ring-1 ring-orange-400 inline-block" aria-hidden /> Exception flagged</span>
          </div>
        </CardContent>
      </Card>

      {/* Add / Edit fundi dialogs (owner only — buttons hidden in client preview) */}
      <AddWorkerDialog open={addOpen} onOpenChange={setAddOpen} onSubmit={addFundi} submitting={addBusy} />
      <EditWorkerDialog open={editOpen} onOpenChange={setEditOpen} onSubmit={saveFundi} submitting={editBusy} worker={editWorker} />

      {/* Daily muster — bulk manager record for today */}
      <Dialog open={musterOpen} onOpenChange={setMusterOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-stone-900 flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-amber-600" aria-hidden /> Daily muster — {dateShort(today)}
            </DialogTitle>
            <DialogDescription>
              Record today&rsquo;s crew in one pass. Manager-recorded = <strong>Reported</strong>, not Verified — verified
              comes from the worker&rsquo;s own check-in (app, USSD or kiosk PIN).
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                const rows: Record<string, string> = {}
                for (const w of activeWorkers) rows[w.id] = 'present'
                setMusterRows(rows)
              }}
            >
              <ClipboardCheck className="w-4 h-4" aria-hidden /> All present (manager-reported)
            </Button>
            <p className="text-[11px] text-stone-500">Changes to existing records are kept in the append-only override log.</p>
          </div>

          <div className={`max-h-96 overflow-y-auto space-y-2 pr-1 ${SCROLLBAR}`} role="list" aria-label="Muster roll">
            {activeWorkers.map((w) => (
              <div key={w.id} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl border border-stone-200 bg-stone-50/60 px-3 py-2" role="listitem">
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <Avatar className="w-8 h-8 border border-stone-200">
                    <AvatarFallback className="bg-stone-100 text-stone-600 text-[10px]">{initials(w.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-800 truncate">{w.name}</p>
                    <div className="mt-0.5"><VerificationBadge compact verification={w.todayStatus.verification} exceptionReason={w.todayStatus.exceptionReason} /></div>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-1 rounded-lg bg-stone-100 p-1 w-full sm:w-64" role="radiogroup" aria-label={`Attendance status for ${w.name}`}>
                  {musterStatuses.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={musterRows[w.id] === s}
                      onClick={() => setMusterRows((rows) => ({ ...rows, [w.id]: s }))}
                      className={`h-9 min-h-9 rounded-md text-[11px] font-medium transition-colors ${
                        musterRows[w.id] === s ? activeSeg[s] : 'text-stone-500 hover:bg-stone-200/70'
                      }`}
                    >
                      {s === 'half_day' ? 'Half' : STATUS_LABELS[s]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMusterOpen(false)} disabled={musterBusy}>Cancel</Button>
            <Button onClick={() => void saveMuster()} disabled={musterBusy} className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white min-w-28">
              {musterBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              {musterBusy ? 'Saving…' : `Save muster (${activeWorkers.length})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Exception dialog — present but no check-in evidence */}
      <Dialog open={!!exceptionFor} onOpenChange={(o) => !o && setExceptionFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-stone-900 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-600" aria-hidden /> Attendance exception
            </DialogTitle>
            <DialogDescription>
              {exceptionFor ? `${exceptionFor.name} is on site but could not check in (present, flagged for review — payroll holds until resolved).` : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-1">
            <div className="space-y-2">
              <Label>Reason *</Label>
              <Select value={exReason || undefined} onValueChange={setExReason}>
                <SelectTrigger aria-label="Exception reason">
                  <SelectValue placeholder="Select a reason…" />
                </SelectTrigger>
                <SelectContent>
                  {EXCEPTION_REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ex-note">Note</Label>
              <Textarea
                id="ex-note"
                value={exNote}
                onChange={(e) => setExNote(e.target.value)}
                placeholder="e.g. Foreman confirmed on site at 07:40, phone battery dead"
                className="min-h-20 bg-white"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setExceptionFor(null)} disabled={exBusy}>Cancel</Button>
            <Button onClick={() => void saveException()} disabled={exBusy || !exReason} className="gap-1.5 bg-orange-600 hover:bg-orange-700 text-white min-w-28">
              {exBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              {exBusy ? 'Saving…' : 'Log exception'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Override dialog — status change with reason (append-only log) */}
      <Dialog open={!!overrideFor} onOpenChange={(o) => !o && setOverrideFor(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-stone-900">Change attendance</DialogTitle>
            <DialogDescription>
              {overrideFor && (
                <>
                  <strong>{overrideFor.worker.name}</strong>: {' '}
                  {STATUS_LABELS[overrideFor.worker.todayStatus.status ?? ''] ?? 'no record'} → <strong>{STATUS_LABELS[overrideFor.to]}</strong>.
                  The change and your reason are kept in the append-only override log.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2 py-1">
            <Label htmlFor="ov-reason">Reason *</Label>
            <Input
              id="ov-reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="e.g. Left early — family emergency"
              aria-invalid={!overrideReason.trim()}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOverrideFor(null)} disabled={overrideBusy}>Cancel</Button>
            <Button onClick={() => void confirmOverride()} disabled={overrideBusy || !overrideReason.trim()} className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white min-w-28">
              {overrideBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              {overrideBusy ? 'Saving…' : 'Save override'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payroll gate — records requiring verification before money moves */}
      <Dialog open={!!gate} onOpenChange={(o) => !o && setGate(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-stone-900 flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-orange-600" aria-hidden /> Payroll blocked — verification required
            </DialogTitle>
            <DialogDescription>
              {gate && (
                <>
                  {gate.requiringReview?.length ?? 0} record{(gate.requiringReview?.length ?? 0) === 1 ? '' : 's'} require
                  verification before payroll — <strong>{formatKES(gate.amount)}</strong> on hold
                  ({formatKES(gate.reviewAmount ?? 0)} pending review).
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <ul className={`max-h-48 overflow-y-auto space-y-1.5 pr-1 ${SCROLLBAR}`} aria-label="Records requiring review">
            {gate?.requiringReview?.map((r) => (
              <li key={r.workerId} className="flex items-center justify-between gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm">
                <span className="font-medium text-stone-800 truncate">{r.name ?? 'Worker'}</span>
                <span className="text-xs text-orange-700 shrink-0">{reasonLabel(r.reason)}</span>
              </li>
            ))}
          </ul>

          <p className="text-[11px] text-stone-500">
            Resolve each exception via the Daily Muster or the worker&rsquo;s status (with a reason), or force payroll to pay
            anyway — the force is recorded in the audit ledger.
          </p>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              className="gap-1.5 sm:mr-auto"
              onClick={() => { setGate(null); setMusterOpen(true) }}
            >
              <ClipboardList className="w-4 h-4" aria-hidden /> Review in muster
            </Button>
            <Button variant="destructive" onClick={() => setConfirmForce(true)} disabled={payrollBusy} className="gap-1.5">
              {payrollBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <ShieldAlert className="w-4 h-4" aria-hidden />}
              Force payroll
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Destructive confirm — paying past exceptions is a money action with audit consequences */}
      <AlertDialog open={confirmForce} onOpenChange={setConfirmForce}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force payroll past exceptions?</AlertDialogTitle>
            <AlertDialogDescription>
              {gate ? `${gate.requiringReview?.length ?? 0} record${(gate.requiringReview?.length ?? 0) === 1 ? '' : 's'} will be paid without verified check-in evidence (${formatKES(gate.reviewAmount ?? 0)} pending review). The force is flagged in the audit ledger.` : 'Unverified records will be paid and the force flagged in the audit ledger.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 bg-red-600 hover:bg-red-700"
              onClick={() => { setGate(null); void runPayroll(true) }}
            >
              Force payroll
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
