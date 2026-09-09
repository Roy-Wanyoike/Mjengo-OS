// AI module — the diaspora trust digest engine (W6-2, the third feature on
// the 8-f seam; the ONLY Wave-6 change to the foundation files is the
// speak() seam extension this engine consumes).
//
// THE DIGEST: a weekly bilingual (EN + SW) "what your money did" note for
// the diaspora client — deterministically composed from rows and spoken
// aloud by TTS. THE TEXT IS THE PRODUCT AND IT IS NEVER MODEL-AUTHORED:
// every line is a template over ledger rows (releases + amounts + ledger
// refs from DrawPack, evidence photo count from SitePhoto, the two latest
// MjengoScore rows for the delta, advisory AI flag counts from AiReviewNote
// + AiInsight, budget pace from Transaction sums vs the Project budget).
// The model's ONLY job is SPEAKING the deterministic text (speak()) — it
// never sees a prompt about the project, never answers a question, never
// authors a figure. The i18n jargon policy applies to the SW template:
// PPE/QS/ledger/MjengoScore terms stay English (the sw.ts dict header).
//
// House rules (every one is test-pinned in tests/unit/ai-trust-digest.test.ts):
//   · DETERMINISTIC — the same rows in the same window render a
//     byte-identical text and textHash (SHA-256 over the canonical JSON of
//     the exact row values the template consumed — the inputsHash
//     discipline). No Date.now() inside the template: the window is an
//     INPUT (windowEnd defaults to "now", overridable for tests/jobs).
//     Number formatting goes through a locale-independent comma grouper,
//     never toLocaleString (ICU variance would break byte-identity).
//   · DIGEST_RULE_VERSION — the template contract is versioned; old rows
//     keep their version (the intel engine convention).
//   · APPEND-ONLY — generating APPENDS a TrustDigest row (latest per
//     (projectId, lang) wins in the read surfaces). No Wave-6 code path
//     updates or deletes a digest row. Regenerating a window = a new row.
//   · AUDIO IS THE BONUS, TEXT IS THE PRODUCT — an audio failure NEVER
//     degrades the text: audioBase64 stays null, audioStatus says
//     'failed'/'unavailable' honestly, and the row (with its text) is
//     still written. 'unavailable' = no attempt was possible (flag on but
//     the SDK could not instantiate); 'failed' = an attempt failed
//     (provider error/timeout/non-audio response — the leak-free error).
//   · FLAG-GATED GENERATION, FLAG-FREE READING — generating is gated on
//     the `ai` flag exactly like ai.drawReview (the AI_ACTIONS family in
//     lib/action-flag-gate.ts enforces it at BOTH /api/actions and
//     /api/sync; this module refuses internally too, so the weekly job —
//     which has no session — also skips honestly). READING an already
//     written digest through the share link is NOT flag-gated (the W6-1
//     boundary: clients read AI output through their share link regardless
//     of the flag); the on-demand share audio render resolves the provider
//     fresh, so the SDK is never contacted while the flag is off.
//   · NEVER THROWS — buildTrustDigest returns the honest three-state
//     outcome (ok / refused+unavailable:false / provider-null+
//     unavailable:true-but-text-saved). Share serving degrades to honest
//     nulls.
//   · NON-INFLUENCE — digest rows gate nothing (grep-pinned: no mutating
//     module reads them; the score module's allowlist admits this file as
//     a READ-ONLY consumer of the two latest MjengoScore rows).
//
// DELIVERY (the wave6-plan W6-2 spec, adjusted to the W6-1 action precedent):
//   · ACTION ai.trustDigest (src/backend/actions/ai.ts — the task
//     direction's seam; the wave6-plan specced a dedicated POST
//     /api/ai/trust-digest route, which W6-1 replaced with the
//     AI_ACTIONS family for draw review — same logged deviation here:
//     the action inherits the route's session/role/idempotency contract and
//     the shared flag-family gate instead of a bespoke bucket) → one
//     digest + one 'digest.trust' domain event.
//   · SHARE GET /api/share?token&trustDigest=latest&lang=en|sw[&audio=1]
//     (src/backend/api/share.ts — the revocable-token read surface; the
//     audio=1 leg renders the voice note on demand, honestly, through the
//     same token gate and 30/min share bucket).
//   · JOB 'digest.trust' (modules/jobs/handlers.ts — the cron-drainable
//     weekly path; generates BOTH languages) → one 'digest.trust' event.
//   · EVENT 'digest.trust' (modules/events/service.ts NOTIFY_POLICY) →
//     one honest in-app notification row (channel in_app, deliveryStatus
//     'logged' — nothing claims WhatsApp delivery; there is no WhatsApp
//     provider and nothing pretends otherwise).
//
// Deviations from the wave6-plan W6-2 spec (each logged in the worklog):
//   1. AiAudioResult carries { audioBase64, mimeType } (the task direction)
//      instead of the plan's audioDataUrl string — the data: URL is built
//      at the serving edge (share GET), where the content type is an HTTP
//      concern; the seam stays transport-neutral.
//   2. One TrustDigest row per LANGUAGE (lang column; task direction)
//      instead of the plan's single row with textEn/textSw — generation is
//      per-language by product (the client toggles EN/SW), regeneration is
//      per-language, and latest-per-(project, lang) is the honest read.
//   3. No dedicated /api/ai/trust-digest route (see DELIVERY above) — the
//      action + the share GET cover the generate and fetch surfaces.
//   4. audioStatus/audioError/providerId columns beyond the plan's set —
//      the plan's own acceptance criteria demand per-language honest
//      statuses; a status without a column would be a lie-shaped gap.

