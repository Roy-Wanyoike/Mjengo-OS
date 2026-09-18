import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { forbidden } from '@/backend/lib/guard'
import { route } from '@/backend/lib/route-kit'
import { log } from '@/backend/lib/log'

// Global search (spec §80) — SQLite LIKE (ASCII case-insensitive by default)
// across the real entities: projects, land parcels, workers, suppliers +
// catalog items, material requests + purchase orders, transactions, invoices
// and notifications. Results come back grouped, max 5 per group, each item
// carrying a target so the header dropdown can route the click.
//
// API-12 / issue #163 — STRUCTURAL DECISION: SQL pushdown. The LIKE now runs
// INSIDE each query (Prisma `contains` → SQLite `LIKE '%q%'`), not in memory
// over a pre-fetched window:
//   · BEFORE: each table loaded its 300 most-recent RAW rows and filtered in
//     memory — a matching row outside that recency window was silently missed
//     (the API-12 ceiling; #166 additionally found the projects window
//     inverted, keeping the OLDEST 300 — fixed there, desc since).
//   · NOW: the sanitized q is pushed down with the SAME `take: MAX_SCAN`
//     bounds, so the window caps MATCHES per table (the ≤300 most-recent
//     matches), not raw rows. An exact-name hit is found no matter how old
//     it is; a miss now needs >300 matches for one query — and when the cap
//     bites, the response says so via `note` (no silent truncation).
//   · `contains` on SQLite is ASCII case-insensitive by default (Prisma sets
//     no case_sensitive_like pragma — pinned on the real engine in
//     tests/unit/search-pushdown-realdb.test.ts). Prisma does NOT escape
//     % / _ in the needle on SQLite, which is why sanitize() below is
//     load-bearing: a user's wildcards are stripped BEFORE they reach LIKE.
//   · Known narrowing (documented, accepted): LIKE folds case for ASCII
//     only; the old in-memory toLowerCase() folded Unicode case too. App
//     data is English/Swahili (ASCII), and this header has claimed "ASCII
//     case-insensitive" since the route was born — the pushdown makes it
//     literally true. Non-ASCII case-variant queries ("CAFÉ" vs "Café")
//     now require the exact byte form.
//   · Deliberately NOT FTS5: at demo scale a full-text index + its sync
//     story are premature (leading-wildcard LIKE can't use one anyway).
//     Revisit trigger recorded in ARCHITECTURE.md: any searchable table
//     >10k rows → SQLite FTS5 over the searchable fields (schema change —
//     coordinate with the DB waves).
//
// Scoping: client-role sessions are pinned to THEIR project (session.user.
// projectId); contractor/admin/finance search across all projects. LIKE
// wildcards in the query are stripped so users can't inject % / _ patterns.
//
// BE-11 (issue #77): the route runs through route-kit with the standard
// per-principal token bucket — 60 searches/min (the sibling GET posture,
// e.g. notifications.get). It was the only guarded JSON route without a
// limiter; each request scans ≤300 rows × ~10 tables, and signed-in users
// could poll it unbounded. No behavior change otherwise: same guard (any
// signed-in role), same 500 'Search failed' catch.
//
// BE-3 (issue #104): supplier sessions get the honest W5-3 403 below — the
// same refusal /api/project gives — BEFORE any query runs. Search fans out
// across EVERY project's workers, transactions, invoices and notification
// bodies, and the client pin never applied to suppliers, so they fell into
// the global branch (a cross-project read). Their read surface is
// GET /api/supplier, where the WHERE clause itself is the scoping.

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

// S6 hardening — bounds every query regardless of table size. Since #163
// (SQL pushdown) the bound caps MATCHES: each source table returns at most
// MAX_SCAN rows that ALREADY match the pushed-down LIKE (recent-first where
// an order exists), instead of loading MAX_SCAN raw rows and filtering in
// memory. A matching row beyond the cap is honestly missed — but the cap is
// now per-query matches, not table recency, so an exact-name search finds
// rows of any age (see the API-12 decision block in the header).
// Issue #166: "recent-first" is true for projects too — the unpinned
// query orders createdAt DESC like every timestamped sibling, so the window
// keeps the NEWEST 300 matches (asc kept the oldest 300 raw rows, making
// every project created after the first 300 unfindable by name).
const MAX_SCAN = 300

/** Cap the query itself — a giant string would still be scanned against every row. */
const MAX_QUERY = 100

/** Strip LIKE wildcards so % and _ are treated literally.
 *  Load-bearing with the #163 pushdown: Prisma does NOT escape LIKE
 *  wildcards inside `contains` on SQLite, so an unstripped % or _ from the
 *  user would act as a pattern (probe-pinned on the real engine). */
function sanitize(q: string): string {
  return q.replace(/[%_]/g, ' ').trim()
}

