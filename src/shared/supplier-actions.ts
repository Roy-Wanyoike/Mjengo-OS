import type { ActionType } from '@/backend/lib/mjengo'

/**
 * Actions a SUPPLIER-role session may perform (W5-3 supplier-side portal) —
 * the supply-side mirror of CLIENT_ACTIONS. Kept in a server-safe module (no
 * 'use client' imports) so the API routes, the supplier portal frontend and
 * the tests share ONE list, exactly like src/shared/client-actions.ts.
 *
 * The list is deliberately the supplier's OWN loop only:
 *  · quote.receive / quote.decline — answer the RFQs addressed to them
 *  · order.confirm                 — confirm a PO they own (availability,
 *                                    delivery, charge — Finder §12)
 *  · order.dispatch                — send the truck: writes the SAME
 *                                    OrderDelivery row the buyer path writes
 *  · catalog.upsert                — maintain their own catalog prices/stock
 *
 * Everything else (requests, approvals, sending POs, receiving deliveries,
 * invoices, money, team, land…) stays with the buyer side — /api/actions 403s
 * a supplier for any type not on this list, and lib/mjengo.applyAction
 * re-checks it server-side so /api/sync-style internal callers cannot bypass.
 * Row-level pinning (a supplier may only touch rows whose supplierId is
 * THEIRS) lives in src/backend/modules/supply/supplier-scope.ts.
 */
export const SUPPLIER_ACTIONS: readonly ActionType[] = [
  'quote.receive',
  'quote.decline',
  'order.confirm',
  'order.dispatch',
  'catalog.upsert',
]
