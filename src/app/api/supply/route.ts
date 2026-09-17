import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { withGuard } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/** SQLITE_BUSY → wait and retry (parallel agents share the SQLite file). */
async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (i < attempts - 1 && /SQLITE_BUSY|database is locked/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }
      throw e
    }
  }
  throw new Error('unreachable')
}

async function resolveProject(projectId: unknown) {
  if (typeof projectId === 'string' && projectId) {
    return db.project.findUnique({ where: { id: projectId } })
  }
  return db.project.findFirst({ orderBy: { createdAt: 'asc' } })
}

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status })

// ---------------------------------------------------------------- GET

export const GET = withGuard(async (req, _session) => {
  try {
    const projectId = new URL(req.url).searchParams.get('projectId')
    const project = await resolveProject(projectId)
    if (!project) return bad('Project not found', 404)

    const [suppliers, warehouses, offers, pricePoints, bidRequests] = await retry(() =>
      Promise.all([
        db.supplier.findMany({ orderBy: { rating: 'desc' } }),
        db.warehouse.findMany({ orderBy: { distanceKm: 'asc' } }),
        db.supplyOffer.findMany({
          orderBy: [{ materialKey: 'asc' }, { unitPrice: 'asc' }],
          include: { supplier: { select: { name: true, rating: true } } },
        }),
        db.pricePoint.findMany({
          orderBy: [{ materialKey: 'asc' }, { region: 'asc' }, { daysAgo: 'asc' }],
        }),
        db.bidRequest.findMany({
          where: { projectId: project.id },
          orderBy: { createdAt: 'desc' },
          include: { quotes: { include: { supplier: true }, orderBy: { total: 'asc' } } },
        }),
      ]),
    )

    return NextResponse.json({ ok: true, suppliers, warehouses, offers, pricePoints, bidRequests })
  } catch (e) {
    console.error('[api/supply GET]', e)
    return bad(e instanceof Error ? e.message : 'Failed to load supply network data', 500)
  }
}, { roles: ['contractor', 'admin'] })

// ---------------------------------------------------------------- POST

interface BidItemBody { materialName?: unknown; qty?: unknown; unit?: unknown }
interface SupplyPostBody {
  type?: unknown
  projectId?: unknown
  payload?: { items?: BidItemBody[]; requiredBy?: unknown; note?: unknown; quoteId?: unknown; offerId?: unknown }
}

/** Does this offer plausibly satisfy a bid item like "Cement 32.5N 300 bags"? */
function offerMatchesItem(offer: { materialKey: string; materialName: string }, materialName: string): boolean {
  const words = materialName
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((w) => w.length > 2)
  const hay = `${offer.materialKey} ${offer.materialName}`.toLowerCase()
  return words.some((w) => hay.includes(w))
}