import { createHash } from 'node:crypto'
import { db } from '@/backend/lib/db'
import { canonicalJson } from '@/backend/modules/drawpack/service'
import { getFlags } from '@/backend/modules/intel/flags'
import { resolveAiProvider } from './provider'

/** Bump when the EN/SW template or the facts contract changes — old rows keep their version. */
export const DIGEST_RULE_VERSION = 1

/** Default rows window: the last 7 days ("this week's digest"). */
export const DEFAULT_DIGEST_WINDOW_DAYS = 7

/** Hard cap on sinceDays — a digest is a weekly artifact, not a project report. */
export const MAX_DIGEST_WINDOW_DAYS = 90

// ---------------- facts (the exact rows the template consumes) ----------------

/**
 * The deterministic digest facts: EVERY value is a row (or an explicitly
 * documented deterministic derivation of rows — sums, the score delta, the
 * budget/progress ratios). `v` pins the rule version into the hash input so
 * a template change can never collide with an old hash.
 */
export interface DigestFacts {
  v: number
  project: {
    id: string
    name: string
    client: string
    location: string
    budget: number
  }
  window: { start: string; end: string; days: number }
  releases: Array<{ milestoneName: string; amount: number; currency: string; ledgerRef: string }>
  evidencePhotos: number
  mjengoScore: { score: number | null; prev: number | null; delta: number | null } | null
  aiFlags: { insights: number; reviewNotes: number }
  budget: { spent: number; transactions: number; pacePct: number }
  progressPct: number
}

/**
 * Load the facts for one project + window. `now` is an explicit input
 * (determinism: the window is data, not a hidden clock) — the callers pass
 * new Date() in production and a fixed instant in tests.
 */
