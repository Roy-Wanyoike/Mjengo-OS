import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/backend/lib/db'
import { overallProgress } from '@/backend/lib/mjengo'
import { scrubTranscriptPhones } from '@/backend/lib/pii-scrub'

 
// BE-4 (issue #76): the legacy AI seam gets the SAME discipline as
// modules/ai/provider.ts — the SDK's own fetch has NO timeout, so every call
// here is raced against a 20s cap (a stuck model API can no longer hold
// analyze-photo/recap/voice-log open for the route's full maxDuration) and
// the SDK instance is a module-level singleton (ZAI.create() re-reads the
// config file on every call — worth avoiding per request). The pattern is
// applied LOCALLY (provider.ts is untouched); on timeout the call throws a
// clean, leak-free Error — callers already route failures through their own
// try/catch + safeErrorMessage. The abandoned SDK request still finishes in
// the background and is discarded.

/** Hard cap on any single SDK call — 20s, then the attempt fails honestly
 *  (same value as modules/ai/provider.ts AI_CALL_TIMEOUT_MS). */
const AI_CALL_TIMEOUT_MS = 20_000

/** Cached create() promise — null until first use, or after a failure. */
let zaiPromise: Promise<ZAI> | null = null

/**
 * The lazy singleton: create the SDK once, cache the SUCCESS. A rejected
 * create() resets the cache and rethrows to the caller's catch — the next
 * call retries (config file dropped in later is picked up, no restart).
 */
async function getZaiSdk(): Promise<ZAI> {
  if (!zaiPromise) {
    zaiPromise = ZAI.create().catch((err: unknown) => {
      zaiPromise = null // do not cache the failure — retry on the next call
      throw err
    })
  }
  return zaiPromise
}

/**
 * Drop the cached SDK instance so the next call re-creates it (the test hook —
 * the flags module's invalidateFlagCache() role; also correct after an
 * operator changes .z-ai-config at runtime).
 */
export function resetLegacyAiSdkCache(): void {
  zaiPromise = null
}

/** Race sentinel — the 20s cap fired before the SDK answered. */
const TIMED_OUT = Symbol('legacy-zai-call-timeout')

/**
 * Race a legacy-seam SDK call against the 20s cap (the provider.ts idiom).
 * The timer is cleared once the race settles, so a fast call never leaves a
 * dangling (later-firing) handle; a timed-out call THROWS — llm()/
 * visionMessage() are throwing-by-contract and their callers already catch.
 */
async function withAiTimeout<T>(label: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const raced = await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), AI_CALL_TIMEOUT_MS)
      }),
    ])
    if (raced === TIMED_OUT) {
      throw new Error(`${label} timed out after ${AI_CALL_TIMEOUT_MS / 1000}s`)
    }
    return raced
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function llm(systemPrompt: string, userPrompt: string, jsonMode = false): Promise<any> {
  const zai = await getZaiSdk()
  const completion = await withAiTimeout(
    'AI chat',
    zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      thinking: { type: 'disabled' },
    }),
  )
  const content = completion.choices[0]?.message?.content
  if (!content) throw new Error('Empty AI response')
  if (!jsonMode) return content
  return extractJson(content)
}

 
export function extractJson(text: string): any {
  let t = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t)
  if (fence) t = fence[1].trim()
  // grab the outermost JSON object if prose surrounds it
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) t = t.slice(start, end + 1)
  return JSON.parse(t)
}

export async function visionMessage(prompt: string, base64: string, mime = 'image/jpeg') {
  const zai = await getZaiSdk()
  const completion = await withAiTimeout(
    'AI vision',
    zai.chat.completions.createVision({
      model: 'glm-5v-turbo',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ],
        },
      ],
      thinking: { type: 'disabled' },
    }),
  )
  return completion.choices[0]?.message?.content ?? ''
}

/**
 * Transcribe a base64 audio payload (BE-4): the voice-log route used to call
 * ZAI.create() + zai.audio.asr.create DIRECTLY with no cap — one stuck ASR
 * request held the route open for its full maxDuration (120s). Same 20s race
 * and same singleton as llm()/visionMessage(); returns the trimmed transcript
 * ('' when the model returned none — the caller decides what empty means).
 */
export async function transcribeAudio(audioBase64: string): Promise<string> {
  const zai = await getZaiSdk()
  const asr: unknown = await withAiTimeout(
    'AI transcription',
    zai.audio.asr.create({ file_base64: audioBase64 }),
  )
  const text = (asr as { text?: unknown } | null)?.text
  return typeof text === 'string' ? text.trim() : ''
}

