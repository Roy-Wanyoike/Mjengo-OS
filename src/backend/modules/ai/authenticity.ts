// AI module — the Evidence Authenticity Screen (W6-3).
//
// WHAT THIS IS: two complementary checks over a project's evidence photos,
// both writing ADVISORY, append-only `AiInsight` rows:
//   1. dHash duplicate detection (source 'dhash' — RULE-computed, fully
//      deterministic, zero SDK): the 64-bit perceptual hash of every photo
//      (lib/perceptual-hash.ts, bytes through the storage driver read seam so
//      local-disk and S3/R2 both work), compared across the project's photo
//      history AND the prior draw packs' frozen evidence sets — the "this
//      photo paid for the foundation AND the slab" flag.
//   2. Vision phase-consistency (source 'vision' — MODEL-computed,
//      confidence-labeled): does each evidence photo plausibly show the phase
//      its milestone claims, and are there render/screenshot/AI-generation
//      tells? One tight provider.vision() call per photo over a capped set.
//
// GATING — ONE SWITCH (per the 8-f "single switch" design, pinned by tests):
// the whole screen rides the `ai` feature flag. Flag OFF → the screen is a
// NO-OP: zero SDK calls, zero PhotoHash rows, zero AiInsight rows, no audit
// row. The dhash/vision split is a LABELING honesty property (the `source`
// column on every row tells the reader whether a rule or a model produced
// the flag), NOT a gating split — deterministic hashing is cheap, but it
// feeds an AI-branded surface, so it rides the same opt-in. Flag ON +
// provider NULL (no .z-ai-config) → the deterministic hash half still runs
// honestly (local math, no SDK contacted) and the vision half is honestly
// skipped: no provider, no vision rows, never a faked analysis.
//
// NEVER THROWS, NEVER GATES:
//   · runAuthenticityScreen() catches everything and returns an honest
//     outcome object ({ ok:false, errorClass } — class name only, leak-free);
//     an UNREADABLE flag table is NOT a screen failure — it is the flag-off
//     no-op (fail-closed: a switch you cannot read is OFF), silent by design
//     so a missing flag store can never spam an 'ai_screen failed' audit row
//     onto every pack freeze;
//   · MODEL TEXT IS SANITIZED BEFORE STORAGE — redactModelFigures() (the W6-1
//     draw-review twin) strips every digit run from the vision pass's free
//     text (observation, render tells): the LEDGER decides numbers, the model
//     describes. constrainPhaseName() maps the model's phase naming onto the
//     project's OWN Phase rows — a hallucinated name becomes 'unknown', never
//     an accusation; the prompt forbids figures outright as the first line of
//     defense and the parse-time redaction is the mechanical backstop;
//   · runPostFreezeAuthenticityScreen() is the draw-pack freeze hook: any
//     failure is logged + audited as 'ai_screen' failed and the pack/release
//     stand unchanged (the W4-1 "pack failure never fails the release"
//     discipline, one layer deeper — the release transaction is sacred);
//   · insight rows influence NOTHING: no action outcome, no score, no money
//     path reads them (grep-pinned in tests/unit/ai-authenticity.test.ts).
//     AI describes and flags; it NEVER approves. The human-decision columns
//     (decidedBy/decision/decidedAt) exist on the row and NO Wave-6 code path
//     writes them — the decide action is an explicit Wave-7 follow-up.
//
// APPEND-ONLY: PhotoHash and AiInsight rows are only ever create()d — no
// update, no delete, no upsert (grep-pinned). Backfill is idempotent through
// the photoId UNIQUE constraint: a second run cache-hits and recomputes
// nothing; duplicate insights are not double-written per (target, kind,
// matched-photo) window.

import sharp from 'sharp'
import { db } from '@/backend/lib/db'
import { logAudit } from '@/backend/lib/audit'
import { getStorageDriver } from '@/backend/lib/storage'
import { dHash, hammingDistance, DUPLICATE_HAMMING_THRESHOLD } from '@/backend/lib/perceptual-hash'
import { resolveAiProvider } from './provider'
import type { AiTextResult, AiProvider } from './types'
import { getFlags, type FlagMap } from '@/backend/modules/intel/flags'

/**
 * Hard cap on photos sent to the VISION pass per screen run. Documented
 * tradeoff: each provider.vision() call is raced against the provider's 8s
 * cap and the freeze hook runs inside the milestone-decide response, so the
 * cap bounds the worst-case added latency to one 8s window (the capped calls
 * run in parallel). Evidence sets on Kenyan residential milestones are
 * single-digit; 6 covers them. Photos beyond the cap still get the
 * deterministic dHash check — only the model pass is capped.
 */
export const VISION_PHOTOS_CAP = 6

