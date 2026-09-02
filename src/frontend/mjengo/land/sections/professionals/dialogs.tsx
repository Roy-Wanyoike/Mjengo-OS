'use client'

// Professionals — mutation dialogs (contractor/admin surface; the client view
// never renders these). Every write goes through the registered
// PROFESSIONALS_ACTIONS via the store's dispatch() so it is offline-queued +
// audited by the Bias-Free Ledger.

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Button } from '@/frontend/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Textarea } from '@/frontend/ui/textarea'
import {
  CATEGORY_LABELS,
  CHECK_METHODS,
  CHECK_METHOD_LABELS,
  LICENCE_BODIES,
  LICENCE_BODY_LABELS,
  PROFESSIONAL_CATEGORIES,
  ASSIGNMENT_ROLES,
  ASSIGNMENT_ROLE_LABELS,
  VERIFICATION_LADDER,
  ladderLabel,
  type ProfessionalCategory,
  type ProfessionalWithChecks,
} from '@/backend/modules/professionals/types'
import type { ParcelDetail, ParcelStatus } from '@/backend/modules/land/types'
import { PARCEL_STATUS_LABELS } from '@/backend/modules/land/types'
import { BadgeCheck, ArrowRight, ShieldQuestion } from 'lucide-react'
import { toast } from 'sonner'

/** Reset a dialog's fields whenever it (re)opens. */
function useReset(open: boolean, reset: () => void) {
  useEffect(() => {
    if (open) reset()
  }, [open])
}

/** The signed-in name is the honest "who checked" — never overridable by hand. */
function useActorName(): string {
  const { data: session } = useSession()
  return session?.user?.name ?? 'Site Manager'
}

// ---------------- add a directory entry ----------------

const CATEGORY_BODY_HINT: Record<ProfessionalCategory, string> = {
  surveyor: 'Licensed land surveyors register with EBK.',
  engineer: 'Professional engineers register with EBK.',
  advocate: 'Advocates hold an LSK practising certificate.',
  architect: 'Architects register with BORAQS.',
  qty_surveyor: 'Quantity surveyors register with BORAQS.',
  contractor: 'Building contractors register with NCA — record that licence under “Other body”.',
}

