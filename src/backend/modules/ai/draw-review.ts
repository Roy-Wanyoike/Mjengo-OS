// AI module — draw review engine (W6-1, the first feature on the 8-f seam).
//
// AI DRAW REVIEW: for one RELEASED milestone's frozen DrawPack, run
//   (a) ONE VISION PASS over the pack's capped evidence-photo set
//       (DrawPack.evidencePhotoIds → SitePhoto rows → bytes → data URLs —
//       the analyze-photo byte-resolution pattern: driver keyFor/read first,
//       then the legacy public-path readFile), and
//   (b) ONE LLM CROSS-CHECK (chat) against the pack's own frozen context
//       (milestone name/amount/ledgerRef, variations open, attendance window,
//       MjengoScore-at-release) plus live context (invoice 3-way-match
//       verdicts via modules/invoices/three-way.ts + phase budget vs ledger
//       spend),
// parse the model output into a structured, confidence-labeled ADVISORY note,
// and append ONE AiReviewNote row.
//
// House rules (every one is test-pinned in tests/unit/ai-draw-review.test.ts):
//   · AI NEVER APPROVES — the note gates nothing. milestone.decide, payments
//     and every other action are blind to AiReviewNote rows (the grep-level
//     non-influence test). The approval click stays human.
//   · THE LEDGER DECIDES NUMBERS — the numbers in the prompt are the rows
//     (pack snapshot, invoice verdicts, budget math); the numbers in the
//     stored note are model-FREE: redactModelFigures() strips every digit run
//     from model-authored text before storage, and every figure the surfaces
//     render next to a note comes from the rows via inputsHash. The model
//     describes; rows decide.
//   · APPEND-ONLY — re-running a review APPENDS a new note (latest wins in
//     the share/view surfaces, history stays queryable — the MjengoScore
//     pattern). No Wave-6 code path updates or deletes a note.
//   · FAIL-CLOSED, NO FAKED ANALYSIS — flag off → honest refusal; provider
//     null (SDK cannot instantiate) → honest "unavailable"; provider error /
//     timeout / empty / unparseable output → honest failure. In EVERY failed
//     state NO row is written (a faked analysis is impossible by
//     construction).
//   · HUMAN DECISION COLUMNS STAY NULL — reviewedBy/reviewedAt/decisionNote
//     exist on the row and are never written here (AI flags, humans decide).
//   · CAPPED INPUTS — MAX_VISION_PHOTOS (6) and MAX_CONTEXT_INVOICES (8)
//     bound every prompt so a pack can never blow the route budget.
//   · RULE_VERSION — the prompt + parse contract is versioned; old rows keep
//     their version (the intel engine convention).
//
// AUDIT: this module never logs manually — the action path (applyAction →
// lib/mjengo logAudit, kind 'ai_review') writes exactly one audit event per
// SUCCESSFUL run; a failed run writes nothing.
//
// Deviation note (logged in the worklog): the wave6-plan specced a dedicated
// POST /api/ai/draw-review route; the task direction wires the same engine as
// action `ai.drawReview` (actions/ai.ts → /api/actions), which inherits the
// route's session/role/idempotency/rate-limit contract and the shared flag
// family gate (lib/action-flag-gate.ts — enforced on /api/actions AND
// /api/sync per item, the S1 discipline) instead of a bespoke 10/min bucket.

import { createHash } from 'node:crypto'
import { readFile } from 'fs/promises'
import path from 'node:path'
import { db } from '@/backend/lib/db'
import { getDrawPackForShare, canonicalJson } from '@/backend/modules/drawpack/service'
import { threeWayCheck } from '@/backend/modules/invoices/service'
import { getFlags } from '@/backend/modules/intel/flags'
import { getStorageDriver } from '@/backend/lib/storage'
import { resolveAiProvider } from './provider'

/** Bump when the prompt or parse contract changes — old rows keep their version. */
export const AI_DRAW_REVIEW_RULE_VERSION = 1

/**
 * Cap on the evidence photos sent to ONE vision call (the first N of the
 * pack's frozen evidencePhotoIds, in pack order). Documented and test-pinned:
 * a pack with 40 photos costs the same vision call as a pack with 6.
 */
export const MAX_VISION_PHOTOS = 6

/** Cap on the invoices whose 3-way verdicts ride the cross-check prompt. */
export const MAX_CONTEXT_INVOICES = 8

