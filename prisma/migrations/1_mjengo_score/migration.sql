-- MjengoScore (issue W3-3) — deterministic contractor trust score history.
-- Additive-only: one CREATE TABLE, no existing table is touched.
-- Append-only like RiskAssessment — every score.recompute appends a row;
-- no row is ever updated (there is no UPDATE statement anywhere in this file).
CREATE TABLE "MjengoScore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score" INTEGER,
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "components" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "ruleVersion" TEXT NOT NULL DEFAULT 'v1',
    CONSTRAINT "MjengoScore_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