/** Compact project digest used to give AI endpoints real context. */
export async function buildProjectDigest(projectId?: string | null) {
  const project = projectId
    ? await db.project.findUnique({ where: { id: String(projectId) } })
    : await db.project.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!project) throw new Error('No project found')
  const [phases, workers, materials, deliveries, consumptions, transactions, attendances, alerts] =
    await Promise.all([
      db.phase.findMany({ where: { projectId: project.id }, orderBy: { order: 'asc' }, include: { tasks: true } }),
      db.worker.findMany({ where: { projectId: project.id } }),
      db.material.findMany(),
      db.delivery.findMany({ where: { projectId: project.id }, orderBy: { date: 'desc' } }),
      db.consumption.findMany({ where: { projectId: project.id }, orderBy: { date: 'desc' } }),
      db.transaction.findMany({ where: { projectId: project.id } }),
      db.attendance.findMany({ where: { projectId: project.id }, orderBy: { date: 'desc' }, take: 60 }),
      db.alert.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ])

  const mat = (id: string) => materials.find((m) => m.id === id)
  const dayCount = Math.max(1, Math.ceil((Date.now() - project.startDate.getTime()) / 86400000))

  return {
    project: {
      name: project.name,
      location: project.location,
      budgetKES: project.budget,
      day: dayCount,
      client: project.client,
    },
    overallProgressPct: overallProgress(phases),
    phases: phases.map((p) => ({
      name: p.name,
      status: p.status,
      progressPct: p.progressManual ?? (p.tasks.length ? Math.round(p.tasks.reduce((s, t) => s + t.progress, 0) / p.tasks.length) : 0),
      budgetKES: p.budget,
      tasks: p.tasks.map((t) => ({ title: t.title, status: t.status, progress: t.progress })),
    })),
    crew: workers.map((w) => ({ name: w.name, role: w.role, dailyRateKES: w.dailyRate })),
    attendanceLastDays: attendances.map((a) => ({
      worker: workers.find((w) => w.id === a.workerId)?.name,
      date: a.date, status: a.status, wageKES: a.wage, paid: a.paid,
    })),
    materialsCatalog: materials.map((m) => ({ id: m.id, name: m.name, unit: m.unit, unitPriceKES: m.unitPrice })),
    deliveries: deliveries.map((d) => ({
      material: mat(d.materialId)?.name, qty: d.quantity, unit: mat(d.materialId)?.unit,
      totalKES: d.totalCost, supplier: d.supplier, daysAgo: Math.round((Date.now() - d.date.getTime()) / 86400000), source: d.source,
    })),
    consumption: consumptions.map((c) => ({
      material: mat(c.materialId)?.name, qty: c.quantity, unit: mat(c.materialId)?.unit,
      phase: c.phaseName, daysAgo: Math.round((Date.now() - c.date.getTime()) / 86400000), note: c.note,
    })),
    spend: {
      totalKES: transactions.reduce((s, t) => s + t.amount, 0),
      wagesKES: transactions.filter((t) => t.type === 'wage').reduce((s, t) => s + t.amount, 0),
      materialsKES: transactions.filter((t) => t.type === 'material').reduce((s, t) => s + t.amount, 0),
    },
    recentAlerts: alerts.map((a) => ({ type: a.type, severity: a.severity, title: a.title })),
    projectId: project.id,
  }
}

export type ProjectDigest = Awaited<ReturnType<typeof buildProjectDigest>>

/** Fuzzy-match a spoken material name to the catalog. */
export function matchMaterial(spoken: string, catalog: Array<{ id: string; name: string }>): string | null {
  const s = spoken.toLowerCase()
  const table: Array<[string[], string]> = [
    [['cement', 'saraji', 'saruji', 'bondü', 'bundu'], 'cement'],
    [['ballast', 'kokoto'], 'ballast'],
    [['sand', 'mchanga'], 'sand'],
    [['stone', 'mawe', 'mae', 'block', 'blocks'], 'machine cut'],
    [['steel', 'chuma', 'rebar', 'y10', 'y12'], 'steel'],
    [['binding wire', 'wire', 'waya'], 'binding'],
    [['timber', 'mbao', 'wood', 'capenter'], 'timber'],
    [['nails', 'misumari', 'sumari'], 'nails'],
    [['dpc', 'membrane', 'nylon'], 'dpc'],
    [['shuttering', 'formwork'], 'shuttering'],
  ]
  for (const [keys, target] of table) {
    if (keys.some((k) => s.includes(k))) {
      const hit = catalog.find((c) => c.name.toLowerCase().includes(target))
      if (hit) return hit.id
    }
  }
  return null
}

/** Number words (Swahili + English) → numeric value. */
export function parseQuantity(raw: string | number): number | null {
  if (typeof raw === 'number' && isFinite(raw)) return raw
  if (typeof raw !== 'string') return null
  const s = raw.toLowerCase().trim()
  const direct = Number(s)
  if (isFinite(direct) && s !== '') return direct
  const swahili: Record<string, number> = {
    moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5, sita: 6, saba: 7, nane: 8, tisa: 9, kumi: 10,
    ishirini: 20, thelathini: 30, arobaini: 40, hamsini: 50, sitini: 60, sabini: 70, themanini: 80, tisini: 90,
    mia: 100, elfu: 1000,
  }
  const words = s.split(/[\s-]+/)
  let total = 0
  let found = false
  for (const w of words) {
    const clean = w.replace(/[^a-z]/g, '')
    if (clean in swahili) {
      const v = swahili[clean]
      if (v === 100 || v === 1000) {
        total = (total || 1) * v
      } else {
        total += v
      }
      found = true
    }
  }
  if (found) return total
  const digits = s.match(/\d+(\.\d+)?/)
  return digits ? Number(digits[0]) : null
}

