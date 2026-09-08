-- Supplier-side portal (issue W5-3) — link a supplier-role User account to the
-- Supplier row it operates. Additive-only: ONE ALTER TABLE ADD COLUMN, no
-- existing data is touched (every existing row gets NULL = "not a supplier
-- account", which fails closed at session shaping). Deliberately a PLAIN
-- scalar column, not a FK relation: the house rule for additive migrations is
-- CREATE TABLE / ALTER TABLE ADD COLUMN only — a constraint would need an
-- ADD CONSTRAINT statement. A dangling supplierId is rejected honestly by the
-- guard ("Supplier account has no supplier linked"), never silently ignored.
ALTER TABLE "User" ADD COLUMN "supplierId" TEXT;