export async function loadDigestFacts(
  projectId: string,
  windowDays: number,
  now: Date,
): Promise<DigestFacts | null> {
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) return null

  const windowEnd = now
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000)

  const [packRows, photoRows, scoreRows, insightRows, noteRows, txnRows, phaseRows] =
    await Promise.all([
      db.drawPack.findMany({
        where: { projectId, createdAt: { gte: windowStart, lte: windowEnd } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { milestoneName: true, amount: true, currency: true, ledgerRef: true },
      }),
      db.sitePhoto.findMany({
        where: { projectId, createdAt: { gte: windowStart, lte: windowEnd } },
        select: { id: true },
      }),
      db.mjengoScore.findMany({
        where: { projectId },
        orderBy: [{ computedAt: 'desc' }, { id: 'asc' }],
        take: 2,
        select: { score: true },
      }),
      db.aiInsight.findMany({
        where: { projectId, createdAt: { gte: windowStart, lte: windowEnd } },
        select: { id: true },
      }),
      db.aiReviewNote.findMany({
        where: { projectId, createdAt: { gte: windowStart, lte: windowEnd } },
        select: { id: true },
      }),
      db.transaction.findMany({ where: { projectId }, select: { amount: true } }),
      db.phase.findMany({
        where: { projectId },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
        select: { budget: true, progressManual: true, tasks: { select: { progress: true } } },
      }),
    ])

  const spent = txnRows.reduce((s, t) => s + t.amount, 0)
  // Budget-weighted overall progress — mirrors lib/mjengo overallProgress()
  // (importing it here would create a module cycle through actions/ai.ts;
  // the rule is 3 lines and this comment is the drift contract).
  const totalBudget = phaseRows.reduce((s, p) => s + p.budget, 0)
  const phasePct = (p: { progressManual: number | null; tasks: Array<{ progress: number }> }) =>
    p.progressManual !== null && p.progressManual !== undefined
      ? p.progressManual
      : p.tasks.length
        ? Math.round(p.tasks.reduce((s, t) => s + t.progress, 0) / p.tasks.length)
        : 0
  const progressPct =
    totalBudget > 0
      ? Math.round((phaseRows.reduce((s, p) => s + (phasePct(p) / 100) * p.budget, 0) / totalBudget) * 100)
      : 0

  const score = scoreRows[0]?.score ?? null
  const prev = scoreRows[1]?.score ?? null

  return {
    v: DIGEST_RULE_VERSION,
    project: {
      id: project.id,
      name: project.name,
      client: project.client,
      location: project.location,
      budget: project.budget,
    },
    window: {
      start: windowStart.toISOString(),
      end: windowEnd.toISOString(),
      days: windowDays,
    },
    releases: packRows.map((p) => ({
      milestoneName: p.milestoneName,
      amount: p.amount,
      currency: p.currency,
      ledgerRef: p.ledgerRef,
    })),
    evidencePhotos: photoRows.length,
    mjengoScore:
      score === null && prev === null
        ? null
        : { score, prev, delta: score !== null && prev !== null ? score - prev : null },
    aiFlags: { insights: insightRows.length, reviewNotes: noteRows.length },
    budget: {
      spent,
      transactions: txnRows.length,
      pacePct: project.budget > 0 ? Math.round((spent / project.budget) * 100) : 0,
    },
    progressPct,
  }
}

/** SHA-256 hex over the canonical JSON of the digest facts (deterministic). */
export function hashDigestFacts(facts: DigestFacts): string {
  return createHash('sha256').update(canonicalJson(facts), 'utf8').digest('hex')
}

// ---------------- the templates (pure, exported for tests) ----------------

/**
 * Locale-independent integer grouping ("650000" → "650,000") — deterministic
 * across ICU builds, unlike toLocaleString (byte-identity is a contract).
 * Negative amounts keep their sign; NaN never reaches here (row values).
 */