export interface ParsedDeliveryItem {
  spokenName: string
  materialId: string | null
  materialName: string
  unit: string
  quantity: number
  unitCostKES: number
  totalKES: number
  matched: boolean
}

export interface ParsedVoiceNote {
  transcript: string
  language: string
  supplier: string | null
  items: ParsedDeliveryItem[]
  totalKES: number
  notes: string | null
  confidence: number
}

/**
 * Parse a (transcribed) supplier/worker voice note into structured delivery
 * items.
 *
 * 8-b (PII): this is the shared parse seam where a transcript is turned into
 * everything the outside world can see — the LLM prompt below, the
 * `transcript` field of the returned ParsedVoiceNote (which /api/ai/voice-log
 * and /api/ai/parse-text return verbatim, and which the copilot UI persists
 * as delivery.create's rawTranscript) — so Kenyan phone numbers are masked
 * HERE, at entry (see src/backend/lib/pii-scrub.ts for shapes/guards and the
 * scoping decision: names are deliberately NOT masked). The LLM only ever
 * sees the scrubbed text, so derived fields (supplier/notes/items) cannot
 * echo a number the model never saw, and no structured delivery field needs
 * the phone — voice logs are notes, not contact records.
 */
export async function parseDeliveryTranscript(transcript: string, digest: ProjectDigest): Promise<ParsedVoiceNote> {
  const { scrubbed } = scrubTranscriptPhones(transcript)
  const catalog = digest.materialsCatalog
  const system = `You are MjengoOS's field-data parser for Kenyan construction sites.
Input is a NOISY ASR transcription of a contractor's voice note (Swahili / Sheng / English mix). ASR frequently garbles Swahili words. Your job is to RECOVER the intended meaning and extract material deliveries.

Swahili/Sheng glossary for common garbles:
- "nimepokea/nima pokia/nimepoke" = "I have received" (delivery verb!)
- numbers: ishirini/aishitini/ashirini=20, tano/teno/tarno=5, kumi=10, themanini/themanini/tomanini=80, hamsini=50, mia=100, thelathini/thelathini=30, mbili=2, tatu=3, nne=4, sita=6, saba=7, nane=8, tisa=9, arobaini=40
- materials: cement/saruji/saruji, mchanga=sand, kokoto/ballast, mawe/machine cut stones, chuma/steel, mbao/timber, waya/wire, misumari/nails
- "kutoka/from" introduces the SUPPLIER name. Fix obvious ASR garbles ("karaoke hardware" -> "Karioke Hardware").

Respond with STRICT JSON only:
{"supplier": string|null, "language": "sw"|"en"|"mix", "items": [{"name": string, "quantity": string|number, "unit": string}], "notes": string|null, "confidence": 0-1}

RULES:
- If the note mentions receiving/nimepokea/imefika materials, ALWAYS extract those items with normalized numeric quantities (e.g. "aishitini za cement" -> quantity 20). Never return an empty items array when a delivery is clearly described.
- Only return empty items if the note is genuinely about something else (weather, attendance, delays) — then summarize it in notes.
- Prices are NOT spoken; leave pricing out.

Example:
Transcript: "Habari, nimepokea bags themanini za cement kutoka Karioke"
=> {"supplier":"Karioke","language":"sw","items":[{"name":"cement","quantity":80,"unit":"bag"}],"notes":null,"confidence":0.9}`

  const parsed = await llm(
    system,
    `Material catalog for matching (name | unit | unit price KES):\n${catalog.map((m) => `${m.name} | ${m.unit} | ${m.unitPriceKES}`).join('\n')}\n\nVoice note transcript:\n"""${scrubbed}"""`,
    true,
  ) as { supplier: string | null; language?: string; items?: Array<{ name: string; quantity: string | number; unit?: string }>; notes?: string | null; confidence?: number }

  const items: ParsedDeliveryItem[] = []
  for (const raw of parsed.items ?? []) {
    const qty = parseQuantity(raw.quantity)
    if (!raw.name || qty === null || qty <= 0) continue
    const materialId = matchMaterial(raw.name, catalog)
    const cat = materialId ? catalog.find((m) => m.id === materialId) : null
    items.push({
      spokenName: raw.name,
      materialId,
      materialName: cat?.name ?? raw.name,
      unit: cat?.unit ?? raw.unit ?? 'unit',
      quantity: qty,
      unitCostKES: cat?.unitPriceKES ?? 0,
      totalKES: (cat?.unitPriceKES ?? 0) * qty,
      matched: Boolean(cat),
    })
  }

  return {
    transcript: scrubbed,
    language: parsed.language ?? 'mix',
    supplier: parsed.supplier ?? null,
    items,
    totalKES: items.reduce((s, i) => s + i.totalKES, 0),
    notes: parsed.notes ?? null,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
  }
}
