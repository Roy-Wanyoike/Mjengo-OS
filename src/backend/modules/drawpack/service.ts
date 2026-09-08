// DrawPack module (issue W4-1) — diaspora evidence draw packs.
//
// An immutable, hash-stamped PROOF BUNDLE frozen at the moment a milestone is
// released (milestone.decide → approve): milestone id + amount + the ledger
// transaction that moved the money, the evidence photo ids, the variation
// orders still awaiting the client, an attendance summary for the
// request→decide window, and the MjengoScore as it stood (nullable — honest).
// One pack a diaspora client can keep, forward, or hand to a lender, served
// read-only through the EXISTING revocable share link (GET /api/share?token=
// <t>&drawPack=<id> — no new auth surface).
//
// House rules this module lives by:
//  · PROJECTION, NEVER MONEY — the pack records what the ledger already did.
//    Nothing here posts a ledger row, touches a wallet or writes a
//    Transaction; creating a pack cannot move a shilling.
//  · WRITE ONCE — `DrawPack.milestoneId` is UNIQUE at the schema level, the
//    release status ladder is single-shot, and createDrawPackForRelease
//    short-circuits when a pack already exists. There is NO update function
//    and no delete function; the row is frozen the moment it is written.
//  · FAILURE IS NEVER A MONEY FAILURE — the hook runs AFTER the atomic
//    release has committed. If the pack write fails, the money has already
//    moved and the release stands; the failure is logged loudly (console +
//    a draw_pack audit event) so a human can see a released milestone
//    carries no pack. The action's own result is returned unchanged.
//  · HONEST SCORE — the pack cites MjengoScore only when a score was
//    actually computed (latest row, score non-null). Otherwise the field is
//    explicit null and the view says "not computed" — never a fake 0.
//  · DETERMINISTIC HASH — contentHash = SHA-256 over the canonical JSON of
//    the pack content (recursively key-sorted, no whitespace). Identical
//    inputs → identical hash, so a recomputation of the same inputs can be
//    checked against the frozen row. Timestamps of pack CREATION (id,
//    createdAt) are deliberately OUTSIDE the hashed content.

import { createHash } from 'node:crypto'
import { db } from '@/backend/lib/db'
import { logAudit } from '@/backend/lib/audit'

/** Bump when the pack content shape changes — old rows keep their version. */
export const DRAW_PACK_SCHEMA_VERSION = 1

// ---------------- content types (the hashed snapshot) ----------------

/** A variation order that was awaiting the client when money moved. */
export interface VariationSnapshot {
  id: string
  title: string
  budgetImpact: number
  submittedAt: string // ISO date — frozen
}

/** Attendance counts over the release-request → decision window. */
export interface AttendanceSummary {
  windowStart: string // YYYY-MM-DD (request day; decision day when requestedAt is unknown)
  windowEnd: string // YYYY-MM-DD (decision day)
  rows: number
  present: number
  halfDay: number
  absent: number
  excused: number
  verified: number
}

/** The MjengoScore as it stood at release. Null = not computed (honest). */
export interface ScoreSnapshot {
  score: number
  confidence: string
  ruleVersion: string
  computedAt: string // ISO timestamp of the score row — frozen
}

/** Everything the contentHash covers — and everything a lender needs. */
export interface DrawPackContent {
  v: number
  milestoneId: string
  milestoneName: string
  amount: number
  currency: string
  ledgerRef: string
  ledgerTxnId: string
  evidencePhotoIds: string[]
  variationsOpen: VariationSnapshot[]
  attendance: AttendanceSummary
  mjengoScore: ScoreSnapshot | null
}

// ---------------- canonical JSON + hashing (pure) ----------------

/** Recursively sort object keys — canonical form is key-order independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key])
    return out
  }
  return value
}

/** Deterministic JSON: sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** SHA-256 hex over the canonical JSON of the pack content. */
export function hashDrawPackContent(content: DrawPackContent): string {
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex')
}

// ---------------- row types (what the surfaces read) ----------------

