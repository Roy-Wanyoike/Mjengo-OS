'use client'

import { useMemo, useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { ProjectPayload } from '@/lib/mjengo'
import {
  Banknote, Camera, Check, Hourglass, ImageOff, Lock, Minus, Plus, Send, ShieldCheck, TrendingUp, Wallet, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatKES, dateShort } from '@/lib/format'

type MilestoneRow = ProjectPayload['milestones'][number]
type VariationRow = ProjectPayload['variations'][number]
type PhotoRow = ProjectPayload['photos'][number]

const LOCKED_STATUSES = ['locked', 'evidence_submitted', 'release_requested']

function parseEvidenceIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function previewReference(method: string): string {
  const prefix = method === 'bank' ? 'BANK' : method === 'card' ? 'CARD' : 'MPESA'
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let suffix = ''
  for (let i = 0; i < 8; i++) suffix += chars[Math.floor(Math.random() * chars.length)]
  return `${prefix}-${suffix}`
}

// ---------------- status badges ----------------

function MilestoneStatusBadge({ status }: { status: string }) {
  if (status === 'released')
    return <Badge className="border-0 bg-emerald-100 text-emerald-800 gap-1 hover:bg-emerald-100"><Check className="h-3 w-3" aria-hidden /> Released</Badge>
  if (status === 'rejected')
    return <Badge className="border-0 bg-rose-100 text-rose-800 gap-1 hover:bg-rose-100"><X className="h-3 w-3" aria-hidden /> Rejected</Badge>
  if (status === 'release_requested')
    return <Badge className="border-0 bg-amber-100 text-amber-900 gap-1 hover:bg-amber-100"><Hourglass className="h-3 w-3" aria-hidden /> Awaiting client</Badge>
  if (status === 'evidence_submitted')
    return <Badge className="border-0 bg-stone-800 text-stone-50 gap-1 hover:bg-stone-800"><Camera className="h-3 w-3" aria-hidden /> Evidence attached</Badge>
  return <Badge className="border-0 bg-stone-100 text-stone-600 gap-1 hover:bg-stone-100"><Lock className="h-3 w-3" aria-hidden /> Locked</Badge>
}

function VariationStatusBadge({ status }: { status: string }) {
  if (status === 'approved')
    return <Badge className="border-0 bg-emerald-100 text-emerald-800 gap-1 hover:bg-emerald-100"><Check className="h-3 w-3" aria-hidden /> Approved</Badge>
  if (status === 'rejected')
    return <Badge className="border-0 bg-rose-100 text-rose-800 gap-1 hover:bg-rose-100"><X className="h-3 w-3" aria-hidden /> Rejected</Badge>
  return <Badge className="border-0 bg-amber-100 text-amber-900 gap-1 hover:bg-amber-100"><Hourglass className="h-3 w-3" aria-hidden /> Awaiting client</Badge>
}

// ---------------- milestone stepper ----------------

function StepperNode({ state, index }: { state: 'done' | 'current' | 'todo'; index: number }) {
  if (state === 'done')
    return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600" aria-hidden><Check className="h-3 w-3 text-white" /></span>
  if (state === 'current')
    return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-amber-500 bg-white text-[10px] font-bold text-amber-600" aria-hidden>{index + 1}</span>
  return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-200 text-[10px] font-bold text-stone-400" aria-hidden>{index + 1}</span>
}

function MilestoneStepper({ m }: { m: MilestoneRow }) {
  const rejected = m.status === 'rejected'
  const doneCount =
    m.status === 'released' ? 4
    : rejected || m.status === 'release_requested' ? 3
    : m.status === 'evidence_submitted' ? 2
    : 1
  const steps = [
    { label: 'Locked', note: 'Funds earmarked' },
    { label: 'Evidence attached', note: m.status === 'locked' ? 'Attach site photos' : 'Proof of work' },
    { label: 'Release requested', note: m.requestedAt ? dateShort(m.requestedAt) : null },
  ]
  const finalStep = rejected
    ? { label: 'Rejected', note: m.decidedAt ? `${dateShort(m.decidedAt)}${m.decidedBy ? ` · ${m.decidedBy}` : ''}` : null }
    : { label: 'Released', note: m.releasedAt ? dateShort(m.releasedAt) : 'Client approves' }

  return (
    <ol className="space-y-0 text-xs" aria-label={`Progress: ${m.name}`}>
      {steps.map((s, i) => {
        const state = i < doneCount ? 'done' : i === doneCount ? 'current' : 'todo'
        return (
          <li key={s.label} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <StepperNode state={state} index={i} />
              <span className={`w-0.5 flex-1 min-h-4 ${i < doneCount && i < steps.length - 1 ? 'bg-emerald-500' : 'bg-stone-200'}`} aria-hidden />
            </div>
            <div className="pb-4 pt-[-2px]">
              <p className={`font-medium leading-5 ${state === 'done' ? 'text-stone-800' : state === 'current' ? 'text-amber-700' : 'text-stone-400'}`}>{s.label}</p>
              {s.note && <p className="text-[11px] text-stone-400">{s.note}</p>}
            </div>
          </li>
        )
      })}
      <li className="flex gap-2.5">
        {rejected ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-rose-600" aria-hidden><X className="h-3 w-3 text-white" /></span>
        ) : (
          <StepperNode state={m.status === 'released' ? 'done' : 'todo'} index={3} />
        )}
        <div>
          <p className={`font-medium leading-5 ${rejected ? 'text-rose-700' : m.status === 'released' ? 'text-stone-800' : 'text-stone-400'}`}>{finalStep.label}</p>
          {finalStep.note && <p className="text-[11px] text-stone-400">{finalStep.note}</p>}
        </div>
      </li>
    </ol>
  )
}