export function AddProfessionalDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [category, setCategory] = useState<string>('surveyor')
  const [organisation, setOrganisation] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [county, setCounty] = useState('')
  const [licenceNumber, setLicenceNumber] = useState('')
  const [licenceBody, setLicenceBody] = useState<string>('EBK')
  const [notes, setNotes] = useState('')

  useReset(open, () => {
    setName(''); setCategory('surveyor'); setOrganisation(''); setPhone('')
    setEmail(''); setCounty(''); setLicenceNumber(''); setLicenceBody('EBK'); setNotes('')
  })

  async function submit() {
    if (!name.trim()) { toast.error('Name is required'); return }
    if (!category) { toast.error('Category is required'); return }
    setBusy(true)
    const ok = await dispatch('professional.upsert', {
      name: name.trim(),
      category,
      organisation: organisation.trim() || undefined,
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      county: county.trim() || undefined,
      licenceNumber: licenceNumber.trim() || undefined,
      licenceBody,
      notes: notes.trim() || undefined,
    }, `Add professional ${name.trim()}`)
    setBusy(false)
    if (ok) {
      toast.success(online
        ? `${name.trim()} added to the directory — unverified until checks are recorded`
        : `Saved on-device — queued (${outbox.length + 1})`)
      onOpenChange(false)
    } else {
      toast.error('Could not add the entry — this name may already be in the directory for that category')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a professional</DialogTitle>
          <DialogDescription>
            New entries start <span className="font-medium">UNVERIFIED (level 0)</span> — being listed claims
            nothing. Verification only moves as checks are recorded on the platform.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="ap-name">Full name *</Label>
            <Input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jane Mwangi" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ap-category">Category *</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="ap-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROFESSIONAL_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-snug text-stone-500">{CATEGORY_BODY_HINT[category as ProfessionalCategory]}</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ap-county">County</Label>
              <Input id="ap-county" value={county} onChange={(e) => setCounty(e.target.value)} placeholder="Nairobi" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ap-org">Organisation / practice</Label>
            <Input id="ap-org" value={organisation} onChange={(e) => setOrganisation(e.target.value)} placeholder="e.g. Mwangi & Partners Land Surveyors" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ap-phone">Phone</Label>
              <Input id="ap-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07…" inputMode="tel" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ap-email">Email</Label>
              <Input id="ap-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@practice.co.ke" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ap-licence">Licence / practising no.</Label>
              <Input id="ap-licence" value={licenceNumber} onChange={(e) => setLicenceNumber(e.target.value)} placeholder="e.g. EBK/LS/2310" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ap-body">Issuing body</Label>
              <Select value={licenceBody} onValueChange={setLicenceBody}>
                <SelectTrigger id="ap-body"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LICENCE_BODIES.map((b) => (
                    <SelectItem key={b} value={b}>{LICENCE_BODY_LABELS[b]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ap-notes">Notes</Label>
            <Textarea id="ap-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="How you know them, availability, rates…" className="min-h-16" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? 'Adding…' : 'Add professional'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- record a credential check ----------------

export function RecordCheckDialog({
  professional,
  open,
  onOpenChange,
}: {
  professional: ProfessionalWithChecks
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const actor = useActorName()
  const [busy, setBusy] = useState(false)
  const [method, setMethod] = useState<string>('document_review')
  const [finding, setFinding] = useState('')
  /** Result echo kept in the dialog so the honest wording is read, not skimmed. */
  const [recorded, setRecorded] = useState<null | {
    checkedBy: string
    previousState: number
    newState: number
    queued: boolean
  }>(null)

  useReset(open, () => {
    setMethod('document_review'); setFinding(''); setRecorded(null)
  })

  async function submit() {
    if (!finding.trim()) { toast.error('Record what was actually observed — the finding is required'); return }
    setBusy(true)
    const ok = await dispatch('credential.record', {
      professionalId: professional.id,
      method,
      finding: finding.trim(),
      checkedBy: actor,
    }, `Record ${method.replace('_', ' ')} check on ${professional.name}`)
    setBusy(false)
    if (!ok) {
      toast.error('Could not record the check')
      return
    }
    // Read the result back from the refreshed payload (online) — the honest
    // echo comes from the stored record, not a guess.
    const fresh = useMjengo
      .getState()
      .data?.professionals?.professionals?.find((p) => p.id === professional.id)
    const latest = fresh?.credentialChecks?.[0]
    const queuedWording = !fresh // offline: the local payload does not refresh
    const previousState = professional.verificationState
    // Offline (queued): predict the advance — it lands when the outbox syncs.
    const predicted = Math.min(previousState + 1, 5)
    const stored = fresh?.verificationState
    setRecorded({
      checkedBy: latest?.checkedBy ?? actor,
      previousState,
      newState: queuedWording ? predicted : (stored ?? previousState),
      queued: queuedWording,
    })
    toast.success(online ? 'Check recorded — this is a platform record' : `Saved on-device — queued (${outbox.length + 1})`)
  }

  const advanced = recorded && recorded.newState > recorded.previousState

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a credential check</DialogTitle>
          <DialogDescription>
            {professional.name}
            {professional.organisation ? ` · ${professional.organisation}` : ''} — an honest observation of
            what <span className="font-medium">you</span> checked and what you found. MjengoOS records the
            check; it never confirms anything with a registry.
          </DialogDescription>
        </DialogHeader>

        {recorded ? (
          <div className="grid gap-3 py-1" role="status">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3.5 min-w-0">
              <p className="text-sm font-semibold text-amber-900 leading-snug">
                Check recorded by {recorded.checkedBy} — this is a platform record, not a registry confirmation.
              </p>
              {advanced ? (
                <p className="mt-1.5 text-xs text-amber-800 leading-relaxed">
                  {ladderLabel(recorded.previousState)}
                  <ArrowRight className="inline w-3 h-3 mx-1 -mt-0.5" aria-hidden />
                  <span className="font-semibold">
                    {ladderLabel(recorded.newState)} (level {recorded.newState} of 6)
                  </span>{' '}
                  — each recorded check advances one level, up to 5 (Transaction). Trusted is a long-run
                  platform distinction that checks alone never grant.
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-amber-800 leading-relaxed">
                  Level stays at {ladderLabel(recorded.newState)} ({recorded.newState} of 6) — recorded checks
                  advance one level up to 5 (Transaction). The finding is still on file.
                </p>
              )}
              {recorded.queued && (
                <p className="mt-1.5 text-xs text-amber-700">
                  Saved on-device — moves to {ladderLabel(recorded.newState)} when it syncs.
                </p>
              )}
            </div>
            <div className="rounded-lg border border-stone-200 bg-white p-3.5 min-w-0">
              <p className="text-xs font-medium text-stone-600 mb-1">Recorded finding</p>
              <p className="text-sm text-stone-700 leading-relaxed">{finding.trim()}</p>
              <p className="mt-1.5 text-xs text-stone-500">
                {CHECK_METHOD_LABELS[method as keyof typeof CHECK_METHOD_LABELS]} · {recorded.checkedBy}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="rc-method">How did you check?</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="rc-method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CHECK_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>{CHECK_METHOD_LABELS[m]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-snug text-stone-500">
                A registry lookup records what you saw when you looked — it is still not a live registry link.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rc-finding">Finding — exactly as observed *</Label>
              <Textarea
                id="rc-finding"
                value={finding}
                onChange={(e) => setFinding(e.target.value)}
                placeholder="e.g. Licence copy sighted and photographed · “licence expired — renewal pending” · reference confirmed 2 completed jobs"
                className="min-h-24"
              />
              <p className="text-[11px] leading-snug text-stone-500 flex items-start gap-1">
                <ShieldQuestion className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
                Honest findings only. An expired licence is recorded as found — the entry keeps its level and
                the finding stays on file.
              </p>
            </div>
            <p className="text-xs text-stone-500">
              Recording as <span className="font-medium text-stone-700">{actor}</span> (signed in). Currently
              level {professional.verificationState} —{' '}
              {professional.verificationState >= 5
                ? 'recorded checks no longer advance this entry'
                : `next recorded check moves it to ${ladderLabel(professional.verificationState + 1)}`}
              .
            </p>
          </div>
        )}

        <DialogFooter>
          {recorded ? (
            <Button onClick={() => onOpenChange(false)} className="bg-stone-900 text-white hover:bg-stone-800">
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button onClick={submit} disabled={busy} className="bg-amber-600 hover:bg-amber-700 text-white">
                {busy ? 'Recording…' : 'Record check'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- assign to a parcel ----------------

export function AssignDialog({
  professional,
  parcels,
  open,
  onOpenChange,
}: {
  professional: ProfessionalWithChecks
  parcels: ParcelDetail[]
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const [busy, setBusy] = useState(false)
  const [parcelId, setParcelId] = useState('')
  const [role, setRole] = useState('surveyor')
  const [note, setNote] = useState('')

  useReset(open, () => {
    setParcelId(parcels[0]?.id ?? '')
    setRole(
      (ASSIGNMENT_ROLES as readonly string[]).includes(professional.category)
        ? professional.category
        : 'surveyor',
    )
    setNote('')
  })

  async function submit() {
    if (!parcelId) { toast.error('Pick a parcel from this project'); return }
    setBusy(true)
    const parcel = parcels.find((p) => p.id === parcelId)
    const ok = await dispatch('assignment.create', {
      parcelId,
      professionalId: professional.id,
      role,
      note: note.trim() || undefined,
    }, `Assign ${professional.name} (${role}) to ${parcel?.plotNumber ?? 'parcel'}`)
    setBusy(false)
    if (ok) {
      toast.success(online
        ? `${professional.name} invited on ${parcel?.plotNumber ?? 'the parcel'} — assignment recorded`
        : `Saved on-device — queued (${outbox.length + 1})`)
      onOpenChange(false)
    } else {
      toast.error('Could not create the assignment — they may already have an open one on that parcel')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign to a parcel</DialogTitle>
          <DialogDescription>
            {professional.name} joins the parcel record with status <span className="font-medium">INVITED</span> —
            an engagement logged inside MjengoOS, not a licence claim.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="as-parcel">Parcel (this project) *</Label>
            <Select value={parcelId} onValueChange={setParcelId}>
              <SelectTrigger id="as-parcel"><SelectValue placeholder={parcels.length ? 'Choose parcel' : 'No parcels recorded'} /></SelectTrigger>
              <SelectContent>
                {parcels.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="whitespace-normal">
                    {p.plotNumber} · {p.county} · {PARCEL_STATUS_LABELS[p.status as ParcelStatus] ?? p.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="as-role">Role on the parcel *</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="as-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ASSIGNMENT_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>{ASSIGNMENT_ROLE_LABELS[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="as-note">Note (scope of work)</Label>
            <Textarea
              id="as-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Re-establish beacons once the registry review lands"
              className="min-h-16"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !parcelId} className="bg-stone-900 text-white hover:bg-stone-800 gap-1.5">
            <BadgeCheck className="w-4 h-4" aria-hidden />
            {busy ? 'Inviting…' : 'Invite on parcel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