async function searchAll(
  q: string,
  projectId: string | null,
): Promise<{ groups: SearchGroup[]; capped: boolean }> {
  const scope = projectId ? { projectId } : {}
  // #163: the per-table LIKE terms, pushed down as `contains` — the SAME
  // fields the old in-memory filter scanned, one OR per searchable column.
  const [projects, parcels, workers, suppliers, catalogItems, requests, orders, transactions, invoices, notifications] =
    await Promise.all([
      projectId
        ? db.project.findMany({ where: { id: projectId, OR: [{ name: { contains: q } }, { client: { contains: q } }, { location: { contains: q } }] } })
        : db.project.findMany({ where: { OR: [{ name: { contains: q } }, { client: { contains: q } }, { location: { contains: q } }] }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN }),
      db.landParcel.findMany({ where: { ...scope, OR: [{ plotNumber: { contains: q } }, { county: { contains: q } }, { town: { contains: q } }] }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN, include: { project: { select: { name: true } } } }),
      // Worker has no timestamp column — the take bound still caps the scan.
      db.worker.findMany({ where: { ...scope, OR: [{ name: { contains: q } }, { role: { contains: q } }] }, take: MAX_SCAN, include: { project: { select: { name: true } } } }),
      db.supplier.findMany({ where: { OR: [{ businessName: { contains: q } }, { county: { contains: q } }, { town: { contains: q } }] }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN }),
      db.catalogItem.findMany({ where: { OR: [{ name: { contains: q } }, { brand: { contains: q } }, { specification: { contains: q } }] }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN, include: { supplier: { select: { businessName: true, county: true } } } }),
      db.materialRequest.findMany({ where: { ...scope, requestCode: { contains: q } }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN, include: { project: { select: { name: true } }, lines: true } }),
      db.purchaseOrder.findMany({ where: { ...scope, orderCode: { contains: q } }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN, include: { project: { select: { name: true } }, supplier: { select: { businessName: true } } } }),
      db.transaction.findMany({ where: { ...scope, OR: [{ reference: { contains: q } }, { note: { contains: q } }] }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN, include: { project: { select: { name: true } } } }),
      db.invoice.findMany({ where: { ...scope, invoiceCode: { contains: q } }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN, include: { project: { select: { name: true } } } }),
      db.notification.findMany({ where: { ...scope, OR: [{ title: { contains: q } }, { body: { contains: q } }] }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN, include: { project: { select: { name: true } } } }),
    ])

  // #163 honesty seam: a table returning exactly MAX_SCAN rows means the
  // take bound truncated its match set (≥300 matches for this q) — the
  // response says so instead of silently showing only the newest 5.
  const capped = [projects, parcels, workers, suppliers, catalogItems, requests, orders, transactions, invoices, notifications].some(
    (rows) => rows.length === MAX_SCAN,
  )

  const groups: SearchGroup[] = []

  // #163: no in-memory filter anymore — the rows arrive pre-matched from the
  // pushed-down LIKE; slicing to MAX_PER_GROUP is all that remains.
  const projectItems: SearchItem[] = projects
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
    .slice(0, MAX_PER_GROUP)
    .map((t) => ({
      id: t.id,
      title: t.reference ?? (t.note ? t.note.slice(0, 40) : `${t.type} transaction`),
      sub: `${t.type} · KSh ${Math.round(Number(t.amount) / 100).toLocaleString('en-KE')}${t.note ? ` · ${t.note.slice(0, 50)}` : ''}`,
      project: t.project.name,
      target: 'transaction',
    }))
  if (transactionItems.length) groups.push({ group: 'Transactions', items: transactionItems })

  const invoiceItems: SearchItem[] = invoices
    .slice(0, MAX_PER_GROUP)
    .map((i) => ({
      id: i.id,
      title: i.invoiceCode,
      sub: `${i.status} · KSh ${Math.round(Number(i.total) / 100).toLocaleString('en-KE')}`,
      project: i.project.name,
      target: 'invoice',
    }))
  if (invoiceItems.length) groups.push({ group: 'Invoices', items: invoiceItems })

  const notificationItems: SearchItem[] = notifications
    .slice(0, MAX_PER_GROUP)
    .map((n) => ({
      id: n.id,
      title: n.title,
      sub: n.body.slice(0, 60),
      project: n.project?.name ?? null,
      target: 'notification',
    }))
  if (notificationItems.length) groups.push({ group: 'Notifications', items: notificationItems })

  return { groups, capped }
}

export const GET = route(
  {
    scope: 'api/search GET',
    // BE-11 (issue #77): the standard limiter — 60/min per principal.
    rateLimit: { bucket: 'search', limit: 60, windowMs: 60_000 },
  },
  async (req: NextRequest, session) => {
    try {
      // W5-3 / BE-3 (issue #104): a supplier session is not a portfolio
      // reader — the honest 403 /api/project gives, returned before ANY of
      // the ten source tables is touched (zero global rows fetched).
      if (session.user.role === 'supplier') return forbidden(session.user.role)

      const raw = new URL(req.url).searchParams.get('q') ?? ''
      if (raw.length > MAX_QUERY) {
        return NextResponse.json({ ok: true, q: raw.slice(0, MAX_QUERY), groups: [], note: `Query capped at ${MAX_QUERY} characters` })
      }
      const q = sanitize(raw).toLowerCase()
      if (q.length < 2) {
        return NextResponse.json({ ok: true, q: raw, groups: [], note: 'Type at least 2 characters' })
      }

      // Client-role sessions are pinned to their own project; every other role
      // searches across all projects. (Suppliers never reach here — the 403
      // above is the W5-3 read boundary; see the BE-3 note in the header.)
      const role = session.user.role
      const pinned = role === 'client' ? (session.user.projectId ?? 'none') : null
      const { groups, capped } = await searchAll(q, pinned)

      // #163: the note seam (same field the query-cap / min-char branches
      // use) — present ONLY when a source table's 300-match window truncated,
      // so a capped result set is never silent. Additive: the ⌘K palette
      // reads ok/groups only.
      return NextResponse.json({
        ok: true,
        q: raw,
        scopedTo: pinned,
        groups,
        ...(capped ? { note: `Match cap reached — at least one table has ${MAX_SCAN}+ matches for this query; refine it to see older matches` } : {}),
      })
    } catch (e) {
      log.error('api/search', 'Request failed', { error: e })
      return NextResponse.json({ error: 'Search failed' }, { status: 500 })
    }
  },
)
