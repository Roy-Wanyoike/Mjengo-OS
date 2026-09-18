'use client'

// Professionals — mutation dialogs (contractor/admin surface; the client view
// never renders these). Every write goes through the registered
// PROFESSIONALS_ACTIONS via the store's dispatch() so it is offline-queued +
// audited by the Bias-Free Ledger.
//
// All copy flows through useT() (land.pros.dlg.* — issue #125); enum labels
// reuse the land.proCategory / land.checkMethod / land.licenceBody /
// land.assignRole / land.parcelStatus / land.ladder families.

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { useT } from '@/frontend/i18n/provider'
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
  CHECK_METHODS,
  LICENCE_BODIES,
  PROFESSIONAL_CATEGORIES,
  ASSIGNMENT_ROLES,
  type ProfessionalWithChecks,
} from '@/backend/modules/professionals/types'
import type { ParcelDetail } from '@/backend/modules/land/types'
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

export function AddProfessionalDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const t = useT()
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
    if (!name.trim()) { toast.error(t('land.pros.dlg.add.toast.nameRequired')); return }
    if (!category) { toast.error(t('land.pros.dlg.add.toast.categoryRequired')); return }
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
    }, t('land.pros.dlg.add.audit', { name: name.trim() }))
    setBusy(false)
    if (ok) {
      toast.success(online
        ? t('land.pros.dlg.add.toast.added', { name: name.trim() })
        : t('field.savedQueued', { count: outbox.length + 1 }))
      onOpenChange(false)
    } else {
      toast.error(t('land.pros.dlg.add.toast.addFailed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('land.pros.dlg.add.title')}</DialogTitle>
          <DialogDescription>
            {t('land.pros.dlg.add.descA')}<span className="font-medium">{t('land.pros.dlg.add.unverified')}</span>{t('land.pros.dlg.add.descB')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="ap-name">{t('land.pros.dlg.add.name')}</Label>
            <Input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('land.pros.dlg.add.namePh')} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ap-category">{t('land.pros.dlg.add.category')}</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="ap-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROFESSIONAL_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{t(`land.proCategory.${c}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-snug text-stone-500">{t(`land.pros.dlg.bodyHint.${category}`)}</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ap-county">{t('land.pros.dlg.add.county')}</Label>
              <Input id="ap-county" value={county} onChange={(e) => setCounty(e.target.value)} placeholder={t('land.pros.dlg.add.countyPh')} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ap-org">{t('land.pros.dlg.add.org')}</Label>
            <Input id="ap-org" value={organisation} onChange={(e) => setOrganisation(e.target.value)} placeholder={t('land.pros.dlg.add.orgPh')} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ap-phone">{t('land.pros.dlg.add.phone')}</Label>
              <Input id="ap-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t('land.pros.dlg.add.phonePh')} inputMode="tel" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ap-email">{t('land.pros.dlg.add.email')}</Label>
              <Input id="ap-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('land.pros.dlg.add.emailPh')} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ap-licence">{t('land.pros.dlg.add.licence')}</Label>
              <Input id="ap-licence" value={licenceNumber} onChange={(e) => setLicenceNumber(e.target.value)} placeholder={t('land.pros.dlg.add.licencePh')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ap-body">{t('land.pros.dlg.add.body')}</Label>
              <Select value={licenceBody} onValueChange={setLicenceBody}>
                <SelectTrigger id="ap-body"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LICENCE_BODIES.map((b) => (
                    <SelectItem key={b} value={b}>{t(`land.licenceBody.${b}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ap-notes">{t('land.pros.dlg.add.notes')}</Label>
            <Textarea id="ap-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('land.pros.dlg.add.notesPh')} className="min-h-16" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('land.dlg.cancel')}</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? t('land.pros.dlg.add.adding') : t('land.pros.dlg.add.add')}
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
  const t = useT()
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
    if (!finding.trim()) { toast.error(t('land.pros.dlg.check.toast.findingRequired')); return }
    setBusy(true)
    const ok = await dispatch('credential.record', {
      professionalId: professional.id,
      method,
      finding: finding.trim(),
      checkedBy: actor,
    }, t('land.pros.dlg.check.audit', { method: t(`land.checkMethod.${method}`), name: professional.name }))
    setBusy(false)
    if (!ok) {
      toast.error(t('land.pros.dlg.check.toast.failed'))
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
    toast.success(online ? t('land.pros.dlg.check.toast.recorded') : t('field.savedQueued', { count: outbox.length + 1 }))
  }

  const advanced = recorded && recorded.newState > recorded.previousState

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('land.pros.dlg.check.title')}</DialogTitle>
          <DialogDescription>
            {professional.name}
            {professional.organisation ? ` · ${professional.organisation}` : ''} — {t('land.pros.dlg.check.desc')}
          </DialogDescription>
        </DialogHeader>

        {recorded ? (
          <div className="grid gap-3 py-1" role="status">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3.5 min-w-0">
              <p className="text-sm font-semibold text-amber-900 leading-snug">
                {t('land.pros.dlg.check.echoTitle', { by: recorded.checkedBy })}
              </p>
              {advanced ? (
                <p className="mt-1.5 text-xs text-amber-800 leading-relaxed">
                  {t(`land.ladder.${recorded.previousState}.label`)}
                  <ArrowRight className="inline w-3 h-3 mx-1 -mt-0.5" aria-hidden />
                  <span className="font-semibold">
                    {t('land.pros.dlg.check.ladderOf', { label: t(`land.ladder.${recorded.newState}.label`), n: recorded.newState })}
                  </span>{' '}
                  {t('land.pros.dlg.check.advanceNote')}
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-amber-800 leading-relaxed">
                  {t('land.pros.dlg.check.staysNote', { label: t(`land.ladder.${recorded.newState}.label`), n: recorded.newState })}
                </p>
              )}
              {recorded.queued && (
                <p className="mt-1.5 text-xs text-amber-700">
                  {t('land.pros.dlg.check.queuedNote', { label: t(`land.ladder.${recorded.newState}.label`) })}
                </p>
              )}
            </div>
            <div className="rounded-lg border border-stone-200 bg-white p-3.5 min-w-0">
              <p className="text-xs font-medium text-stone-600 mb-1">{t('land.pros.dlg.check.recordedFinding')}</p>
              <p className="text-sm text-stone-700 leading-relaxed">{finding.trim()}</p>
              <p className="mt-1.5 text-xs text-stone-500">
                {t(`land.checkMethod.${method}`)} · {recorded.checkedBy}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="rc-method">{t('land.pros.dlg.check.method')}</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="rc-method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CHECK_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>{t(`land.checkMethod.${m}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-snug text-stone-500">
                {t('land.pros.dlg.check.methodNote')}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rc-finding">{t('land.pros.dlg.check.finding')}</Label>
              <Textarea
                id="rc-finding"
                value={finding}
                onChange={(e) => setFinding(e.target.value)}
                placeholder={t('land.pros.dlg.check.findingPh')}
                className="min-h-24"
              />
              <p className="text-[11px] leading-snug text-stone-500 flex items-start gap-1">
                <ShieldQuestion className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
                {t('land.pros.dlg.check.findingNote')}
              </p>
            </div>
            <p className="text-xs text-stone-500">
              {professional.verificationState >= 5
                ? t('land.pros.dlg.check.asActorMax', { actor, n: professional.verificationState })
                : t('land.pros.dlg.check.asActorNext', {
                  actor,
                  n: professional.verificationState,
                  label: t(`land.ladder.${professional.verificationState + 1}.label`),
                })}
            </p>
          </div>
        )}

        <DialogFooter>
          {recorded ? (
            <Button onClick={() => onOpenChange(false)} className="bg-stone-900 text-white hover:bg-stone-800">
              {t('land.pros.dlg.check.done')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{t('land.dlg.cancel')}</Button>
              <Button onClick={submit} disabled={busy} className="bg-amber-600 hover:bg-amber-700 text-white">
                {busy ? t('land.pros.dlg.check.recording') : t('land.pros.dlg.check.record')}
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
  const t = useT()
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
    if (!parcelId) { toast.error(t('land.pros.dlg.assign.toast.parcelRequired')); return }
    setBusy(true)
    const parcel = parcels.find((p) => p.id === parcelId)
    const plot = parcel?.plotNumber ?? t('land.pros.dlg.assign.parcelFallback')
    const ok = await dispatch('assignment.create', {
      parcelId,
      professionalId: professional.id,
      role,
      note: note.trim() || undefined,
    }, t('land.pros.dlg.assign.audit', { name: professional.name, role: t(`land.assignRole.${role}`), plot }))
    setBusy(false)
    if (ok) {
      toast.success(online
        ? t('land.pros.dlg.assign.toast.invited', { name: professional.name, plot })
        : t('field.savedQueued', { count: outbox.length + 1 }))
      onOpenChange(false)
    } else {
      toast.error(t('land.pros.dlg.assign.toast.failed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('land.pros.dlg.assign.title')}</DialogTitle>
          <DialogDescription>
            {professional.name} {t('land.pros.dlg.assign.descA')}<span className="font-medium">{t('land.pros.dlg.assign.invited')}</span>{t('land.pros.dlg.assign.descB')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="as-parcel">{t('land.pros.dlg.assign.parcel')}</Label>
            <Select value={parcelId} onValueChange={setParcelId}>
              <SelectTrigger id="as-parcel"><SelectValue placeholder={parcels.length ? t('land.pros.dlg.assign.chooseParcel') : t('land.pros.dlg.assign.noParcels')} /></SelectTrigger>
              <SelectContent>
                {parcels.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="whitespace-normal">
                    {p.plotNumber} · {p.county} · {t(`land.parcelStatus.${p.status}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="as-role">{t('land.pros.dlg.assign.role')}</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="as-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ASSIGNMENT_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>{t(`land.assignRole.${r}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="as-note">{t('land.pros.dlg.assign.note')}</Label>
            <Textarea
              id="as-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('land.pros.dlg.assign.notePh')}
              className="min-h-16"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{t('land.dlg.cancel')}</Button>
          <Button onClick={submit} disabled={busy || !parcelId} className="bg-stone-900 text-white hover:bg-stone-800 gap-1.5">
            <BadgeCheck className="w-4 h-4" aria-hidden />
            {busy ? t('land.pros.dlg.assign.inviting') : t('land.pros.dlg.assign.invite')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