/**
 * Hard cap on photos hashed per on-demand screen run (the freeze hook hashes
 * only the pack's frozen set, which is naturally small). Bounds route time
 * on a legacy project with a large photo library; the count is reported
 * honestly so the caller knows the backfill is partial.
 */
export const HASH_PHOTOS_CAP = 200

/** Read cap for the insight list (the tab paginates nothing — newest first). */
export const INSIGHT_LIST_CAP = 200

// ---------------- input / outcome types ----------------

/** The pack context a screen run anchors on (null = on-demand full-project run). */
export interface AuthenticityPackContext {
  id: string
  milestoneId: string
  milestoneName: string
  evidencePhotoIds: string[]
  createdAt: Date
}

export interface AuthenticityScreenInput {
  projectId: string
  /** The just-frozen pack (post-freeze hook); null for the on-demand route. */
  pack?: AuthenticityPackContext | null
  /**
   * Explicit photo set to screen (defaults to the pack's frozen set when a
   * pack is given, else the project's photos — the backfill run).
   */
  photoIds?: string[]
}

/** Honest accounting of the vision half (what ran, what was skipped, why). */
export interface VisionOutcome {
  provider: 'zai' | 'unavailable'
  attempted: number
  insights: number
  skipped: string | null
}

export type AuthenticityScreenOutcome =
  | {
      ok: true
      ran: boolean
      /** Honest no-op reason when ran === false. */
      reason: 'flag_off' | 'no_photos' | 'screened'
      photos: number
      hashed: number
      cacheHits: number
      unreadable: number
      duplicateInsights: number
      vision: VisionOutcome
      insightsWritten: number
    }
  | { ok: false; errorClass: string }

// ---------------- small pure helpers ----------------

/** Defensive JSON parse of a stored detail column — never throws. */
function parseDetail(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Defensive string-array parse (frozen evidencePhotoIds columns). */
function parseIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** ISO-safe comparison of two Date-ish values. */
function timeOf(v: Date | string): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime()
}

/**
 * Extract the outermost JSON object from model text (fences, stray prose) and
 * parse it defensively. null = no parseable object — the caller skips
 * honestly, never a faked finding. Local twin of lib/ai.ts extractJson (that
 * file imports the SDK directly — never pulled in here).
 */
