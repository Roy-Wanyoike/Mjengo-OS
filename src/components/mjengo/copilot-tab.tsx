'use client'

import { useRef, useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { PhotoAnalysisBody } from '@/components/mjengo/overview-tab'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Camera, Mic, Square, ScanSearch, Sparkles, Upload, Play, Loader2, CheckCircle2,
  AlertTriangle, TriangleAlert, Info, Lock, FileAudio,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatKES } from '@/lib/format'

interface PhotoAnalysisResult {
  analysis: {
    phaseShown?: string
    progressPct?: number
    confidence?: number
    summary?: string
    observations?: string[]
    safety?: Array<{ issue: string; severity: string }>
    materialsVisible?: Array<{ name: string; roughQty: string }>
    qualityFlags?: string[]
  }
  phaseId: string | null
  phaseName: string | null
  recordedProgress: number | null
  appliedPhotoId: string | null
}

interface ParsedVoice {
  transcript: string
  language: string
  supplier: string | null
  items: Array<{
    spokenName: string
    materialId: string | null
    materialName: string
    unit: string
    quantity: number
    unitCostKES: number
    totalKES: number
    matched: boolean
  }>
  totalKES: number
  notes: string | null
  confidence: number
}

interface ScanResult {
  summary: string
  alerts: Array<{ type: string; severity: string; title: string; message: string }>
}

export function CopilotTab() {
  const { data, dispatch, online, viewMode } = useMjengo()
  const [tab, setTab] = useState<'photo' | 'voice' | 'scan'>('photo')

  if (!data) return null

  // Diaspora clients see a locked placeholder — AI tools are site-team only
  if (viewMode === 'client') {
    return (
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="py-16 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-stone-100 flex items-center justify-center" aria-hidden>
            <Lock className="w-7 h-7 text-stone-400" />
          </div>
          <div className="max-w-md">
            <h2 className="text-lg font-semibold text-stone-900">AI tools are for the site team</h2>
            <p className="mt-1.5 text-sm text-stone-500 leading-relaxed">
              Photo verification, Swahili voice logging and integrity scans are run by the crew on site.
              Your client view shows the results — photo evidence, alerts and the 6 PM recap.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <Card className="border-amber-200 bg-gradient-to-br from-amber-50 to-stone-50 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-600" aria-hidden /> AI Copilot — the connective tissue
          </CardTitle>
          <CardDescription>
            The AI never replaces the human on site — it turns photos, Swahili voice notes and messy ledgers into
            structured ground truth. AI features require connectivity; field logging works offline.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2 flex-wrap">
          <Button variant={tab === 'photo' ? 'default' : 'outline'} size="sm" className="gap-1.5" onClick={() => setTab('photo')}>
            <Camera className="w-4 h-4" aria-hidden /> Photo progress
          </Button>
          <Button variant={tab === 'voice' ? 'default' : 'outline'} size="sm" className="gap-1.5" onClick={() => setTab('voice')}>
            <Mic className="w-4 h-4" aria-hidden /> Voice-to-invoice
          </Button>
          <Button variant={tab === 'scan' ? 'default' : 'outline'} size="sm" className="gap-1.5" onClick={() => setTab('scan')}>
            <ScanSearch className="w-4 h-4" aria-hidden /> Anomaly scan
          </Button>
          {!online && (
            <Badge className="gap-1 bg-amber-100 text-amber-800 border-0 ml-auto"><Lock className="w-3 h-3" aria-hidden /> offline — AI paused</Badge>
          )}
        </CardContent>
      </Card>

      {tab === 'photo' && <PhotoPanel online={online} />}
      {tab === 'voice' && <VoicePanel online={online} />}
      {tab === 'scan' && <ScanPanel online={online} />}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { icon: Camera, title: 'Physical ground truth', text: 'Every estimate is anchored to a real site photo with timestamp & provenance — no photo, no AI opinion.' },
          { icon: Mic, title: 'Swahili/Sheng first', text: 'Voice notes in Kiswahili, Sheng or English are parsed into ledger entries — fundis do not type.' },
          { icon: ScanSearch, title: 'Trust engine', text: 'Deliveries vs consumption vs progress are reconciled continuously to catch loss, theft and ghost workers.' },
        ].map(({ icon: Icon, title, text }) => (
          <Card key={title} className="border-stone-200 shadow-sm bg-white">
            <CardContent className="p-4 flex gap-3">
              <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0" aria-hidden>
                <Icon className="w-5 h-5 text-amber-700" />
              </div>
              <div>
                <p className="text-sm font-semibold text-stone-800">{title}</p>
                <p className="text-xs text-stone-500 mt-0.5 leading-relaxed">{text}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ Photo

/** Data-Saver downscale (spec §74): canvas resize to max 1024px, JPEG q0.72. */
async function downscaleDataUrl(dataUrl: string, max = 1024, quality = 0.72): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      if (scale >= 1) { resolve(dataUrl); return } // already small enough
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('Canvas unavailable')); return }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => reject(new Error('Could not load image for downscale'))
    img.src = dataUrl
  })
}

