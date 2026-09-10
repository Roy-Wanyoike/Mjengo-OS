'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Button } from '@/frontend/ui/button'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Banknote, CreditCard, Loader2, ReceiptText, Smartphone, Truck, User, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { formatKES } from '@/frontend/lib/format'
import { useT } from '@/frontend/i18n/provider'

export interface ExpenseDialogPayload {
  type: string
  amount: number
  method: string
  note?: string
  date?: string
}

export interface ExpenseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (payload: ExpenseDialogPayload) => Promise<boolean>
  submitting: boolean
}

// i18n (issue #107): `label` carries a DICT KEY rendered via t(); the value
// strings are server data and never change.
const TYPE_OPTIONS: Array<{ value: string; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { value: 'material', label: 'dialog.expense.type.material', icon: Wrench },
  { value: 'wage', label: 'dialog.expense.type.wage', icon: User },
  { value: 'transport', label: 'dialog.expense.type.transport', icon: Truck },
  { value: 'other', label: 'dialog.expense.type.other', icon: ReceiptText },
]

const METHOD_OPTIONS: Array<{ value: string; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { value: 'mpesa', label: 'dialog.expense.method.mpesa', icon: Smartphone },
  { value: 'cash', label: 'dialog.expense.method.cash', icon: Banknote },
  { value: 'bank', label: 'dialog.expense.method.bank', icon: CreditCard },
]

const dateInputClass =
  'flex h-9 w-full rounded-md border border-stone-200 bg-white px-3 py-1 text-sm text-stone-900 shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500'

function localToday(): string {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export function ExpenseDialog({ open, onOpenChange, onSubmit, submitting }: ExpenseDialogProps) {
  const t = useT()
  const [type, setType] = useState('material')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('mpesa')
  const [note, setNote] = useState('')
  const [date, setDate] = useState('')
  const [amountError, setAmountError] = useState<string | null>(null)

  // Reset to defaults each time the dialog opens (adjust-state-during-render pattern)
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setType('material')
      setAmount('')
      setMethod('mpesa')
      setNote('')
      setDate(localToday())
      setAmountError(null)
    }
  }

  const amountNum = Number(amount)

  async function handleSubmit() {
    if (!amount || Number.isNaN(amountNum) || amountNum <= 0) {
      setAmountError(t('dialog.expense.error.amount'))
      return
    }
    setAmountError(null)
    const ok = await onSubmit({
      type,
      amount: Math.round(amountNum),
      method,
      note: note.trim() || undefined,
      date: date || undefined,
    })
    if (ok) {
      toast.success(t('dialog.expense.toastOk', {
        amount: formatKES(Math.round(amountNum)),
        method: t(METHOD_OPTIONS.find((m) => m.value === method)?.label ?? 'dialog.expense.method.mpesa'),
      }))
      onOpenChange(false)
    } else {
      toast.error(t('dialog.expense.toastFailed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-stone-900">{t('dialog.expense.title')}</DialogTitle>
          <DialogDescription>{t('dialog.expense.desc')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="space-y-2">
            <Label>{t('dialog.expense.type')}</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger aria-label={t('dialog.expense.typeAria')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map(({ value, label, icon: Icon }) => (
                  <SelectItem key={value} value={value}>
                    <span className="flex items-center gap-2">
                      <Icon className="w-4 h-4 text-stone-400" aria-hidden /> {t(label)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="exp-amount">{t('dialog.expense.amount')}</Label>
            <Input
              id="exp-amount"
              type="number"
              min="1"
              inputMode="numeric"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value)
                if (amountError) setAmountError(null)
              }}
              placeholder={t('dialog.expense.amountPh')}
              aria-invalid={Boolean(amountError)}
              aria-describedby={amountError ? 'exp-amount-error' : undefined}
            />
            <div className="flex items-center justify-between text-xs">
              <span className={amount && !Number.isNaN(amountNum) && amountNum > 0 ? 'text-stone-600 font-medium' : 'text-stone-400'}>
                {amount && !Number.isNaN(amountNum) && amountNum > 0 ? formatKES(amountNum) : t('dialog.expense.preview')}
              </span>
              {/* FE-3 (issue #108): the validation error is announced — id linked
                  via aria-describedby on the input above, role="alert" for live
                  region semantics. */}
              {amountError && <span id="exp-amount-error" role="alert" className="text-red-600">{amountError}</span>}
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('dialog.expense.method')}</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger aria-label={t('dialog.expense.methodAria')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHOD_OPTIONS.map(({ value, label, icon: Icon }) => (
                  <SelectItem key={value} value={value}>
                    <span className="flex items-center gap-2">
                      <Icon className="w-4 h-4 text-stone-400" aria-hidden /> {t(label)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="exp-note">{t('dialog.expense.note')}</Label>
            <Input id="exp-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('dialog.expense.notePh')} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="exp-date">{t('dialog.expense.date')}</Label>
            <input id="exp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={dateInputClass} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>{t('dialog.expense.cancel')}</Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting} className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white min-w-32">
            {submitting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
            {submitting ? t('dialog.expense.saving') : t('dialog.expense.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
