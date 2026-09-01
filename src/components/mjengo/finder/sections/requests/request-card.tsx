'use client'

// One purchase request card (Finder §2/§11): lines, estimated total (the same
// pure estimator the approval engine uses), status ladder, approval chain
// (role pills — PENDING/APPROVED/REJECTED with auto-approved notes shown) and
// decision buttons for the session role holding a pending approval. Wrong-role
// decision attempts are rejected server-side with a clear message — the system
// controls who approves, the UI never fakes it.

import { useSession } from 'next-auth/react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'
import { estimateRequestTotal } from '@/modules/supply/insights'
import { requiredApproverRoles } from '@/modules/supply/policy'
import type { Approval, ApprovalRule, RequestWithLines, SupplierWithCatalog } from '@/modules/supply/types'
import { ApprovalPill, RequestStatusBadge, RequestStatusLadder, fmtQty, formatKes, roleLabel } from './bits'

export function RequestCard({
  request, approvals, rules, suppliers, canManage, canDecide, onDecide, onCreateOrder,
}: {
  request: RequestWithLines
  approvals: Approval[]
  rules: ApprovalRule[]
  suppliers: SupplierWithCatalog[]
  canManage: boolean
  /** Client-role sessions decide client-band approvals too (F-PROCURE). */
  canDecide?: boolean
  onDecide: (request: RequestWithLines, decision: 'approve' | 'reject') => Promise<void>
  onCreateOrder: (request: RequestWithLines) => void
}) {
  const { dispatch, online, outbox, actionBusy } = useMjengo()
  const { data: session } = useSession()
  const busy = actionBusy !== null
  const offlineNote = `Saved on-device — queued (${outbox.length})`

  const chain = approvals.filter(
    (a) => a.entityId === request.id && ['request', 'material_request'].includes(a.entityType),
  )
  const estimate = estimateRequestTotal(
    request.lines.map((l) => ({ materialName: l.materialName, qty: l.qty })),
    suppliers,
    request.quotes.map((q) => ({ status: q.status, totalLanded: q.totalLanded })),
  )
  const sessionRole = session?.user?.role ?? null
  const decider = canDecide ?? canManage
  const mine = chain.find((a) => a.decision === 'pending' && a.approverRole === sessionRole)
  const waitingFor = chain.filter((a) => a.decision === 'pending').map((a) => roleLabel(a.approverRole))
  const requiredRoles = requiredApproverRoles(rules, estimate.total)

  async function submit() {
    const ok = await dispatch('request.submit', { id: request.id }, `Request submitted: ${request.requestCode}`)
    if (ok) {
      toast.success(online ? `${request.requestCode} submitted — the approval engine routed it` : offlineNote)
    } else {
      toast.error('Could not submit — the request may no longer be a draft')
    }
  }

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base text-stone-900">
              <span className="font-mono text-sm font-bold text-stone-800">{request.requestCode}</span>
              <RequestStatusBadge status={request.status} />
            </CardTitle>
            <CardDescription>
              By {request.requestedByName} ({roleLabel(request.requestedByRole)}) · {request.lines.length} line{request.lines.length === 1 ? '' : 's'} ·
              est. <span className="font-semibold tabular-nums text-stone-700">{formatKes(estimate.total)}</span>{' '}
              {estimate.source === 'quotes' ? '(best quote)' : '(catalog averages)'}
            </CardDescription>
          </div>
          <div className="flex flex-col items-end gap-2">
            <RequestStatusLadder status={request.status} />
            {canManage && request.status === 'draft' && (
              <Button
                size="sm"
                className="gap-1.5 bg-amber-600 text-white hover:bg-amber-700 min-h-9"
                disabled={busy}
                onClick={() => void submit()}
                aria-label={`Submit ${request.requestCode} for approval`}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
                Submit for approval
              </Button>
            )}
            {canManage && request.status === 'approved' && (
              <Button
                size="sm"
                className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 min-h-9"
                disabled={busy}
                onClick={() => onCreateOrder(request)}
                aria-label={`Create a purchase order from ${request.requestCode}`}
              >
                Create PO
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* lines — grid-cols-1 keeps the implicit track minmax(0,1fr) on mobile
            (an auto track would size to the truncated name's full text and
            blow the card past a 390px viewport) */}
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {request.lines.map((line) => (
            <li key={line.id} className="flex min-w-0 items-baseline justify-between gap-2 rounded-md bg-stone-50 px-3 py-1.5 text-sm">
              <span className="min-w-0 truncate text-stone-700">{line.materialName}</span>
              <span className="shrink-0 tabular-nums font-medium text-stone-900">
                {fmtQty(line.qty)} <span className="text-xs text-stone-500">{line.unit}</span>
              </span>
            </li>
          ))}
        </ul>
        {estimate.unpricedLines.length > 0 && (
          <p className="text-[11px] text-amber-800">
            No catalog price found for {estimate.unpricedLines.join(', ')} — the estimate excludes them; request quotes for a real figure.
          </p>
        )}
        {request.notes && <p className="text-xs italic leading-relaxed text-stone-500">{request.notes}</p>}

        {/* approval chain */}
        <div className="space-y-1.5 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
            Approval chain {requiredRoles.length > 0 && `— ${requiredRoles.map(roleLabel).join(' + ')} at ${formatKes(estimate.total)}`}
          </p>
          {chain.length === 0 ? (
            <p className="text-xs text-stone-500">
              {request.status === 'draft'
                ? 'Not submitted yet — the chain appears on submit.'
                : 'No approval rows recorded.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {chain.map((a) => (
                <li key={a.id}>
                  <ApprovalPill
                    role={a.approverRole}
                    decision={a.decision}
                    note={a.note}
                    isMine={decider && a.approverRole === sessionRole}
                    onDecide={(decision) => void onDecide(request, decision)}
                  />
                </li>
              ))}
            </ul>
          )}
          {request.status === 'submitted' && (
            <p className="text-[11px] text-stone-500">
              {mine && decider
                ? `You are signed in as ${roleLabel(sessionRole ?? '')} — this decision is yours.`
                : waitingFor.length
                  ? `Waiting for ${waitingFor.join(' and ')} approval — only that role can decide (server-enforced).`
                  : 'Awaiting a decision.'}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