function PhotoPanel({ online }: { online: boolean }) {
  const { data, dispatch, load } = useMjengo()
  const dataMode = useMjengo((s) => s.dataMode)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewIsData, setPreviewIsData] = useState(false)
  const [phaseId, setPhaseId] = useState<string>('')
  const [applyToLedger, setApplyToLedger] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PhotoAnalysisResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  if (!data) return null

  // Feature flag (spec §81): ai_progress gates this whole panel's analysis.
  const aiProgressOn = data.intel.flags?.ai_progress !== false
  const saver = dataMode === 'data_saver'

  function pickSeeded(url: string, caption: string | null) {
    setPreview(url)
    setPreviewIsData(false)
    setResult(null)
    const match = data?.photos.find((p) => p.url === url)
    setPhaseId(match?.phaseId ?? '')
    if (caption) toast.info(`Selected: ${caption}`)
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => { setPreview(String(reader.result)); setPreviewIsData(true); setResult(null); setPhaseId('') }
    reader.readAsDataURL(f)
  }

  async function analyze() {
    if (!preview) { toast.error('Upload or pick a site photo first'); return }
    if (!online) { toast.error('AI analysis needs connectivity — toggle Online in the header'); return }
    if (!aiProgressOn) { toast.error('AI progress is disabled by feature flag (ai_progress)'); return }
    setBusy(true); setResult(null)
    try {
      let url: string | undefined
      let dataUrl: string | undefined
      let photoId: string | undefined
      if (previewIsData) {
        // Data Saver (spec §74): compress on-device BEFORE anything is sent.
        let toSend = preview
        if (saver) {
          try {
            toSend = await downscaleDataUrl(preview)
            toast.info('Data Saver — photo compressed before upload (max 1024px JPEG)')
          } catch {
            toast.info('Data Saver — could not compress this image, uploading as-is')
          }
        }
        // Upload first (POST /api/upload) so the photo persists at a real URL —
        // the analysis AND the photo.apply action both need that url; a raw
        // dataUrl used to leave "Apply to ledger" silently dead.
        const up = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: toSend }),
        })
        const upJson = await up.json().catch(() => null)
        if (!up.ok || !upJson?.url) {
          toast.error(upJson?.error ?? 'Photo upload failed — analysis aborted (nothing was recorded)')
          return
        }
        url = upJson.url as string
        setPreview(url)
        setPreviewIsData(false)
      } else {
        url = preview
        const match = data?.photos.find((p) => p.url === url)
        photoId = match?.id
      }
      const res = await fetch('/api/ai/analyze-photo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, url, photoId, phaseId: phaseId || undefined, apply: applyToLedger, projectId: data?.project.id }),
      })
      const json = await res.json()
      if (json.ok) {
        setResult(json as PhotoAnalysisResult)
        if (json.appliedPhotoId) {
          toast.success(`Progress updated — ${json.phaseName}: ${json.analysis.progressPct}% (photo evidence attached)`)
          await load()
        } else {
          toast.success('Analysis complete — review below, then Apply to ledger')
        }
      } else {
        toast.error(json.error ?? 'Analysis failed')
      }
    } catch {
      toast.error('Network error during analysis')
    } finally {
      setBusy(false)
    }
  }

  async function applyNow() {
    if (!result) return
    const ok = await dispatch('photo.apply', {
      photoId: result.appliedPhotoId ?? undefined,
      url: !result.appliedPhotoId && !previewIsData ? preview : undefined,
      caption: result.analysis.summary ?? 'AI-analyzed site photo',
      phaseId: result.phaseId ?? undefined,
      progressPct: typeof result.analysis.progressPct === 'number' ? result.analysis.progressPct : undefined,
      analysis: result.analysis,
    }, 'Apply AI photo analysis')
    if (ok) {
      toast.success('Applied to ledger — phase progress updated with photo evidence')
      setResult(null)
    } else {
      // Dispatch failures are surfaced, never silent (spec §84 no dead UI).
      toast.error('Apply to ledger failed — the analysis was NOT recorded. Try again.')
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">1 · Capture the physical ground truth</CardTitle>
          <CardDescription>Upload a fresh site photo, or re-analyze one from the evidence log</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className="border-2 border-dashed border-stone-300 rounded-xl p-4 flex flex-col items-center gap-3 bg-stone-50/50"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) { const dt = new DataTransfer(); dt.items.add(f); if (fileRef.current) { fileRef.current.files = dt.files; onFile({ target: { files: dt.files } } as never) } } }}
          >
            {preview ? (
              <img src={preview} alt="Site photo preview" className="max-h-64 rounded-lg border border-stone-200 object-cover" />
            ) : (
              <div className="py-8 flex flex-col items-center gap-2 text-stone-400">
                <Camera className="w-10 h-10" aria-hidden />
                <p className="text-sm">Drop a site photo here, or</p>
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={onFile} aria-label="Upload site photo" />
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fileRef.current?.click()}>
              <Upload className="w-4 h-4" aria-hidden /> {preview ? 'Change photo' : 'Upload photo'}
            </Button>
            {saver && <p className="text-[11px] text-stone-400">Data Saver on — photos are compressed to ≤1024px JPEG before upload</p>}
          </div>

          <div>
            <p className="text-xs font-medium text-stone-500 mb-2">Or pick from the evidence log</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {data.photos.slice(0, 5).map((p) => (
                <button key={p.id} onClick={() => pickSeeded(p.url, p.caption)} className={`shrink-0 w-20 aspect-[4/3] rounded-lg overflow-hidden border-2 ${preview === p.url ? 'border-amber-500' : 'border-stone-200'} focus:outline-none focus:ring-2 focus:ring-amber-500`} aria-label={`Pick ${p.caption ?? 'photo'}`}>
                  <img src={p.url} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-stone-200 p-3">
            <div className="min-w-0">
              <Label htmlFor="phase-pick" className="text-sm font-medium text-stone-700">Phase context</Label>
              <p className="text-xs text-stone-400">Helps the vision model anchor the estimate</p>
            </div>
            <Select value={phaseId} onValueChange={setPhaseId}>
              <SelectTrigger id="phase-pick" size="sm" className="w-44 bg-white shrink-0"><SelectValue placeholder="Auto-detect" /></SelectTrigger>
              <SelectContent>
                {data.phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-stone-200 p-3">
            <div>
              <Label htmlFor="apply-ledger" className="text-sm font-medium text-stone-700">Apply to ledger automatically</Label>
              <p className="text-xs text-stone-400">Updates phase progress + attaches photo as evidence</p>
            </div>
            <Switch id="apply-ledger" checked={applyToLedger} onCheckedChange={setApplyToLedger} className="data-[state=checked]:bg-amber-600" />
          </div>

          <Button
            className="w-full gap-2 bg-amber-600 hover:bg-amber-700 text-white"
            size="lg"
            onClick={() => void analyze()}
            disabled={busy || !preview || !aiProgressOn}
            title={!aiProgressOn ? 'Disabled by feature flag (ai_progress)' : undefined}
          >
            {busy ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden /> : <ScanSearch className="w-5 h-5" aria-hidden />}
            {busy ? 'Vision model analyzing…' : 'Analyze with vision AI'}
          </Button>
          {!aiProgressOn && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2" role="status">
              Disabled by feature flag (ai_progress) — an admin can re-enable it from the Settings icon in the header.
            </p>
          )}
          {busy && <Progress value={70} className="h-1.5 bg-stone-200 [&>[data-slot=progress-indicator]]:bg-amber-500" />}
        </CardContent>
      </Card>

      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">2 · AI reads the site</CardTitle>
          <CardDescription>Progress %, safety (PPE), visible materials & workmanship</CardDescription>
        </CardHeader>
        <CardContent>
          {result ? (
            <div className="space-y-4">
              <PhotoAnalysisBody analysis={result.analysis} />
              {result.recordedProgress !== null && (
                <div className="flex items-center justify-between rounded-lg bg-stone-50 border border-stone-200 px-3 py-2 text-sm">
                  <span className="text-stone-600">Recorded progress: <strong>{result.recordedProgress}%</strong></span>
                  {!result.appliedPhotoId ? (
                    <Button size="sm" className="gap-1 bg-amber-600 hover:bg-amber-700 text-white" onClick={() => void applyNow()}>
                      <CheckCircle2 className="w-4 h-4" aria-hidden /> Apply to ledger
                    </Button>
                  ) : (
                    <Badge className="bg-emerald-100 text-emerald-800 border-0 gap-1"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> applied</Badge>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-stone-400 border border-dashed border-stone-200 rounded-lg p-8 text-center">
              The vision model&apos;s report appears here — phase match, completion %, PPE compliance,
              material counts and quality flags, all traceable to the photo.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ Voice

function VoicePanel({ online }: { online: boolean }) {
  const { data, dispatch, load } = useMjengo()
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [busy, setBusy] = useState(false)
  const [parsed, setParsed] = useState<ParsedVoice | null>(null)
  const [textMode, setTextMode] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioFileRef = useRef<HTMLInputElement>(null)

  if (!data) return null

  function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) { toast.error('Microphone not available in this browser'); return }
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const mr = new MediaRecorder(stream)
      mediaRef.current = mr
      chunksRef.current = []
      mr.ondataavailable = (e) => chunksRef.current.push(e.data)
      mr.onstop = () => { stream.getTracks().forEach((t) => t.stop()); void processBlob(chunksRef.current[0] ?? new Blob()) }
      mr.start()
      setRecording(true); setElapsed(0); setParsed(null); setConfirmed(false)
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
    }).catch(() => toast.error('Microphone permission denied'))
  }

  function stopRecording() {
    mediaRef.current?.stop()
    setRecording(false)
    if (timerRef.current) clearInterval(timerRef.current)
  }

  async function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(String(reader.result).split(',')[1])
      reader.readAsDataURL(blob)
    })
  }

  async function processBlob(blob: Blob) {
    if (blob.size < 1000) { toast.error('Recording too short'); return }
    await runVoice(await blobToBase64(blob))
  }

  async function runVoice(base64: string) {
    if (!online) { toast.error('Voice AI needs connectivity — toggle Online first'); return }
    setBusy(true); setParsed(null); setConfirmed(false)
    try {
      const res = await fetch('/api/ai/voice-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: base64, projectId: data?.project.id }),
      })
      const json = await res.json()
      if (json.ok) { setParsed(json as ParsedVoice); toast.success(`Transcribed (${json.language === 'sw' ? 'Kiswahili' : json.language === 'mix' ? 'mixed' : 'English'}) — review items below`) }
      else toast.error(json.error ?? 'Voice processing failed')
    } catch { toast.error('Network error') } finally { setBusy(false) }
  }

  async function playSample(file: string) {
    if (!online) { toast.error('Voice AI needs connectivity'); return }
    setBusy(true); setParsed(null); setConfirmed(false)
    try {
      const blob = await fetch(file).then((r) => r.blob())
      await runVoice(await blobToBase64(blob))
    } catch { toast.error('Could not load sample'); setBusy(false) }
  }

  async function parseText() {
    if (!textMode.trim()) { toast.error('Type or paste a note first'); return }
    if (!online) { toast.error('Parsing needs connectivity'); return }
    setBusy(true); setParsed(null); setConfirmed(false)
    try {
      const res = await fetch('/api/ai/parse-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: textMode.trim(), projectId: data?.project.id }) })
      const json = await res.json()
      if (json.ok) { setParsed(json as ParsedVoice); toast.success('Parsed — review the items below') }
      else toast.error(json.error ?? 'Parse failed')
    } catch { toast.error('Network error') } finally { setBusy(false) }
  }

  async function confirmLog() {
    if (!parsed || !parsed.items.length) return
    let ok = true
    for (const item of parsed.items) {
      if (!item.materialId) continue
      ok = ok && await dispatch('delivery.create', {
        materialId: item.materialId,
        quantity: item.quantity,
        unitCost: item.unitCostKES,
        supplier: parsed.supplier ?? 'Unknown supplier',
        source: 'voice',
        rawTranscript: parsed.transcript,
      }, `Voice-logged ${item.quantity} ${item.unit} ${item.materialName}`)
    }
    if (ok) {
      toast.success(`${parsed.items.length} item(s) logged to inventory + M-Pesa ledger`)
      setConfirmed(true)
      await load()
    } else toast.error('Some items failed to log')
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">1 · Send a voice note</CardTitle>
          <CardDescription>Kiswahili, Sheng or English — like WhatsApping your supplier log</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-stone-200 bg-stone-50/60 p-6">
            <button
              onClick={recording ? stopRecording : startRecording}
              disabled={busy}
              className={`w-20 h-20 rounded-full flex items-center justify-center transition-all focus:outline-none focus:ring-4 focus:ring-amber-300 ${recording ? 'bg-red-600 animate-pulse' : 'bg-amber-600 hover:bg-amber-700'}`}
              aria-label={recording ? 'Stop recording' : 'Start recording'}
            >
              {recording ? <Square className="w-8 h-8 text-white" aria-hidden /> : <Mic className="w-8 h-8 text-white" aria-hidden />}
            </button>
            <p className="text-sm text-stone-600 font-medium tabular-nums">
              {recording ? `Recording… ${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')} — tap to stop` : busy ? 'Transcribing & parsing…' : 'Tap to record a delivery note'}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-stone-500">No mic? Try a sample voice note</p>
            <div className="flex gap-2 flex-wrap">
              <Button variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={() => void playSample('/audio/voice-cement-delivery.wav')}>
                <Play className="w-3.5 h-3.5" aria-hidden /> “20 bags cement + 5 wire — Karioke”
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={() => void playSample('/audio/voice-sand-ballast.wav')}>
                <Play className="w-3.5 h-3.5" aria-hidden /> “12t sand + 5t ballast — Mwangaza”
              </Button>
            </div>
            <input ref={audioFileRef} type="file" accept="audio/*" className="sr-only" aria-label="Upload audio file"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void processBlob(f) }} />
            <Button variant="ghost" size="sm" className="gap-1.5 self-start text-stone-500" disabled={busy} onClick={() => audioFileRef.current?.click()}>
              <FileAudio className="w-4 h-4" aria-hidden /> Upload an audio file instead
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-stone-500">Or type it (WhatsApp forward style)</p>
            <Textarea value={textMode} onChange={(e) => setTextMode(e.target.value)} rows={3}
              placeholder="e.g. Nimepokea bags 50 za cement na mawe 2000 kutoka Ndarugu Quarry" />
            <Button variant="outline" size="sm" className="gap-1.5" disabled={busy || !textMode.trim()} onClick={() => void parseText()}>
              <Sparkles className="w-4 h-4" aria-hidden /> Parse text
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">2 · Structured invoice preview</CardTitle>
          <CardDescription>Review, then commit to the shared ledger</CardDescription>
        </CardHeader>
        <CardContent>
          {!parsed ? (
            <div className="text-sm text-stone-400 border border-dashed border-stone-200 rounded-lg p-8 text-center">
              Transcript + itemized deliveries (with catalog price matching) appear here.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg bg-stone-900 text-stone-100 p-3 text-sm font-mono">
                <p className="text-[10px] text-stone-400 uppercase tracking-wide mb-1">Transcript ({parsed.language === 'sw' ? 'Kiswahili' : parsed.language === 'mix' ? 'mixed' : 'English'} · {Math.round(parsed.confidence * 100)}% confidence)</p>
                “{parsed.transcript}”
              </div>
              {parsed.items.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Est. cost</TableHead>
                      <TableHead>Match</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsed.items.map((item, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium text-stone-800 text-sm">{item.materialName}</TableCell>
                        <TableCell className="text-right tabular-nums">{item.quantity} {item.unit}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatKES(item.totalKES)}</TableCell>
                        <TableCell>
                          {item.matched ? <Badge className="bg-emerald-100 text-emerald-800 border-0 text-[10px] hover:bg-emerald-100">catalog</Badge> : <Badge className="bg-amber-100 text-amber-800 border-0 text-[10px] hover:bg-amber-100">manual</Badge>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                  No deliveries found in this note. {parsed.notes && <span className="italic">“{parsed.notes}”</span>}
                </p>
              )}
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  {parsed.supplier && <p className="text-stone-500">Supplier: <strong className="text-stone-800">{parsed.supplier}</strong></p>}
                  {parsed.items.length > 0 && <p className="text-stone-500">Total: <strong className="text-stone-900">{formatKES(parsed.totalKES)}</strong></p>}
                </div>
                {confirmed ? (
                  <Badge className="bg-emerald-100 text-emerald-800 border-0 gap-1"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> logged</Badge>
                ) : (
                  <Button className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white" disabled={!parsed.items.length} onClick={() => void confirmLog()}>
                    <CheckCircle2 className="w-4 h-4" aria-hidden /> Confirm &amp; log
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ Scan

function ScanPanel({ online }: { online: boolean }) {
  const { data, load } = useMjengo()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)

  if (!data) return null

  async function runScan() {
    if (!online) { toast.error('Anomaly AI needs connectivity'); return }
    setBusy(true); setResult(null)
    try {
      const res = await fetch('/api/ai/anomaly-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: data?.project.id }),
      })
      const json = await res.json()
      if (json.ok) {
        setResult({ summary: json.summary, alerts: json.alerts ?? [] })
        toast.success(`Integrity scan complete — ${json.alerts?.length ?? 0} finding(s) added to the alert feed`)
        await load()
      } else toast.error(json.error ?? 'Scan failed')
    } catch { toast.error('Network error') } finally { setBusy(false) }
  }

  const openIssues = data.alerts.filter((a) => !a.acknowledged)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">Ledger integrity scan</CardTitle>
          <CardDescription>
            Cross-checks {data.deliveries.length} deliveries vs {data.consumptions.length} consumption logs vs
            {' '}{data.summary.progressPct}% progress and wage records — the ghost-buster.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-stone-50 border border-stone-200 p-3">
              <p className="text-lg font-bold text-stone-900 tabular-nums">{data.materials.reduce((s, m) => s + m.deliveredQty, 0).toLocaleString()}</p>
              <p className="text-[10px] text-stone-500 uppercase tracking-wide">units delivered</p>
            </div>
            <div className="rounded-lg bg-stone-50 border border-stone-200 p-3">
              <p className="text-lg font-bold text-stone-900 tabular-nums">{data.materials.reduce((s, m) => s + m.consumedQty, 0).toLocaleString()}</p>
              <p className="text-[10px] text-stone-500 uppercase tracking-wide">units consumed</p>
            </div>
            <div className="rounded-lg bg-stone-50 border border-stone-200 p-3">
              <p className="text-lg font-bold text-stone-900 tabular-nums">{formatKES(data.materials.reduce((s, m) => s + m.stockValue, 0), true)}</p>
              <p className="text-[10px] text-stone-500 uppercase tracking-wide">stock at risk</p>
            </div>
          </div>
          <Button className="w-full gap-2 bg-amber-600 hover:bg-amber-700 text-white" size="lg" onClick={() => void runScan()} disabled={busy}>
            {busy ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden /> : <ScanSearch className="w-5 h-5" aria-hidden />}
            {busy ? 'Auditing the shared ledger…' : 'Run integrity scan'}
          </Button>
          <p className="text-xs text-stone-400 leading-relaxed">
            Typical catches: delivered vs used cement variance, spend leading progress, wage payouts without
            matching attendance, supplier pricing above catalog.
          </p>
        </CardContent>
      </Card>

      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">Findings</CardTitle>
          <CardDescription>{openIssues.length} open issue(s) in the trust ledger</CardDescription>
        </CardHeader>
        <CardContent>
          {result && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-semibold flex items-center gap-1.5 mb-1"><Sparkles className="w-4 h-4" aria-hidden /> Verdict</p>
              {result.summary}
            </div>
          )}
          <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
            {openIssues.length === 0 && !result && (
              <p className="text-sm text-stone-400 border border-dashed border-stone-200 rounded-lg p-6 text-center">
                No open findings. Run a scan to reconcile the ledger.
              </p>
            )}
            {openIssues.map((a) => (
              <div key={a.id} className={`rounded-lg border p-3 ${a.severity === 'critical' ? 'border-red-200 bg-red-50/60' : a.severity === 'warning' ? 'border-amber-200 bg-amber-50/60' : 'border-stone-200'}`}>
                <div className="flex items-start gap-2">
                  {a.severity === 'critical' ? <TriangleAlert className="w-4 h-4 text-red-600 mt-0.5 shrink-0" aria-hidden />
                    : a.severity === 'warning' ? <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" aria-hidden />
                    : <Info className="w-4 h-4 text-stone-400 mt-0.5 shrink-0" aria-hidden />}
                  <div>
                    <p className="text-sm font-semibold text-stone-800">{a.title}</p>
                    <p className="text-xs text-stone-600 mt-1 leading-relaxed">{a.message}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
