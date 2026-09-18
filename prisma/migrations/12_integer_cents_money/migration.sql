-- 12_integer_cents_money (issue #122 — DB-1: "the ledger never lies")
--
-- Converts every money column from Float KSh to BigInt INTEGER CENTS
-- (65000.55 KSh → 6500055). Data-preserving table rebuilds: each copy
-- wraps money columns in CAST(ROUND(col * 100) AS INTEGER) — half-away-
-- from-zero, exact for the ≤2-dp values the write paths enforced
-- (money-bounds since #241). Quantities stay REAL (Supabase numeric(18,3)
-- parity). NOT additive-only by necessity: this is the sanctioned type
-- migration the production gate #122 exists for. The 0.005 service-level
-- ledger tolerance is removed in the same change — bigint legs compare
-- exactly.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ApprovalRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "minAmount" BIGINT NOT NULL DEFAULT 0,
    "maxAmount" BIGINT,
    "approverRole" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApprovalRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ApprovalRule" ("active", "approverRole", "createdAt", "id", "maxAmount", "minAmount", "priority", "projectId", "updatedAt") SELECT "active", "approverRole", "createdAt", "id", CAST(ROUND("maxAmount" * 100) AS INTEGER), CAST(ROUND("minAmount" * 100) AS INTEGER), "priority", "projectId", "updatedAt" FROM "ApprovalRule";
DROP TABLE "ApprovalRule";
ALTER TABLE "new_ApprovalRule" RENAME TO "ApprovalRule";
CREATE TABLE "new_Attendance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workerId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "checkIn" DATETIME,
    "checkOut" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'present',
    "method" TEXT NOT NULL DEFAULT 'geofence',
    "wage" BIGINT NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "synced" BOOLEAN NOT NULL DEFAULT true,
    "verification" TEXT NOT NULL DEFAULT 'reported',
    "evidence" TEXT,
    "exceptionReason" TEXT,
    "exceptionNote" TEXT,
    "overrideLog" TEXT,
    "recordedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "Attendance_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Attendance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Attendance" ("checkIn", "checkOut", "createdAt", "date", "evidence", "exceptionNote", "exceptionReason", "id", "method", "overrideLog", "paid", "projectId", "recordedBy", "status", "synced", "verification", "version", "wage", "workerId") SELECT "checkIn", "checkOut", "createdAt", "date", "evidence", "exceptionNote", "exceptionReason", "id", "method", "overrideLog", "paid", "projectId", "recordedBy", "status", "synced", "verification", "version", CAST(ROUND("wage" * 100) AS INTEGER), "workerId" FROM "Attendance";
DROP TABLE "Attendance";
ALTER TABLE "new_Attendance" RENAME TO "Attendance";
CREATE INDEX "Attendance_projectId_date_idx" ON "Attendance"("projectId", "date");
CREATE UNIQUE INDEX "Attendance_workerId_date_key" ON "Attendance"("workerId", "date");
CREATE TABLE "new_BoqLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "boqId" TEXT NOT NULL,
    "materialName" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "estUnitPrice" BIGINT NOT NULL DEFAULT 0,
    "category" TEXT,
    "note" TEXT,
    CONSTRAINT "BoqLine_boqId_fkey" FOREIGN KEY ("boqId") REFERENCES "Boq" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BoqLine" ("boqId", "category", "estUnitPrice", "id", "materialName", "note", "qty", "unit") SELECT "boqId", "category", CAST(ROUND("estUnitPrice" * 100) AS INTEGER), "id", "materialName", "note", "qty", "unit" FROM "BoqLine";
DROP TABLE "BoqLine";
ALTER TABLE "new_BoqLine" RENAME TO "BoqLine";
CREATE TABLE "new_CatalogItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "brand" TEXT,
    "specification" TEXT,
    "unit" TEXT NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "stockQty" REAL NOT NULL DEFAULT 0,
    "minOrderQty" REAL NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CatalogItem_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CatalogItem" ("brand", "category", "createdAt", "id", "minOrderQty", "name", "specification", "stockQty", "supplierId", "unit", "unitPrice", "updatedAt") SELECT "brand", "category", "createdAt", "id", "minOrderQty", "name", "specification", "stockQty", "supplierId", "unit", CAST(ROUND("unitPrice" * 100) AS INTEGER), "updatedAt" FROM "CatalogItem";
DROP TABLE "CatalogItem";
ALTER TABLE "new_CatalogItem" RENAME TO "CatalogItem";
CREATE TABLE "new_Delivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "unitCost" BIGINT NOT NULL,
    "totalCost" BIGINT NOT NULL,
    "supplier" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "rawTranscript" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Delivery_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Delivery_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Delivery" ("createdAt", "date", "id", "materialId", "projectId", "quantity", "rawTranscript", "source", "supplier", "totalCost", "unitCost") SELECT "createdAt", "date", "id", "materialId", "projectId", "quantity", "rawTranscript", "source", "supplier", CAST(ROUND("totalCost" * 100) AS INTEGER), CAST(ROUND("unitCost" * 100) AS INTEGER) FROM "Delivery";
DROP TABLE "Delivery";
ALTER TABLE "new_Delivery" RENAME TO "Delivery";
CREATE TABLE "new_DrawPack" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "milestoneId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "milestoneName" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "ledgerRef" TEXT NOT NULL,
    "ledgerTxnId" TEXT NOT NULL,
    "evidencePhotoIds" TEXT NOT NULL DEFAULT '[]',
    "variationsOpen" TEXT NOT NULL DEFAULT '[]',
    "attendanceSummary" TEXT NOT NULL,
    "mjengoScore" TEXT,
    "contentHash" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DrawPack_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DrawPack_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DrawPack" ("amount", "attendanceSummary", "contentHash", "createdAt", "currency", "evidencePhotoIds", "id", "ledgerRef", "ledgerTxnId", "milestoneId", "milestoneName", "mjengoScore", "projectId", "schemaVersion", "variationsOpen") SELECT CAST(ROUND("amount" * 100) AS INTEGER), "attendanceSummary", "contentHash", "createdAt", "currency", "evidencePhotoIds", "id", "ledgerRef", "ledgerTxnId", "milestoneId", "milestoneName", "mjengoScore", "projectId", "schemaVersion", "variationsOpen" FROM "DrawPack";
DROP TABLE "DrawPack";
ALTER TABLE "new_DrawPack" RENAME TO "DrawPack";
CREATE UNIQUE INDEX "DrawPack_milestoneId_key" ON "DrawPack"("milestoneId");
CREATE TABLE "new_EscrowWallet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "ledgerAccountId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EscrowWallet_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_EscrowWallet" ("balance", "createdAt", "id", "ledgerAccountId", "projectId", "updatedAt") SELECT CAST(ROUND("balance" * 100) AS INTEGER), "createdAt", "id", "ledgerAccountId", "projectId", "updatedAt" FROM "EscrowWallet";
DROP TABLE "EscrowWallet";
ALTER TABLE "new_EscrowWallet" RENAME TO "EscrowWallet";
CREATE UNIQUE INDEX "EscrowWallet_projectId_key" ON "EscrowWallet"("projectId");
CREATE TABLE "new_Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceCode" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "orderId" TEXT,
    "supplierId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "tax" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL DEFAULT 0,
    "dueDate" DATETIME,
    "issuedAt" DATETIME,
    "submittedAt" DATETIME,
    "decidedAt" DATETIME,
    "decidedBy" TEXT,
    "paidAt" DATETIME,
    "paidByRole" TEXT,
    "paymentMethod" TEXT,
    "paymentReference" TEXT,
    "createdBy" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Invoice_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Invoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Invoice" ("createdAt", "createdBy", "decidedAt", "decidedBy", "dueDate", "id", "invoiceCode", "issuedAt", "note", "orderId", "paidAt", "paidByRole", "paymentMethod", "paymentReference", "projectId", "status", "submittedAt", "subtotal", "supplierId", "tax", "total", "updatedAt") SELECT "createdAt", "createdBy", "decidedAt", "decidedBy", "dueDate", "id", "invoiceCode", "issuedAt", "note", "orderId", "paidAt", "paidByRole", "paymentMethod", "paymentReference", "projectId", "status", "submittedAt", CAST(ROUND("subtotal" * 100) AS INTEGER), "supplierId", CAST(ROUND("tax" * 100) AS INTEGER), CAST(ROUND("total" * 100) AS INTEGER), "updatedAt" FROM "Invoice";
DROP TABLE "Invoice";
ALTER TABLE "new_Invoice" RENAME TO "Invoice";
CREATE UNIQUE INDEX "Invoice_projectId_invoiceCode_key" ON "Invoice"("projectId", "invoiceCode");
CREATE TABLE "new_InvoiceLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "lineTotal" BIGINT NOT NULL,
    CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_InvoiceLine" ("id", "invoiceId", "lineTotal", "name", "qty", "unitPrice") SELECT "id", "invoiceId", CAST(ROUND("lineTotal" * 100) AS INTEGER), "name", "qty", CAST(ROUND("unitPrice" * 100) AS INTEGER) FROM "InvoiceLine";
DROP TABLE "InvoiceLine";
ALTER TABLE "new_InvoiceLine" RENAME TO "InvoiceLine";
CREATE TABLE "new_LedgerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "txnId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "memo" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerEntry_txnId_fkey" FOREIGN KEY ("txnId") REFERENCES "LedgerTransaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_LedgerEntry" ("accountId", "amount", "createdAt", "id", "memo", "side", "txnId") SELECT "accountId", CAST(ROUND("amount" * 100) AS INTEGER), "createdAt", "id", "memo", "side", "txnId" FROM "LedgerEntry";
DROP TABLE "LedgerEntry";
ALTER TABLE "new_LedgerEntry" RENAME TO "LedgerEntry";
CREATE INDEX "LedgerEntry_accountId_idx" ON "LedgerEntry"("accountId");
CREATE TABLE "new_Material" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "unitPrice" BIGINT NOT NULL
);
INSERT INTO "new_Material" ("id", "name", "unit", "unitPrice") SELECT "id", "name", "unit", CAST(ROUND("unitPrice" * 100) AS INTEGER) FROM "Material";
DROP TABLE "Material";
ALTER TABLE "new_Material" RENAME TO "Material";
CREATE TABLE "new_Milestone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "phaseId" TEXT,
    "name" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'locked',
    "evidencePhotoIds" TEXT NOT NULL DEFAULT '[]',
    "requestedAt" DATETIME,
    "decidedAt" DATETIME,
    "decidedBy" TEXT,
    "decisionNote" TEXT,
    "releasedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Milestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Milestone" ("amount", "createdAt", "decidedAt", "decidedBy", "decisionNote", "evidencePhotoIds", "id", "name", "phaseId", "projectId", "releasedAt", "requestedAt", "status") SELECT CAST(ROUND("amount" * 100) AS INTEGER), "createdAt", "decidedAt", "decidedBy", "decisionNote", "evidencePhotoIds", "id", "name", "phaseId", "projectId", "releasedAt", "requestedAt", "status" FROM "Milestone";
