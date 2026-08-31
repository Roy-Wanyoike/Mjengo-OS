import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { overallProgress } from '@/lib/mjengo'

 
export async function llm(systemPrompt: string, userPrompt: string, jsonMode = false): Promise<any> {
  const zai = await ZAI.create()
  const completion = await zai.chat.completions.create({
    messages: [
      { role: 'assistant', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    thinking: { type: 'disabled' },
  })
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
  const zai = await ZAI.create()
  const completion = await zai.chat.completions.createVision({
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
  })
  return completion.choices[0]?.message?.content ?? ''
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

/** Parse a (transcribed) supplier/worker voice note into structured delivery items. */
export async function parseDeliveryTranscript(transcript: string, digest: ProjectDigest): Promise<ParsedVoiceNote> {
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
    `Material catalog for matching (name | unit | unit price KES):\n${catalog.map((m) => `${m.name} | ${m.unit} | ${m.unitPriceKES}`).join('\n')}\n\nVoice note transcript:\n"""${transcript}"""`,
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
    transcript,
    language: parsed.language ?? 'mix',
    supplier: parsed.supplier ?? null,
    items,
    totalKES: items.reduce((s, i) => s + i.totalKES, 0),
    notes: parsed.notes ?? null,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
  }
}
