'use client'

// Approval rules settings card (Finder §11 — project-configurable bands):
//   < KES 10,000 supervisor · 10K–50K contractor · 50K–250K client · >250K
//   client + finance (two chained rules).
// Editable via rule.upsert / rule.delete (every change lands in the ledger);
// the bands feed the request-submit engine live.

import { useState } from 'react'
import { useSession } from 'next-auth/react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Loader2, Pencil, Plus, Settings2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ApprovalRule } from '@prisma/client'
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
  const [edit, setEdit] = useState<RuleDraft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ApprovalRule | null>(null)
  const busy = actionBusy !== null
  const rules = data?.supply.approvalRules ?? []
  const offlineNote = `Saved on-device — queued (${outbox.length})`
  const sessionRole = session?.user?.role ?? null
  const canEdit = canManage && (sessionRole === 'contractor' || sessionRole === 'admin')

  if (!data) return null

  function openNew() {
    setEdit({ id: null, minAmount: '', maxAmount: '', approverRole: 'supervisor', priority: '50', active: true })
  }

  function openEdit(rule: ApprovalRule) {
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
    }, edit.id ? 'Approval band updated' : 'Approval band added')
    if (ok) {
      toast.success(online ? 'Approval band saved — new requests route through it immediately' : offlineNote)
      setEdit(null)
    } else toast.error('Could not save the band — check the amounts (max must exceed min)')
  }

  async function remove() {
    if (!deleteTarget) return
    const ok = await dispatch('rule.delete', { id: deleteTarget.id }, 'Approval band removed')
    if (ok) {
      toast.success('Approval band removed')
      setDeleteTarget(null)
    } else toast.error('Could not remove the band')
  }

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base text-stone-900">
            <Settings2 className="h-4 w-4 text-amber-600" aria-hidden /> Approval rules (who signs off)
          </CardTitle>
          <CardDescription>
            Amount bands route every submitted request: the first band containing the estimate decides the signer;
            chained bands stack (over 250K → client + finance). Auto-approve only when the requester&apos;s own role
            is the sole signer.
          </CardDescription>
        </div>
        {canEdit && (
          <Button size="sm" variant="outline" className="min-h-11 gap-1.5" disabled={busy} onClick={openNew} aria-label="Add an approval band">
            <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Add band</span>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border border-stone-200">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">Approval bands</caption>
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                <th scope="col" className="px-3 py-2 font-medium">Amount band (KSh)</th>
                <th scope="col" className="px-2 py-2 font-medium">Signer</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Priority</th>
                <th scope="col" className="px-2 py-2 font-medium">State</th>
                {/* relative anchors the sr-only span (see results-table.tsx note) */}
                {canEdit && <th scope="col" className="relative px-3 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-stone-800">
                    {formatKes(rule.minAmount)} – {rule.maxAmount === null ? 'no ceiling' : formatKes(rule.maxAmount)}
                  </td>
                  <td className="px-2 py-2.5 text-stone-700">{roleLabel(rule.approverRole)}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-stone-500">{rule.priority}</td>
                  <td className="px-2 py-2.5">
                    {rule.active
                      ? <Badge className="border-0 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Active</Badge>
                      : <Badge className="border-0 bg-stone-100 text-stone-500 hover:bg-stone-100">Paused</Badge>}
                  </td>
                  {canEdit && (
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <span className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" className="h-8 min-h-8 w-8 p-0" disabled={busy} onClick={() => openEdit(rule)} aria-label={`Edit the ${formatKes(rule.minAmount)} band`}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 min-h-8 w-8 p-0 text-stone-400 hover:text-rose-600" disabled={busy} onClick={() => setDeleteTarget(rule)} aria-label={`Remove the ${formatKes(rule.minAmount)} band`}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
              {!rules.length && (
                <tr><td colSpan={canEdit ? 5 : 4} className="px-3 py-3 text-center text-xs text-stone-400">No bands — every request falls back to client approval</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>

      {/* edit dialog */}
      <Dialog open={Boolean(edit)} onOpenChange={(v) => !v && setEdit(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{edit?.id ? 'Edit approval band' : 'Add approval band'}</DialogTitle>
            <DialogDescription>Requests whose estimate lands in this band route to the signer.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rule-min">From (KSh)</Label>
                <Input id="rule-min" type="number" inputMode="decimal" min={0} value={edit?.minAmount ?? ''} onChange={(e) => setEdit((d) => (d ? { ...d, minAmount: e.target.value } : d))} placeholder="0" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-max">To (KSh)</Label>
                <Input id="rule-max" type="number" inputMode="decimal" min={0} value={edit?.maxAmount ?? ''} onChange={(e) => setEdit((d) => (d ? { ...d, maxAmount: e.target.value } : d))} placeholder="no ceiling" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rule-role">Signer</Label>
                <Select value={edit?.approverRole ?? 'supervisor'} onValueChange={(v) => setEdit((d) => (d ? { ...d, approverRole: v } : d))}>
                  <SelectTrigger id="rule-role"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['supervisor', 'contractor', 'client', 'finance'].map((r) => (
                      <SelectItem key={r} value={r}>{roleLabel(r)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-priority">Priority</Label>
                <Input id="rule-priority" type="number" inputMode="numeric" value={edit?.priority ?? ''} onChange={(e) => setEdit((d) => (d ? { ...d, priority: e.target.value } : d))} placeholder="50" />
              </div>
            </div>
            <label className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2.5 text-sm">
              <span>
                <span className="block font-medium text-stone-800">Active</span>
                <span className="block text-[10px] text-stone-400">Paused bands are skipped by the engine</span>
              </span>
              <Switch checked={edit?.active ?? true} onCheckedChange={(v) => setEdit((d) => (d ? { ...d, active: v } : d))} aria-label="Band active" />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button>
            <Button className="gap-1.5 bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void save()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Save band
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove this band?</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `${formatKes(deleteTarget.minAmount)} – ${deleteTarget.maxAmount === null ? 'no ceiling' : formatKes(deleteTarget.maxAmount)} signed by ${roleLabel(deleteTarget.approverRole)}`
                : ''}
              . Requests in that range fall through to the next matching band (or the client default).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Keep band</Button>
            <Button className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700" disabled={busy} onClick={() => void remove()}>
              <Trash2 className="h-4 w-4" aria-hidden /> Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