/** Length caps for stored model text (advisory prose, not a document store). */
const MAX_SUMMARY_CHARS = 500
const MAX_FINDING_CHARS = 400
const MAX_FINDINGS = 10
const MAX_FINDING_CATEGORY_CHARS = 40

// ---------------- note types ----------------

/** One advisory finding — model-authored text with figures redacted. */
export interface AiReviewFinding {
  category: string // e.g. 'evidence' | 'schedule' | 'cost' | 'quality' | 'general'
  severity: 'info' | 'warning' | 'critical'
  text: string
}

/** The parsed, persisted note (the share GET + viewer shape). */
export interface AiReviewNoteDetail {
  id: string
  drawPackId: string
  projectId: string
  providerId: string
  modelLabel: string
  ruleVersion: number
  verdict: string // 'consistent' | 'advisory' | 'escalate'
  summary: string
  confidence: string // 'low' | 'medium' | 'high'
  findings: AiReviewFinding[]
  inputsHash: string
  /** Human decision columns — present, NEVER written by Wave-6 code. */
  reviewedBy: string | null
  reviewedAt: string | null
  decisionNote: string | null
  createdAt: string
}

/**
 * The honest outcome of one review run — never thrown, always returned:
 *   { ok: true, note }                       — one append-only row written.
 *   { ok: false, unavailable: false, error } — refused or failed honestly
 *                                              (flag off, provider error,
 *                                              unparseable output, no pack).
 *   { ok: false, unavailable: true, error }  — the provider itself could not
 *                                              be reached (SDK/config missing)
 *                                              — the honest "AI unavailable"
 *                                              state, distinct from a failed
 *                                              attempt. NO row in either case.
 */
export type DrawReviewOutcome =
  | { ok: true; note: AiReviewNoteDetail }
  | { ok: false; unavailable: boolean; error: string }

// ---------------- pure helpers (test-pinned) ----------------

/**
 * Redact every digit run from model-authored text (the "the ledger decides
 * numbers" rule, made mechanical): 'KSh 650,000' → 'KSh #', 'phase 2' →
 * 'phase #'. The deterministic context rendered next to a note carries every
 * real figure; the model's prose carries none.
 */
export function redactModelFigures(text: string): string {
  return text.replace(/\d[\d.,]*/g, '#')
}

