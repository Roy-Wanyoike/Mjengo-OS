// Supply module — PURE landed-cost engine + weighted supplier ranking (Finder §3-§4).
//
// No database, no React: the SAME function runs server-side (service.ts,
// authoritative for the `supply.compare` action) and client-side (the Finder
// search section renders the table from the payload slices). One algorithm,
// one source of truth, no drift between what the server computes and what the
// human sees — the modules/invoices/three-way.ts pattern.
//
// Deterministic, documented:
//   product cost  = unitPrice × qty                          (catalog)
//   delivery fee  = 0 when (freeDeliveryOver set AND productCost ≥ freeDeliveryOver),
//                   else the supplier's deliveryFeeBase       (supplier rules)
//   transport     = ceil(distanceKm / 10) × 100              (distance surcharge,
//                   ~KSh 100 per 10 km beyond the base fee)
//   total landed  = product + delivery + transport           (spec §4)
//
//   Weighted score (spec §4 — price + distance + availability + delivery time
//   + reliability; BEST OVERALL is not necessarily the cheapest unit price):
//     0.45 × price       bestLanded / landed      (normalized against the best)
//     0.15 × distance    bestKm / km              (closer is better)
//     0.15 × stock       full 1 · partial 0.5 · none 0
//     0.10 × speed       same-day 1 · next-day 0.6 · 2+ days 0.3
//     0.15 × reliability supplier reliabilityScore / 100
//
//   Delivery-speed tier (v1 heuristic, labeled in the UI as an estimate): the
//   supplier's average quote RESPONSE time is the honest signal we hold before
//   real quotes arrive — responseHours ≤ 4 → "same day", ≤ 12 → "next day",
//   else "2+ days". Once quotes exist, their deliveryEta is the real signal.
//
// Fuzzy material match: catalog item NAME contains the query,
// case-insensitive, whitespace-tolerant. When a supplier stocks several
// matches, the CHEAPEST unit price is used (documented).

import type {
  CompareCandidate, CompareInput, CompareResult, CompareRow, CompareSite, EtaTier, StockState,
} from './types'

export const NAIROBI_SITE: CompareSite = { lat: -1.2921, lng: 36.8219, label: 'Nairobi (default)' }

/** Haversine distance in km. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Case-insensitive CONTAINS match (spec's fuzzy material finder). */
export function materialMatches(itemName: string, query: string): boolean {
  const q = norm(query)
  if (!q) return false
  return norm(itemName).includes(q)
}

/** Best-matching catalog item for a supplier — cheapest among fuzzy matches. */
export function bestCatalogMatch(
  items: Array<{ id: string; name: string; unit: string; unitPrice: number; stockQty: number; minOrderQty: number }>,
  query: string,
) {
  const matches = items.filter((i) => materialMatches(i.name, query))
  if (!matches.length) return null
  return matches.reduce((best, i) => (i.unitPrice < best.unitPrice ? i : best))
}

function stockState(qty: number, stockQty: number): StockState {
  if (stockQty <= 0) return 'none'
  return stockQty >= qty ? 'full' : 'partial'
}

function etaTier(responseHours: number): EtaTier {
  if (responseHours <= 4) return 'same day'
  if (responseHours <= 12) return 'next day'
  return '2+ days'
}

const ETA_SCORE: Record<EtaTier, number> = { 'same day': 1, 'next day': 0.6, '2+ days': 0.3 }

/** Slower tiers are excluded when a delivery day is requested (faster is fine). */
function etaAllowed(tier: EtaTier, day: CompareInput['deliveryDay']): boolean {
  if (!day || day === 'any') return true
  if (day === 'two_days') return true
  if (day === 'next_day') return tier !== '2+ days'
  return tier === 'same day' // same_day requested → only same-day suppliers
}

/**
 * Rank suppliers for one material + quantity around a site.
 * Rows are sorted by weighted score desc; `bestOverall` marks rank 1 and
 * `cheapestUnit` marks the lowest unit price — the two flags the UI must keep
 * visibly distinct (spec §3: cheapest unit ≠ cheapest landed ≠ best overall).
 */
