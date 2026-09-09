'use client'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Button } from '@/frontend/ui/button'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Separator } from '@/frontend/ui/separator'
import { Switch } from '@/frontend/ui/switch'
import { Copy, Eye, RefreshCw, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'

export interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  shareUrl: string | null
  previewing: boolean
  onPreviewingChange: (v: boolean) => void
  onRegenerate: () => void | Promise<void>
}

export function ShareDialog({ open, onOpenChange, shareUrl, previewing, onPreviewingChange, onRegenerate }: ShareDialogProps) {
  const t = useT()
  async function copyLink() {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      toast.success(t('share.linkCopied'))
    } catch {
      toast.error(t('share.copyFailed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-stone-900 flex items-center gap-2">
            <Eye className="w-5 h-5 text-amber-600" aria-hidden />
            {t('share.title')}
          </DialogTitle>
          <DialogDescription>
            {t('share.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="space-y-2">
            <Label htmlFor="share-url">{t('share.linkLabel')}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="share-url"
                readOnly
                value={shareUrl ?? t('share.generating')}
                placeholder={t('share.generating')}
                className="font-mono text-xs text-stone-600 bg-stone-50"
                aria-label={t('share.aria.link')}
              />
              <Button
                size="icon"
                onClick={() => void copyLink()}
                disabled={!shareUrl}
                aria-label={t('share.aria.copy')}
                className="shrink-0 h-11 w-11 bg-amber-600 hover:bg-amber-700 text-white"
              >
                <Copy className="w-4 h-4" aria-hidden />
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void Promise.resolve(onRegenerate())}
              disabled={!shareUrl}
              className="gap-1.5 text-stone-500 hover:text-stone-800 h-8"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden /> {t('share.regenerate')}
            </Button>
            {/* FE-4 (issue #80): stone-600 on white — the share note was
                stone-400 (2.31:1). */}
            <p className="text-[11px] text-stone-600 flex items-start gap-1.5">
              <Share2 className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />
              {t('share.note')}
            </p>
          </div>

          <Separator className="bg-stone-200" />

          <div className="flex items-center justify-between gap-4 rounded-xl border border-stone-200 bg-stone-50 p-3.5">
            <div className="min-w-0">
              <Label htmlFor="preview-switch" className="text-sm font-medium text-stone-800">{t('share.previewLabel')}</Label>
              <p className="text-xs text-stone-500 mt-0.5">{t('share.previewHint')}</p>
            </div>
            <Switch
              id="preview-switch"
              checked={previewing}
              onCheckedChange={onPreviewingChange}
              aria-label={t('share.previewLabel')}
              className="data-[state=checked]:bg-amber-500"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
