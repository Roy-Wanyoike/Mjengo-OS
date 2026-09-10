import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { getProjectPayload } from '@/backend/lib/mjengo'
import { publicRoute, genericError } from '@/backend/lib/route-kit'
import { unauthorized, forbidden } from '@/backend/lib/guard'

// Owner project payload — src/app/api/project/route.ts is the shim.
// Requires a session; a VALID ?share=<token> is also accepted so share-link
// components that hit this route keep working with no login.

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

export const GET = publicRoute(
  {
    scope: 'api/project',
    // Rate limit (S-SEC): the ?share= path is an UNAUTHENTICATED token oracle
    // (the token is the auth) — throttled per principal like /api/share so
    // scripted token brute-forcing cannot run at full speed on this route either.
    rateLimit: { bucket: 'project.get', limit: 60, windowMs: 60_000 },
    onError: genericError(500, 'Failed to load project'),
  },
  async (req: NextRequest, session) => {
    // W5-3: supplier sessions never read the buyer project payload — their
    // surface is GET /api/supplier (scoped to their own rows). Fail closed
    // BEFORE the share-token path too: a supplier session is signed in and
    // gets the honest 403, not a share-link client view.
    if (session && session.user.role === 'supplier') return forbidden(session.user.role)
    // BE-1 (audit 2026-09-10, issue #102): a share token is a bearer
    // capability bound to exactly ONE project. The project it resolves is
    // the ONLY project this route may answer for on the public path — a
    // ?projectId query can never redirect it, and the token's project never
    // falls back to "first project in the DB" (the cross-project read +
    // shareToken-harvesting hole this closes).
    let shareProject: { id: string; shareToken: string } | null = null
    if (!session) {
      const share = req.nextUrl.searchParams.get('share')
      if (!share) return unauthorized()
      shareProject = await db.project.findUnique({ where: { shareToken: share } })
      if (!shareProject) return unauthorized()
    }
    const queryProjectId = req.nextUrl.searchParams.get('projectId')
    // A share token paired with a ?projectId that names a DIFFERENT project
    // is a cross-project probe — answer with the same 404 as an unknown id
    // (no existence oracle).
    if (shareProject && queryProjectId && queryProjectId !== shareProject.id) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    // Tenant isolation: client-role sessions are PINNED to their own project —
    // a ?projectId from the URL is ignored (mirrors /api/sync). The public
    // share path is pinned to the token's own project.
    const projectId = shareProject
      ? shareProject.id
      : session?.user.role === 'client'
        ? session.user.projectId
        : queryProjectId
    const payload = await getProjectPayload(projectId)
    if (!payload) {
      return NextResponse.json({ error: projectId ? 'Project not found' : 'No project found' }, { status: 404 })
    }
    // B4-INTEL: the §57 unified timeline rides along as an ADDITIVE key — the
    // rest of the payload is byte-identical to getProjectPayload's output.
    const timeline = await buildTimelineSlice(payload.project.id)
    // Defense-in-depth per the v1 doctrine ("shareToken is a bearer
    // capability, not a data field"): the PUBLIC share path never echoes
    // token material — the caller already holds the one token it used.
    // Owner sessions keep the field (the Share dialog builds the link from
    // it). The public client surface is GET /api/share, which never echoes
    // tokens either.
    const body = shareProject
      ? (() => {
          const { shareToken: _stripped, ...projectWithoutToken } = payload.project
          return { ...payload, project: projectWithoutToken, timeline }
        })()
      : { ...payload, timeline }
    return NextResponse.json(body)
  },
)
