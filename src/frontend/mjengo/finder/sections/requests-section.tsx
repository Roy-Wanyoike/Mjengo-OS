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
  const offlineNote = `Saved on-device — queued (${outbox.length})`

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
    }, `Request ${decision === 'approve' ? 'approved' : 'rejected'}: ${request.requestCode}`)
    if (ok) {
      toast.success(online
        ? decision === 'approve'
          ? `${request.requestCode} approved${decideNote.trim() ? ' — note recorded' : ''}`
          : `${request.requestCode} rejected — the requester can re-draft a new request`
        : offlineNote)
      setDecideTarget(null)
    } else {
      // Honest failure: the server rejected the decision (wrong role / status)
      const waiting = approvals
        .filter((a) => a.entityId === request.id && a.decision === 'pending')
        .map((a) => roleLabel(a.approverRole))
        .join(' and ')
      toast.error(
        `Decision NOT recorded — the server rejected it. Only ${waiting || 'the pending approver role'} may decide ${request.requestCode}; you are signed in as ${roleLabel(sessionRole ?? 'contractor')}.`,
        { duration: 8000 },
      )
      setDecideTarget(null)
    }
  }

  return (
    <section aria-label="Purchase requests, approvals, orders and delivery" className="space-y-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
              <ClipboardList className="h-5 w-5 text-amber-600" aria-hidden /> Purchase requests &amp; approvals
              <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{requests.length}</Badge>
            </CardTitle>
            <CardDescription>
              Request → approval rules → purchase order → delivery with ground-truth verification. Anyone authorized
              can request — the system controls who approves.
            </CardDescription>
            {(pendingForMe.length > 0 || ordersInTransit.length > 0 || discrepancies.length > 0) && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {pendingForMe.length > 0 && (
                  <Badge className="border-0 gap-1 bg-amber-100 text-amber-900 hover:bg-amber-100">
                    {pendingForMe.length} decision{pendingForMe.length === 1 ? '' : 's'} waiting for you ({roleLabel(sessionRole ?? '')})
                  </Badge>
                )}
                {ordersInTransit.length > 0 && (
                  <Badge className="border-0 gap-1 bg-sky-100 text-sky-800 hover:bg-sky-100">
                    <Truck className="h-3 w-3" aria-hidden /> {ordersInTransit.length} order{ordersInTransit.length === 1 ? '' : 's'} in transit
                  </Badge>
                )}
                {discrepancies.length > 0 && (
                  <Badge className="border-0 gap-1 bg-orange-100 text-orange-800 hover:bg-orange-100">
                    {discrepancies.length} deliver{discrepancies.length === 1 ? 'y' : 'ies'} flagged for review
                  </Badge>
                )}
              </div>
            )}
          </div>
          {isSiteTeam && (
            <Button size="sm" className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700" onClick={() => openRequestDialog()} aria-label="Create a new purchase request">
              <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">New request</span>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {requests.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center">
              <p className="text-sm font-medium text-stone-700">No purchase requests yet</p>
              <p className="pt-1 text-xs text-stone-500">
                Start from the search above — &quot;Order&quot; on any supplier row prefills a request.
              </p>
            </div>
          ) : (
            <div className="space-y-6" role="list" aria-label="Purchase requests">
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
            <Truck className="h-5 w-5 text-amber-600" aria-hidden /> Purchase orders &amp; deliveries
            <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{orders.length}</Badge>
          </CardTitle>
          <CardDescription>
            Approved request + supplier → PO-2026-000NNN → send → confirm → dispatch → receive on the ground.
            Short counts are flagged for review; invoices and payment live in the section below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center">
              <p className="text-sm font-medium text-stone-700">No purchase orders yet</p>
              <p className="pt-1 text-xs text-stone-500">Approve a request, then “Create PO” on it.</p>
            </div>
          ) : (
            <div className="max-h-[40rem] space-y-4 overflow-y-auto pr-2 -mr-2" role="region" aria-label="Purchase orders, scrollable">
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
              {decideTarget?.decision === 'approve' ? 'Approve' : 'Reject'} {decideTarget?.request.requestCode}
            </DialogTitle>
            <DialogDescription>
              {decideTarget?.decision === 'approve'
                ? 'Approval lets purchase orders be created against this request — no money moves yet.'
                : 'A rejection is final for this request; the requester can draft a fresh one.'}
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={decideNote} onChange={(e) => setDecideNote(e.target.value)} placeholder="Optional note — lands in the decision trail" aria-label="Decision note" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecideTarget(null)}>Cancel</Button>
            <Button
              className={`gap-1.5 text-white ${decideTarget?.decision === 'approve' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}`}
              disabled={busy}
              onClick={() => void confirmDecide()}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {decideTarget?.decision === 'approve' ? 'Approve request' : 'Reject request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
