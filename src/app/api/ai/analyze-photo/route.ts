import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import { extractJson, visionMessage } from '@/lib/ai'
import { applyAction, getProjectPayload } from '@/lib/mjengo'
import { withGuard } from '@/lib/guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const POST = withGuard(async (req: NextRequest) => {
  try {
    const { dataUrl, url, photoId, phaseId, apply, projectId } = (await req.json()) as {
      dataUrl?: string; url?: string; photoId?: string; phaseId?: string; apply?: boolean; projectId?: string
    }

    // Resolve image bytes: direct data URL or a public site photo
    let base64 = ''
    let mime = 'image/jpeg'
    if (dataUrl) {
      const m = /^data:([a-zA-Z/+.-]+);base64,(.+)$/.exec(dataUrl)
      if (!m) return NextResponse.json({ error: 'Invalid dataUrl' }, { status: 400 })
      mime = m[1]
      base64 = m[2]
    } else if (url) {
      const safe = url.replace(/\.\./g, '')
      const filePath = path.join(process.cwd(), 'public', safe.startsWith('/') ? safe.slice(1) : safe)
      const buf = await readFile(filePath)
      mime = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg'
      base64 = buf.toString('base64')
    } else {
      return NextResponse.json({ error: 'dataUrl or url required' }, { status: 400 })
    }

    const project = projectId
      ? await db.project.findUnique({ where: { id: projectId } })
      : await db.project.findFirst({ orderBy: { createdAt: 'asc' } })
    if (!project) return NextResponse.json({ error: 'No project' }, { status: 404 })
    const phases = await db.phase.findMany({ where: { projectId: project.id }, orderBy: { order: 'asc' }, include: { tasks: true } })
    const phaseContext = phases
      .map((p) => `${p.order}. ${p.name} — status: ${p.status}, recorded progress: ${p.progressManual ?? Math.round(p.tasks.reduce((s, t) => s + t.progress, 0) / Math.max(1, p.tasks.length))}%`)
      .join('\n')

    const prompt = `You are a senior construction site inspector for residential builds in Kenya (machine-cut stone masonry construction).
A site foreman uploaded this photo taken NOW (day ${Math.ceil((Date.now() - project.startDate.getTime()) / 86400000)} of the build "${project.name}" in ${project.location}).

The project phases are:
${phaseContext}

Analyze the photo and respond with STRICT JSON only (no markdown):
{
  "phaseShown": "<most likely phase name from the list above, or 'unknown'>",
  "progressPct": <your independent visual estimate of THAT phase's completion, 0-100 integer>,
  "confidence": <0-1>,
  "observations": ["3-5 short factual observations of what is visible: wall courses, scaffolding, openings, ring beam etc."],
  "safety": [{"issue": "<PPE or hazard issue>", "severity": "low|medium|high"}],
  "materialsVisible": [{"name": "<material>", "roughQty": "<rough count/stack estimate>"}],
  "qualityFlags": ["0-3 short workmanship concerns or 'none' array empty"],
  "summary": "<one-line plain-English summary like: 'Ground floor walls approximately 80% complete, courses up to lintel level.'>"
}
Be conservative and evidence-based. If uncertain, lower the confidence.`

    const raw = await visionMessage(prompt, base64, mime)
    const analysis = extractJson(raw)

    // Match spoken phase to a phase row
    let matchedPhase: typeof phases[number] | null = null
    if (analysis.phaseShown && analysis.phaseShown !== 'unknown') {
      matchedPhase = phases.find((p) => p.name.toLowerCase().includes(String(analysis.phaseShown).toLowerCase().split(' ')[0])) ?? null
    }
    if (phaseId) matchedPhase = phases.find((p) => p.id === phaseId) ?? matchedPhase

    let data = null
    let appliedPhotoId: string | null = null
    if (apply) {
      const result = await applyAction('photo.apply', {
        photoId: photoId ?? undefined,
        url: url ?? undefined,
        caption: analysis.summary ?? 'AI-analyzed site photo',
        phaseId: matchedPhase?.id,
        progressPct: typeof analysis.progressPct === 'number' ? analysis.progressPct : undefined,
        analysis,
      }, projectId)
      appliedPhotoId = result.id
      data = await getProjectPayload(projectId)
    }

    return NextResponse.json({
      ok: true,
      analysis,
      phaseId: matchedPhase?.id ?? null,
      phaseName: matchedPhase?.name ?? analysis.phaseShown,
      recordedProgress: matchedPhase ? (matchedPhase.progressManual ?? 0) : null,
      appliedPhotoId,
      data,
    })
  } catch (e) {
    console.error('[api/ai/analyze-photo]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Photo analysis failed' }, { status: 500 })
  }
})
