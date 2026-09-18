'use client'

// Approval rules settings card (Finder §11 — project-configurable bands):
//   < KES 10,000 supervisor · 10K–50K contractor · 50K–250K client · >250K
//   client + finance (two chained rules).
// Editable via rule.upsert / rule.delete (every change lands in the ledger);
// the bands feed the request-submit engine live.

import { useState } from 'react'
import { useSession } from 'next-auth/react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Switch } from '@/frontend/ui/switch'
import { Loader2, Pencil, Plus, Settings2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'
import type { ApprovalRuleKes } from '@/backend/modules/supply/types'
import { formatKes, roleLabel } from './helpers'

interface RuleDraft {
  id: string | null
  minAmount: string
  maxAmount: string
  approverRole: string
  priority: string
  active: boolean
}

export function RulesCard({ canManage }: { canManage: boolean }) {
  const { data, dispatch, online, outbox, actionBusy } = useMjengo()
  const { data: session } = useSession()
  const t = useT()
  const [edit, setEdit] = useState<RuleDraft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ApprovalRuleKes | null>(null)
  const busy = actionBusy !== null
  const rules = data?.supply.approvalRules ?? []
  const offlineNote = t('field.savedQueued', { count: outbox.length })
  const sessionRole = session?.user?.role ?? null
  const canEdit = canManage && (sessionRole === 'contractor' || sessionRole === 'admin')

  if (!data) return null

  function openNew() {
    setEdit({ id: null, minAmount: '', maxAmount: '', approverRole: 'supervisor', priority: '50', active: true })
  }

  function openEdit(rule: ApprovalRuleKes) {
    setEdit({
      id: rule.id,
      minAmount: String(rule.minAmount),
      maxAmount: rule.maxAmount === null ? '' : String(rule.maxAmount),
      approverRole: rule.approverRole,
      priority: String(rule.priority),
      active: rule.active,
    })
  }

  async function save() {
    if (!edit) return
    const ok = await dispatch('rule.upsert', {
      id: edit.id ?? undefined,
      minAmount: Number(edit.minAmount) || 0,
      maxAmount: edit.maxAmount === '' ? null : Number(edit.maxAmount),
      approverRole: edit.approverRole,
      priority: Number(edit.priority) || 50,
      active: edit.active,
    }, edit.id ? t('finder.rules.audit.updated') : t('finder.rules.audit.added'))
    if (ok) {
      toast.success(online ? t('finder.rules.toast.saved') : offlineNote)
      setEdit(null)
    } else toast.error(t('finder.rules.toast.saveFailed'))
  }

  async function remove() {
    if (!deleteTarget) return
    const ok = await dispatch('rule.delete', { id: deleteTarget.id }, t('finder.rules.audit.removed'))
    if (ok) {
      toast.success(t('finder.rules.toast.removed'))
      setDeleteTarget(null)
    } else toast.error(t('finder.rules.toast.removeFailed'))
  }

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base text-stone-900">
            <Settings2 className="h-4 w-4 text-amber-600" aria-hidden /> {t('finder.rules.title')}
          </CardTitle>
          <CardDescription>
            {t('finder.rules.desc')}
          </CardDescription>
        </div>
        {canEdit && (
          <Button size="sm" variant="outline" className="min-h-11 gap-1.5" disabled={busy} onClick={openNew} aria-label={t('finder.rules.addAria')}>
            <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{t('finder.rules.add')}</span>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border border-stone-200">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">{t('finder.rules.caption')}</caption>
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                <th scope="col" className="px-3 py-2 font-medium">{t('finder.rules.col.band')}</th>
                <th scope="col" className="px-2 py-2 font-medium">{t('finder.rules.col.signer')}</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">{t('finder.rules.col.priority')}</th>
                <th scope="col" className="px-2 py-2 font-medium">{t('finder.rules.col.state')}</th>
                {/* relative anchors the sr-only span (see results-table.tsx note) */}
                {canEdit && <th scope="col" className="relative px-3 py-2 text-right font-medium"><span className="sr-only">{t('finder.rules.col.actions')}</span></th>}
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-stone-800">
                    {formatKes(rule.minAmount)} – {rule.maxAmount === null ? t('finder.rules.noCeiling') : formatKes(rule.maxAmount)}
                  </td>
                  <td className="px-2 py-2.5 text-stone-700">{roleLabel(rule.approverRole, t)}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-stone-500">{rule.priority}</td>
                  <td className="px-2 py-2.5">
                    {rule.active
                      ? <Badge className="border-0 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">{t('finder.rules.active')}</Badge>
                      : <Badge className="border-0 bg-stone-100 text-stone-500 hover:bg-stone-100">{t('finder.rules.paused')}</Badge>}
                  </td>
                  {canEdit && (
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <span className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" className="h-8 min-h-8 w-8 p-0" disabled={busy} onClick={() => openEdit(rule)} aria-label={t('finder.rules.editAria', { band: formatKes(rule.minAmount) })}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 min-h-8 w-8 p-0 text-stone-400 hover:text-rose-600" disabled={busy} onClick={() => setDeleteTarget(rule)} aria-label={t('finder.rules.removeAria', { band: formatKes(rule.minAmount) })}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
              {!rules.length && (
                <tr><td colSpan={canEdit ? 5 : 4} className="px-3 py-3 text-center text-xs text-stone-400">{t('finder.rules.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>

      {/* edit dialog */}
      <Dialog open={Boolean(edit)} onOpenChange={(v) => !v && setEdit(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{edit?.id ? t('finder.rules.editTitle') : t('finder.rules.addTitle')}</DialogTitle>
            <DialogDescription>{t('finder.rules.editDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rule-min">{t('finder.rules.from')}</Label>
                <Input id="rule-min" type="number" inputMode="decimal" min={0} value={edit?.minAmount ?? ''} onChange={(e) => setEdit((d) => (d ? { ...d, minAmount: e.target.value } : d))} placeholder="0" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-max">{t('finder.rules.to')}</Label>
                <Input id="rule-max" type="number" inputMode="decimal" min={0} value={edit?.maxAmount ?? ''} onChange={(e) => setEdit((d) => (d ? { ...d, maxAmount: e.target.value } : d))} placeholder={t('finder.rules.noCeiling')} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rule-role">{t('finder.rules.signer')}</Label>
                <Select value={edit?.approverRole ?? 'supervisor'} onValueChange={(v) => setEdit((d) => (d ? { ...d, approverRole: v } : d))}>
                  <SelectTrigger id="rule-role"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['supervisor', 'contractor', 'client', 'finance'].map((r) => (
                      <SelectItem key={r} value={r}>{roleLabel(r, t)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-priority">{t('finder.rules.priority')}</Label>
                <Input id="rule-priority" type="number" inputMode="numeric" value={edit?.priority ?? ''} onChange={(e) => setEdit((d) => (d ? { ...d, priority: e.target.value } : d))} placeholder="50" />
              </div>
            </div>
            <label className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2.5 text-sm">
              <span>
                <span className="block font-medium text-stone-800">{t('finder.rules.activeLabel')}</span>
                <span className="block text-[10px] text-stone-400">{t('finder.rules.activeHint')}</span>
              </span>
              <Switch checked={edit?.active ?? true} onCheckedChange={(v) => setEdit((d) => (d ? { ...d, active: v } : d))} aria-label={t('finder.rules.activeAria')} />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>{t('dialog.expense.cancel')}</Button>
            <Button className="gap-1.5 bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void save()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} {t('finder.rules.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('finder.rules.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? t('finder.rules.deleteDesc', { range: `${formatKes(deleteTarget.minAmount)} – ${deleteTarget.maxAmount === null ? t('finder.rules.noCeiling') : formatKes(deleteTarget.maxAmount)}`, signer: roleLabel(deleteTarget.approverRole, t) })
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('finder.rules.keep')}</Button>
            <Button className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700" disabled={busy} onClick={() => void remove()}>
              <Trash2 className="h-4 w-4" aria-hidden /> {t('finder.rules.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