/** Full parsed pack — the share GET response body shape. */
export interface DrawPackDetail {
  id: string
  milestoneId: string
  projectId: string
  milestoneName: string
  amount: number
  currency: string
  ledgerRef: string
  ledgerTxnId: string
  evidencePhotoIds: string[]
  variationsOpen: VariationSnapshot[]
  attendance: AttendanceSummary
  mjengoScore: ScoreSnapshot | null
  contentHash: string
  content: string // canonical JSON string — SHA-256 of this must equal contentHash
  schemaVersion: number
  createdAt: string
}

/** Lightweight link row for the project payload (money-tab links). */
export interface DrawPackLink {
  id: string
  milestoneId: string
  milestoneName: string
  amount: number
  ledgerRef: string
  contentHash: string
  createdAt: string
}

/** Parse a JSON column defensively — malformed stored JSON never 500s a view. */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Parse the JSON evidencePhotoIds column safely (money.ts twin). */
function parseEvidenceIds(raw: string): string[] {
  const v = parseJson<unknown>(raw, [])
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// ---------------- creation (the milestone.decide → approve hook) ----------------

/** Local YYYY-MM-DD (EAT, same convention as lib/mjengo todayStr). */
function dayStr(d: Date): string {
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10)
}

/** Build the pure content snapshot from the decision-time rows. */
export function buildDrawPackContent(input: {
  milestoneId: string
  milestoneName: string
  amount: number
  currency?: string
  ledgerRef: string
  ledgerTxnId: string
  evidencePhotoIds: string[]
  variations: Array<{ id: string; title: string; budgetImpact: number; status: string; createdAt: Date }>
  attendanceRows: Array<{ date: string; status: string; verification: string }>
  requestedAt: Date | null
  decidedAt: Date
  mjengoScore: { score: number | null; confidence: string; ruleVersion: string; computedAt: Date } | null
}): DrawPackContent {
  const windowEnd = dayStr(input.decidedAt)
  // requestedAt is the ladder's own stamp; a legacy row without one falls
  // back honestly to the decision day (a one-day window) — deterministic.
  const windowStart = input.requestedAt ? dayStr(input.requestedAt) : windowEnd
  const inWindow = input.attendanceRows.filter((a) => a.date >= windowStart && a.date <= windowEnd)
  const attendance: AttendanceSummary = {
    windowStart,
    windowEnd,
    rows: inWindow.length,
    present: inWindow.filter((a) => a.status === 'present').length,
    halfDay: inWindow.filter((a) => a.status === 'half_day').length,
    absent: inWindow.filter((a) => a.status === 'absent').length,
    excused: inWindow.filter((a) => a.status === 'excused').length,
    verified: inWindow.filter((a) => a.verification === 'verified').length,
  }
  // Variations open at decision time — deterministic order (createdAt, id).
  const open = input.variations
    .filter((v) => v.status === 'submitted')
    .sort((a, b) =>
      a.createdAt.getTime() !== b.createdAt.getTime()
        ? a.createdAt.getTime() - b.createdAt.getTime()
        : a.id < b.id ? -1 : 1,
    )
    .map<VariationSnapshot>((v) => ({
      id: v.id,
      title: v.title,
      budgetImpact: v.budgetImpact,
      submittedAt: v.createdAt.toISOString(),
    }))
  // Honest score citation: only when the latest row actually computed a
  // number. No row, or a null-score row → explicit null (never a fake 0).
  const score = input.mjengoScore && input.mjengoScore.score !== null
    ? {
        score: input.mjengoScore.score,
        confidence: input.mjengoScore.confidence,
        ruleVersion: input.mjengoScore.ruleVersion,
        computedAt: input.mjengoScore.computedAt.toISOString(),
      }
    : null
  return {
    v: DRAW_PACK_SCHEMA_VERSION,
    milestoneId: input.milestoneId,
    milestoneName: input.milestoneName,
    amount: input.amount,
    currency: input.currency ?? 'KES',
    ledgerRef: input.ledgerRef,
    ledgerTxnId: input.ledgerTxnId,
    evidencePhotoIds: [...input.evidencePhotoIds],
    variationsOpen: open,
    attendance,
    mjengoScore: score,
  }
}