export const POST = withGuard(async (req, session) => {
  try {
    const body = (await req.json().catch(() => null)) as SupplyPostBody | null
    const type = body?.type
    const payload = body?.payload ?? {}
    if (typeof type !== 'string') return bad('type required')

    const project = await resolveProject(body?.projectId)
    if (!project) return bad('Project not found', 404)

    const actor = session.user.name || session.user.email || 'Site Manager'
    const role = session.user.role

    // ------------------------------------------------------------ bid.create
    if (type === 'bid.create') {
      const items = Array.isArray(payload.items) ? payload.items : []
      if (items.length < 1 || items.length > 3) return bad('A bid needs 1–3 line items')
      const parsed: Array<{ materialName: string; qty: number; unit: string }> = []
      for (const it of items) {
        const materialName = typeof it.materialName === 'string' ? it.materialName.trim() : ''
        const qty = Number(it.qty)
        const unit = typeof it.unit === 'string' ? it.unit.trim() : ''
        if (!materialName) return bad('Every item needs a material name')
        if (!Number.isFinite(qty) || qty <= 0) return bad(`Quantity for "${materialName}" must be above 0`)
        if (!unit) return bad(`Unit for "${materialName}" is required (bag, metre, lorry…)`)
        parsed.push({ materialName, qty, unit })
      }
      const requiredBy = typeof payload.requiredBy === 'string' ? payload.requiredBy : ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredBy)) return bad('requiredBy must be a date (YYYY-MM-DD)')
      const note = typeof payload.note === 'string' ? payload.note.trim() : null

      const result = await retry(async () => {
        const allOffers = await db.supplyOffer.findMany()
        const eligible = await db.supplier.count({ where: { businessVerified: true } })

        // best-matching suppliers = those stocking any requested material, ranked by rating
        const bySupplier = new Map<string, typeof allOffers>()
        for (const o of allOffers) {
          if (parsed.some((it) => offerMatchesItem(o, it.materialName))) {
            const list = bySupplier.get(o.supplierId) ?? []
            list.push(o)
            bySupplier.set(o.supplierId, list)
          }
        }
        const suppliers = await db.supplier.findMany({
          where: { id: { in: [...bySupplier.keys()] } },
          orderBy: { rating: 'desc' },
        })
        const chosen = suppliers.slice(0, 4)
        if (chosen.length === 0) return { request: null, quoteCount: 0, eligible }

        const request = await db.bidRequest.create({
          data: {
            projectId: project.id,
            items: JSON.stringify(parsed),
            location: project.location,
            requiredBy,
            note,
            status: 'open',
            notifiedCount: eligible,
          },
        })

        // deterministic auto-quotes: own offer price × qty × 1.02–1.08 + delivery,
        // delivery days from minLeadDays ± 1, staggered createdAt hours ago
        const H = 3600 * 1000
        const quoteRows: Array<{
          bidRequestId: string; supplierId: string; total: number; deliveryDays: number
          note: string; status: string; createdAt: Date
        }> = []
        chosen.forEach((sup, i) => {
          const stock = bySupplier.get(sup.id) ?? []
          const variance = 1.02 + i * 0.02
          let goods = 0
          for (const it of parsed) {
            const own = stock.filter((o) => offerMatchesItem(o, it.materialName)).sort((a, b) => a.unitPrice - b.unitPrice)[0]
            const any = allOffers.filter((o) => offerMatchesItem(o, it.materialName)).sort((a, b) => a.unitPrice - b.unitPrice)[0]
            const unitPrice = own?.unitPrice ?? any?.unitPrice ?? 750
            goods += unitPrice * it.qty * variance
          }
          const leadBase = stock.length ? Math.min(...stock.map((o) => o.minLeadDays)) : 2
          const deliveryFee = stock.length ? Math.min(...stock.map((o) => o.deliveryFee)) : 2500
          const freeOver = stock.find((o) => o.freeDeliveryOver != null)?.freeDeliveryOver ?? null
          const total = Math.round(goods + (freeOver != null && goods >= freeOver ? 0 : deliveryFee))
          const deliveryDays = Math.max(1, leadBase + (i % 3 === 0 ? 0 : i % 3 === 1 ? -1 : 1))
          const leadWord = deliveryDays <= leadBase ? 'Stock on hand' : 'Sourcing stock'
          quoteRows.push({
            bidRequestId: request.id,
            supplierId: sup.id,
            total,
            deliveryDays,
            note: `${leadWord} — delivered to ${project.location}.`,
            status: 'submitted',
            createdAt: new Date(Date.now() - (i * 3 + 1) * H),
          })
        })
        await db.bidQuote.createMany({ data: quoteRows })

        await db.notification.create({
          data: {
            projectId: project.id,
            kind: 'system',
            title: `${quoteRows.length} supplier bids received`,
            body: `Your bid request (${parsed.map((p) => `${p.qty} ${p.unit} ${p.materialName}`).join(' + ')}) was broadcast to ${eligible} verified suppliers — ${quoteRows.length} quotes are already in. Compare delivered totals in the Supply tab.`,
            channel: 'in_app',
          },
        })

        await db.auditEvent.create({
          data: {
            projectId: project.id,
            kind: 'supply',
            actor,
            role,
            summary: `Bid broadcast to ${eligible} suppliers: ${parsed.map((p) => `${p.qty} ${p.unit} ${p.materialName}`).join(' + ')} — ${quoteRows.length} quotes auto-received`,
            meta: JSON.stringify({ bidRequestId: request.id, quotes: quoteRows.length, notifiedCount: eligible }),
          },
        })

        return { request, quoteCount: quoteRows.length, eligible }
      })

      if (!result.request) {
        return bad('No suppliers stock those materials — try naming them like the catalog (e.g. "Cement 32.5N", "River sand")')
      }
      return NextResponse.json({
        ok: true,
        bidRequest: result.request,
        quoteCount: result.quoteCount,
        notifiedCount: result.eligible,
      })
    }

    // ------------------------------------------------------------ bid.select
    if (type === 'bid.select') {
      const quoteId = typeof payload.quoteId === 'string' ? payload.quoteId : ''
      if (!quoteId) return bad('quoteId required')

      const outcome = await retry(async () => {
        const quote = await db.bidQuote.findUnique({
          where: { id: quoteId },
          include: { bidRequest: true, supplier: true },
        })
        if (!quote) return { error: 'Quote not found', status: 404 as const }
        if (quote.bidRequest.projectId !== project.id) return { error: 'Quote belongs to a different project', status: 403 as const }
        if (quote.bidRequest.status === 'awarded') return { error: 'This bid request is already awarded', status: 400 as const }

        await db.bidQuote.updateMany({
          where: { bidRequestId: quote.bidRequestId, status: 'submitted' },
          data: { status: 'declined' },
        })
        await db.bidQuote.update({ where: { id: quote.id }, data: { status: 'selected' } })
        const request = await db.bidRequest.update({
          where: { id: quote.bidRequestId },
          data: { status: 'awarded' },
        })

        const items = (JSON.parse(request.items) as Array<{ qty: number; unit: string; materialName: string }>)
          .map((it) => `${it.qty} ${it.unit} ${it.materialName}`)
          .join(' + ')
        await db.auditEvent.create({
          data: {
            projectId: project.id,
            kind: 'supply',
            actor,
            role,
            summary: `Bid awarded to ${quote.supplier.name} — KSh ${quote.total.toLocaleString('en-KE')} delivered in ${quote.deliveryDays} day(s): ${items}`,
            meta: JSON.stringify({ bidRequestId: request.id, quoteId: quote.id, supplier: quote.supplier.name, total: quote.total }),
          },
        })
        return { request, supplier: quote.supplier.name, total: quote.total }
      })

      if ('error' in outcome) return bad(outcome.error, outcome.status)
      return NextResponse.json({ ok: true, bidRequest: outcome.request, awardedTo: outcome.supplier, total: outcome.total })
    }

    // ------------------------------------------------------------ stock.refresh
    if (type === 'stock.refresh') {
      const offerId = typeof payload.offerId === 'string' ? payload.offerId : ''
      if (!offerId) return bad('offerId required')

      const outcome = await retry(async () => {
        const offer = await db.supplyOffer.findUnique({
          where: { id: offerId },
          include: { warehouse: true, supplier: true },
        })
        if (!offer) return { error: 'Offer not found', status: 404 as const }

        const jitter = 1 + (Math.random() - 0.5) * 0.06 // ±3%
        const newQty = Math.max(0, Math.round(offer.stockQty * jitter))
        const updated = await db.supplyOffer.update({
          where: { id: offer.id },
          data: { stockConfidence: 'verified', stockVerifiedAt: new Date(), stockQty: newQty },
        })

        await db.auditEvent.create({
          data: {
            projectId: project.id,
            kind: 'supply',
            actor,
            role,
            summary: `Stock re-verified: ${offer.materialName} at ${offer.warehouse.name} — ${newQty} ${offer.unit} available`,
            meta: JSON.stringify({ offerId: offer.id, supplier: offer.supplier.name, stockQty: newQty }),
          },
        })
        return { offer: updated }
      })

      if ('error' in outcome) return bad(outcome.error, outcome.status)
      return NextResponse.json({ ok: true, offer: outcome.offer })
    }

    return bad(`Unknown action "${type}" — expected bid.create, bid.select or stock.refresh`)
  } catch (e) {
    console.error('[api/supply POST]', e)
    return bad(e instanceof Error ? e.message : 'Supply action failed', 500)
  }
}, { roles: ['contractor', 'admin'] })