DROP TABLE "Milestone";
ALTER TABLE "new_Milestone" RENAME TO "Milestone";
CREATE TABLE "new_PaymentRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestCode" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requestedByRole" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "payee" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'mpesa',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    "decisionNote" TEXT,
    "paidAt" DATETIME,
    "paidTxnId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaymentRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PaymentRequest" ("amount", "createdAt", "decidedAt", "decidedBy", "decisionNote", "description", "id", "method", "paidAt", "paidTxnId", "payee", "projectId", "relatedEntityId", "relatedEntityType", "requestCode", "requestedByName", "requestedByRole", "status", "updatedAt") SELECT CAST(ROUND("amount" * 100) AS INTEGER), "createdAt", "decidedAt", "decidedBy", "decisionNote", "description", "id", "method", "paidAt", "paidTxnId", "payee", "projectId", "relatedEntityId", "relatedEntityType", "requestCode", "requestedByName", "requestedByRole", "status", "updatedAt" FROM "PaymentRequest";
DROP TABLE "PaymentRequest";
ALTER TABLE "new_PaymentRequest" RENAME TO "PaymentRequest";
CREATE TABLE "new_Phase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "budget" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progressManual" INTEGER,
    CONSTRAINT "Phase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Phase" ("budget", "id", "name", "order", "progressManual", "projectId", "status") SELECT CAST(ROUND("budget" * 100) AS INTEGER), "id", "name", "order", "progressManual", "projectId", "status" FROM "Phase";