/** First '{' to last '}' JSON.parse — strict-ish extraction, null on failure. */
function parseModelJson(text: string): Record<string, unknown> | null {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first === -1 || last <= first) return null
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(first, last + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * The deterministic hash inputs: the EXACT rows fed to the model (frozen pack
 * content + live invoice verdicts + budget math). SHA-256 over canonical JSON
 * — same rows in, same hash out (the DrawPack contentHash discipline).
 * Timestamps of note CREATION are outside the hashed content.
 */
export interface ReviewInputs {
  v: number
  pack: {
    milestoneId: string
    milestoneName: string
    amount: number
    currency: string
    ledgerRef: string
    ledgerTxnId: string
    evidencePhotoIds: string[]
    visionPhotoIds: string[]
    variationsOpen: Array<{ id: string; title: string; budgetImpact: number }>
    attendance: { windowStart: string; windowEnd: string; rows: number; present: number }
    mjengoScore: { score: number; confidence: string } | null
  }
  invoices: Array<{ code: string; status: string; mode: string; mismatches: number }>
  budget: {
    phaseBudgets: Array<{ name: string; budget: number }>
    totalSpent: number
    transactionCount: number
  }
}

/** SHA-256 hex over the canonical JSON of the review inputs (deterministic). */
export function hashReviewInputs(inputs: ReviewInputs): string {
  return createHash('sha256').update(canonicalJson(inputs), 'utf8').digest('hex')
}

// ---------------- photo byte resolution (the analyze-photo pattern) ----------------

/**
 * Resolve one evidence photo to a vision-input address: a data: URL (bytes we
 * hold), an https: URL (a driver public URL — the vision API fetches it), or
 * null when neither the storage driver nor the local public tree can produce
 * bytes (an honest miss — the caller skips the photo, never guesses).
 */
async function resolvePhotoInput(url: string): Promise<string | null> {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (/^https:\/\//i.test(raw)) return raw

  if (raw.startsWith('/')) {
    // Issue #37 read seam first: the active driver reverses its own URL shape
    // (local-disk /photos/<key>, /docs/<key>) and reads the bytes back.
    const driver = getStorageDriver()
    if (typeof driver.keyFor === 'function' && typeof driver.read === 'function') {
      const key = driver.keyFor(raw)
      if (key) {
        const stored = await driver.read(key).catch(() => null)
        if (stored && stored.bytes && stored.bytes.length > 0) {
          return `data:${stored.contentType ?? 'image/jpeg'};base64,${stored.bytes.toString('base64')}`
        }
      }
    }
    // Legacy local-disk fallback (the analyze-photo byte pattern): rows that
    // predate the driver seam (or foreign shapes) read straight off public/.
    // '..' is stripped — a URL is a path we read, never a traversal vector.
    const safe = raw.replace(/\.\./g, '')
    const filePath = path.join(process.cwd(), 'public', safe.startsWith('/') ? safe.slice(1) : safe)
    const buf = await readFile(filePath).catch(() => null)
    if (buf && buf.length > 0) {
      const mime = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
      return `data:${mime};base64,${buf.toString('base64')}`
    }
  }
  return null
}

// ---------------- the engine ----------------

/**
 * Run one AI draw review for a frozen pack (action `ai.drawReview`).
 * `drawPackId` or `milestoneId` (resolved to its unique pack) identifies the
 * pack; it must belong to `projectId` and its milestone must be RELEASED —
 * the review runs over frozen release evidence, never before money moved.
 */
export async function runDrawReview(input: {
  projectId: string
  drawPackId?: string
  milestoneId?: string
}): Promise<DrawReviewOutcome> {
  // ---- resolve the pack (unique per milestone, pinned to the project) ----
  let packId = typeof input.drawPackId === 'string' && input.drawPackId ? input.drawPackId : null
  if (!packId && typeof input.milestoneId === 'string' && input.milestoneId) {
    const byMilestone = await db.drawPack.findUnique({ where: { milestoneId: input.milestoneId } })
    packId = byMilestone?.id ?? null
  }
  if (!packId) {
    return {
      ok: false,
      unavailable: false,
      error: 'No draw pack found — a pack is frozen only when a milestone is released, and the review runs over that frozen evidence',
    }
  }
  const found = await getDrawPackForShare(input.projectId, packId)
  if (!found) {
    return {
      ok: false,
      unavailable: false,
      error: 'Draw pack not found (unknown id, or it belongs to another project)',
    }
  }
  const { pack, photos } = found

  // ---- RELEASED check (defense in depth: a pack implies a release, but the
  // review states its precondition honestly rather than assuming it) ----
  const milestone = await db.milestone.findUnique({ where: { id: pack.milestoneId } })
  if (!milestone || milestone.status !== 'released') {
    return {
      ok: false,
      unavailable: false,
      error: 'The milestone behind this draw pack is not released — AI review runs only over frozen release evidence',
    }
  }

  // ---- flag gate (fail-closed; the SDK is never contacted while off) ----
  const flags = await getFlags()
  if (flags.ai !== true) {
    return {
      ok: false,
      unavailable: false,
      error: 'AI draw review refused — the ai feature flag is off (an admin can enable it from the flags popover in the header)',
    }
  }
  const provider = resolveAiProvider(flags)
  if (!provider) {
    // Unreachable when flags.ai is true (resolveAiProvider constructs a
    // ZaiProvider) — but the honest shape is the honest shape: no provider,
    // no review, no row.
    return {
      ok: false,
      unavailable: true,
      error: 'AI unavailable — the AI provider could not be initialized; nothing was recorded',
    }
  }

  // ---- assemble the exact rows the review runs over ----
  const visionPhotoIds = pack.evidencePhotoIds.slice(0, MAX_VISION_PHOTOS)
  const photoInputs: string[] = []
  for (const photoId of visionPhotoIds) {
    const row = photos.find((p) => p.id === photoId)
    if (!row) continue
    const address = await resolvePhotoInput(row.url)
    if (address) photoInputs.push(address)
  }
  if (photoInputs.length === 0) {
    return {
      ok: false,
      unavailable: false,
      error: 'No readable evidence photos for this draw pack — the vision pass was not sent and nothing was recorded',
    }
  }

  const invoiceRows = await db.invoice.findMany({
    where: { projectId: input.projectId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const invoiceVerdicts: Array<{ code: string; status: string; mode: string; mismatches: number }> = []
  for (const inv of invoiceRows.slice(0, MAX_CONTEXT_INVOICES)) {
    const report = await threeWayCheck(input.projectId, { id: inv.id })
    invoiceVerdicts.push({
      code: inv.invoiceCode,
      status: inv.status,
      mode: report.mode,
      mismatches: report.mismatches.length,
    })
  }

  const [phaseRows, txnRows] = await Promise.all([
    db.phase.findMany({
      where: { projectId: input.projectId },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
      select: { name: true, budget: true },
    }),
    db.transaction.findMany({ where: { projectId: input.projectId }, select: { amount: true } }),
  ])
  const budget = {
    phaseBudgets: phaseRows.map((p) => ({ name: p.name, budget: p.budget })),
    totalSpent: txnRows.reduce((s, t) => s + t.amount, 0),
    transactionCount: txnRows.length,
  }

  const reviewInputs: ReviewInputs = {
    v: AI_DRAW_REVIEW_RULE_VERSION,
    pack: {
      milestoneId: pack.milestoneId,
      milestoneName: pack.milestoneName,
      amount: pack.amount,
      currency: pack.currency,
      ledgerRef: pack.ledgerRef,
      ledgerTxnId: pack.ledgerTxnId,
      evidencePhotoIds: pack.evidencePhotoIds,
      visionPhotoIds,
      variationsOpen: pack.variationsOpen.map((v) => ({ id: v.id, title: v.title, budgetImpact: v.budgetImpact })),
      attendance: {
        windowStart: pack.attendance.windowStart,
        windowEnd: pack.attendance.windowEnd,
        rows: pack.attendance.rows,
        present: pack.attendance.present,
      },
      mjengoScore: pack.mjengoScore ? { score: pack.mjengoScore.score, confidence: pack.mjengoScore.confidence } : null,
    },
    invoices: invoiceVerdicts,
    budget,
  }
  const inputsHash = hashReviewInputs(reviewInputs)

  // ---- (a) the vision pass — describe the evidence photos ----
  const visionPrompt = [
    'You are a senior construction site inspector reviewing EVIDENCE PHOTOS for a milestone draw payment on a residential build in Kenya (machine-cut stone masonry).',
    `The milestone is "${pack.milestoneName}" — the money was released against these frozen photos.`,
    '',
    `Photos: ${photoInputs.length} (the platform capped the set at the first ${MAX_VISION_PHOTOS} of the pack).`,
    'Describe what is actually visible. Do NOT state amounts, quantities or dates in your text — the platform ledger provides every number; you provide observations.',
    '',
    'Respond with STRICT JSON only (no markdown):',
    '{',
    '  "observations": ["3-6 short factual observations of what is visible: wall courses, formwork, openings, ring beam, materials on site, etc."],',
    '  "photoQuality": ["short notes on any photo that is blurry, dark or uninformative, or an empty array"],',
    '  "workmanship": ["0-3 short visible workmanship or safety concerns, or an empty array"],',
    '  "summary": "<one-line description of the work shown>"',
    '}',
    'Be conservative and evidence-based. If a photo shows nothing useful, say so.',
  ].join('\n')
  const visionResult = await provider.vision(visionPrompt, photoInputs)
  if (visionResult === null) {
    return {
      ok: false,
      unavailable: true,
      error: 'AI unavailable — the AI provider could not be initialized (SDK configuration missing); nothing was recorded',
    }
  }
  if (!visionResult.ok) {
    return { ok: false, unavailable: false, error: `AI vision pass failed (${visionResult.error}) — nothing was recorded` }
  }
  const visionJson = parseModelJson(visionResult.text)
  if (!visionJson) {
    return { ok: false, unavailable: false, error: 'AI vision response was not parseable JSON — nothing was recorded' }
  }
  const observations = [
    ...asTextArray(visionJson.observations, 6),
    ...asTextArray(visionJson.photoQuality, 3).map((t) => `photo quality: ${t}`),
    ...asTextArray(visionJson.workmanship, 3).map((t) => `workmanship: ${t}`),
  ]
  const visionSummary = typeof visionJson.summary === 'string' ? visionJson.summary.trim().slice(0, 300) : ''

  // ---- (b) the LLM cross-check — evidence + money context → verdict ----
  const moneyLines = [
    `Milestone: "${pack.milestoneName}" — ${pack.amount.toLocaleString('en-KE')} ${pack.currency} released against ledger ref ${pack.ledgerRef}.`,
    `Variations awaiting the client at decision time: ${pack.variationsOpen.length ? pack.variationsOpen.map((v) => `"${v.title}" (${v.budgetImpact >= 0 ? '+' : '−'}${Math.abs(v.budgetImpact).toLocaleString('en-KE')})`).join('; ') : 'none'}.`,
    `Attendance over the request→decision window (${pack.attendance.windowStart} → ${pack.attendance.windowEnd}): ${pack.attendance.rows} day-rows, ${pack.attendance.present} present.`,
    pack.mjengoScore
      ? `MjengoScore at release: ${pack.mjengoScore.score}/100 (confidence ${pack.mjengoScore.confidence}).`
      : 'MjengoScore at release: not computed.',
    invoiceVerdicts.length
      ? `Invoice 3-way-match verdicts: ${invoiceVerdicts.map((i) => `${i.code} (${i.status}, ${i.mode}, ${i.mismatches} open item(s))`).join('; ')}.`
      : 'Invoice 3-way-match verdicts: no invoices on record for this project.',
    `Budget context: phase budgets ${budget.phaseBudgets.map((p) => `${p.name} ${p.budget.toLocaleString('en-KE')}`).join(', ') || 'none'}; total ledger spend ${budget.totalSpent.toLocaleString('en-KE')} across ${budget.transactionCount} transaction(s).`,
  ]
  const chatPrompt = [
    'You are the draw-review cross-checker for a Kenyan construction escrow platform. A milestone draw was ALREADY released (a human approved it; you did not). Your job is an advisory review: does the evidence look consistent with the money that moved?',
    'You NEVER approve or reject anything — a human reads your note and decides. Your text must not state figures; the platform supplies every number.',
    '',
    'FROZEN PACK CONTEXT (from the platform ledger — authoritative):',
    ...moneyLines.map((l) => `- ${l}`),
    '',
    'VISION OBSERVATIONS (from the evidence photos):',
    ...observations.map((o) => `- ${o}`),
    visionSummary ? `- overall: ${visionSummary}` : '',
    '',
    'Respond with STRICT JSON only (no markdown):',
    '{',
    '  "verdict": "consistent" | "advisory" | "escalate" — consistent: evidence matches the released scope; advisory: minor gaps a human should look at; escalate: a serious inconsistency a human MUST look at',
    '  "confidence": "low" | "medium" | "high" — your honest confidence in your own verdict',
    '  "summary": "<one-line advisory summary — no figures>"',
    '  "findings": [{"category": "<evidence|schedule|cost|quality|general>", "severity": "<info|warning|critical>", "text": "<short advisory finding — no figures>"}]',
    '}',
    'Describe patterns, never people. If you are uncertain, lower the confidence. Findings may be empty.',
  ]
    .filter((l) => l !== '')
    .join('\n')

  const chatResult = await provider.chat([
    { role: 'system', content: 'You are an advisory construction draw reviewer. You describe and flag; you never approve, and a human always decides.' },
    { role: 'user', content: chatPrompt },
  ])
  if (chatResult === null) {
    return {
      ok: false,
      unavailable: true,
      error: 'AI unavailable — the AI provider could not be initialized (SDK configuration missing); nothing was recorded',
    }
  }
  if (!chatResult.ok) {
    return { ok: false, unavailable: false, error: `AI cross-check failed (${chatResult.error}) — nothing was recorded` }
  }
  const verdictJson = parseModelJson(chatResult.text)
  if (!verdictJson) {
    return { ok: false, unavailable: false, error: 'AI review response was not parseable JSON — nothing was recorded' }
  }

  // ---- sanitize the model output into the stored note (never trusted) ----
  const verdict =
    verdictJson.verdict === 'consistent' || verdictJson.verdict === 'escalate'
      ? verdictJson.verdict
      : 'advisory'
  const confidence =
    verdictJson.confidence === 'medium' || verdictJson.confidence === 'high' ? verdictJson.confidence : 'low'
  const summary = redactModelFigures(asText(verdictJson.summary) ?? visionSummary ?? '').slice(0, MAX_SUMMARY_CHARS)
  const findings: AiReviewFinding[] = sanitizeFindings(verdictJson.findings)

  // ---- append the note (the ONLY write; append-only by construction) ----
  const row = await db.aiReviewNote.create({
    data: {
      drawPackId: pack.id,
      projectId: input.projectId,
      providerId: provider.id,
      modelLabel: provider.label,
      ruleVersion: AI_DRAW_REVIEW_RULE_VERSION,
      verdict,
      summary,
      confidence,
      findings: JSON.stringify(findings),
      inputsHash,
      // Human decision columns deliberately absent — they stay null.
    },
  })
  return { ok: true, note: noteFromRow(row) }
}

// ---------------- reads (share GET + viewer) ----------------

/** A raw AiReviewNote row as the (test) stub or Prisma returns it. */
interface AiReviewNoteRow {
  id: string
  drawPackId: string
  projectId: string
  providerId: string
  modelLabel: string
  ruleVersion: number
  verdict: string
  summary: string
  confidence: string
  findings: string
  inputsHash: string
  reviewedBy: string | null
  reviewedAt: Date | string | null
  decisionNote: string | null
  createdAt: Date | string
}

/** Row → parsed detail (never throws; malformed stored JSON degrades honestly). */
function noteFromRow(row: AiReviewNoteRow): AiReviewNoteDetail {
  let findings: AiReviewFinding[] = []
  try {
    const parsed: unknown = JSON.parse(row.findings ?? '[]')
    if (Array.isArray(parsed)) {
      findings = parsed
        .map((item) => {
          const f = (item ?? {}) as Record<string, unknown>
          const severity = f.severity === 'warning' || f.severity === 'critical' ? f.severity : 'info'
          return {
            category: typeof f.category === 'string' ? f.category : 'general',
            severity,
            text: typeof f.text === 'string' ? f.text : '',
          } satisfies AiReviewFinding
        })
        .filter((f) => f.text !== '')
    }
  } catch {
    findings = []
  }
  return {
    id: row.id,
    drawPackId: row.drawPackId,
    projectId: row.projectId,
    providerId: row.providerId,
    modelLabel: row.modelLabel,
    ruleVersion: row.ruleVersion,
    verdict: row.verdict,
    summary: row.summary,
    confidence: row.confidence,
    findings,
    inputsHash: row.inputsHash,
    reviewedBy: row.reviewedBy ?? null,
    reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null,
    decisionNote: row.decisionNote ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

/**
 * The LATEST note for one pack (append-only history, latest wins — the
 * MjengoScore read pattern). Read-only: the share GET draw-pack branch serves
 * it through the same revocable token as the pack itself.
 */
export async function loadLatestAiReviewNote(drawPackId: string): Promise<AiReviewNoteDetail | null> {
  const row = await db.aiReviewNote.findFirst({
    where: { drawPackId },
    orderBy: { createdAt: 'desc' },
  })
  return row ? noteFromRow(row) : null
}

// ---------------- small parse helpers ----------------

function asText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Model-provided string lists (observations/quality/workmanship): trimmed, capped. */
function asTextArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
    .slice(0, cap)
}

/**
 * Model-provided findings list → the stored shape: every field sanitized
 * (severity/category to their enums, figures redacted, lengths capped) and
 * empty-text findings dropped. The model is never trusted — this is the
 * only path its output takes into a row.
 */
function sanitizeFindings(v: unknown): AiReviewFinding[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .slice(0, MAX_FINDINGS)
    .map((f): AiReviewFinding => {
      const rawText = typeof f.text === 'string' ? f.text : ''
      const rawCategory = typeof f.category === 'string' && f.category.trim() ? f.category.trim() : 'general'
      const rawSeverity = typeof f.severity === 'string' ? f.severity : 'info'
      const severity: AiReviewFinding['severity'] =
        rawSeverity === 'warning' || rawSeverity === 'critical' ? rawSeverity : 'info'
      return {
        category: redactModelFigures(rawCategory).slice(0, MAX_FINDING_CATEGORY_CHARS) || 'general',
        severity,
        text: redactModelFigures(rawText).slice(0, MAX_FINDING_CHARS),
      }
    })
    .filter((f) => f.text !== '')
}
