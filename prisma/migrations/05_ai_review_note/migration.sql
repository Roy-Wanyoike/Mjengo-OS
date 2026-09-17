-- AiReviewNote (issue W6-1) — advisory, append-only AI review notes over
-- frozen DrawPacks (the ai.drawReview action writes them; the share GET
-- serves the latest read-only). Additive-only: ONE CREATE TABLE, no existing
-- table is touched (no ALTER/DROP/UPDATE/DELETE/INSERT anywhere in this
-- file). There is no update path and no delete path in Wave-6 code —
-- re-running a review APPENDS a new row (latest wins in the views, history
-- stays queryable). The note gates nothing: AI describes and flags, humans
-- decide — the human decision columns (reviewedBy/reviewedAt/decisionNote)
-- exist and stay null until a human writes them in a later wave.
CREATE TABLE "AiReviewNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "drawPackId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelLabel" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "verdict" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "findings" TEXT NOT NULL DEFAULT '[]',
    "inputsHash" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME,
    "decisionNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiReviewNote_drawPackId_fkey" FOREIGN KEY ("drawPackId") REFERENCES "DrawPack" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiReviewNote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