DROP TABLE "Phase";
ALTER TABLE "new_Phase" RENAME TO "Phase";
CREATE TABLE "new_PricePoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialName" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'seed'
);
INSERT INTO "new_PricePoint" ("id", "materialName", "recordedAt", "region", "source", "unitPrice") SELECT "id", "materialName", "recordedAt", "region", "source", CAST(ROUND("unitPrice" * 100) AS INTEGER) FROM "PricePoint";
DROP TABLE "PricePoint";
ALTER TABLE "new_PricePoint" RENAME TO "PricePoint";
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shareToken" TEXT NOT NULL,
    "shareTokenExpiresAt" DATETIME,
    "name" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "clientType" TEXT NOT NULL DEFAULT 'diaspora',
    "location" TEXT NOT NULL,
    "budget" BIGINT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "targetDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Project" ("budget", "client", "clientType", "createdAt", "id", "location", "name", "shareToken", "shareTokenExpiresAt", "startDate", "status", "targetDate", "updatedAt") SELECT CAST(ROUND("budget" * 100) AS INTEGER), "client", "clientType", "createdAt", "id", "location", "name", "shareToken", "shareTokenExpiresAt", "startDate", "status", "targetDate", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_shareToken_key" ON "Project"("shareToken");
CREATE TABLE "new_PurchaseOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderCode" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requestId" TEXT,
    "supplierId" TEXT NOT NULL,
    "subtotal" BIGINT NOT NULL,
    "deliveryFee" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "paymentSource" TEXT NOT NULL DEFAULT 'client',
    "createdByRole" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PurchaseOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrder_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MaterialRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PurchaseOrder" ("createdAt", "createdByRole", "deliveryFee", "id", "note", "orderCode", "paymentSource", "projectId", "requestId", "status", "subtotal", "supplierId", "total", "updatedAt") SELECT "createdAt", "createdByRole", CAST(ROUND("deliveryFee" * 100) AS INTEGER), "id", "note", "orderCode", "paymentSource", "projectId", "requestId", "status", CAST(ROUND("subtotal" * 100) AS INTEGER), "supplierId", CAST(ROUND("total" * 100) AS INTEGER), "updatedAt" FROM "PurchaseOrder";