function parseModelJson(text: string): Record<string, unknown> | null {
  let t = (text ?? '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const v = JSON.parse(t.slice(start, end + 1))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Strip every digit run from model-authored text before storage — the W6-1
 * draw-review twin of the same rule: THE LEDGER DECIDES NUMBERS, the model
 * describes. Applied at PARSE time to the vision pass's free text (the
 * observation line + the render tells), so every stored detail, dedup key and
 * outcome note is model-figure-free by construction — a number can only reach
 * a row from a database row, never from a model's imagination.
 */
export function redactModelFigures(text: string): string {
  return text.replace(/\d[\d.,]*/g, '#')
}

// ---------------- duplicate comparison (pure, exported for tests) ----------------

/** Where a duplicate match came from — drives severity + the detail shape. */
export type DuplicateMatchKind = 'cross_pack' | 'within_pack' | 'project_history'

/** One resolved duplicate pair, ready to persist as an AiInsight row. */
export interface DuplicateFinding {
  targetPhotoId: string
  matchedPhotoId: string
  match: DuplicateMatchKind
  hammingDistance: number
  matchedPackId: string | null
  matchedMilestoneName: string | null
}

/** Photo row shape the comparison needs (subset of SitePhoto). */
export interface PhotoLike {
  id: string
  url: string
  createdAt: Date | string
}

/** PhotoHash row shape the comparison needs. */
export interface HashRowLike {
  photoId: string
  hashHex: string
  packId: string | null
}

/**
 * Pure duplicate resolution: for each screened photo (with its hash), compare
 * against every PhotoHash row of the project and emit the duplicate pairs.
 *
 * Rules (all deterministic — no clock, no randomness):
 *   · SELF match (R is the photo's own row): a finding IFF the photo id also
 *     appears in a PRIOR pack's frozen evidence set — the literal re-use
 *     ("same photo paid for milestone A and milestone B"). The Hamming
 *     distance is computed against the stored row (0 in practice).
 *   · PAIR match (R is a different photo, distance ≤ threshold): the pair is
 *     emitted ONCE, targeting the NEWER photo (the later submission is the
 *     suspicious one); the older photo is the match. Match attribution:
 *     matched photo in the CURRENT pack's set → within_pack; in a prior
 *     pack's frozen set → cross_pack (matched pack/milestone cited); neither
 *     → project_history (same image uploaded before, no pack attached).
 *   · Uncomparable hashes (−1) are never duplicates — fail toward
 *     no-accusation.
 */
export function resolveDuplicateFindings(input: {
  screened: Array<{ photo: PhotoLike; hashHex: string }>
  allHashRows: HashRowLike[]
  /** photoId → the pack/milestone memberships of the project's frozen packs, in pack order. */
  membership: Map<string, Array<{ packId: string; milestoneName: string }>>
  currentPackId: string | null
  priorPackIds: ReadonlySet<string>
}): DuplicateFinding[] {
  const { screened, allHashRows, membership, currentPackId, priorPackIds } = input
  const findings: DuplicateFinding[] = []
  const seenPairs = new Set<string>() // canonical sorted pair key, per run

  const newer = (aId: string, aAt: number, bId: string, bAt: number): boolean =>
    aAt !== bAt ? aAt > bAt : aId > bId

  const screenedAt = new Map<string, number>(screened.map((s) => [s.photo.id, timeOf(s.photo.createdAt)]))
  const currentSet = new Set<string>()
  if (currentPackId) {
    for (const [photoId, packs] of membership) {
      if (packs.some((p) => p.packId === currentPackId)) currentSet.add(photoId)
    }
  }

  for (const { photo, hashHex } of screened) {
    for (const row of allHashRows) {
      // ---- self row: the literal re-use case -------------------------------
      if (row.photoId === photo.id) {
        const prior = (membership.get(photo.id) ?? []).filter((m) => priorPackIds.has(m.packId))
        if (prior.length && currentPackId) {
          const pairKey = `${photo.id}::${photo.id}`
          if (!seenPairs.has(pairKey)) {
            seenPairs.add(pairKey)
            findings.push({
              targetPhotoId: photo.id,
              matchedPhotoId: photo.id,
              match: 'cross_pack',
              hammingDistance: Math.max(0, hammingDistance(hashHex, row.hashHex)),
              matchedPackId: prior[0].packId,
              matchedMilestoneName: prior[0].milestoneName,
            })
          }
        }
        continue
      }
      // ---- pair row: two photo ids, one image ------------------------------
      const distance = hammingDistance(hashHex, row.hashHex)
      if (distance < 0 || distance > DUPLICATE_HAMMING_THRESHOLD) continue

      // Which photo of the pair is the newer submission (the target)?
      const matchedAt = screenedAt.get(row.photoId) // undefined when the match is not in this run's set
      const matchedIsNewer =
        matchedAt !== undefined && newer(row.photoId, matchedAt, photo.id, timeOf(photo.createdAt))
      const targetPhotoId = matchedIsNewer ? row.photoId : photo.id
      const matchedPhotoId = matchedIsNewer ? photo.id : row.photoId

      const pairKey = [targetPhotoId, matchedPhotoId].sort().join('::')
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)

      // Attribution of the MATCHED photo's pack context (prior packs first).
      const matchedPacks = membership.get(matchedPhotoId) ?? []
      const priorMatch = matchedPacks.find((m) => priorPackIds.has(m.packId))
      const currentMatch = currentPackId ? matchedPacks.find((m) => m.packId === currentPackId) : undefined
      const match: DuplicateMatchKind = priorMatch ? 'cross_pack' : currentMatch ? 'within_pack' : 'project_history'

      findings.push({
        targetPhotoId,
        matchedPhotoId,
        match,
        hammingDistance: distance,
        matchedPackId: priorMatch?.packId ?? currentMatch?.packId ?? null,
        matchedMilestoneName: priorMatch?.milestoneName ?? currentMatch?.milestoneName ?? null,
      })
    }
  }
  return findings
}

// ---------------- vision pass ----------------

/** Defensive shape of one vision verdict. */
export interface VisionVerdict {
  phaseShown: string
  matchesClaim: boolean
  confidence: 'low' | 'medium' | 'high'
  renderTells: string[]
  observation: string
}

/** Parse one model answer into a verdict — null when unusable (honest skip). */
export function parseVisionVerdict(text: string): VisionVerdict | null {
  const v = parseModelJson(text)
  if (!v) return null
  const phaseShown = typeof v.phaseShown === 'string' ? v.phaseShown.trim().slice(0, 60) : ''
  if (!phaseShown) return null
  const matchesClaim = v.matchesClaim !== false // absent/odd → NOT an accusation
  const confidence = v.confidence === 'high' || v.confidence === 'medium' ? v.confidence : 'low'
  // MODEL FIGURES ARE STRIPPED AT PARSE TIME (redactModelFigures) — the ledger
  // decides numbers; render tells + the observation line can never carry a
  // model-invented figure into a stored row.
  const renderTells = Array.isArray(v.renderTells)
    ? v.renderTells.filter((t): t is string => typeof t === 'string' && Boolean(t.trim())).slice(0, 3).map((t) => redactModelFigures(t.trim()).slice(0, 120))
    : []
  const observation = typeof v.observation === 'string' ? redactModelFigures(v.observation.trim()).slice(0, 300) : ''
  return { phaseShown, matchesClaim, confidence, renderTells, observation }
}

