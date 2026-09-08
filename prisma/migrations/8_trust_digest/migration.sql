-- TrustDigest (issue W6-2 — Diaspora Trust Digest with voice) — one weekly
-- "what your money did" digest row per (project, language): DETERMINISTIC
-- text composed purely from rows (releases + ledger refs from DrawPack,
-- evidence photo count, the two latest MjengoScore rows for the delta,
-- advisory AI flag counts from AiReviewNote/AiInsight, budget pace from
-- Transaction sums) — ZERO model-authored figures; the model's only job is
-- TTS over the already-composed text (the AiProvider.speak() seam). The
-- TEXT is the product: audioBase64 is NULL when the voice note was never
-- attempted (provider unavailable) or failed, audioStatus records which
-- honestly ('unavailable' | 'failed' | 'ready'), and an audio failure never
-- degrades the text. Additive-only: ONE CREATE TABLE, no existing table is
-- touched (no ALTER/DROP/UPDATE/DELETE/INSERT anywhere in this file).
-- APPEND-ONLY (the MjengoScore/AiReviewNote discipline): no Wave-6 code
-- path updates or deletes a digest row — regenerating APPENDS a new row
-- (latest per (projectId, lang) wins in the read surfaces). Digest rows
-- gate nothing: no action outcome, no score, no money path reads them.
CREATE TABLE "TrustDigest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "windowStart" DATETIME NOT NULL,
    "windowEnd" DATETIME NOT NULL,
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "audioBase64" TEXT,
    "audioMime" TEXT,
    "audioStatus" TEXT NOT NULL DEFAULT 'unavailable',
    "audioError" TEXT,
    "providerId" TEXT,
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrustDigest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