DROP TABLE "PurchaseOrder";
ALTER TABLE "new_PurchaseOrder" RENAME TO "PurchaseOrder";
CREATE UNIQUE INDEX "PurchaseOrder_projectId_orderCode_key" ON "PurchaseOrder"("projectId", "orderCode");
CREATE TABLE "new_PurchaseOrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "lineTotal" BIGINT NOT NULL,
    CONSTRAINT "PurchaseOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PurchaseOrderLine" ("id", "lineTotal", "name", "orderId", "qty", "unit", "unitPrice") SELECT "id", CAST(ROUND("lineTotal" * 100) AS INTEGER), "name", "orderId", "qty", "unit", CAST(ROUND("unitPrice" * 100) AS INTEGER) FROM "PurchaseOrderLine";
DROP TABLE "PurchaseOrderLine";
ALTER TABLE "new_PurchaseOrderLine" RENAME TO "PurchaseOrderLine";
CREATE TABLE "new_Quote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "deliveryFee" BIGINT NOT NULL DEFAULT 0,
    "transportFee" BIGINT NOT NULL DEFAULT 0,
    "fees" BIGINT NOT NULL DEFAULT 0,
    "totalLanded" BIGINT NOT NULL,
    "deliveryEta" TEXT,
    "validUntil" DATETIME,
    "terms" TEXT,
    "stockOk" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Quote_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MaterialRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Quote_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Quote" ("createdAt", "deliveryEta", "deliveryFee", "fees", "id", "requestId", "status", "stockOk", "supplierId", "terms", "totalLanded", "transportFee", "unitPrice", "updatedAt", "validUntil") SELECT "createdAt", "deliveryEta", CAST(ROUND("deliveryFee" * 100) AS INTEGER), CAST(ROUND("fees" * 100) AS INTEGER), "id", "requestId", "status", "stockOk", "supplierId", "terms", CAST(ROUND("totalLanded" * 100) AS INTEGER), CAST(ROUND("transportFee" * 100) AS INTEGER), CAST(ROUND("unitPrice" * 100) AS INTEGER), "updatedAt", "validUntil" FROM "Quote";
DROP TABLE "Quote";
ALTER TABLE "new_Quote" RENAME TO "Quote";
CREATE TABLE "new_QuoteLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quoteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "lineTotal" BIGINT NOT NULL,
    CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_QuoteLine" ("id", "lineTotal", "name", "qty", "quoteId", "unit", "unitPrice") SELECT "id", CAST(ROUND("lineTotal" * 100) AS INTEGER), "name", "qty", "quoteId", "unit", CAST(ROUND("unitPrice" * 100) AS INTEGER) FROM "QuoteLine";
