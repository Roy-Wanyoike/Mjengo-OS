'use client'

// Draw pack viewer (issue W4-1) — the diaspora client's frozen proof bundle.
//
// Opened from money-tab on a RELEASED milestone (the pack link rows ride on
// the project payload). The bundle is fetched read-only through the EXISTING
// revocable share token — GET /api/share?token=<t>&drawPack=<id> — on both
// surfaces: the share-link client uses its own token, the owner/preview
// surface uses the project's token (the payload carries it; a share client
// holds it by construction). A revoked/regenerated token or an unknown pack
// id renders the standard invalid-link error, never a stack trace.
//
// The printable record follows the printable-invoice.tsx pattern: the block
// lives in a hidden `#draw-pack-print-root` container and window.print()
// prints ONLY it (the parent — money-tab — supplies the print-isolation
// <style>, exactly like the invoices section). The contentHash + canonical
// content string are shown so a lender can re-verify SHA-256 offline after
// the pack is forwarded.

import { useCallback, useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Button } from '@/frontend/ui/button'
import { Badge } from '@/frontend/ui/badge'
import { Copy, FileCheck2, Gauge, Printer, ShieldCheck, TrendingUp, Users } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'
import { formatKES } from '@/frontend/lib/format'
import type { DrawPackDetail } from '@/backend/modules/drawpack/service'

/** GET /api/share?token&drawPack response (shape pinned by the route). */
interface DrawPackResponse {
  ok: boolean
  pack: DrawPackDetail
  photos: Array<{ id: string; url: string; caption: string | null }>
  project: { name: string; client: string; location: string | null; status: string }
}

export interface DrawPackViewerProps {
  open: boolean
  onClose: () => void
  /** The immutable pack id (payload drawPacks link row). */
  packId: string
  /** The revocable share token serving the pack (share-link session or project token). */
  shareToken: string
  /** Milestone name — shown while loading / on errors. */
  milestoneName: string
}

