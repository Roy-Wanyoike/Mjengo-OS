// Supply module — W5-3 supplier-side pinning (server-enforced scoping).
//
// THE CONTRACT (mirrors the client-role tenant pin, deliberately):
//   · ALLOWLIST: a supplier session may run exactly SUPPLIER_ACTIONS
//     (src/shared/supplier-actions.ts) — everything else is refused HERE,
//     server-side, before any handler touches data. The route-layer allowlist
//     (/api/actions 403) stays a convenience gate, exactly like CLIENT_ACTIONS.
//   · ROW PIN: every id a supplier touches must resolve to a row whose
//     supplierId is THEIR session-pinned supplier. A foreign id throws the
//     SAME single-line domain error as a miss ('Quote not found in this
//     project', 'Purchase order not found in this project', 'Catalog item not
//     found') — indistinguishable from the id not existing at all, the same
//     honesty the client pin applies to project ids.
//   · FAIL CLOSED: a supplier role stamp without a supplier id, or an
//     unknown/edge action, is rejected with a clear error — never guessed.
//
// Called from lib/mjengo.ts applyAction() — the ONE shared mutation path
// (/api/actions, /api/sync, jobs) — so no entry route can bypass it.

import { db } from '@/backend/lib/db'
import { SUPPLIER_ACTIONS } from '@/shared/supplier-actions'

/** Honest refusal copy for a supplier attempting a buyer-side action. */
export const SUPPLIER_ACTION_REFUSED =
  'Suppliers answer their own quotes, confirm and dispatch their own purchase orders, and maintain their own catalog — ' +
  'this action stays with the buyer side. Sign in as the site team, or ask them to run it.'

/** Fail-closed copy for a supplier stamp with no link. */
export const SUPPLIER_UNLINKED =
  'Supplier account has no supplier linked — ask an admin to link your account to a supplier row.'

/**
 * Enforce the supplier pin on one dispatched action. Throws the exact
 * domain-error strings the service layer's own miss lookups produce, so a
 * foreign id is indistinguishable from an unknown one.
 *
 * For `catalog.upsert` the payload is REWRITTEN in place: `supplierId` is
 * forced to the session pin (a payload copy naming another supplier is
 * ignored, mirroring "a client's body projectId is ignored"); for an EXISTING
 * item the id must already belong to the pinned supplier.
 */
export async function assertSupplierScope(
  type: string,
  payload: Record<string, unknown>,
  projectId: string,
  supplierId: string | null,
): Promise<void> {
  if (!(SUPPLIER_ACTIONS as readonly string[]).includes(type)) {
    throw new Error(`${SUPPLIER_ACTION_REFUSED} (action: ${type})`)
  }
  if (!supplierId) throw new Error(SUPPLIER_UNLINKED)

  const id = (v: unknown): string | null => {
    const s = String(v ?? '').trim()
    return s || null
  }

  switch (type) {
    case 'quote.receive':
    case 'quote.decline': {
      const quoteId = id(payload.id)
      if (!quoteId) throw new Error('Quote id required')
      const quote = await db.quote.findFirst({
        where: { id: quoteId, request: { projectId } },
        select: { supplierId: true },
      })
      // Foreign quote → the SAME error a miss produces (getQuoteOrThrow).
      if (!quote || quote.supplierId !== supplierId) {
        throw new Error('Quote not found in this project')
      }
      return
    }
    case 'order.confirm':
    case 'order.dispatch': {
      const orderId = id(payload.orderId ?? payload.id)
      if (!orderId) throw new Error('Order id required')
      const order = await db.purchaseOrder.findFirst({
        where: { id: orderId, projectId },
        select: { supplierId: true },
      })
      // Foreign order → the SAME error a miss produces (getOrderOrThrow).
      if (!order || order.supplierId !== supplierId) {
        throw new Error('Purchase order not found in this project')
      }
      return
    }
    case 'catalog.upsert': {
      const itemId = id(payload.id)
      if (itemId) {
        const item = await db.catalogItem.findUnique({ where: { id: itemId } })
        // Foreign item → the SAME error a miss produces (upsertCatalogItem).
        if (!item || item.supplierId !== supplierId) {
          throw new Error('Catalog item not found')
        }
      }
      // Tenant pin: the payload's supplierId is IGNORED for supplier sessions —
      // forced to the session pin (mirrors the client body-projectId rule).
      payload.supplierId = supplierId
      return
    }
    default:
      // SUPPLIER_ACTIONS drifted without extending this switch — fail closed.
      throw new Error(`${SUPPLIER_ACTION_REFUSED} (action: ${type})`)
  }
}