DROP TABLE "QuoteLine";
ALTER TABLE "new_QuoteLine" RENAME TO "QuoteLine";
CREATE TABLE "new_StockMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "unitCost" BIGINT,
    "reference" TEXT,
    "note" TEXT,
    "recordedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockMovement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_StockMovement" ("createdAt", "id", "inventoryItemId", "note", "projectId", "quantity", "recordedBy", "reference", "type", "unitCost") SELECT "createdAt", "id", "inventoryItemId", "note", "projectId", "quantity", "recordedBy", "reference", "type", CAST(ROUND("unitCost" * 100) AS INTEGER) FROM "StockMovement";
DROP TABLE "StockMovement";
ALTER TABLE "new_StockMovement" RENAME TO "StockMovement";
CREATE INDEX "StockMovement_inventoryItemId_idx" ON "StockMovement"("inventoryItemId");
CREATE TABLE "new_Supplier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessName" TEXT NOT NULL,
    "county" TEXT NOT NULL,
    "town" TEXT,
    "lat" REAL,
    "lng" REAL,
    "phone" TEXT,
    "email" TEXT,
    "warehouseLocation" TEXT,
    "deliveryZones" TEXT NOT NULL DEFAULT '',
    "deliveryFeeBase" BIGINT NOT NULL DEFAULT 0,
    "freeDeliveryOver" BIGINT,
    "minimumOrder" BIGINT NOT NULL DEFAULT 0,
    "verificationState" INTEGER NOT NULL DEFAULT 0,
    "reliabilityScore" INTEGER NOT NULL DEFAULT 50,
    "responseHours" INTEGER NOT NULL DEFAULT 24,
    "operatingHours" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Supplier" ("businessName", "county", "createdAt", "deliveryFeeBase", "deliveryZones", "email", "freeDeliveryOver", "id", "lat", "lng", "minimumOrder", "operatingHours", "phone", "reliabilityScore", "responseHours", "town", "updatedAt", "verificationState", "warehouseLocation") SELECT "businessName", "county", "createdAt", CAST(ROUND("deliveryFeeBase" * 100) AS INTEGER), "deliveryZones", "email", CAST(ROUND("freeDeliveryOver" * 100) AS INTEGER), "id", "lat", "lng", CAST(ROUND("minimumOrder" * 100) AS INTEGER), "operatingHours", "phone", "reliabilityScore", "responseHours", "town", "updatedAt", "verificationState", "warehouseLocation" FROM "Supplier";
DROP TABLE "Supplier";
ALTER TABLE "new_Supplier" RENAME TO "Supplier";
CREATE TABLE "new_Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'mpesa',
    "reference" TEXT,
    "costCode" TEXT,
    "phaseId" TEXT,
    "ledgerTxnId" TEXT,
    "note" TEXT,
    "date" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transaction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "Phase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Transaction" ("amount", "costCode", "createdAt", "date", "id", "ledgerTxnId", "method", "note", "phaseId", "projectId", "reference", "type") SELECT CAST(ROUND("amount" * 100) AS INTEGER), "costCode", "createdAt", "date", "id", "ledgerTxnId", "method", "note", "phaseId", "projectId", "reference", "type" FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
CREATE TABLE "new_VariationOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "phaseId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "budgetImpact" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "submittedBy" TEXT,
    "decidedBy" TEXT,
    "decisionNote" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VariationOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_VariationOrder" ("budgetImpact", "createdAt", "decidedAt", "decidedBy", "decisionNote", "description", "id", "phaseId", "projectId", "status", "submittedBy", "title") SELECT CAST(ROUND("budgetImpact" * 100) AS INTEGER), "createdAt", "decidedAt", "decidedBy", "decisionNote", "description", "id", "phaseId", "projectId", "status", "submittedBy", "title" FROM "VariationOrder";
DROP TABLE "VariationOrder";
ALTER TABLE "new_VariationOrder" RENAME TO "VariationOrder";
CREATE TABLE "new_Worker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "pin" TEXT,
    "dailyRate" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "idNumber" TEXT,
    "employmentType" TEXT,
    "skills" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    CONSTRAINT "Worker_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Worker" ("active", "dailyRate", "emergencyContactName", "emergencyContactPhone", "employmentType", "id", "idNumber", "name", "phone", "pin", "projectId", "role", "skills") SELECT "active", CAST(ROUND("dailyRate" * 100) AS INTEGER), "emergencyContactName", "emergencyContactPhone", "employmentType", "id", "idNumber", "name", "phone", "pin", "projectId", "role", "skills" FROM "Worker";
DROP TABLE "Worker";
ALTER TABLE "new_Worker" RENAME TO "Worker";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