// ---------------- evidence thumbnails ----------------

function EvidenceThumb({ photo }: { photo: PhotoRow | undefined }) {
  if (!photo) {
    return (
      <span className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 bg-stone-50" title="Photo no longer on file">
        <ImageOff className="h-4 w-4 text-stone-400" aria-hidden />
        <span className="sr-only">Evidence photo no longer on file</span>
      </span>
    )
  }
  return (
    <a
      href={photo.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block h-12 w-12 overflow-hidden rounded-md border border-stone-200 transition hover:border-amber-500"
      title={photo.caption ?? 'Evidence photo — opens in new tab'}
      aria-label={`Evidence photo: ${photo.caption ?? 'site photo'} — opens in new tab`}
    >
      <img src={photo.url} alt={photo.caption ?? 'Site evidence photo'} className="h-full w-full object-cover" loading="lazy" />
    </a>
  )
}

// ---------------- main tab ----------------

export function MoneyTab() {
  const { data, dispatch, online, outbox, viewMode, actionBusy } = useMjengo()
  const busy = actionBusy !== null

  // top-up dialog
  const [topupOpen, setTopupOpen] = useState(false)
  const [tAmount, setTAmount] = useState('')
  const [tMethod, setTMethod] = useState('mpesa')

  // milestone create dialog
  const [msOpen, setMsOpen] = useState(false)
  const [msName, setMsName] = useState('')
  const [msAmount, setMsAmount] = useState('')
  const [msPhase, setMsPhase] = useState('none')

  // evidence dialog
  const [evidenceTarget, setEvidenceTarget] = useState<MilestoneRow | null>(null)
  const [selectedPhotos, setSelectedPhotos] = useState<Set<string>>(new Set())

  // request-release confirmation
  const [releaseTarget, setReleaseTarget] = useState<MilestoneRow | null>(null)

  // reject dialog (milestone or variation)
  const [rejectTarget, setRejectTarget] = useState<{ kind: 'milestone' | 'variation'; id: string; title: string } | null>(null)
  const [rejectNote, setRejectNote] = useState('')

  // approve confirmation — releases escrow money / changes the budget; one
  // deliberate click (Reject already asks for a note; Approve gets a confirm)
  const [approveConfirm, setApproveConfirm] = useState<{ kind: 'milestone' | 'variation'; id: string; title: string; amount: number } | null>(null)

  // variation create dialog
  const [vOpen, setVOpen] = useState(false)
  const [vTitle, setVTitle] = useState('')
  const [vDesc, setVDesc] = useState('')
  const [vSign, setVSign] = useState<1 | -1>(1)
  const [vAmount, setVAmount] = useState('')
  const [vPhase, setVPhase] = useState('none')

  const refPreview = useMemo(() => previewReference(tMethod), [topupOpen, tMethod])

  if (!data) return null
  const isClient = viewMode === 'client'
  const clientName = data.project.client

  const balance = data.escrow?.balance ?? 0
  const lockedAmount = data.milestones
    .filter((m) => LOCKED_STATUSES.includes(m.status))
    .reduce((s, m) => s + m.amount, 0)
  const releasedAmount = data.milestones
    .filter((m) => m.status === 'released')
    .reduce((s, m) => s + m.amount, 0)
  const pendingCount = data.milestones.filter((m) => m.status === 'release_requested').length

  const photoById = (id: string) => data.photos.find((p) => p.id === id)
  const phaseName = (phaseId: string | null) =>
    phaseId ? data.phases.find((p) => p.id === phaseId)?.name ?? null : null

  const offlineNote = `Saved on-device — queued (${outbox.length})`

  // ---------------- handlers ----------------

  async function topUp() {
    const amount = Number(tAmount)
    if (!tAmount || Number.isNaN(amount) || amount <= 0) { toast.error('Enter a top-up amount greater than zero'); return }
    const ok = await dispatch('escrow.topup', { amount, method: tMethod }, `Escrow top-up ${formatKES(amount)}`)
    if (ok) {
      toast.success(online ? `${formatKES(amount)} added to the escrow wallet` : offlineNote)
      setTopupOpen(false); setTAmount('')
    } else toast.error('Top-up failed')
  }

  async function createMilestone() {
    const amount = Number(msAmount)
    if (!msName.trim()) { toast.error('Give the milestone a name'); return }
    if (!msAmount || Number.isNaN(amount) || amount <= 0) { toast.error('Milestone amount must be greater than zero'); return }
    const ok = await dispatch('milestone.create', {
      name: msName.trim(), amount, phaseId: msPhase === 'none' ? undefined : msPhase,
    }, `Milestone: ${msName.trim()}`)
    if (ok) {
      toast.success(online ? `${msName.trim()} locked at ${formatKES(amount)}` : offlineNote)
      setMsOpen(false); setMsName(''); setMsAmount(''); setMsPhase('none')
    } else toast.error('Could not create milestone')
  }

  async function attachEvidence() {
    if (!evidenceTarget) return
    if (!selectedPhotos.size) { toast.error('Select at least one photo'); return }
    const ok = await dispatch('milestone.evidence', {
      id: evidenceTarget.id, photoIds: Array.from(selectedPhotos),
    }, `Evidence on ${evidenceTarget.name}`)
    if (ok) {
      toast.success(online ? `${selectedPhotos.size} evidence photo(s) attached to "${evidenceTarget.name}"` : offlineNote)
      setEvidenceTarget(null)
    } else toast.error('Could not attach evidence')
  }

  async function requestRelease() {
    if (!releaseTarget) return
    const ok = await dispatch('milestone.requestRelease', { id: releaseTarget.id }, `Release request: ${releaseTarget.name}`)
    if (ok) {
      toast.success(online ? `Release requested — ${clientName} will decide` : offlineNote)
      setReleaseTarget(null)
    } else toast.error('Could not request release — evidence may be missing')
  }

  async function decideMilestone(m: MilestoneRow, decision: 'approve' | 'reject') {
    const ok = await dispatch('milestone.decide', {
      id: m.id, decision, by: clientName, note: decision === 'reject' && rejectNote.trim() ? rejectNote.trim() : undefined,
    }, `Milestone ${decision}: ${m.name}`)
    if (ok) {
      toast.success(decision === 'approve'
        ? `${formatKES(m.amount)} released to contractor`
        : `Release rejected — "${m.name}"`)
      setRejectTarget(null); setRejectNote('')
      setApproveConfirm(null)
    } else {
      toast.error(decision === 'approve'
        ? 'Could not approve — check the escrow balance'
        : 'Could not record the rejection')
    }
  }

  async function submitVariation() {
    const amount = Number(vAmount)
    if (!vTitle.trim() || !vDesc.trim()) { toast.error('Title and description are required'); return }
    if (!vAmount || Number.isNaN(amount) || amount <= 0) { toast.error('Enter the budget impact amount'); return }
    const budgetImpact = vSign * amount
    const ok = await dispatch('variation.submit', {
      title: vTitle.trim(), description: vDesc.trim(), budgetImpact,
      phaseId: vPhase === 'none' ? undefined : vPhase,
    }, `Variation: ${vTitle.trim()}`)
    if (ok) {
      toast.success(online ? `Variation submitted — awaiting ${clientName}` : offlineNote)
      setVOpen(false); setVTitle(''); setVDesc(''); setVAmount(''); setVPhase('none')
    } else toast.error('Could not submit variation')
  }

  async function decideVariation(v: VariationRow, decision: 'approve' | 'reject') {
    const ok = await dispatch('variation.decide', {
      id: v.id, decision, by: clientName, note: decision === 'reject' && rejectNote.trim() ? rejectNote.trim() : undefined,
    }, `Variation ${decision}: ${v.title}`)
    if (ok) {
      toast.success(decision === 'approve'
        ? `Budget ${v.budgetImpact >= 0 ? 'increased' : 'reduced'} by ${formatKES(Math.abs(v.budgetImpact))}`
        : `Variation rejected — "${v.title}"`)
      setRejectTarget(null); setRejectNote('')
      setApproveConfirm(null)
    } else toast.error('Could not record the decision')
  }

  // ---------------- render ----------------

  return (
    <div className="space-y-6">
      {/* KPI row */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="MjengoPay KPIs">
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Wallet className="h-3.5 w-3.5" aria-hidden /> In escrow</CardDescription>
            <CardTitle className="text-2xl font-bold tabular-nums text-stone-900">{formatKES(balance)}</CardTitle>
          </CardHeader>
          <CardContent><p className="text-xs text-stone-500">Held for {data.project.name}</p></CardContent>
        </Card>
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Lock className="h-3.5 w-3.5" aria-hidden /> Locked in milestones</CardDescription>
            <CardTitle className="text-2xl font-bold tabular-nums text-stone-900">{formatKES(lockedAmount)}</CardTitle>
          </CardHeader>
          <CardContent><p className="text-xs text-stone-500">{data.milestones.filter((m) => LOCKED_STATUSES.includes(m.status)).length} milestone(s) not yet released</p></CardContent>
        </Card>
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Banknote className="h-3.5 w-3.5" aria-hidden /> Released to date</CardDescription>
            <CardTitle className="text-2xl font-bold tabular-nums text-stone-900">{formatKES(releasedAmount)}</CardTitle>
          </CardHeader>
          <CardContent><p className="text-xs text-stone-500">Client-approved, against photo proof</p></CardContent>
        </Card>
        <Card className={`shadow-sm ${pendingCount > 0 ? 'border-amber-300' : 'border-stone-200'}`}>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Hourglass className="h-3.5 w-3.5" aria-hidden /> Pending client decision</CardDescription>
            <CardTitle className="text-2xl font-bold tabular-nums text-stone-900">{pendingCount}</CardTitle>
          </CardHeader>
          <CardContent><p className="text-xs text-stone-500">Release request(s) awaiting {clientName}</p></CardContent>
        </Card>
      </section>

      {/* Escrow wallet card */}
      <Card className="border-stone-800 bg-stone-950 text-stone-50 shadow-md">
        <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-stone-400">
              <Wallet className="h-3.5 w-3.5" aria-hidden /> MjengoPay escrow wallet
            </p>
            <p className="pt-1 text-4xl font-bold tabular-nums text-stone-50">{formatKES(balance)}</p>
            <p className="pt-1.5 text-xs text-stone-400">
              Milestone-based escrow — money moves only on client-approved, photo-proven work
            </p>
          </div>
          {!isClient && (
            <Button
              onClick={() => setTopupOpen(true)}
              disabled={busy}
              className="min-h-11 gap-1.5 bg-amber-500 text-base font-semibold text-stone-950 hover:bg-amber-400"
              aria-label="Top up the escrow wallet"
            >
              <Plus className="h-4 w-4" aria-hidden /> Top up
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Milestones */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-lg text-stone-900">Milestones — money tied to proof of work</CardTitle>
            <CardDescription>
              Locked → evidence → client-approved release. Money never moves without photo proof.
            </CardDescription>
          </div>
          {!isClient && (
            <Button size="sm" variant="outline" className="min-h-11 gap-1.5" onClick={() => setMsOpen(true)} aria-label="Create a new milestone">
              <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">New milestone</span>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {data.milestones.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center">
              <Lock className="mx-auto h-8 w-8 text-stone-300" aria-hidden />
              <p className="pt-3 text-sm font-medium text-stone-700">No milestones yet</p>
              <p className="pt-1 text-xs text-stone-500">Create the first milestone — tie money to proof of work.</p>
              {!isClient && (
                <Button size="sm" className="mt-4 min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700" onClick={() => setMsOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden /> Create milestone
                </Button>
              )}
            </div>
          ) : (
            <div className="max-h-96 space-y-4 overflow-y-auto pr-2 -mr-2" role="region" aria-label="Milestones, scrollable">
              {data.milestones.map((m) => {
                const evidence = parseEvidenceIds(m.evidencePhotoIds)
                const phName = phaseName(m.phaseId)
                const awaiting = m.status === 'release_requested'
                const canAttach = !isClient && ['locked', 'evidence_submitted'].includes(m.status)
                const canRequest = !isClient && m.status === 'evidence_submitted'
                const insufficient = awaiting && balance < m.amount
                return (
                  <div
                    key={m.id}
                    className={`rounded-lg border bg-white p-4 ${awaiting ? 'border-amber-300' : 'border-stone-200'}`}
                  >
                    <div className="grid gap-4 md:grid-cols-[190px minmax(0,1fr)]">
                      <MilestoneStepper m={m} />
                      <div className="min-w-0 space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-stone-900">{m.name}</p>
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              {phName && <Badge variant="outline" className="text-[10px]">{phName}</Badge>}
                              <span className="text-xs text-stone-400">created {dateShort(m.createdAt)}</span>
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1.5">
                            <span className="text-base font-bold tabular-nums text-stone-900">{formatKES(m.amount)}</span>
                            <MilestoneStatusBadge status={m.status} />
                          </div>
                        </div>

                        {/* decision history */}
                        {m.decidedBy && (
                          <p className={`rounded-md px-2.5 py-1.5 text-xs ${m.status === 'rejected' ? 'bg-rose-50 text-rose-700' : 'bg-stone-50 text-stone-500'}`}>
                            {m.status === 'rejected' ? 'Rejected' : 'Decided'} by <span className="font-medium">{m.decidedBy}</span>
                            {m.decidedAt ? ` · ${dateShort(m.decidedAt)}` : ''}
                            {m.decisionNote ? ` — “${m.decisionNote}”` : ''}
                          </p>
                        )}

                        {/* evidence photos */}
                        <div>
                          <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Evidence ({evidence.length})</p>
                          {evidence.length === 0 ? (
                            <p className="pt-1 text-xs text-stone-400">No proof-of-work photos yet — release is blocked until evidence is attached.</p>
                          ) : (
                            <div className="flex flex-wrap gap-1.5 pt-1.5">
                              {evidence.map((pid) => <EvidenceThumb key={pid} photo={photoById(pid)} />)}
                            </div>
                          )}
                        </div>

                        {/* owner actions */}
                        {(canAttach || canRequest) && (
                          <div className="flex flex-wrap gap-2 border-t border-stone-100 pt-3">
                            {canAttach && (
                              <Button
                                size="sm" variant="outline" className="min-h-11 gap-1.5"
                                onClick={() => { setEvidenceTarget(m); setSelectedPhotos(new Set(evidence)) }}
                                aria-label={`Attach evidence photos to ${m.name}`}
                              >
                                <Camera className="h-4 w-4" aria-hidden /> {evidence.length ? 'Attach more evidence' : 'Attach evidence'}
                              </Button>
                            )}
                            {canRequest && (
                              <Button
                                size="sm"
                                className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
                                disabled={busy || evidence.length === 0}
                                title={evidence.length === 0 ? 'Attach proof-of-work photos first' : undefined}
                                onClick={() => setReleaseTarget(m)}
                                aria-label={`Request release of ${formatKES(m.amount)} for ${m.name}`}
                              >
                                <Send className="h-4 w-4" aria-hidden /> Request release
                              </Button>
                            )}
                          </div>
                        )}

                        {/* client decision panel */}
                        {awaiting && (
                          <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
                            <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
                              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                              {isClient
                                ? `Client decision — ${clientName} approves via the share link`
                                : `Acting as client (they'd do this via their share link)`}
                            </p>
                            <p className="text-xs text-stone-600">
                              Escrow: <span className="font-semibold tabular-nums">{formatKES(balance)}</span>
                              {' '}· Release: <span className="font-semibold tabular-nums">{formatKES(m.amount)}</span>
                              {insufficient && (
                                <Badge className="ml-2 border-0 bg-rose-100 text-rose-800 hover:bg-rose-100">Insufficient escrow — top up first</Badge>
                              )}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm" className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                                disabled={busy || insufficient}
                                onClick={() => setApproveConfirm({ kind: 'milestone', id: m.id, title: m.name, amount: m.amount })}
                                aria-label={`Approve release of ${formatKES(m.amount)} for ${m.name}`}
                              >
                                <Check className="h-4 w-4" aria-hidden /> Approve release
                              </Button>
                              <Button
                                size="sm" variant="outline" className="min-h-11 gap-1.5 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                                disabled={busy}
                                onClick={() => { setRejectTarget({ kind: 'milestone', id: m.id, title: m.name }); setRejectNote('') }}
                                aria-label={`Reject the release request for ${m.name}, with a note`}
                              >
                                <X className="h-4 w-4" aria-hidden /> Reject with note
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Variations */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg text-stone-900"><TrendingUp className="h-5 w-5 text-amber-600" aria-hidden /> Variation orders</CardTitle>
            <CardDescription>Plan changes that move the budget — only after the client approves.</CardDescription>
          </div>
          {!isClient && (
            <Button size="sm" variant="outline" className="min-h-11 gap-1.5" onClick={() => setVOpen(true)} aria-label="Submit a new variation order">
              <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">New variation</span>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {data.variations.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center">
              <TrendingUp className="mx-auto h-8 w-8 text-stone-300" aria-hidden />
              <p className="pt-3 text-sm font-medium text-stone-700">No variations</p>
              <p className="pt-1 text-xs text-stone-500">The plan is holding. Submit a variation when site reality demands a change.</p>
            </div>
          ) : (
            <div className="max-h-96 space-y-3 overflow-y-auto pr-2 -mr-2" role="region" aria-label="Variation orders, scrollable">
              {data.variations.map((v) => {
                const positive = v.budgetImpact >= 0
                const phName = phaseName(v.phaseId)
                return (
                  <div key={v.id} className="rounded-lg border border-stone-200 bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-stone-900">{v.title}</p>
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {phName && <Badge variant="outline" className="text-[10px]">{phName}</Badge>}
                          <span className="text-xs text-stone-400">
                            {v.submittedBy ? `by ${v.submittedBy} · ` : ''}{dateShort(v.createdAt)}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <span className={`text-sm font-bold tabular-nums ${positive ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {positive ? '+' : '−'}{formatKES(Math.abs(v.budgetImpact))}
                        </span>
                        <VariationStatusBadge status={v.status} />
                      </div>
                    </div>
                    <p className="pt-2 text-xs leading-relaxed text-stone-600">{v.description}</p>
                    {v.decidedBy && (
                      <p className={`mt-2 rounded-md px-2.5 py-1.5 text-xs ${v.status === 'rejected' ? 'bg-rose-50 text-rose-700' : 'bg-stone-50 text-stone-500'}`}>
                        {v.status === 'rejected' ? 'Rejected' : 'Approved'} by <span className="font-medium">{v.decidedBy}</span>
                        {v.decidedAt ? ` · ${dateShort(v.decidedAt)}` : ''}
                        {v.decisionNote ? ` — “${v.decisionNote}”` : ''}
                      </p>
                    )}
                    {v.status === 'submitted' && (
                      <div className="mt-3 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
                          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                          {isClient ? `Your decision — budget moves only after approval` : `Acting as client (they'd do this via their share link)`}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm" className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                            disabled={busy}
                            onClick={() => setApproveConfirm({ kind: 'variation', id: v.id, title: v.title, amount: v.budgetImpact })}
                            aria-label={`Approve variation ${v.title}`}
                          >
                            <Check className="h-4 w-4" aria-hidden /> Approve
                          </Button>
                          <Button
                            size="sm" variant="outline" className="min-h-11 gap-1.5 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                            disabled={busy}
                            onClick={() => { setRejectTarget({ kind: 'variation', id: v.id, title: v.title }); setRejectNote('') }}
                            aria-label={`Reject variation ${v.title}, with a note`}
                          >
                            <X className="h-4 w-4" aria-hidden /> Reject with note
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Top-up dialog ---------------- */}
      <Dialog open={topupOpen} onOpenChange={setTopupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Top up escrow wallet</DialogTitle>
            <DialogDescription>Funds are held in escrow and released only against client-approved milestones.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="topup-amount">Amount (KSh)</Label>
              <Input id="topup-amount" type="number" min="1" value={tAmount} onChange={(e) => setTAmount(e.target.value)} placeholder="e.g. 500,000" inputMode="numeric" />
              {Number(tAmount) > 0 && (
                <p className="text-xs text-stone-500">
                  Adding <span className="font-semibold text-stone-800">{formatKES(Number(tAmount))}</span> — new balance{' '}
                  <span className="font-semibold text-stone-800">{formatKES(balance + Number(tAmount))}</span>
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Method</Label>
              <RadioGroup value={tMethod} onValueChange={setTMethod} className="grid grid-cols-3 gap-2" aria-label="Payment method">
                {[
                  { value: 'mpesa', label: 'M-Pesa' },
                  { value: 'bank', label: 'Bank' },
                  { value: 'card', label: 'Card' },
                ].map((opt) => (
                  <label
                    key={opt.value}
                    htmlFor={`method-${opt.value}`}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-stone-200 px-3 text-sm text-stone-700 transition has-[[data-state=checked]]:border-amber-500 has-[[data-state=checked]]:bg-amber-50"
                  >
                    <RadioGroupItem value={opt.value} id={`method-${opt.value}`} />
                    {opt.label}
                  </label>
                ))}
              </RadioGroup>
            </div>
            <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-[11px] leading-relaxed text-stone-500">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
              Simulated wallet — Daraja sandbox wiring pending. Reference (auto): <span className="font-mono font-medium text-stone-700">{refPreview}</span>
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTopupOpen(false)}>Cancel</Button>
            <Button onClick={() => void topUp()} disabled={busy} className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700">
              <Plus className="h-4 w-4" aria-hidden /> Top up
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- New milestone dialog ---------------- */}
      <Dialog open={msOpen} onOpenChange={setMsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">New milestone</DialogTitle>
            <DialogDescription>Lock an amount against a phase of work — it releases only against photo proof + client approval.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="ms-name">Milestone name</Label>
              <Input id="ms-name" value={msName} onChange={(e) => setMsName(e.target.value)} placeholder="e.g. Roofing complete" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ms-amount">Amount (KSh)</Label>
              <Input id="ms-amount" type="number" min="1" value={msAmount} onChange={(e) => setMsAmount(e.target.value)} placeholder="e.g. 500,000" inputMode="numeric" />
              {Number(msAmount) > 0 && (
                <p className="text-xs text-stone-500">Will lock <span className="font-semibold text-stone-800">{formatKES(Number(msAmount))}</span> in the milestone flow</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Phase (optional)</Label>
              <Select value={msPhase} onValueChange={setMsPhase}>
                <SelectTrigger aria-label="Phase"><SelectValue placeholder="Optional" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific phase</SelectItem>
                  {data.phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMsOpen(false)}>Cancel</Button>
            <Button onClick={() => void createMilestone()} disabled={busy} className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700">
              <Plus className="h-4 w-4" aria-hidden /> Create milestone
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Attach evidence dialog ---------------- */}
      <Dialog open={evidenceTarget !== null} onOpenChange={(open) => { if (!open) setEvidenceTarget(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-stone-900">Attach proof-of-work photos</DialogTitle>
            <DialogDescription>
              {evidenceTarget ? `Evidence for “${evidenceTarget.name}” — release is blocked until at least one photo is on file.` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            {data.photos.length === 0 ? (
              <p className="rounded-md bg-stone-50 p-3 text-xs text-stone-500">No site photos yet — capture evidence in the Evidence tab first.</p>
            ) : (
              <div className="max-h-72 space-y-2 overflow-y-auto pr-2" role="region" aria-label="Site photos, scrollable">
                {data.photos.map((p) => {
                  const checked = selectedPhotos.has(p.id)
                  return (
                    <label
                      key={p.id}
                      className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md border p-2 transition ${checked ? 'border-amber-500 bg-amber-50' : 'border-stone-200 hover:border-stone-300'}`}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          const next = new Set(selectedPhotos)
                          if (v) next.add(p.id); else next.delete(p.id)
                          setSelectedPhotos(next)
                        }}
                        aria-label={`Select photo: ${p.caption ?? 'site photo'}`}
                      />
                      <img src={p.url} alt="" className="h-11 w-11 shrink-0 rounded-md border border-stone-200 object-cover" loading="lazy" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-stone-800">{p.caption ?? 'Site photo'}</span>
                        <span className="block text-[11px] text-stone-400">{p.phaseName ?? 'No phase'} · {dateShort(p.createdAt)}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            <p className="text-[11px] text-stone-400">{selectedPhotos.size} selected — already-attached photos stay attached.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEvidenceTarget(null)}>Cancel</Button>
            <Button onClick={() => void attachEvidence()} disabled={busy || selectedPhotos.size === 0} className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700">
              <Camera className="h-4 w-4" aria-hidden /> Attach {selectedPhotos.size > 0 ? `(${selectedPhotos.size})` : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Request release confirmation ---------------- */}
      <Dialog open={releaseTarget !== null} onOpenChange={(open) => { if (!open) setReleaseTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Request release</DialogTitle>
            <DialogDescription>
              {releaseTarget
                ? `${releaseTarget.name} — ${formatKES(releaseTarget.amount)} will need approval from ${clientName}.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {releaseTarget && (
            <div className="grid gap-4 py-2">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                  Evidence attached ({parseEvidenceIds(releaseTarget.evidencePhotoIds).length})
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1.5">
                  {parseEvidenceIds(releaseTarget.evidencePhotoIds).map((pid) => (
                    <EvidenceThumb key={pid} photo={photoById(pid)} />
                  ))}
                </div>
              </div>
              <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-xs leading-relaxed text-stone-500">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
                Money never moves without photo proof. {clientName} reviews this evidence before approving.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReleaseTarget(null)}>Cancel</Button>
            <Button onClick={() => void requestRelease()} disabled={busy} className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700">
              <Send className="h-4 w-4" aria-hidden /> Request release
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Reject-with-note dialog (milestone / variation) ---------------- */}
      <Dialog open={rejectTarget !== null} onOpenChange={(open) => { if (!open) setRejectTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Reject with a note</DialogTitle>
            <DialogDescription>
              {rejectTarget?.kind === 'milestone'
                ? `Rejecting the release of “${rejectTarget?.title}” — the note is recorded in the decision history.`
                : `Rejecting variation “${rejectTarget?.title}” — the budget stays untouched.`}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="reject-note">Note to the site team (optional)</Label>
              <Textarea id="reject-note" rows={3} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="e.g. Ring beam not yet cast — resubmit after casting" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>Cancel</Button>
            <Button
              onClick={() => {
                if (!rejectTarget) return
                const m = data.milestones.find((x) => x.id === rejectTarget.id)
                const v = data.variations.find((x) => x.id === rejectTarget.id)
                if (rejectTarget.kind === 'milestone' && m) void decideMilestone(m, 'reject')
                if (rejectTarget.kind === 'variation' && v) void decideVariation(v, 'reject')
              }}
              disabled={busy}
              className="min-h-11 gap-1.5 border-rose-300 bg-white text-rose-700 hover:bg-rose-50 hover:text-rose-800"
              variant="outline"
            >
              <X className="h-4 w-4" aria-hidden /> Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Approve confirmation (milestone release / variation) ---------------- */}
      <Dialog open={approveConfirm !== null} onOpenChange={(open) => { if (!open) setApproveConfirm(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">
              {approveConfirm?.kind === 'milestone' ? 'Approve release' : 'Approve variation'}
            </DialogTitle>
            <DialogDescription>
              {approveConfirm?.kind === 'milestone'
                ? `This releases ${formatKES(approveConfirm.amount)} from escrow to the contractor for “${approveConfirm.title}”.`
                : approveConfirm
                  ? `The project budget will ${approveConfirm.amount >= 0 ? 'increase' : 'reduce'} by ${formatKES(Math.abs(approveConfirm.amount))} for “${approveConfirm.title}”.`
                  : ''}
            </DialogDescription>
          </DialogHeader>
          <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-xs leading-relaxed text-stone-500">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
            One deliberate click, not two accidental ones — the decision is recorded in the audit ledger and cannot be edited afterwards.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveConfirm(null)}>Cancel</Button>
            <Button
              onClick={() => {
                if (!approveConfirm) return
                const m = approveConfirm.kind === 'milestone' ? data.milestones.find((x) => x.id === approveConfirm.id) : undefined
                const v = approveConfirm.kind === 'variation' ? data.variations.find((x) => x.id === approveConfirm.id) : undefined
                if (m) void decideMilestone(m, 'approve')
                if (v) void decideVariation(v, 'approve')
              }}
              disabled={busy}
              className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <Check className="h-4 w-4" aria-hidden /> Confirm approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- New variation dialog ---------------- */}
      <Dialog open={vOpen} onOpenChange={setVOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">New variation order</DialogTitle>
            <DialogDescription>A plan change that moves the budget. The budget only moves after {clientName} approves.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="v-title">Title</Label>
              <Input id="v-title" value={vTitle} onChange={(e) => setVTitle(e.target.value)} placeholder="e.g. Kitchen counter granite upgrade" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="v-desc">Description</Label>
              <Textarea id="v-desc" rows={3} value={vDesc} onChange={(e) => setVDesc(e.target.value)} placeholder="What changed on site, and why" />
            </div>
            <div className="space-y-2">
              <Label>Budget impact</Label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button" variant="outline"
                  className={`min-h-11 gap-1.5 ${vSign === 1 ? 'border-emerald-500 bg-emerald-50 text-emerald-700 hover:bg-emerald-50' : 'text-stone-600'}`}
                  onClick={() => setVSign(1)} aria-pressed={vSign === 1} aria-label="Extra cost — increases the budget"
                >
                  <Plus className="h-4 w-4" aria-hidden /> Extra cost
                </Button>
                <Button
                  type="button" variant="outline"
                  className={`min-h-11 gap-1.5 ${vSign === -1 ? 'border-rose-500 bg-rose-50 text-rose-700 hover:bg-rose-50' : 'text-stone-600'}`}
                  onClick={() => setVSign(-1)} aria-pressed={vSign === -1} aria-label="Saving — reduces the budget"
                >
                  <Minus className="h-4 w-4" aria-hidden /> Saving
                </Button>
              </div>
              <Input
                id="v-amount" type="number" min="1" value={vAmount}
                onChange={(e) => setVAmount(e.target.value)} placeholder="e.g. 95,000" inputMode="numeric"
                aria-label="Budget impact amount in KSh"
              />
              {Number(vAmount) > 0 && (
                <p className={`text-xs font-medium ${vSign === 1 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {vSign === 1 ? '+' : '−'}{formatKES(Number(vAmount))} budget impact
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Phase (optional)</Label>
              <Select value={vPhase} onValueChange={setVPhase}>
                <SelectTrigger aria-label="Phase"><SelectValue placeholder="Optional" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific phase</SelectItem>
                  {data.phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVOpen(false)}>Cancel</Button>
            <Button onClick={() => void submitVariation()} disabled={busy} className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700">
              <Send className="h-4 w-4" aria-hidden /> Submit for approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
