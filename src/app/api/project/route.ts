import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getProjectPayload } from '@/lib/mjengo'
import { getSessionFromReq, unauthorized } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * Owner project payload. Requires a session; a VALID ?share=<token> is also
 * accepted so share-link components that hit this route keep working with no login.
 */

/** One entry of the unified project timeline (Doc A §57). */
export interface TimelineEvent {
  id: string
  at: string // ISO timestamp of when the event happened
  source: 'audit' | 'event' | 'photo' | 'milestone' | 'order' | 'delivery' | 'invoice' | 'notification'
  kind: string
  title: string // human sentence
  projectId: string
}

function kes(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

/**
 * Unified chronological timeline (Doc A §57 "every project should have one
 * unified chronological timeline") — the last events merged from eight
 * sources, each shaped { id, at, source, kind, title, projectId }, sorted
 * descending, capped at 60. ONE prisma query per source with a take limit —
 * no N+1. Timestamp honesty:
 *   · AuditEvent / SitePhoto / Notification / PurchaseOrder → createdAt
 *     (PurchaseOrder has NO sentAt column — createdAt is when the order was
 *     placed; the status rides along in `kind`).
 *   · DomainEvent → processedAt (falls back to createdAt if not yet processed).
 *   · Milestone → releasedAt · OrderDelivery → receivedAt · Invoice → paidAt
 *     (each source only contributes rows where that timestamp exists).
 */
export async function buildTimelineSlice(projectId: string): Promise<TimelineEvent[]> {
  const [audits, events, photos, milestones, orders, deliveries, invoices, notifications] = await Promise.all([
    db.auditEvent.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: { id: true, kind: true, summary: true, createdAt: true },
    }),
    db.domainEvent.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: { id: true, type: true, processedAt: true, createdAt: true },
    }),
    db.sitePhoto.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: { id: true, progressPct: true, caption: true, createdAt: true },
    }),
    db.milestone.findMany({
      where: { projectId, releasedAt: { not: null } },
      orderBy: { releasedAt: 'desc' },
      take: 60,
      select: { id: true, name: true, status: true, amount: true, releasedAt: true },
    }),
    db.purchaseOrder.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: { id: true, orderCode: true, status: true, total: true, createdAt: true },
    }),
    db.orderDelivery.findMany({
      where: { order: { projectId }, receivedAt: { not: null } },
      orderBy: { receivedAt: 'desc' },
      take: 60,
      select: { id: true, status: true, receivedAt: true, order: { select: { orderCode: true } } },
    }),
    db.invoice.findMany({
      where: { projectId, paidAt: { not: null } },
      orderBy: { paidAt: 'desc' },
      take: 60,
      select: { id: true, invoiceCode: true, status: true, total: true, paidAt: true },
    }),
    db.notification.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: { id: true, kind: true, title: true, createdAt: true },
    }),
  ])

  const rows: TimelineEvent[] = [
    ...audits.map((a) => ({
      id: a.id, at: a.createdAt.toISOString(), source: 'audit' as const, kind: a.kind,
      title: a.summary?.trim() || `${a.kind} recorded`, projectId,
    })),
    ...events.map((e) => ({
      id: e.id, at: (e.processedAt ?? e.createdAt).toISOString(), source: 'event' as const, kind: e.type,
      title: `System processed ${e.type}`, projectId,
    })),
    ...photos.map((p) => ({
      id: p.id, at: p.createdAt.toISOString(), source: 'photo' as const, kind: 'photo',
      title: `Site photo logged${p.progressPct !== null ? ` — progress ${p.progressPct}%` : ''}${p.caption ? ` (${p.caption})` : ''}`,
      projectId,
    })),
    ...milestones.map((m) => ({
      id: m.id, at: (m.releasedAt as Date).toISOString(), source: 'milestone' as const, kind: m.status,
      title: `Milestone "${m.name}" released — ${kes(m.amount)}`, projectId,
    })),
    ...orders.map((o) => ({
      id: o.id, at: o.createdAt.toISOString(), source: 'order' as const, kind: o.status,
      title: `Purchase order ${o.orderCode} placed — ${kes(o.total)} (${o.status})`, projectId,
    })),
    ...deliveries.map((d) => ({
      id: d.id, at: (d.receivedAt as Date).toISOString(), source: 'delivery' as const, kind: d.status,
      title: `Delivery received for ${d.order.orderCode}`, projectId,
    })),
    ...invoices.map((i) => ({
      id: i.id, at: (i.paidAt as Date).toISOString(), source: 'invoice' as const, kind: i.status,
      title: `Invoice ${i.invoiceCode} paid — ${kes(i.total)}`, projectId,
    })),
    ...notifications.map((n) => ({
      id: n.id, at: n.createdAt.toISOString(), source: 'notification' as const, kind: n.kind,
      title: n.title, projectId,
    })),
  ]

  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id.localeCompare(b.id))).slice(0, 60)
}

export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromReq(req)
    if (!session) {
      const share = req.nextUrl.searchParams.get('share')
      if (!share) return unauthorized()
      const project = share
        ? await db.project.findUnique({ where: { shareToken: share } })
        : null
      if (!project) return unauthorized()
    }
    // Tenant isolation: client-role sessions are PINNED to their own project —
    // a ?projectId from the URL is ignored (mirrors /api/sync).
    const projectId =
      session?.user.role === 'client'
        ? session.user.projectId
        : req.nextUrl.searchParams.get('projectId')
    const payload = await getProjectPayload(projectId)
    if (!payload) {
      return NextResponse.json({ error: projectId ? 'Project not found' : 'No project found' }, { status: 404 })
    }
    // B4-INTEL: the §57 unified timeline rides along as an ADDITIVE key — the
    // rest of the payload is byte-identical to getProjectPayload's output.
    const timeline = await buildTimelineSlice(payload.project.id)
    return NextResponse.json({ ...payload, timeline })
  } catch (e) {
    console.error('[api/project]', e)
    return NextResponse.json({ error: 'Failed to load project' }, { status: 500 })
  }
}