/**
 * Constrain the model's phase naming to the project's OWN vocabulary (the
 * Phase rows): a name outside the list (or 'unknown') becomes 'unknown' — a
 * hallucinated phase can never accuse, and the stored phase text is
 * ROW-decided, not model-decided. Case/whitespace-insensitive match keeps
 * the ROW's exact spelling.
 */
export function constrainPhaseName(phaseShown: string, allowed: readonly string[]): string {
  const v = phaseShown.trim()
  if (!v || v.toLowerCase() === 'unknown') return 'unknown'
  const hit = allowed.find((p) => p.trim().toLowerCase() === v.toLowerCase())
  return hit ? hit.trim() : 'unknown'
}

/** Build the tight phase-consistency prompt (the analyze-photo discipline). */
export function buildVisionPrompt(input: {
  milestoneName: string | null
  claimedPhase: string
  phaseList: string[]
}): string {
  const context = input.milestoneName
    ? `This photo is submitted as evidence for milestone "${input.milestoneName}", which claims phase "${input.claimedPhase}".`
    : `This photo is recorded by the site team under phase "${input.claimedPhase}".`
  return [
    'You are reviewing one construction evidence photo from a Kenyan residential build (machine-cut stone masonry).',
    context,
    `The project's phase list: ${input.phaseList.length ? input.phaseList.join(', ') : '(no phases recorded)'}.`,
    'Answer with STRICT JSON only (no markdown):',
    '{',
    '  "phaseShown": "<most likely phase from the list above, or \'unknown\'>",',
    '  "matchesClaim": <true|false — does the photo plausibly show the claimed phase>,',
    '  "confidence": "low"|"medium"|"high",',
    '  "renderTells": [<0-2 short strings: visible signs this is a RENDER, SCREENSHOT, drawing or AI-generated image rather than a real site photo; empty array if none>],',
    '  "observation": "<one short factual line about what is visible>"',
    '}',
    'Do not include numbers, quantities, amounts or dates in any string — describe only what is visible; the ledger decides figures.',
    'Be conservative: when uncertain, answer "unknown", matchesClaim true, confidence low. This check is advisory — a human reviews every flag.',
  ].join('\n')
}

/** The AiInsight create payload (typed once; both halves use it). */
interface InsightWriteData {
  projectId: string
  targetType: string
  targetId: string
  packId: string | null
  kind: string
  source: string
  severity: string
  confidence: string | null
  detail: string
}

// ---------------- the screen ----------------

/**
 * Run the authenticity screen over a photo set. NEVER THROWS — every failure
 * is caught and returned as { ok:false, errorClass } (leak-free). See the
 * module header for the gating/append-only/non-influence contracts.
 */
