// Low-stock rule (issue #207) — ONE server-owned definition.
//
// Before #207 the inventory slice hardcoded `lowStock: false` and each
// frontend surface re-derived "low" for itself with divergent heuristics
// (the legacy materials table compared onSiteQty against 10% of DELIVERED,
// the Store card compared closing against 10% of opening+received+returned).
// This module is the single rule both ledgers and both surfaces now share:
//
//   · EXPLICIT THRESHOLD: an item with a reorderLevel (InventoryItem.
//     reorderLevel, set through inventory.open / inventory.receive) is low
//     when its derived closing ≤ that absolute level. The explicit point
//     governs outright — a stockout under a set reorder point is low no
//     matter what any percentage would say.
//   · DERIVED DEFAULT (reorderLevel null): low when closing ≤ 10% of
//     everything that ever flowed IN. Each stock surface feeds its own
//     ledger's honest inflow — the movement ledger's opening + received +
//     returned (movementInflowQty below), the v1 delivery ledger's
//     delivered total — but the RULE is one definition, not a per-screen
//     invention.
//   · ZERO-INFLOW ITEMS ARE NEVER LOW: a percentage of nothing has no
//     basis, and 0 ≤ 0 would flag every fresh/empty row — so an item with
//     no inflow yet (e.g. stock that only ever arrived by transfer, or a
//     brand-new line) is not low under the default. An explicit
//     reorderLevel still governs: 0 ≤ level is a real stockout signal.
//
// Pure module by design (no db import): the backend computes the flag at
// the payload boundary, and the frontend's optimistic reducer mirrors the
// same rule offline from THIS code — the rule is the contract, so the
// offline badge can never disagree with the server's.
//
// Crossing notifications (service write paths) reuse this rule: a movement
// that flips an item from not-low to low fires ONE notify (per crossing,
// never per read) — see service.ts notifyLowStockCrossing.

/** Default fraction: low = closing ≤ 10% of everything that ever flowed in. */
export const LOW_STOCK_INFLOW_FRACTION = 0.1

/** The one low-stock rule. Inputs are each surface's own derived quantities. */
export interface LowStockInput {
  /** Derived closing stock — never stored, always projected from a ledger. */
  closingQty: number
  /** Σ of everything that ever flowed IN (the derived default's denominator). */
  inflowQty: number
  /** Explicit per-item reorder point (#207) — when set it governs outright. */
  reorderLevel?: number | null
}

/** Is this item low? One definition, every surface, server and client. */
export function isLowStock(input: LowStockInput): boolean {
  if (input.reorderLevel != null) return input.closingQty <= input.reorderLevel
  // Zero inflow ⇒ no basis for a percentage (and 0 ≤ 0 would flag every
  // empty row) — never low under the derived default.
  return input.inflowQty > 0 && input.closingQty <= input.inflowQty * LOW_STOCK_INFLOW_FRACTION
}

/**
 * Inflow of a movement log: Σ opening + received + returned. Transfers are
 * deliberately EXCLUDED on both sides (a transfer only moves stock between
 * this project's own locations — it is not new stock), matching the closing
 * equation's own signed-delta terms. One definition, shared by the slice
 * loader and the service's crossing detection.
 */
export function movementInflowQty(
  movements: readonly { type: string; quantity: number }[],
): number {
  return movements.reduce(
    (sum, m) =>
      m.type === 'opening' || m.type === 'received' || m.type === 'returned' ? sum + m.quantity : sum,
    0,
  )
}