/**
 * Freeze the evidence pack for a JUST-RELEASED milestone. Called from
 * actions/money.ts AFTER releaseMilestoneAtomic has committed (hook only —
 * the release transaction itself is untouched). Never throws: money has
 * already moved; a pack failure is recorded (console + audit) and returns
 * null so the release result flows back unchanged.
 */
export async function createDrawPackForRelease(
  projectId: string,
  input: {
    milestoneId: string
    milestoneName: string
    amount: number
    evidencePhotoIds: string[]
    requestedAt: Date | null
    decidedAt: Date
    ledgerRef: string
    ledgerTxnId: string
    decider: { name: string; role: string }
  },
): Promise<DrawPackDetail | null> {
  try {
    // Defensive idempotency on top of the UNIQUE constraint + the status
    // ladder: a pack already frozen for this milestone is returned as-is —
    // a second pack can never exist, whatever called this.
    const existing = await db.drawPack.findUnique({ where: { milestoneId: input.milestoneId } })
    if (existing) return detailFromRow(existing)

    // Evidence as it was at decision time — the CURRENT frozen
    // evidencePhotoIds of the milestone (the request ladder guarantees ≥1).
    const [variations, attendanceRows, scoreRow] = await Promise.all([
      db.variationOrder.findMany({
        where: { projectId, status: 'submitted' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      db.attendance.findMany({ where: { projectId } }),
      db.mjengoScore.findFirst({ where: { projectId }, orderBy: { computedAt: 'desc' } }),
    ])

    const content = buildDrawPackContent({
      milestoneId: input.milestoneId,
      milestoneName: input.milestoneName,
      amount: input.amount,
      ledgerRef: input.ledgerRef,
      ledgerTxnId: input.ledgerTxnId,
      evidencePhotoIds: input.evidencePhotoIds,
      variations: variations.map((v) => ({
        id: v.id,
        title: v.title,
        budgetImpact: v.budgetImpact,
        status: v.status,
        createdAt: v.createdAt,
      })),
      attendanceRows: attendanceRows.map((a) => ({
        date: a.date,
        status: a.status,
        verification: a.verification,
      })),
      requestedAt: input.requestedAt,
      decidedAt: input.decidedAt,
      mjengoScore: scoreRow
        ? {
            score: scoreRow.score,
            confidence: scoreRow.confidence,
            ruleVersion: scoreRow.ruleVersion,
            computedAt: scoreRow.computedAt,
          }
        : null,
    })
    const contentHash = hashDrawPackContent(content)

    const row = await db.drawPack.create({
      data: {
        milestoneId: input.milestoneId,
        projectId,
        milestoneName: input.milestoneName,
        amount: input.amount,
        currency: content.currency,
        ledgerRef: input.ledgerRef,
        ledgerTxnId: input.ledgerTxnId,
        evidencePhotoIds: JSON.stringify(content.evidencePhotoIds),
        variationsOpen: JSON.stringify(content.variationsOpen),
        attendanceSummary: JSON.stringify(content.attendance),
        mjengoScore: content.mjengoScore ? JSON.stringify(content.mjengoScore) : null,
        contentHash,
        schemaVersion: DRAW_PACK_SCHEMA_VERSION,
      },
    })

    // Audit event for pack creation (the action's own milestone.decide event
    // is written separately by applyAction — this one is the pack's own
    // record, entity-scoped to the DrawPack row). logAudit never throws.
    await logAudit(
      projectId,
      'draw_pack',
      { name: input.decider.name, role: input.decider.role },
      `Evidence draw pack frozen for milestone "${input.milestoneName}" — ${content.evidencePhotoIds.length} evidence photo(s), ledger ${input.ledgerRef}, hash ${contentHash.slice(0, 12)}…`,
      {
        type: 'draw_pack.create',
        milestoneId: input.milestoneId,
        drawPackId: row.id,
        contentHash,
        schemaVersion: DRAW_PACK_SCHEMA_VERSION,
      },
      { entity: 'DrawPack', entityId: row.id },
    )
    return detailFromRow(row)
  } catch (e) {
    // Money already moved — the release stands. Record the failure loudly.
    console.error('[draw-pack] failed to freeze the evidence pack for milestone', input.milestoneId, e)
    await logAudit(
      projectId,
      'draw_pack',
      { name: input.decider.name, role: input.decider.role },
      `Evidence draw pack FAILED to freeze for milestone "${input.milestoneName}" — the release stands, the pack is missing; check server logs`,
      { type: 'draw_pack.create_failed', milestoneId: input.milestoneId, errorClass: e instanceof Error ? e.constructor.name : 'unknown' },
    )
    return null
  }
}

// ---------------- reads (share GET + project payload) ----------------

/** A raw DrawPack row as Prisma returns it. */
interface DrawPackRow {
  id: string
  milestoneId: string
  projectId: string
  milestoneName: string
  amount: number
  currency: string
  ledgerRef: string
  ledgerTxnId: string
  evidencePhotoIds: string
  variationsOpen: string
  attendanceSummary: string
  mjengoScore: string | null
  contentHash: string
  schemaVersion: number
  createdAt: Date | string
}

/** Row → parsed detail (content JSON regenerated from the frozen columns). */
function detailFromRow(row: DrawPackRow): DrawPackDetail {
  const evidencePhotoIds = parseEvidenceIds(row.evidencePhotoIds)
  const variationsOpen = parseJson<VariationSnapshot[]>(row.variationsOpen, [])
  const attendance = parseJson<AttendanceSummary>(row.attendanceSummary, {
    windowStart: '', windowEnd: '', rows: 0, present: 0, halfDay: 0, absent: 0, excused: 0, verified: 0,
  })
  const mjengoScore = parseJson<ScoreSnapshot | null>(row.mjengoScore, null)
  const content: DrawPackContent = {
    v: row.schemaVersion,
    milestoneId: row.milestoneId,
    milestoneName: row.milestoneName,
    amount: row.amount,
    currency: row.currency,
    ledgerRef: row.ledgerRef,
    ledgerTxnId: row.ledgerTxnId,
    evidencePhotoIds,
    variationsOpen,
    attendance,
    mjengoScore,
  }
  return {
    id: row.id,
    milestoneId: row.milestoneId,
    projectId: row.projectId,
    milestoneName: row.milestoneName,
    amount: row.amount,
    currency: row.currency,
    ledgerRef: row.ledgerRef,
    ledgerTxnId: row.ledgerTxnId,
    evidencePhotoIds,
    variationsOpen,
    attendance,
    mjengoScore,
    contentHash: row.contentHash,
    content: canonicalJson(content),
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString(),
  }
}

/**
 * The pack for a share-link reader: the token is already validated by the
 * route (the project IS the token's project), the pack is pinned to that
 * project. Returns null for an unknown id or a pack belonging to a different
 * project — the route answers the standard share 404 family. Current
 * evidence photo rows ride along as VIEW data (id/url/caption) so the
 * printable view renders with no second round-trip; the frozen pack itself
 * only ever cites ids.
 */
export async function getDrawPackForShare(
  projectId: string,
  packId: string,
): Promise<{
  pack: DrawPackDetail
  photos: Array<{ id: string; url: string; caption: string | null }>
} | null> {
  const row = await db.drawPack.findFirst({ where: { id: packId, projectId } })
  if (!row) return null
  const pack = detailFromRow(row)
  let photos: Array<{ id: string; url: string; caption: string | null }> = []
  if (pack.evidencePhotoIds.length) {
    const rows = await db.sitePhoto.findMany({
      where: { projectId, id: { in: pack.evidencePhotoIds } },
      select: { id: true, url: true, caption: true },
    })
    photos = rows.map((p) => ({ id: p.id, url: p.url, caption: p.caption }))
  }
  return { pack, photos }
}

/** Link rows for getProjectPayload — released milestones in money-tab link their packs through these. */
export async function loadDrawPacks(projectId: string): Promise<DrawPackLink[]> {
  const rows = await db.drawPack.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, milestoneId: true, milestoneName: true, amount: true, ledgerRef: true, contentHash: true, createdAt: true,
    },
  })
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
  }))
}
