'use client'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Copy, Eye, RefreshCw, Share2 } from 'lucide-react'
import { toast } from 'sonner'

export interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  shareUrl: string | null
  previewing: boolean
  onPreviewingChange: (v: boolean) => void
  onRegenerate: () => void | Promise<void>
}

export function ShareDialog({ open, onOpenChange, shareUrl, previewing, onPreviewingChange, onRegenerate }: ShareDialogProps) {
  async function copyLink() {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      toast.success('Link copied')
    } catch {
      toast.error('Could not copy — long-press or select the link to copy manually')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-stone-900 flex items-center gap-2">
            <Eye className="w-5 h-5 text-amber-600" aria-hidden />
            Share with client
          </DialogTitle>
          <DialogDescription>
            Your client gets a read-only live view: photo evidence, progress, budget position — no editing.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="space-y-2">
            <Label htmlFor="share-url">Client link</Label>
            <div className="flex items-center gap-2">
              <Input
                id="share-url"
                readOnly
                value={shareUrl ?? 'Generating link…'}
                placeholder="Generating link…"
                className="font-mono text-xs text-stone-600 bg-stone-50"
                aria-label="Read-only client share link"
              />
              <Button
                size="icon"
                onClick={() => void copyLink()}
                disabled={!shareUrl}
                aria-label="Copy share link"
                className="shrink-0 h-9 w-9 bg-amber-600 hover:bg-amber-700 text-white"
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
              <RefreshCw className="w-3.5 h-3.5" aria-hidden /> Regenerate link
            </Button>
            <p className="text-[11px] text-stone-400 flex items-start gap-1.5">
              <Share2 className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />
              Send this over WhatsApp or email. Regenerating invalidates the old link.
            </p>
          </div>

          <Separator className="bg-stone-200" />

          <div className="flex items-center justify-between gap-4 rounded-xl border border-stone-200 bg-stone-50 p-3.5">
            <div className="min-w-0">
              <Label htmlFor="preview-switch" className="text-sm font-medium text-stone-800">Preview as client (read-only)</Label>
              <p className="text-xs text-stone-500 mt-0.5">See exactly what your client sees.</p>
            </div>
            <Switch
              id="preview-switch"
              checked={previewing}
              onCheckedChange={onPreviewingChange}
              aria-label="Preview as client (read-only)"
              className="data-[state=checked]:bg-amber-500"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
