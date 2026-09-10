'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Button } from '@/frontend/ui/button'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Switch } from '@/frontend/ui/switch'
import { HardHat, KeyRound, Loader2, Phone, User } from 'lucide-react'
import { toast } from 'sonner'
import { formatKES } from '@/frontend/lib/format'
import { useT } from '@/frontend/i18n/provider'

export const WORKER_ROLES = [
  'Foreman',
  'Fundi wa Mawe (Mason)',
  'Fundi wa Mbao (Carpenter)',
  'Fundi wa Umeme (Electrician)',
  'Fundi wa Maji (Plumber)',
  'Msimamizi (Supervisor)',
  'Mtumishi (Labourer)',
] as const

// WORKER_ROLES are DATA (persisted role strings on worker rows) — they stay
// as-is in every locale; only the surrounding chrome translates.

export interface AddWorkerPayload {
  name: string
  role: string
  phone: string
  dailyRate: number
  pin?: string
}

export interface EditWorkerPayload extends AddWorkerPayload {
  active: boolean
}

export interface EditWorkerData {
  id: string
  name: string
  role: string
  phone: string
  dailyRate: number
  active: boolean
  hasPin?: boolean // masked prefill: existing PIN is never sent back to the client
}

export interface AddWorkerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (payload: AddWorkerPayload) => Promise<boolean>
  submitting: boolean
}

export interface EditWorkerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (payload: EditWorkerPayload) => Promise<boolean>
  submitting: boolean
  worker?: EditWorkerData | null
}

interface FormState {
  name: string
  role: string
  phone: string
  dailyRate: string
  pin: string
  active: boolean
}

const emptyForm: FormState = { name: '', role: 'Mtumishi (Labourer)', phone: '', dailyRate: '800', pin: '', active: true }