export function DrawPackViewer({ open, onClose, packId, shareToken, milestoneName }: DrawPackViewerProps) {
  const t = useT()
  const [pack, setPack] = useState<DrawPackResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Fetch the frozen bundle read-only through the share token (audit-tab's
  // useCallback pattern: the setStates live in the async fn, the effect only
  // triggers it). isCancelled guards the unmount/close race.
  const loadPack = useCallback(
    async (isCancelled: () => boolean) => {
      setLoading(true)
      setError(null)
      setPack(null)
      try {
        const res = await fetch(
          `/api/share?token=${encodeURIComponent(shareToken)}&drawPack=${encodeURIComponent(packId)}`,
          { cache: 'no-store' },
        )
        const json = (await res.json().catch(() => null)) as DrawPackResponse | null
        if (isCancelled()) return
        if (res.ok && json?.ok && json.pack) {
          setPack(json)
        } else {
          // Standard share error family: invalid/revoked token OR unknown pack.
          setError(t('drawPack.error'))
        }
      } catch {
        if (!isCancelled()) setError(t('drawPack.error'))
      } finally {
        if (!isCancelled()) setLoading(false)
      }
    },
    // t() is stable per locale; packId/shareToken identify the fetch.
    [packId, shareToken, t],
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void loadPack(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [open, loadPack])

  async function copyHash() {
    if (!pack) return
    try {
      await navigator.clipboard.writeText(pack.pack.contentHash)
      toast.success(t('drawPack.copied'))
    } catch {
      toast.error(t('drawPack.errorHashCopy'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-stone-900">
            <FileCheck2 className="h-5 w-5 text-amber-600" aria-hidden />
            {t('drawPack.title')} — {milestoneName}
          </DialogTitle>
          <DialogDescription>{t('drawPack.desc')}</DialogDescription>
        </DialogHeader>

        {loading && <p className="py-8 text-center text-sm text-stone-500">{t('drawPack.loading')}</p>}

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" role="alert">
            {error}
          </div>
        )}

        {pack && (
          <div className="space-y-5">
            {/* the money line */}
            <div className="grid grid-cols-3 gap-3 rounded-lg border border-stone-200 bg-stone-50 p-4 text-xs">
              <div>
                <p className="pb-0.5 font-medium uppercase tracking-wide text-stone-400">{t('drawPack.amount')}</p>
                <p className="text-base font-bold tabular-nums text-stone-900">{formatKES(pack.pack.amount)}</p>
              </div>
              <div>
                <p className="pb-0.5 font-medium uppercase tracking-wide text-stone-400">{t('drawPack.ledgerRef')}</p>
                <p className="font-mono font-semibold text-stone-800">{pack.pack.ledgerRef}</p>
              </div>
              <div>
                <p className="pb-0.5 font-medium uppercase tracking-wide text-stone-400">{t('drawPack.frozenAt')}</p>
                <p className="font-medium text-stone-800">{new Date(pack.pack.createdAt).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
              </div>
            </div>

            {/* evidence photos */}
            <section aria-label={t('drawPack.evidence')} className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-stone-500">
                <ShieldCheck className="h-3.5 w-3.5 text-amber-600" aria-hidden /> {t('drawPack.evidence')} ({pack.pack.evidencePhotoIds.length})
              </h4>
              {pack.pack.evidencePhotoIds.length === 0 ? (
                <p className="text-xs text-stone-400">{t('drawPack.evidenceNone')}</p>
              ) : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {pack.photos.map((p) => (
                    <figure key={p.id} className="overflow-hidden rounded-md border border-stone-200">
                      <img src={p.url} alt={p.caption ?? t('drawPack.evidence')} className="h-24 w-full object-cover" loading="lazy" />
                      {p.caption && <figcaption className="truncate px-1.5 py-1 text-[10px] text-stone-500">{p.caption}</figcaption>}
                    </figure>
                  ))}
                  {pack.pack.evidencePhotoIds.length > pack.photos.length && (
                    <p className="col-span-full text-[11px] text-stone-400">{t('drawPack.photoGone', { count: pack.pack.evidencePhotoIds.length - pack.photos.length })}</p>
                  )}
                </div>
              )}
            </section>

            {/* variations open at decision time */}
            <section aria-label={t('drawPack.variations')} className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-stone-500">
                <TrendingUp className="h-3.5 w-3.5 text-amber-600" aria-hidden /> {t('drawPack.variations')}
              </h4>
              {pack.pack.variationsOpen.length === 0 ? (
                <p className="text-xs text-stone-400">{t('drawPack.variationsNone')}</p>
              ) : (
                <ul className="space-y-1.5">
                  {pack.pack.variationsOpen.map((v) => (
                    <li key={v.id} className="flex items-center justify-between rounded-md border border-stone-200 px-3 py-2 text-xs">
                      <span className="min-w-0 truncate font-medium text-stone-800">{v.title}</span>
                      <span className={`shrink-0 pl-2 font-bold tabular-nums ${v.budgetImpact >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {v.budgetImpact >= 0 ? '+' : '−'}{formatKES(Math.abs(v.budgetImpact))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* attendance window */}
            <section aria-label={t('drawPack.attendance')} className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-stone-500">
                <Users className="h-3.5 w-3.5 text-amber-600" aria-hidden /> {t('drawPack.attendance')}
              </h4>
              <p className="rounded-md border border-stone-200 px-3 py-2 text-xs text-stone-700">
                <span className="font-medium text-stone-500">{pack.pack.attendance.windowStart} → {pack.pack.attendance.windowEnd} · </span>
                {t('drawPack.attendanceRows', {
                  rows: pack.pack.attendance.rows,
                  present: pack.pack.attendance.present,
                  halfDay: pack.pack.attendance.halfDay,
                  absent: pack.pack.attendance.absent,
                  excused: pack.pack.attendance.excused,
                })}
                {pack.pack.attendance.verified > 0 ? ` · ${t('drawPack.attendanceVerified', { verified: pack.pack.attendance.verified })}` : ''}
              </p>
            </section>

            {/* MjengoScore — honest */}
            <section aria-label={t('drawPack.score')} className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-stone-500">
                <Gauge className="h-3.5 w-3.5 text-amber-600" aria-hidden /> {t('drawPack.score')}
              </h4>
              {pack.pack.mjengoScore ? (
                <p className="flex items-center gap-2 rounded-md border border-stone-200 px-3 py-2 text-xs text-stone-800">
                  <Badge className="border-0 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">{pack.pack.mjengoScore.score}/100</Badge>
                  {t('drawPack.scoreValue', { confidence: pack.pack.mjengoScore.confidence })}
                  <span className="text-stone-400">· v{pack.pack.mjengoScore.ruleVersion.replace(/^v/, '')}</span>
                </p>
              ) : (
                <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 px-3 py-2 text-xs italic text-stone-500">
                  {t('drawPack.scoreNotComputed')}
                </p>
              )}
            </section>

            {/* hash + verification */}
            <section aria-label={t('drawPack.hash')} className="space-y-1.5">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-stone-500">{t('drawPack.hash')}</h4>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-stone-100 px-3 py-2 font-mono text-[11px] text-stone-700" data-testid="draw-pack-hash">
                  {pack.pack.contentHash}
                </code>
                <Button size="sm" variant="outline" className="h-9 shrink-0 gap-1.5" onClick={() => void copyHash()}>
                  <Copy className="h-3.5 w-3.5" aria-hidden /> {t('drawPack.copy')}
                </Button>
              </div>
              <p className="text-[11px] leading-relaxed text-stone-400">{t('drawPack.hashHint')}</p>
            </section>

            <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-[11px] leading-relaxed text-stone-500">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
              {t('drawPack.footer')}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('drawPack.close')}</Button>
          <Button
            className="gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
            disabled={!pack}
            onClick={() => { if (pack) setTimeout(() => window.print(), 300) }}
            aria-label={t('drawPack.print')}
          >
            <Printer className="h-4 w-4" aria-hidden /> {t('drawPack.print')}
          </Button>
        </DialogFooter>

        {/* printable record — only this block is visible on paper (parent supplies the print-isolation style) */}
        {pack && <PrintableDrawPack res={pack} />}
      </DialogContent>
    </Dialog>
  )
}

// ---------------- printable record (printable-invoice.tsx pattern) ----------------

function PrintableDrawPack({ res }: { res: DrawPackResponse }) {
  const t = useT()
  const { pack, project, photos } = res
  return (
    <div id="draw-pack-print-root" className="hidden print:block fixed inset-0 z-[999] bg-white p-8 text-stone-900">
      {/* header */}
      <div className="flex items-start justify-between border-b-2 border-stone-800 pb-4">
        <div>
          <p className="text-2xl font-black tracking-tight">Mjengo<span className="text-amber-600">OS</span></p>
          <p className="text-xs text-stone-500">Construction procurement &amp; site record</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium uppercase tracking-widest text-stone-400">Evidence draw pack</p>
          <p className="font-mono text-lg font-bold">{pack.milestoneName}</p>
          <p className="text-xs text-stone-500">FROZEN AT RELEASE — IMMUTABLE</p>
        </div>
      </div>

      {/* parties */}
      <div className="grid grid-cols-2 gap-6 pt-4 text-xs">
        <div>
          <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">Project / client</p>
          <p className="font-medium">{project.name}</p>
          <p className="text-stone-500">{project.client}{project.location ? ` · ${project.location}` : ''}</p>
        </div>
        <div className="text-right">
          <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">Release</p>
          <p className="font-medium">{new Date(pack.createdAt).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
          <p className="text-stone-500">{t('drawPack.frozenAt')}</p>
        </div>
      </div>

      {/* the money line */}
      <div className="grid grid-cols-3 gap-4 pt-4 text-xs">
        <div><span className="text-stone-400">{t('drawPack.amount')}: </span><span className="font-bold tabular-nums">KSh {Math.round(pack.amount).toLocaleString('en-KE')}</span></div>
        <div><span className="text-stone-400">{t('drawPack.ledgerRef')}: </span><span className="font-mono font-medium">{pack.ledgerRef}</span></div>
        <div><span className="text-stone-400">{t('drawPack.packId')}: </span><span className="font-mono font-medium">{pack.id.slice(-8)}</span></div>
      </div>

      {/* evidence photos */}
      <div className="mt-6">
        <p className="pb-2 text-left font-medium uppercase tracking-wide text-stone-400">{t('drawPack.evidence')} ({pack.evidencePhotoIds.length})</p>
        {photos.length === 0 ? (
          <p className="text-xs text-stone-500">{t('drawPack.evidenceNone')}</p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {photos.map((p) => (
              <figure key={p.id} className="border border-stone-200 p-1">
                <img src={p.url} alt={p.caption ?? t('drawPack.evidence')} className="h-28 w-full object-cover" />
                <figcaption className="px-1 pt-1 text-[10px] text-stone-500">{p.caption ?? p.id.slice(-6)}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>

      {/* variations open */}
      <div className="mt-6 border border-stone-200 p-3 text-xs">
        <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">{t('drawPack.variations')}</p>
        {pack.variationsOpen.length === 0 ? (
          <p className="text-stone-500">{t('drawPack.variationsNone')}</p>
        ) : (
          <ul className="space-y-1">
            {pack.variationsOpen.map((v) => (
              <li key={v.id} className="flex justify-between">
                <span>{v.title}</span>
                <span className="tabular-nums">{v.budgetImpact >= 0 ? '+' : '−'}KSh {Math.abs(Math.round(v.budgetImpact)).toLocaleString('en-KE')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* attendance + score */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="border border-stone-200 p-3 text-xs">
          <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">{t('drawPack.attendance')}</p>
          <p className="text-stone-600">{pack.attendance.windowStart} → {pack.attendance.windowEnd}</p>
          <p className="text-stone-600">
            {pack.attendance.rows} day-rows · {pack.attendance.present} present · {pack.attendance.halfDay} half-day · {pack.attendance.absent} absent · {pack.attendance.excused} excused
          </p>
          <p className="text-stone-600">{pack.attendance.verified} verified</p>
        </div>
        <div className="border border-stone-200 p-3 text-xs">
          <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">{t('drawPack.score')}</p>
          {pack.mjengoScore ? (
            <p className="text-stone-600">
              {pack.mjengoScore.score}/100 · {t('drawPack.scoreValue', { confidence: pack.mjengoScore.confidence })} · v{pack.mjengoScore.ruleVersion.replace(/^v/, '')}
            </p>
          ) : (
            <p className="italic text-stone-500">{t('drawPack.scoreNotComputed')}</p>
          )}
        </div>
      </div>

      {/* verification */}
      <div className="mt-3 border-2 border-stone-800 p-3 text-xs">
        <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">{t('drawPack.hash')}</p>
        <p className="break-all font-mono text-[10px] leading-relaxed">{pack.contentHash}</p>
        <p className="pt-1 text-[10px] text-stone-500">{t('drawPack.hashHint')}</p>
      </div>

      {/* footer */}
      <p className="mt-8 border-t border-stone-200 pt-3 text-center text-[10px] text-stone-400">
        {t('drawPack.footer')} · Generated by MjengoOS — {new Date().toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })}
      </p>
    </div>
  )
}
