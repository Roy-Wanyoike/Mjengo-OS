import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { withGuard } from '@/lib/guard'

// Global search (spec §80) — SQLite LIKE (ASCII case-insensitive by default)
// across the real entities: projects, land parcels, workers, suppliers +
// catalog items, material requests + purchase orders, transactions, invoices
// and notifications. Results come back grouped, max 5 per group, each item
// carrying a target so the header dropdown can route the click.
//
// Scoping: client-role sessions are pinned to THEIR project (session.user.
// projectId); contractor/admin/finance search across all projects. LIKE
// wildcards in the query are stripped so users can't inject % / _ patterns.

export const dynamic = 'force-dynamic'

interface SearchItem {
  id: string
  title: string
  sub: string
  project: string | null
  target:
    | 'project' | 'parcel' | 'worker' | 'supplier' | 'catalog'
    | 'request' | 'order' | 'invoice' | 'transaction' | 'notification'
}

interface SearchGroup {
  group: string
  items: SearchItem[]
}

const MAX_PER_GROUP = 5

/** Strip LIKE wildcards so % and _ are treated literally. */
function sanitize(q: string): string {
  return q.replace(/[%_]/g, ' ').trim()
}

async function searchAll(q: string, projectId: string | null): Promise<SearchGroup[]> {
  const scope = projectId ? { projectId } : {}
  const [projects, parcels, workers, suppliers, catalogItems, requests, orders, transactions, invoices, notifications] =
    await Promise.all([
      projectId
        ? db.project.findMany({ where: { id: projectId } })
        : db.project.findMany({ orderBy: { createdAt: 'asc' } }),
      db.landParcel.findMany({ where: { ...scope }, include: { project: { select: { name: true } } } }),
      db.worker.findMany({ where: { ...scope }, include: { project: { select: { name: true } } } }),
      db.supplier.findMany({}),
      db.catalogItem.findMany({ include: { supplier: { select: { businessName: true, county: true } } } }),
      db.materialRequest.findMany({ where: { ...scope }, include: { project: { select: { name: true } }, lines: true } }),
      db.purchaseOrder.findMany({ where: { ...scope }, include: { project: { select: { name: true } }, supplier: { select: { businessName: true } } } }),
      db.transaction.findMany({ where: { ...scope }, include: { project: { select: { name: true } } } }),
      db.invoice.findMany({ where: { ...scope }, include: { project: { select: { name: true } } } }),
      db.notification.findMany({ where: { ...scope }, orderBy: { createdAt: 'desc' }, include: { project: { select: { name: true } } } }),
    ])

  const has = (s: string | null | undefined) => Boolean(s && s.toLowerCase().includes(q))

  const groups: SearchGroup[] = []

  const projectItems: SearchItem[] = projects
    .filter((p) => has(p.name) || has(p.client) || has(p.location))
    .slice(0, MAX_PER_GROUP)
    .map((p) => ({
      id: p.id,
      title: p.name,
      sub: `${p.client} · ${p.location} · ${p.status}`,
      project: p.name,
      target: 'project',
    }))
  if (projectItems.length) groups.push({ group: 'Projects', items: projectItems })

  const parcelItems: SearchItem[] = parcels
    .filter((p) => has(p.plotNumber) || has(p.county) || has(p.town))
    .slice(0, MAX_PER_GROUP)
    .map((p) => ({
      id: p.id,
      title: p.plotNumber,
      sub: `${[p.county, p.town].filter(Boolean).join(', ')} · ${p.status}`,
      project: p.project.name,
      target: 'parcel',
    }))
  if (parcelItems.length) groups.push({ group: 'Land parcels', items: parcelItems })

  const workerItems: SearchItem[] = workers
    .filter((w) => has(w.name) || has(w.role))
    .slice(0, MAX_PER_GROUP)
    .map((w) => ({
      id: w.id,
      title: w.name,
      sub: `${w.role} · ${w.active ? 'active' : 'inactive'}`,
      project: w.project.name,
      target: 'worker',
    }))
  if (workerItems.length) groups.push({ group: 'Workers', items: workerItems })

  const supplierItems: SearchItem[] = suppliers
    .filter((s) => has(s.businessName) || has(s.county) || has(s.town))
    .slice(0, MAX_PER_GROUP)
    .map((s) => ({
      id: s.id,
      title: s.businessName,
      sub: `${[s.county, s.town].filter(Boolean).join(', ')} · verification level ${s.verificationState}/5`,
      project: null,
      target: 'supplier',
    }))
  if (supplierItems.length) groups.push({ group: 'Suppliers', items: supplierItems })

  const catalogItemsOut: SearchItem[] = catalogItems
    .filter((c) => has(c.name) || has(c.brand) || has(c.specification))
    .slice(0, MAX_PER_GROUP)
    .map((c) => ({
      id: c.id,
      title: c.name,
      sub: `${[c.brand, c.specification].filter(Boolean).join(' · ') || c.unit} · ${c.supplier.businessName}`,
      project: null,
      target: 'catalog',
    }))
  if (catalogItemsOut.length) groups.push({ group: 'Catalog items', items: catalogItemsOut })

  const requestItems: SearchItem[] = requests
    .filter((r) => has(r.requestCode))
    .slice(0, MAX_PER_GROUP)
    .map((r) => ({
      id: r.id,
      title: r.requestCode,
      sub: `${r.status} · ${r.lines.length} line${r.lines.length === 1 ? '' : 's'}`,
      project: r.project.name,
      target: 'request',
    }))
  if (requestItems.length) groups.push({ group: 'Requests', items: requestItems })

  const orderItems: SearchItem[] = orders
    .filter((o) => has(o.orderCode))
    .slice(0, MAX_PER_GROUP)
    .map((o) => ({
      id: o.id,
      title: o.orderCode,
      sub: `${o.status} · ${o.supplier.businessName}`,
      project: o.project.name,
      target: 'order',
    }))
  if (orderItems.length) groups.push({ group: 'Purchase orders', items: orderItems })

  const transactionItems: SearchItem[] = transactions
    .filter((t) => has(t.reference) || has(t.note))
    .slice(0, MAX_PER_GROUP)
    .map((t) => ({
      id: t.id,
      title: t.reference ?? (t.note ? t.note.slice(0, 40) : `${t.type} transaction`),
      sub: `${t.type} · KSh ${Math.round(t.amount).toLocaleString('en-KE')}${t.note ? ` · ${t.note.slice(0, 50)}` : ''}`,
      project: t.project.name,
      target: 'transaction',
    }))
  if (transactionItems.length) groups.push({ group: 'Transactions', items: transactionItems })

  const invoiceItems: SearchItem[] = invoices
    .filter((i) => has(i.invoiceCode))
    .slice(0, MAX_PER_GROUP)
    .map((i) => ({
      id: i.id,
      title: i.invoiceCode,
      sub: `${i.status} · KSh ${Math.round(i.total).toLocaleString('en-KE')}`,
      project: i.project.name,
      target: 'invoice',
    }))
  if (invoiceItems.length) groups.push({ group: 'Invoices', items: invoiceItems })

  const notificationItems: SearchItem[] = notifications
    .filter((n) => has(n.title) || has(n.body))
    .slice(0, MAX_PER_GROUP)
    .map((n) => ({
      id: n.id,
      title: n.title,
      sub: n.body.slice(0, 60),
      project: n.project?.name ?? null,
      target: 'notification',
    }))
  if (notificationItems.length) groups.push({ group: 'Notifications', items: notificationItems })

  return groups
}

export const GET = withGuard(async (req: NextRequest, session) => {
  try {
    const raw = new URL(req.url).searchParams.get('q') ?? ''
    const q = sanitize(raw).toLowerCase()
    if (q.length < 2) {
      return NextResponse.json({ ok: true, q: raw, groups: [], note: 'Type at least 2 characters' })
    }

    // Client-role sessions are pinned to their own project; every other role
    // searches across all projects.
    const role = session.user.role
    const pinned = role === 'client' ? (session.user.projectId ?? 'none') : null
    const groups = await searchAll(q, pinned)

    return NextResponse.json({ ok: true, q: raw, scopedTo: pinned, groups })
  } catch (e) {
    console.error('[api/search]', e)
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }
})