export async function runAuthenticityScreen(input: AuthenticityScreenInput): Promise<AuthenticityScreenOutcome> {
  try {
    // 1. THE single-switch gate: flag OFF → the whole screen is a no-op —
    //    zero SDK calls, zero PhotoHash rows, zero AiInsight rows. An
    //    UNREADABLE flag table is the same state, fail-closed: a switch you
    //    cannot read is OFF, and the no-op is silent (a loud failure here
    //    would audit an 'ai_screen failed' row on EVERY pack freeze in any
    //    environment whose flag store is missing or broken — noise, not
    //    honesty).
    let flags: FlagMap | null = null
    try {
      flags = await getFlags()
    } catch {
      // Fail-closed: a switch that cannot be read is OFF (the all-off state
      // below skips the screen silently — no failure audit, no console spam
      // on every pack freeze).
    }
    if (!flags || flags.ai !== true) {
      return {
        ok: true, ran: false, reason: 'flag_off',
        photos: 0, hashed: 0, cacheHits: 0, unreadable: 0, duplicateInsights: 0,
        vision: { provider: 'unavailable', attempted: 0, insights: 0, skipped: 'ai flag off — screen skipped by design' },
        insightsWritten: 0,
      }
    }

    // 2. Resolve the photo set: the pack's frozen evidence ids (in frozen
    //    order), else the project's photos (on-demand backfill, capped).
    const requestedIds = input.photoIds ?? (input.pack ? input.pack.evidencePhotoIds : null)
    let photos: PhotoLike[] = []
    if (requestedIds) {
      const rows = await db.sitePhoto.findMany({
        where: { projectId: input.projectId, id: { in: requestedIds } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      photos = rows.map((r) => ({ id: r.id, url: r.url, createdAt: r.createdAt }))
      if (input.pack) {
        const order = new Map(requestedIds.map((id, i) => [id, i]))
        photos = photos.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      }
    } else {
      const rows = await db.sitePhoto.findMany({
        where: { projectId: input.projectId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: HASH_PHOTOS_CAP,
      })
      photos = rows.map((r) => ({ id: r.id, url: r.url, createdAt: r.createdAt }))
    }
    if (!photos.length) {
      return {
        ok: true, ran: false, reason: 'no_photos',
        photos: 0, hashed: 0, cacheHits: 0, unreadable: 0, duplicateInsights: 0,
        vision: { provider: 'unavailable', attempted: 0, insights: 0, skipped: 'no photos to screen' },
        insightsWritten: 0,
      }
    }

    // 3. Hash backfill (deterministic, local math — runs even when the
    //    provider is null; the SDK is never contacted for this half).
    const driver = getStorageDriver()
    const existingHashes = await db.photoHash.findMany({ where: { projectId: input.projectId } })
    const hashByPhotoId = new Map(existingHashes.map((r) => [r.photoId, r]))

    let hashed = 0
    let cacheHits = 0
    let unreadable = 0
    /** Screened photos with a usable hash (the comparison input). */
    const screened: Array<{ photo: PhotoLike; hashHex: string }> = []
    /** Bytes kept for the vision pass (only readable ones). */
    const readableBytes = new Map<string, { bytes: Buffer; contentType: string | null }>()

    for (const photo of photos) {
      const cached = hashByPhotoId.get(photo.id)
      if (cached) {
        cacheHits++
        screened.push({ photo, hashHex: cached.hashHex })
        continue
      }
      // Resolve bytes through the storage driver seam (keyFor → read).
      const key = driver.keyFor?.(photo.url) ?? null
      const read = key ? (driver.read ? await driver.read(key) : null) : null
      if (!read) {
        unreadable++ // honest skip — no hash, no fake row
        continue
      }
      const hashHex = await dHash(read.bytes)
      if (!hashHex) {
        unreadable++ // corrupt/non-image bytes — honest skip, never a throw
        continue
      }
      // Header-only metadata probe (cheap; honest nulls on failure).
      let width: number | null = null
      let height: number | null = null
      try {
        const meta = await sharp(read.bytes).metadata()
        width = typeof meta.width === 'number' ? meta.width : null
        height = typeof meta.height === 'number' ? meta.height : null
      } catch {
        // width/height are cosmetic — the hash stands.
      }
      await db.photoHash.create({
        data: {
          photoId: photo.id,
          projectId: input.projectId,
          storageKey: photo.url,
          hashHex,
          width,
          height,
          packId: input.pack?.id ?? null,
        },
      })
      hashed++
      screened.push({ photo, hashHex })
      readableBytes.set(photo.id, { bytes: read.bytes, contentType: read.contentType })
    }

    // 4. Duplicate comparison — within the screened set, across prior packs'
    //    frozen sets, and over the project's photo history.
    const packs = await db.drawPack.findMany({
      where: { projectId: input.projectId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const membership = new Map<string, Array<{ packId: string; milestoneName: string }>>()
    for (const p of packs) {
      for (const photoId of parseIds(p.evidencePhotoIds)) {
        const list = membership.get(photoId) ?? []
        list.push({ packId: p.id, milestoneName: p.milestoneName })
        membership.set(photoId, list)
      }
    }
    // Prior packs = everything frozen BEFORE the current one (pack order).
    const currentPackId = input.pack?.id ?? null
    const currentPackIndex = currentPackId ? packs.findIndex((p) => p.id === currentPackId) : -1
    const priorPackIds = new Set<string>()
    if (currentPackIndex > 0) {
      for (const p of packs.slice(0, currentPackIndex)) priorPackIds.add(p.id)
    }

    const allHashRows = await db.photoHash.findMany({ where: { projectId: input.projectId } })
    const findings = resolveDuplicateFindings({
      screened,
      allHashRows: allHashRows.map((r) => ({ photoId: r.photoId, hashHex: r.hashHex, packId: r.packId })),
      membership,
      currentPackId,
      priorPackIds,
    })

    // Existing duplicate insights → the (target, matched-photo) dedup window.
    const existingInsights = await db.aiInsight.findMany({
      where: { projectId: input.projectId, kind: 'duplicate' },
    })
    const recordedPairs = new Set<string>()
    for (const row of existingInsights) {
      const d = parseDetail(row.detail)
      const matched = typeof d.matchedPhotoId === 'string' ? d.matchedPhotoId : null
      if (matched && typeof row.targetId === 'string') {
        recordedPairs.add([row.targetId, matched].sort().join('::'))
      }
    }

    let duplicateInsights = 0
    for (const f of findings) {
      const pairKey = [f.targetPhotoId, f.matchedPhotoId].sort().join('::')
      if (recordedPairs.has(pairKey)) continue // not double-written
      recordedPairs.add(pairKey)
      await db.aiInsight.create({
        data: {
          projectId: input.projectId,
          targetType: 'site_photo',
          targetId: f.targetPhotoId,
          packId: input.pack?.id ?? null,
          kind: 'duplicate',
          source: 'dhash',
          severity: f.match === 'cross_pack' ? 'critical' : 'warning',
          confidence: null, // rules carry no confidence — that label is vision-only
          detail: JSON.stringify({
            match: f.match,
            matchedPhotoId: f.matchedPhotoId,
            matchedPackId: f.matchedPackId,
            matchedMilestoneName: f.matchedMilestoneName,
            packId: input.pack?.id ?? null,
            milestoneName: input.pack?.milestoneName ?? null,
            hammingDistance: f.hammingDistance,
            threshold: DUPLICATE_HAMMING_THRESHOLD,
          }),
        },
      })
      duplicateInsights++
    }

    // 5. Vision phase-consistency pass — the model half, honestly optional.
    let vision: VisionOutcome
    const provider: AiProvider | null = resolveAiProvider(flags)
    if (!provider || !screened.length) {
      // Flag on but no provider object (a future resolution returning null)
      // or nothing readable to inspect: honest skip, no rows, no fakes. When
      // the provider exists but the SDK cannot be created (no .z-ai-config),
      // every attempt below returns null and the all-unavailable branch at
      // the end reports it honestly instead.
      vision = {
        provider: provider ? 'zai' : 'unavailable',
        attempted: 0,
        insights: 0,
        skipped: !provider
          ? 'AI provider unavailable — hash checks ran, vision pass honestly skipped'
          : 'no readable photos to inspect',
      }
    } else {
      // Claimed-phase context: the pack's milestone → its phase; on-demand
      // runs use each photo's own recorded phase (the honest equivalent).
      const phases = await db.phase.findMany({
        where: { projectId: input.projectId },
        orderBy: { order: 'asc' },
      })
      const phaseNameById = new Map(phases.map((p) => [p.id, p.name]))
      const phaseList = phases.map((p) => p.name)
      let claimedPhase: string | null = null
      if (input.pack) {
        const milestone = await db.milestone.findUnique({ where: { id: input.pack.milestoneId } })
        claimedPhase = milestone?.phaseId ? phaseNameById.get(milestone.phaseId) ?? null : null
      }
      const photoRows = await db.sitePhoto.findMany({ where: { projectId: input.projectId } })
      const photoPhaseById = new Map(photoRows.map((p) => [p.id, p.phaseId]))
      const photoById = new Map(photoRows.map((p) => [p.id, p]))

      // Cap the vision set (documented): bytes for photos hashed THIS run are
      // already held; cache-hit photos re-read through the driver seam.
      const visionPhotos = screened.slice(0, VISION_PHOTOS_CAP).map((s) => s.photo)
      for (const photo of visionPhotos) {
        if (!readableBytes.has(photo.id)) {
          const key = driver.keyFor?.(photo.url) ?? null
          const read = key ? (driver.read ? await driver.read(key) : null) : null
          if (read) readableBytes.set(photo.id, { bytes: read.bytes, contentType: read.contentType })
        }
      }

      interface VisionAttempt {
        photoId: string
        photoClaim: string
        res: AiTextResult | null
        skipped: string | null
      }
      const attempts: VisionAttempt[] = await Promise.all(
        visionPhotos.map(async (photo): Promise<VisionAttempt> => {
          const bytes = readableBytes.get(photo.id)
          if (!bytes) return { photoId: photo.id, photoClaim: 'uncategorized', res: null, skipped: 'bytes unreadable' }
          const mime = bytes.contentType && bytes.contentType.startsWith('image/')
            ? bytes.contentType
            : 'image/jpeg'
          const phaseId = photoPhaseById.get(photo.id) ?? null
          const photoClaim = claimedPhase
            ?? (phaseId ? phaseNameById.get(phaseId) ?? null : null)
            ?? 'uncategorized'
          const prompt = buildVisionPrompt({
            milestoneName: input.pack?.milestoneName ?? null,
            claimedPhase: photoClaim,
            phaseList,
          })
          const dataUrl = `data:${mime};base64,${bytes.bytes.toString('base64')}`
          const res = await provider.vision(prompt, [dataUrl])
          return { photoId: photo.id, photoClaim, res, skipped: null }
        }),
      )

      // Dedup window for vision rows: (target, kind, matchKey).
      const existingVision = await db.aiInsight.findMany({
        where: { projectId: input.projectId, source: 'vision' },
      })
      const recordedVision = new Set<string>()
      for (const row of existingVision) {
        const d = parseDetail(row.detail)
        const key = typeof d.phaseShown === 'string' ? d.phaseShown : typeof d.tell === 'string' ? d.tell : ''
        if (key && typeof row.targetId === 'string') recordedVision.add(`${row.targetId}:${row.kind}:${key}`)
      }

      const writes: InsightWriteData[] = []
      for (const a of attempts) {
        if (a.skipped) continue // bytes unreadable — honest skip
        if (!a.res) continue // provider null mid-run — honest skip, no row
        if (!a.res.ok) continue // failed attempt (timeout/SDK error) — no fake insight
        const verdict = parseVisionVerdict(a.res.text)
        if (!verdict) continue // unparseable answer — honest skip
        // Row-decided vocabulary only: a hallucinated phase name becomes
        // 'unknown' (never an accusation) — the stored text comes from the
        // project's OWN Phase rows, not the model's imagination.
        verdict.phaseShown = constrainPhaseName(verdict.phaseShown, phaseList)
        const photo = photoById.get(a.photoId)
        const caption = photo && typeof photo.caption === 'string' ? photo.caption : null

        // Phase mismatch: the model named a DIFFERENT concrete phase from the
        // project's own list. A photo with NO claimed phase ('uncategorized',
        // on-demand run without pack context) cannot contradict a claim —
        // there is nothing claimed to contradict.
        if (!verdict.matchesClaim && verdict.phaseShown !== 'unknown' && a.photoClaim !== 'uncategorized' && verdict.phaseShown !== a.photoClaim) {
          const key = `${a.photoId}:phase_mismatch:${verdict.phaseShown}`
          if (!recordedVision.has(key)) {
            recordedVision.add(key)
            writes.push({
              projectId: input.projectId,
              targetType: 'site_photo',
              targetId: a.photoId,
              packId: input.pack?.id ?? null,
              kind: 'phase_mismatch',
              source: 'vision',
              severity: 'warning',
              confidence: verdict.confidence,
              detail: JSON.stringify({
                match: 'phase',
                phaseShown: verdict.phaseShown,
                phaseClaimed: a.photoClaim,
                milestoneName: input.pack?.milestoneName ?? null,
                packId: input.pack?.id ?? null,
                observation: verdict.observation,
                caption,
              }),
            })
          }
        }
        // Render/screenshot/AI-generation tells.
        if (verdict.renderTells.length) {
          const key = `${a.photoId}:render_suspect:${verdict.renderTells[0]}`
          if (!recordedVision.has(key)) {
            recordedVision.add(key)
            writes.push({
              projectId: input.projectId,
              targetType: 'site_photo',
              targetId: a.photoId,
              packId: input.pack?.id ?? null,
              kind: 'render_suspect',
              source: 'vision',
              severity: 'warning',
              confidence: verdict.confidence,
              detail: JSON.stringify({
                match: 'render',
                tells: verdict.renderTells,
                tell: verdict.renderTells[0],
                phaseShown: verdict.phaseShown,
                phaseClaimed: a.photoClaim,
                milestoneName: input.pack?.milestoneName ?? null,
                packId: input.pack?.id ?? null,
                observation: verdict.observation,
                caption,
              }),
            })
          }
        }
      }
      for (const data of writes) await db.aiInsight.create({ data })

      // Honest outcome accounting, in priority order:
      //   · every attempt answered null → the SDK itself could not be created
      //     (no .z-ai-config): the vision pass was UNAVAILABLE, not attempted;
      //   · some attempt failed honestly ({ ok:false }) → no insight for it;
      //   · the cap held some photos back → say so (dHash covered them);
      //   · everything ran → no skip note at all.
      const attempted = attempts.filter((a) => a.skipped === null).length
      const allUnavailable = attempts.length > 0 && attempts.every((a) => a.res === null && !a.skipped)
      if (allUnavailable) {
        vision = {
          provider: 'unavailable',
          attempted: 0,
          insights: 0,
          skipped: 'AI provider unavailable (the SDK could not be created — no .z-ai-config?) — hash checks ran, vision pass honestly skipped',
        }
      } else {
        const skippedNote =
          attempts.some((a) => a.res === null && !a.skipped)
            ? 'provider unavailable for at least one photo — those inspections honestly skipped'
            : attempts.some((a) => a.res && !a.res.ok)
              ? 'at least one vision attempt failed — no insight written for it'
              : attempted < screened.length
                ? `vision capped at ${VISION_PHOTOS_CAP} photo(s) — the deterministic dHash check still covered all ${screened.length}`
                : attempts.length === 0
                  ? 'no readable photos to inspect'
                  : null
        vision = { provider: 'zai', attempted, insights: writes.length, skipped: skippedNote }
      }
    }

    const insightsWritten = duplicateInsights + (vision.provider === 'zai' ? vision.insights : 0)

    // 6. Audit event (the screen's own record — one row per run).
    await logAudit(
      input.projectId,
      'ai_screen',
      { name: 'ai', role: 'ai' },
      `Evidence authenticity screen ran — ${hashed} photo(s) hashed (${cacheHits} cached), ${duplicateInsights} duplicate flag(s), ${vision.insights} vision flag(s)${vision.skipped ? `; vision: ${vision.skipped}` : ''}`,
      {
        type: 'ai_screen.run',
        packId: input.pack?.id ?? null,
        milestoneName: input.pack?.milestoneName ?? null,
        hashed,
        cacheHits,
        unreadable,
        duplicateInsights,
        visionInsights: vision.insights,
        visionSkipped: vision.skipped,
      },
    )
    return {
      ok: true,
      ran: true,
      reason: 'screened',
      photos: photos.length,
      hashed,
      cacheHits,
      unreadable,
      duplicateInsights,
      vision,
      insightsWritten,
    }
  } catch (e) {
    // NEVER THROWN into a caller — a screen failure is advisory-only noise,
    // logged loudly and reported leak-free (error class only).
    console.error('[ai-authenticity] screen failed (advisory only)', e)
    return { ok: false, errorClass: e instanceof Error ? e.constructor.name : 'unknown' }
  }
}

/**
 * The draw-pack post-freeze hook (called from modules/drawpack/service.ts
 * after the pack row + its audit event are written). NEVER FAILS the pack or
 * the release: the wrapper catches EVERYTHING (runAuthenticityScreen itself
 * never throws, but a belt-and-braces catch guards any future edit) and a
 * failure is logged + audited as 'ai_screen' failed while the pack result
 * flows back unchanged. Flag OFF → runAuthenticityScreen no-ops silently by
 * design (documented in its header) — no audit row, no SDK contact.
 */
export async function runPostFreezeAuthenticityScreen(
  projectId: string,
  pack: AuthenticityPackContext,
): Promise<void> {
  try {
    const outcome = await runAuthenticityScreen({ projectId, pack })
    if (!outcome.ok) {
      console.error('[ai-authenticity] post-freeze screen failed (advisory only — the pack and release stand)', outcome.errorClass)
      await logAudit(
        projectId,
        'ai_screen',
        { name: 'ai', role: 'ai' },
        `Evidence authenticity screen FAILED after pack freeze for milestone "${pack.milestoneName}" — the pack and the release stand; check server logs`,
        { type: 'ai_screen.failed', packId: pack.id, milestoneId: pack.milestoneId, errorClass: outcome.errorClass },
      )
    }
  } catch (e) {
    // Belt and braces: even a programming error here cannot fail the pack.
    console.error('[ai-authenticity] post-freeze hook threw (advisory only — the pack and release stand)', e)
    await logAudit(
      projectId,
      'ai_screen',
      { name: 'ai', role: 'ai' },
      `Evidence authenticity screen FAILED after pack freeze for milestone "${pack.milestoneName}" — the pack and the release stand; check server logs`,
      {
        type: 'ai_screen.failed',
        packId: pack.id,
        milestoneId: pack.milestoneId,
        errorClass: e instanceof Error ? e.constructor.name : 'unknown',
      },
    )
  }
}

// ---------------- read path (route + evidence tab) ----------------

/** One advisory insight row, serialized for the client (detail parsed). */
export interface AuthenticityInsightView {
  id: string
  targetType: string
  targetId: string
  packId: string | null
  kind: string
  source: string
  severity: string
  confidence: string | null
  detail: Record<string, unknown>
  decidedBy: string | null
  decision: string | null
  decidedAt: string | null
  createdAt: string
}

/**
 * The project's advisory insight rows, newest first. READ-ONLY view data for
 * the evidence tab — nothing here feeds a decision, a gate or a score.
 */
export async function loadAuthenticityInsights(projectId: string): Promise<AuthenticityInsightView[]> {
  const rows = await db.aiInsight.findMany({
    where: { projectId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: INSIGHT_LIST_CAP,
  })
  return rows.map((r) => ({
    id: String(r.id),
    targetType: String(r.targetType),
    targetId: String(r.targetId),
    packId: r.packId === null || r.packId === undefined ? null : String(r.packId),
    kind: String(r.kind),
    source: String(r.source),
    severity: String(r.severity),
    confidence: r.confidence === null || r.confidence === undefined ? null : String(r.confidence),
    detail: parseDetail(String(r.detail ?? '{}')),
    decidedBy: r.decidedBy === null || r.decidedBy === undefined ? null : String(r.decidedBy),
    decision: r.decision === null || r.decision === undefined ? null : String(r.decision),
    decidedAt: r.decidedAt ? new Date(r.decidedAt as Date | string).toISOString() : null,
    createdAt: new Date(r.createdAt as Date | string).toISOString(),
  }))
}
