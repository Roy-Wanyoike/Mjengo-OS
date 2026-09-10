'use client'

// Finder requests section — the procurement heart: purchase
// requests & approvals (§2/§11), quotes comparison, purchase orders &
// deliveries (§12/§13). The status ladders are honest and server-enforced:
// decision buttons appear for the session role holding a PENDING approval;
// wrong-role attempts are rejected server-side with a clear message (never
// faked). Payment never happens here — that's the invoices section below.

import { useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Textarea } from '@/frontend/ui/textarea'
import { ClipboardList, Loader2, Plus, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { useFinderLink } from './requests/finder-link'
import { useT } from '@/frontend/i18n/provider'
import { CreateRequestDialog } from './requests/create-request-dialog'
import { CreateOrderDialog } from './requests/create-order-dialog'
import { OrderCard } from './requests/order-card'
import { QuotesCard } from './requests/quotes-card'
import { RequestCard } from './requests/request-card'
import { roleLabel } from './requests/bits'
import type { RequestWithLines } from '@/backend/modules/supply/types'

export function RequestsSection() {
  const { data, dispatch, viewMode, actionBusy, online, outbox, clientRole, shareToken } = useMjengo()
  const { data: session } = useSession()
  const t = useT()
  const { requestPrefill, requestDialogOpen, requestDialogNonce, openRequestDialog, clearRequestDialog } = useFinderLink()
  const [orderTarget, setOrderTarget] = useState<RequestWithLines | null>(null)
  const [decideTarget, setDecideTarget] = useState<{ request: RequestWithLines; decision: 'approve' | 'reject' } | null>(null)
  const [decideNote, setDecideNote] = useState('')
  const busy = actionBusy !== null

  const isSiteTeam = viewMode === 'owner'
  // Client-role sessions (logged in, no share link) may DECIDE the requests
  // routed to them (client band) — request.decide is in CLIENT_ACTIONS and
  // role-checked server-side. Management (submit/PO/quotes) stays site-team.
  const canDecide = isSiteTeam || (viewMode === 'client' && clientRole && !shareToken)
  const suppliers = data?.supply.suppliers ?? []
  const requests = data?.supply.requests ?? []
  const approvals = data?.supply.approvals ?? []
  const rules = data?.supply.approvalRules ?? []
  const orders = data?.supply.orders ?? []
  const sessionRole = session?.user?.role ?? null
  const offlineNote = t('finder.req.offlineQueued', { count: outbox.length })

  // Create dialog state lives in the finder-link store (search hand-off);
  // the nonce key remounts the dialog body so every open starts fresh.

  const pendingForMe = useMemo(
    () =>
      approvals.filter(
        (a) => a.decision === 'pending' && ['request', 'material_request'].includes(a.entityType) && a.approverRole === sessionRole,
      ),
    [approvals, sessionRole],
  )
  const ordersInTransit = orders.filter((o) => o.status === 'delivering')
  const discrepancies = orders.filter((o) => o.deliveries.some((d) => d.status === 'discrepancy'))

  if (!data) return null

  async function onDecide(request: RequestWithLines, decision: 'approve' | 'reject') {
    setDecideTarget({ request, decision })
    setDecideNote('')
  }

  async function confirmDecide() {
    if (!decideTarget) return
    const { request, decision } = decideTarget
    const ok = await dispatch('request.decide', {
      id: request.id, decision,
      note: decideNote.trim() || undefined,
    }, t('finder.req.decide.audit', { decision: t(decision === 'approve' ? 'finder.req.decide.approved' : 'finder.req.decide.rejected'), code: request.requestCode }))
    if (ok) {
      toast.success(online
        ? decision === 'approve'
          ? t('finder.req.toast.approved', { code: request.requestCode, note: decideNote.trim() ? t('finder.req.toast.noteRecorded') : '' })
          : t('finder.req.toast.rejected', { code: request.requestCode })
        : offlineNote)
      setDecideTarget(null)
    } else {
      // Honest failure: the server rejected the decision (wrong role / status)
      const waiting = approvals
        .filter((a) => a.entityId === request.id && a.decision === 'pending')
        .map((a) => roleLabel(t, a.approverRole))
        .join(t('finder.req.and'))
      toast.error(
        t('finder.req.toast.decideRejected', {
          waiting: waiting || t('finder.req.toast.pendingApprover'),
          code: request.requestCode,
          role: roleLabel(t, sessionRole ?? 'contractor'),
        }),
        { duration: 8000 },
      )
      setDecideTarget(null)
    }
  }

  return (
    <section aria-label={t('finder.req.aria')} className="space-y-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
              <ClipboardList className="h-5 w-5 text-amber-600" aria-hidden /> {t('finder.req.title')}
              <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{requests.length}</Badge>
            </CardTitle>
            <CardDescription>
              {t('finder.req.desc')}
            </CardDescription>
            {(pendingForMe.length > 0 || ordersInTransit.length > 0 || discrepancies.length > 0) && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {pendingForMe.length > 0 && (
                  <Badge className="border-0 gap-1 bg-amber-100 text-amber-900 hover:bg-amber-100">
                    {t(pendingForMe.length === 1 ? 'finder.req.waitingOne' : 'finder.req.waitingMany', { count: pendingForMe.length, role: roleLabel(t, sessionRole ?? '') })}
                  </Badge>
                )}
                {ordersInTransit.length > 0 && (
                  <Badge className="border-0 gap-1 bg-sky-100 text-sky-800 hover:bg-sky-100">
                    <Truck className="h-3 w-3" aria-hidden /> {t(ordersInTransit.length === 1 ? 'finder.req.transitOne' : 'finder.req.transitMany', { count: ordersInTransit.length })}
                  </Badge>
                )}
                {discrepancies.length > 0 && (
                  <Badge className="border-0 gap-1 bg-orange-100 text-orange-800 hover:bg-orange-100">
                    {t(discrepancies.length === 1 ? 'finder.req.flaggedOne' : 'finder.req.flaggedMany', { count: discrepancies.length })}
                  </Badge>
                )}
              </div>
            )}
          </div>
          {isSiteTeam && (
            <Button size="sm" className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700" onClick={() => openRequestDialog()} aria-label={t('finder.req.newAria')}>
              <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{t('finder.req.new')}</span>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {requests.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center">
              <p className="text-sm font-medium text-stone-700">{t('finder.req.emptyTitle')}</p>
              <p className="pt-1 text-xs text-stone-500">
                {t('finder.req.emptyDesc')}
              </p>
            </div>
          ) : (
            <div className="space-y-6" role="list" aria-label={t('finder.req.listAria')}>
              {requests.map((request) => (
                <div key={request.id} role="listitem" className="space-y-4">
                  <RequestCard
                    request={request}
                    approvals={approvals}
                    rules={rules}
                    suppliers={suppliers}
                    canManage={isSiteTeam}
                    canDecide={canDecide}
                    onDecide={onDecide}
                    onCreateOrder={setOrderTarget}
                  />
                  <QuotesCard request={request} suppliers={suppliers} canManage={isSiteTeam} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- purchase orders & deliveries ---- */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <Truck className="h-5 w-5 text-amber-600" aria-hidden /> {t('finder.orders.title')}
            <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{orders.length}</Badge>
          </CardTitle>
          <CardDescription>
            {t('finder.orders.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center">
              <p className="text-sm font-medium text-stone-700">{t('finder.orders.emptyTitle')}</p>
              <p className="pt-1 text-xs text-stone-500">{t('finder.orders.emptyDesc')}</p>
            </div>
          ) : (
            <div className="max-h-[40rem] space-y-4 overflow-y-auto pr-2 -mr-2" role="region" aria-label={t('finder.orders.scrollAria')}>
              {orders.map((order) => (
                <OrderCard key={order.id} order={order} canManage={isSiteTeam} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- dialogs ---- */}
      <CreateRequestDialog
        key={requestDialogNonce}
        open={requestDialogOpen}
        onOpenChange={(v) => (v ? openRequestDialog(requestPrefill ?? undefined) : clearRequestDialog())}
        prefill={requestPrefill}
        suppliers={suppliers}
      />

      <CreateOrderDialog
        request={orderTarget}
        suppliers={suppliers}
        open={Boolean(orderTarget)}
        onOpenChange={(v) => !v && setOrderTarget(null)}
      />

      <Dialog open={Boolean(decideTarget)} onOpenChange={(v) => !v && setDecideTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t(decideTarget?.decision === 'approve' ? 'finder.req.decideDialog.approve' : 'finder.req.decideDialog.reject', { code: decideTarget?.request.requestCode ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {decideTarget?.decision === 'approve'
                ? t('finder.req.decideDialog.approveDesc')
                : t('finder.req.decideDialog.rejectDesc')}
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={decideNote} onChange={(e) => setDecideNote(e.target.value)} placeholder={t('finder.req.decideDialog.notePh')} aria-label={t('finder.req.decideDialog.noteAria')} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecideTarget(null)}>{t('finder.req.decideDialog.cancel')}</Button>
            <Button
              className={`gap-1.5 text-white ${decideTarget?.decision === 'approve' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}`}
              disabled={busy}
              onClick={() => void confirmDecide()}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {t(decideTarget?.decision === 'approve' ? 'finder.req.decideDialog.approveBtn' : 'finder.req.decideDialog.rejectBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
