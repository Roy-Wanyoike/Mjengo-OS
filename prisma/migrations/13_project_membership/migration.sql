-- ProjectMembership (issue #174 — SEC-6: site-team read scoping) — one row
-- = one user's grant to work on one project in a role. Read paths resolve
-- the membership set for supervisor/procurement/qs/finance sessions
-- (src/backend/lib/membership-scope.ts) and scope to EXACTLY that set —
-- fail closed: zero rows = the honest empty portfolio, never everything;
-- contractor/admin keep the explicit portfolio-wide grant.
-- ADDITIVE-ONLY: ONE CREATE TABLE + its unique/index statements — no
-- existing table is touched (no ALTER/DROP/UPDATE/DELETE/INSERT anywhere in
-- this file). Folder order note: 13_ sorts after 12_integer_cents_money and
-- the zero-padded 00-09 wave (the fresh-deploy lexicographic fix from #122).
-- CreateTable
CREATE TABLE "ProjectMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectMembership_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMembership_userId_projectId_key" ON "ProjectMembership"("userId", "projectId");

-- CreateIndex
CREATE INDEX "ProjectMembership_projectId_idx" ON "ProjectMembership"("projectId");
