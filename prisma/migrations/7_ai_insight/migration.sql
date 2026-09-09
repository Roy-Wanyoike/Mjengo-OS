-- AiInsight (issue W6-3 — Evidence Authenticity Screen) — one ADVISORY finding
-- from the authenticity screen: a dHash duplicate hit (source 'dhash', rule-
-- computed, deterministic) or a vision phase-consistency/render-tell flag
-- (source 'vision', model-computed, confidence-labeled). Additive-only: ONE
-- CREATE TABLE + its project FK, no existing table is touched. Append-only:
-- no Wave-6 code path updates or deletes an insight row, and the
-- human-decision columns (decidedBy/decision/decidedAt) are present-but-NULL
-- BY CONTRACT — AI describes and flags, it NEVER approves; the decide action
-- is an explicit Wave-7 follow-up. Insight rows gate nothing: no action
-- outcome, no score, no money path reads them (grep-pinned in tests).
CREATE TABLE "AiInsight" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "packId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "detail" TEXT NOT NULL,
    "confidence" TEXT,
    "decidedBy" TEXT,
    "decision" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiInsight_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