export function rankSuppliers(
  input: CompareInput,
  candidates: CompareCandidate[],
  site: CompareSite,
): CompareRow[] {
  const qty = Math.max(1, Math.round(input.qty * 100) / 100)
  const query = input.materialName

  // 1) price + per-supplier landed cost
  const scored: CompareRow[] = []
  for (const c of candidates) {
    const tier = etaTier(c.responseHours)
    if (!etaAllowed(tier, input.deliveryDay ?? 'any')) continue

    const distanceKm =
      typeof c.lat === 'number' && typeof c.lng === 'number'
        ? Math.round(haversineKm(site, { lat: c.lat, lng: c.lng }) * 10) / 10
        : null
    if (input.radiusKm && distanceKm !== null && distanceKm > input.radiusKm) continue

    const productCost = Math.round(c.item.unitPrice * qty * 100) / 100
    const deliveryFee =
      c.freeDeliveryOver !== null && c.freeDeliveryOver !== undefined && productCost >= c.freeDeliveryOver
        ? 0
        : c.deliveryFeeBase
    const transportFee = distanceKm === null ? 0 : Math.ceil(distanceKm / 10) * 100
    const totalLanded = Math.round((productCost + deliveryFee + transportFee) * 100) / 100

    scored.push({
      supplierId: c.supplierId,
      businessName: c.businessName,
      county: c.county,
      town: c.town ?? null,
      itemName: c.item.name,
      unit: c.item.unit,
      unitPrice: c.item.unitPrice,
      qty,
      productCost,
      deliveryFee,
      transportFee,
      totalLanded,
      distanceKm,
      stockQty: c.item.stockQty,
      stockState: stockState(qty, c.item.stockQty),
      minOrderQty: c.item.minOrderQty,
      minimumOrder: c.minimumOrder,
      meetsMinOrder: productCost >= c.minimumOrder && qty >= c.item.minOrderQty,
      etaTier: tier,
      reliabilityScore: Math.max(0, Math.min(100, c.reliabilityScore)),
      scores: { price: 0, distance: 0, stock: 0, speed: 0, reliability: 0, total: 0 },
      flags: { bestOverall: false, cheapestUnit: false },
    })
  }
  if (!scored.length) return []

  // 2) normalize each dimension against the BEST value, then weight + rank
  const bestLanded = Math.min(...scored.map((r) => r.totalLanded))
  const distances = scored.map((r) => r.distanceKm).filter((d): d is number => d !== null)
  const bestKm = distances.length ? Math.min(...distances) : null
  const cheapestUnit = Math.min(...scored.map((r) => r.unitPrice))

  for (const r of scored) {
    r.scores.price = bestLanded > 0 ? Math.min(1, bestLanded / r.totalLanded) : 1
    r.scores.distance =
      r.distanceKm === null || bestKm === null || bestKm === 0 ? (r.distanceKm === null ? 0 : 1) : Math.min(1, bestKm / r.distanceKm)
    r.scores.stock = r.stockState === 'full' ? 1 : r.stockState === 'partial' ? 0.5 : 0
    r.scores.speed = ETA_SCORE[r.etaTier]
    r.scores.reliability = r.reliabilityScore / 100
    r.scores.total =
      Math.round(
        (0.45 * r.scores.price +
          0.15 * r.scores.distance +
          0.15 * r.scores.stock +
          0.1 * r.scores.speed +
          0.15 * r.scores.reliability) *
          1000,
      ) / 1000
    r.flags.cheapestUnit = r.unitPrice === cheapestUnit
  }

  scored.sort((a, b) => b.scores.total - a.scores.total || a.totalLanded - b.totalLanded)
  if (scored.length) scored[0].flags.bestOverall = true
  return scored
}

/** Flatten supplier+catalog slices (client payload or db rows) into candidates. */
export function toCandidates(
  suppliers: Array<{
    id: string
    businessName: string
    county: string
    town?: string | null
    lat?: number | null
    lng?: number | null
    deliveryFeeBase: number
    freeDeliveryOver?: number | null
    minimumOrder: number
    reliabilityScore: number
    responseHours: number
    catalogItems: Array<{ id: string; name: string; unit: string; unitPrice: number; stockQty: number; minOrderQty: number }>
  }>,
  materialName: string,
): CompareCandidate[] {
  const out: CompareCandidate[] = []
  for (const s of suppliers) {
    const item = bestCatalogMatch(s.catalogItems, materialName)
    if (!item) continue
    out.push({
      supplierId: s.id,
      businessName: s.businessName,
      county: s.county,
      town: s.town ?? null,
      lat: s.lat ?? null,
      lng: s.lng ?? null,
      deliveryFeeBase: s.deliveryFeeBase,
      freeDeliveryOver: s.freeDeliveryOver ?? null,
      minimumOrder: s.minimumOrder,
      reliabilityScore: s.reliabilityScore,
      responseHours: s.responseHours,
      item,
    })
  }
  return out
}

/** Run a full compare against pre-loaded suppliers. */
export function compareSuppliers(
  input: CompareInput,
  suppliers: Parameters<typeof toCandidates>[0],
  site: CompareSite,
): CompareResult {
  return { site, rows: rankSuppliers(input, toCandidates(suppliers, input.materialName), site) }
}

// ---------------- ETA labels (UI + service share them) ----------------

export const DELIVERY_DAY_LABELS: Record<string, string> = {
  any: 'Any day',
  same_day: 'Same day',
  next_day: 'Next day',
  two_days: 'Within 2 days',
}