function WorkerFormFields({
  form,
  setForm,
  nameError,
  rateError,
  pinError,
  hasPin = false,
}: {
  form: FormState
  setForm: (patch: Partial<FormState>) => void
  nameError: string | null
  rateError: string | null
  pinError: string | null
  hasPin?: boolean
}) {
  const t = useT()
  const rateNum = Number(form.dailyRate)
  return (
    <div className="grid gap-4 py-1">
      <div className="space-y-2">
        <Label htmlFor="wk-name">{t('dialog.worker.name')}</Label>
        <div className="relative">
          <User className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
          <Input
            id="wk-name"
            value={form.name}
            onChange={(e) => setForm({ name: e.target.value })}
            placeholder={t('dialog.worker.namePh')}
            className="pl-9"
            aria-invalid={Boolean(nameError)}
            aria-describedby={nameError ? 'wk-name-error' : undefined}
          />
        </div>
        {nameError && <p id="wk-name-error" role="alert" className="text-xs text-red-600">{nameError}</p>}
      </div>

      <div className="space-y-2">
        <Label>{t('dialog.worker.role')}</Label>
        <Select value={form.role} onValueChange={(role) => setForm({ role })}>
          <SelectTrigger aria-label={t('dialog.worker.roleAria')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORKER_ROLES.map((r) => (
              <SelectItem key={r} value={r}>{r}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="wk-phone">{t('dialog.worker.phone')}</Label>
          <div className="relative">
            <Phone className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
            <Input
              id="wk-phone"
              type="tel"
              value={form.phone}
              onChange={(e) => setForm({ phone: e.target.value })}
              placeholder="+254 7XX XXX XXX"
              className="pl-9"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="wk-rate">{t('dialog.worker.rate')}</Label>
          <Input
            id="wk-rate"
            type="number"
            min="1"
            inputMode="numeric"
            value={form.dailyRate}
            onChange={(e) => setForm({ dailyRate: e.target.value })}
            aria-invalid={Boolean(rateError)}
            aria-describedby={rateError ? 'wk-rate-error' : undefined}
          />
        </div>
      </div>
      <div className="flex items-center justify-between text-xs -mt-2">
        <span className={form.dailyRate && !Number.isNaN(rateNum) && rateNum > 0 ? 'text-stone-600 font-medium' : 'text-stone-400'}>
          {form.dailyRate && !Number.isNaN(rateNum) && rateNum > 0 ? t('dialog.worker.ratePerDay', { amount: formatKES(rateNum) }) : t('dialog.worker.ratePreview')}
        </span>
        {rateError && <span id="wk-rate-error" role="alert" className="text-red-600">{rateError}</span>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="wk-pin">{t('dialog.worker.pin')}</Label>
        <div className="relative">
          <KeyRound className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
          <Input
            id="wk-pin"
            inputMode="numeric"
            maxLength={4}
            value={form.pin}
            onChange={(e) => setForm({ pin: e.target.value.replace(/\D/g, '').slice(0, 4) })}
            placeholder={hasPin ? '\u2022\u2022\u2022\u2022' : t('dialog.worker.pinPhNew')}
            className="pl-9 tracking-[0.4em] font-mono"
            autoComplete="off"
            aria-invalid={Boolean(pinError)}
            aria-describedby={`wk-pin-help${pinError ? ' wk-pin-error' : ''}`}
          />
        </div>
        <p id="wk-pin-help" className="text-xs text-stone-500">
          {hasPin ? t('dialog.worker.pinHelpSet') : t('dialog.worker.pinHelp')}
        </p>
        {pinError && <p id="wk-pin-error" role="alert" className="text-xs text-red-600">{pinError}</p>}
      </div>
    </div>
  )
}

function validate(form: FormState, t: (key: string) => string): { name: string | null; rate: string | null; pin: string | null } {
  return {
    name: form.name.trim() ? null : t('dialog.worker.error.name'),
    rate: form.dailyRate && !Number.isNaN(Number(form.dailyRate)) && Number(form.dailyRate) > 0 ? null : t('dialog.worker.error.rate'),
    pin: form.pin === '' || /^\d{4}$/.test(form.pin) ? null : t('dialog.worker.error.pin'),
  }
}

export function AddWorkerDialog({ open, onOpenChange, onSubmit, submitting }: AddWorkerDialogProps) {
  const t = useT()
  const [form, setFormState] = useState<FormState>(emptyForm)
  const [errors, setErrors] = useState<{ name: string | null; rate: string | null; pin: string | null }>({ name: null, rate: null, pin: null })

  // Reset to defaults each time the dialog opens (adjust-state-during-render pattern)
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setFormState({ ...emptyForm })
      setErrors({ name: null, rate: null, pin: null })
    }
  }

  const setForm = (patch: Partial<FormState>) => setFormState((f) => ({ ...f, ...patch }))

  async function handleSubmit() {
    const e = validate(form, t)
    setErrors(e)
    if (e.name || e.rate || e.pin) return
    const ok = await onSubmit({
      name: form.name.trim(),
      role: form.role,
      phone: form.phone.trim(),
      dailyRate: Math.round(Number(form.dailyRate)),
      pin: form.pin,
    })
    if (ok) {
      toast.success(t('dialog.worker.toast.addOk', { name: form.name.trim().split(' ')[0] }))
      onOpenChange(false)
    } else {
      toast.error(t('dialog.worker.toast.addFailed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-stone-900">{t('dialog.worker.addTitle')}</DialogTitle>
          <DialogDescription>{t('dialog.worker.addDesc')}</DialogDescription>
        </DialogHeader>

        <WorkerFormFields form={form} setForm={setForm} nameError={errors.name} rateError={errors.rate} pinError={errors.pin} />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>{t('dialog.worker.cancel')}</Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting} className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white min-w-32">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <HardHat className="w-4 h-4" aria-hidden />}
            {submitting ? t('dialog.worker.adding') : t('dialog.worker.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function EditWorkerDialog({ open, onOpenChange, onSubmit, submitting, worker }: EditWorkerDialogProps) {
  const t = useT()
  const [form, setFormState] = useState<FormState>(emptyForm)
  const [errors, setErrors] = useState<{ name: string | null; rate: string | null; pin: string | null }>({ name: null, rate: null, pin: null })

  // Prefill whenever the dialog opens or the target worker changes
  const [prefillKey, setPrefillKey] = useState('')
  const key = `${open}:${worker?.id ?? ''}`
  if (key !== prefillKey) {
    setPrefillKey(key)
    if (open && worker) {
      setFormState({
        name: worker.name,
        role: worker.role || 'Mtumishi (Labourer)',
        phone: worker.phone || '',
        dailyRate: String(worker.dailyRate ?? 800),
        pin: '',
        active: worker.active,
      })
      setErrors({ name: null, rate: null, pin: null })
    }
  }

  const setForm = (patch: Partial<FormState>) => setFormState((f) => ({ ...f, ...patch }))

  async function handleSubmit() {
    if (!worker) return
    const e = validate(form, t)
    setErrors(e)
    if (e.name || e.rate || e.pin) return
    const ok = await onSubmit({
      name: form.name.trim(),
      role: form.role,
      phone: form.phone.trim(),
      dailyRate: Math.round(Number(form.dailyRate)),
      pin: form.pin, // '' clears the PIN server-side (/^\d{4}$/ or null)
      active: form.active,
    })
    if (ok) {
      toast.success(t('dialog.worker.toast.editOk'))
      onOpenChange(false)
    } else {
      toast.error(t('dialog.worker.toast.editFailed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-stone-900">{t('dialog.worker.editTitle')}</DialogTitle>
          <DialogDescription>{t('dialog.worker.editDesc')}</DialogDescription>
        </DialogHeader>

        {worker && (
          <>
            <WorkerFormFields form={form} setForm={setForm} nameError={errors.name} rateError={errors.rate} pinError={errors.pin} hasPin={Boolean(worker.hasPin)} />

            <div className="flex items-center justify-between gap-4 rounded-xl border border-stone-200 bg-stone-50 p-3.5">
              <div className="min-w-0">
                <Label htmlFor="wk-active" className="text-sm font-medium text-stone-800">{t('dialog.worker.active')}</Label>
                <p className="text-xs text-stone-500 mt-0.5">{t('dialog.worker.activeHint')}</p>
              </div>
              <Switch
                id="wk-active"
                checked={form.active}
                onCheckedChange={(active) => setForm({ active })}
                aria-label={t('dialog.worker.activeAria')}
                className="data-[state=checked]:bg-amber-500"
              />
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>{t('dialog.worker.cancel')}</Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting} className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white min-w-32">
            {submitting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
            {submitting ? t('dialog.worker.saving') : t('dialog.worker.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
