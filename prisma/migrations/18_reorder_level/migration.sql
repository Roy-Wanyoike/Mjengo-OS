-- #207: per-item low-stock threshold on InventoryItem. Nullable by design —
-- null keeps the documented derived default (closing ≤ 10% of everything
-- that ever flowed in; modules/inventory/low-stock.ts). No backfill: every
-- existing item keeps the derived default until an operator sets a level
-- through inventory.open / inventory.receive.
ALTER TABLE "InventoryItem" ADD COLUMN "reorderLevel" INTEGER;