export function formatAmount(n: number): string {
  const rounded = Math.round(n)
  const sign = rounded < 0 ? '-' : ''
  const digits = Math.abs(rounded).toString()
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** ISO "2026-02-16T09:00:00.000Z" → "2026-02-16" (window labels; row-pinned input). */
function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

/** Compose the DETERMINISTIC EN digest text (pure function of the facts). */
export function composeDigestTextEn(f: DigestFacts): string {
  const lines: string[] = []
  lines.push(`MJENGO-OS TRUST DIGEST — ${f.project.name} (${f.project.location})`)
  lines.push(
    `Week: ${dayOf(f.window.start)} → ${dayOf(f.window.end)} (last ${f.window.days} days)`,
  )
  lines.push('')
  lines.push(`RELEASES THIS WEEK (${f.releases.length}):`)
  if (f.releases.length === 0) {
    lines.push('- None — no money left escrow this week.')
  } else {
    for (const r of f.releases) {
      lines.push(`- ${r.milestoneName} — KSh ${formatAmount(r.amount)} (ledger ${r.ledgerRef})`)
    }
    const total = f.releases.reduce((s, r) => s + r.amount, 0)
    lines.push(`Total released: KSh ${formatAmount(total)}`)
  }
  lines.push('')
  lines.push(`EVIDENCE: ${f.evidencePhotos} new site photo(s) on file.`)
  lines.push('')
  if (f.mjengoScore === null) {
    lines.push('MJENGO SCORE: not computed yet.')
  } else if (f.mjengoScore.score === null) {
    lines.push('MJENGO SCORE: no score yet (not enough evidence rows).')
  } else if (f.mjengoScore.delta === null) {
    lines.push(`MJENGO SCORE: ${f.mjengoScore.score}/100 (no prior score to compare).`)
  } else {
    const dir = f.mjengoScore.delta >= 0 ? 'up' : 'down'
    lines.push(
      `MJENGO SCORE: ${f.mjengoScore.score}/100 (was ${f.mjengoScore.prev} — ${dir} ${Math.abs(f.mjengoScore.delta)}).`,
    )
  }
  lines.push('')
  const flags = f.aiFlags.insights + f.aiFlags.reviewNotes
  lines.push(
    `AI FLAGS (ADVISORY — AI describes, humans decide): ${flags} this week` +
      ` (${f.aiFlags.insights} evidence-screen flag(s), ${f.aiFlags.reviewNotes} draw-review note(s)).`,
  )
  lines.push('')
  lines.push(
    `BUDGET PACE: KSh ${formatAmount(f.budget.spent)} of KSh ${formatAmount(f.project.budget)} spent` +
      ` across ${f.budget.transactions} ledger transaction(s) (${f.budget.pacePct}%) — overall progress ${f.progressPct}%.`,
  )
  lines.push('')
  lines.push(
    'Every number above is a ledger row, not a guess. AI reads this digest aloud; it never decides anything.',
  )
  lines.push('— MjengoOS')
  return lines.join('\n')
}

/**
 * Compose the DETERMINISTIC SW digest text (pure function of the facts).
 * Real Kiswahili; the i18n jargon policy holds — PPE/QS/ledger terms,
 * product names (MJENGO-OS, MjengoScore, AI) and row values (milestone
 * names, ledger refs) stay exactly as the rows carry them.
 */
export function composeDigestTextSw(f: DigestFacts): string {
  const lines: string[] = []
  lines.push(`MJENGO-OS TRUST DIGEST — ${f.project.name} (${f.project.location})`)
  lines.push(`Wiki: ${dayOf(f.window.start)} → ${dayOf(f.window.end)} (siku ${f.window.days} zilizopita)`)
  lines.push('')
  lines.push(`MALIPO YA WIKI HII (${f.releases.length}):`)
  if (f.releases.length === 0) {
    lines.push('- Hakuna — hakuna pesa iliyoondoka escrow wiki hii.')
  } else {
    for (const r of f.releases) {
      lines.push(`- ${r.milestoneName} — KSh ${formatAmount(r.amount)} (ledger ${r.ledgerRef})`)
    }
    const total = f.releases.reduce((s, r) => s + r.amount, 0)
    lines.push(`Jumla iliyolipwa: KSh ${formatAmount(total)}`)
  }
  lines.push('')
  lines.push(`UTHIBITISHO: picha ${f.evidencePhotos} mpya za tovuti zimehifadhiwa.`)
  lines.push('')
  if (f.mjengoScore === null) {
    lines.push('MJENGO SCORE: bado haijakokotolewa.')
  } else if (f.mjengoScore.score === null) {
    lines.push('MJENGO SCORE: hakuna alama bado (mistari ya ushahidi haitoshi).')
  } else if (f.mjengoScore.delta === null) {
    lines.push(`MJENGO SCORE: ${f.mjengoScore.score}/100 (hakuna alama ya awali ya kulinganisha).`)
  } else {
    const dir = f.mjengoScore.delta >= 0 ? 'imepanda' : 'imeshuka'
    lines.push(
      `MJENGO SCORE: ${f.mjengoScore.score}/100 (ilikuwa ${f.mjengoScore.prev} — ${dir} kwa ${Math.abs(f.mjengoScore.delta)}).`,
    )
  }
  lines.push('')
  const flags = f.aiFlags.insights + f.aiFlags.reviewNotes
  lines.push(
    `ALAMA ZA AI (ZA USHAURI — AI inaelezea, binadamu ndiye anayeamua): ${flags} wiki hii` +
      ` (${f.aiFlags.insights} za ukaguzi wa ushahidi, ${f.aiFlags.reviewNotes} kumbukumbu za uhakiki wa malipo).`,
  )
  lines.push('')
  lines.push(
    `MWENDO WA BAJETI: KSh ${formatAmount(f.budget.spent)} kati ya KSh ${formatAmount(f.project.budget)} zimetumika` +
      ` katika ${f.budget.transactions} mstari wa ledger (${f.budget.pacePct}%) — maendeleo kwa ujumla ${f.progressPct}%.`,
  )
  lines.push('')
  lines.push(
    'Kila nambari hapo juu ni mstari wa daftari, si makadirio. AI inaisoma kwa sauti; haamui kitu chochote.',
  )
  lines.push('— MjengoOS')
  return lines.join('\n')
}

/** Compose the deterministic text for one language (the single template door). */
export function composeDigestText(f: DigestFacts, lang: 'en' | 'sw'): string {
  return lang === 'sw' ? composeDigestTextSw(f) : composeDigestTextEn(f)
}

// ---------------- the row detail (share GET + action result) ----------------

/** The digest as the surfaces serve it (ISO dates, honest audio state). */
export interface TrustDigestDetail {
  id: string
  projectId: string
  lang: 'en' | 'sw'
  windowStart: string
  windowEnd: string
  text: string
  textHash: string
  ruleVersion: number
  audioStatus: 'unavailable' | 'failed' | 'ready'
  audioError: string | null
  providerId: string | null
  client: string
  createdAt: string
}

/** A raw TrustDigest row as the (test) stub or Prisma returns it. */
interface TrustDigestRow {
  id: string
  projectId: string
  lang: string
  windowStart: Date | string
  windowEnd: Date | string
  text: string
  textHash: string
  audioBase64?: string | null
  audioMime?: string | null
  audioStatus: string
  audioError?: string | null
  providerId?: string | null
  ruleVersion: number
  createdAt: Date | string
}

/** Row → detail (never throws; unknown audioStatus degrades to 'unavailable'). */
function detailFromRow(row: TrustDigestRow, client: string): TrustDigestDetail {
  const status =
    row.audioStatus === 'ready' || row.audioStatus === 'failed' ? row.audioStatus : 'unavailable'
  return {
    id: row.id,
    projectId: row.projectId,
    lang: row.lang === 'sw' ? 'sw' : 'en',
    windowStart: new Date(row.windowStart).toISOString(),
    windowEnd: new Date(row.windowEnd).toISOString(),
    text: row.text,
    textHash: row.textHash,
    ruleVersion: row.ruleVersion,
    audioStatus: status,
    audioError: row.audioError ?? null,
    providerId: row.providerId ?? null,
    client,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

// ---------------- the engine ----------------

/**
 * The honest outcome of one digest generation — never thrown, always
 * returned:
 *   { ok: true, digest }                     — one append-only row written
 *                                               (with audio when TTS
 *                                               succeeded; text always).
 *   { ok: false, unavailable: false, error } — refused or failed before the
 *                                               row (flag off, project
 *                                               missing, bad window).
 *   { ok: false, unavailable: true, error }  — legacy shape parity with
 *                                               draw-review; NOT produced
 *                                               here: a null provider (SDK
 *                                               cannot instantiate) still
 *                                               writes the TEXT row with
 *                                               audioStatus 'unavailable' —
 *                                               the text is deterministic
 *                                               and needs no SDK. Kept in
 *                                               the union so callers stay
 *                                               forward-compatible.
 */
export type TrustDigestOutcome =
  | { ok: true; digest: TrustDigestDetail }
  | { ok: false; unavailable: boolean; error: string }

/**
 * Generate this week's trust digest for one project + language:
 *   1. load the facts (pure rows) and compose the deterministic text;
 *   2. flag gate — the `ai` flag OFF refuses BEFORE any TTS attempt (the
 *      action family gate refuses earlier still; this is the
 *      defense-in-depth check the job path relies on);
 *   3. TTS — speak() the exact composed text (flag ON). Provider null →
 *      audio honestly 'unavailable'; a failed attempt → 'failed' + the
 *      leak-free error; success → audioBase64 + 'ready';
 *   4. APPEND the row (text + audio state) — the ONLY write.
 */
export async function buildTrustDigest(
  projectId: string,
  opts: { lang: 'en' | 'sw'; sinceDays?: number; now?: Date },
): Promise<TrustDigestOutcome> {
  const lang = opts.lang === 'sw' ? 'sw' : 'en'
  const windowDays =
    typeof opts.sinceDays === 'number' && Number.isFinite(opts.sinceDays) && opts.sinceDays >= 1
      ? Math.min(Math.floor(opts.sinceDays), MAX_DIGEST_WINDOW_DAYS)
      : DEFAULT_DIGEST_WINDOW_DAYS
  const now = opts.now instanceof Date ? opts.now : new Date()

  // ---- flag gate (fail-closed; the SDK is never contacted while off) ----
  const flags = await getFlags()
  if (flags.ai !== true) {
    return {
      ok: false,
      unavailable: false,
      error:
        'AI trust digest refused — the ai feature flag is off (an admin can enable it from the flags popover in the header)',
    }
  }

  // ---- the facts + the deterministic text (no SDK involved) ----
  const facts = await loadDigestFacts(projectId, windowDays, now)
  if (!facts) {
    return { ok: false, unavailable: false, error: 'No project found — nothing to digest' }
  }
  const text = composeDigestText(facts, lang)
  const textHash = hashDigestFacts(facts)

  // ---- TTS: speak the exact deterministic text (audio is the bonus) ----
  const provider = resolveAiProvider(flags)
  let audioBase64: string | null = null
  let audioMime: string | null = null
  let audioStatus: 'unavailable' | 'failed' | 'ready' = 'unavailable'
  let audioError: string | null = null
  let providerId: string | null = null
  if (!provider) {
    // Flag on but the SDK could not be instantiated (no/invalid config):
    // no attempt was possible. The TEXT is still the product — row written.
    audioError = 'AI unavailable — the provider could not be initialized'
  } else {
    const spoken = await provider.speak(text)
    if (spoken === null) {
      audioError = 'AI unavailable — the provider could not be initialized'
    } else {
      // An attempt WAS possible — record which provider, whatever the outcome.
      providerId = provider.id
      if (spoken.ok) {
        audioBase64 = spoken.audioBase64
        audioMime = spoken.mimeType
        audioStatus = 'ready'
      } else {
        audioStatus = 'failed'
        audioError = spoken.error // already leak-free (the seam contract)
      }
    }
  }

  // ---- append the row (append-only: the ONLY write; audio state honest) ----
  const row = await db.trustDigest.create({
    data: {
      projectId,
      lang,
      windowStart: new Date(facts.window.start),
      windowEnd: new Date(facts.window.end),
      text,
      textHash,
      audioBase64,
      audioMime,
      audioStatus,
      audioError,
      providerId,
      ruleVersion: DIGEST_RULE_VERSION,
    },
  })
  return { ok: true, digest: detailFromRow(row, facts.project.client) }
}

// ---------------- reads (share GET + section) ----------------

/**
 * The LATEST digest for one project + language (append-only history,
 * latest wins — the MjengoScore/AiReviewNote read pattern). Read-only:
 * the share GET serves it through the same revocable token as the packs.
 */
export async function loadLatestTrustDigest(
  projectId: string,
  lang: 'en' | 'sw',
): Promise<TrustDigestDetail | null> {
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) return null
  const row = await db.trustDigest.findFirst({
    where: { projectId, lang },
    orderBy: { createdAt: 'desc' },
  })
  return row ? detailFromRow(row, project.client) : null
}

/**
 * The share-GET serving shape: the digest text + its honest audio state,
 * plus the voice note when one exists (or when `renderAudio` asked for a
 * fresh on-demand render — which resolves the provider HERE, so the flag
 * stays the single switch and the SDK is never contacted while it is off).
 *
 * ON-DEMAND RENDER HONESTY: the row is append-only, so a fresh render is
 * returned in the RESPONSE but never written back (regenerate to persist);
 * `audioOnDemand: true` says exactly that. A render failure degrades to
 * `audio: null` + the leak-free reason — the text always ships.
 */
export interface TrustDigestShareView {
  id: string
  lang: 'en' | 'sw'
  windowStart: string
  windowEnd: string
  text: string
  textHash: string
  ruleVersion: number
  createdAt: string
  audioStatus: 'unavailable' | 'failed' | 'ready'
  audio: { dataUrl: string; mimeType: string } | null
  /** True when audio was rendered fresh for THIS response (not persisted). */
  audioOnDemand: boolean
  /** Leak-free reason audio is absent (row state or render failure). */
  audioNote: string | null
}

/**
 * Serve the latest digest for the token's project + language. `renderAudio`
 * (the share GET's &audio=1) attempts a fresh TTS render only when the row
 * carries no audio — the expensive call is opt-in per request and rides the
 * share route's existing 30/min bucket. Never throws.
 */
export async function serveTrustDigestForShare(
  projectId: string,
  params: { lang: 'en' | 'sw'; renderAudio?: boolean },
): Promise<TrustDigestShareView | null> {
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) return null
  const row = await db.trustDigest.findFirst({
    where: { projectId, lang: params.lang },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) return null
  const detail = detailFromRow(row, project.client)

  const view: TrustDigestShareView = {
    id: detail.id,
    lang: detail.lang,
    windowStart: detail.windowStart,
    windowEnd: detail.windowEnd,
    text: detail.text,
    textHash: detail.textHash,
    ruleVersion: detail.ruleVersion,
    createdAt: detail.createdAt,
    audioStatus: detail.audioStatus,
    audio: null,
    audioOnDemand: false,
    audioNote: null,
  }

  const stored = row as TrustDigestRow
  if (stored.audioBase64 && stored.audioMime) {
    view.audio = {
      dataUrl: `data:${stored.audioMime};base64,${stored.audioBase64}`,
      mimeType: stored.audioMime,
    }
    return view
  }

  // No stored audio: the honest row state explains it until a render is
  // explicitly requested.
  view.audioNote =
    detail.audioStatus === 'failed'
      ? detail.audioError ?? 'Audio synthesis failed when this digest was generated'
      : 'Audio was not synthesized when this digest was generated'

  if (!params.renderAudio) return view

  // On-demand render (opt-in &audio=1): resolve the provider fresh — the
  // flag gate lives here, so a flag-off share link never touches the SDK.
  const flags = await getFlags()
  const provider = resolveAiProvider(flags)
  if (!provider) {
    view.audioNote = 'Audio not available — the AI provider is off or not configured'
    return view
  }
  const spoken = await provider.speak(detail.text)
  if (spoken === null) {
    view.audioNote = 'Audio not available — the AI provider could not be initialized'
    return view
  }
  if (!spoken.ok) {
    view.audioNote = spoken.error // leak-free by the seam contract
    return view
  }
  view.audio = { dataUrl: `data:${spoken.mimeType};base64,${spoken.audioBase64}`, mimeType: spoken.mimeType }
  view.audioOnDemand = true
  view.audioNote = 'Rendered on demand — not stored; regenerate the digest to persist the voice note'
  return view
}
