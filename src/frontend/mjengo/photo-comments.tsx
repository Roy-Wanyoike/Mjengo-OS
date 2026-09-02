'use client'

import { useState } from 'react'
import { format, formatDistanceToNow } from 'date-fns'
import type { PhotoComment } from '@prisma/client'
import { Button } from '@/frontend/ui/button'
import { Textarea } from '@/frontend/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { CheckCheck, Loader2, MessageSquare, Send } from 'lucide-react'

const SCROLLBAR = '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full'

export type CommentRole = 'client' | 'contractor' | 'foreman'

export interface CommentablePhoto {
  id: string
  url: string
  caption?: string | null
}

export interface CommentThreadProps {
  photo: CommentablePhoto
  comments: PhotoComment[]
  /** Show the resolve action on unresolved comments (site team side). */
  canResolve?: boolean
  /** Display name used when the add-form is submitted (passed back via onAdd). */
  defaultAuthor: string
  defaultRole: CommentRole
  /** Wire to dispatch('comment.add', { photoId, author, role, message }). */
  onAdd?: (message: string) => void | Promise<void>
  /** Wire to dispatch('comment.resolve', { id }). */
  onResolve?: (id: string) => void | Promise<void>
}

function RoleChip({ role }: { role: string }) {
  if (role === 'client') {
    return <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">client</span>
  }
  if (role === 'foreman') {
    return <span className="inline-flex items-center rounded-full bg-stone-600 px-1.5 py-0.5 text-[10px] font-medium text-stone-50">foreman</span>
  }
  return <span className="inline-flex items-center rounded-full bg-stone-800 px-1.5 py-0.5 text-[10px] font-medium text-stone-50">contractor</span>
}

/**
 * Contextual comment thread for one site photo — client questions and site-team
 * answers, pinned to the evidence. Parent wires onAdd/onResolve to the store.
 */
export function CommentThread({
  photo,
  comments,
  canResolve = false,
  defaultAuthor,
  defaultRole,
  onAdd,
  onResolve,
}: CommentThreadProps) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  const sorted = [...comments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )
  const unresolved = sorted.filter((c) => !c.resolved).length

  async function submit() {
    const text = message.trim()
    if (!text || !onAdd) return
    setSending(true)
    try {
      await onAdd(text)
      setMessage('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Photo header */}
      <div className="flex items-center gap-3">
        <div className="h-14 w-20 shrink-0 overflow-hidden rounded-lg border border-stone-200 bg-stone-100">
          <img src={photo.url} alt={photo.caption ?? 'Site photo'} className="h-full w-full object-cover" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-stone-900">{photo.caption ?? 'Site photo'}</p>
          <p className="text-xs text-stone-500">
            {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
            {unresolved > 0 ? ` · ${unresolved} open` : ''}
          </p>
        </div>
      </div>

      {/* Thread */}
      {sorted.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-stone-200 bg-stone-50 py-8 text-center" role="status">
          <MessageSquare className="w-6 h-6 text-stone-300" aria-hidden />
          <p className="text-sm text-stone-500">No comments yet — ask a question about this photo.</p>
        </div>
      ) : (
        <ul className={`max-h-72 space-y-2 overflow-y-auto pr-2 ${SCROLLBAR}`} aria-label="Photo comments">
          {sorted.map((c) => (
            <li
              key={c.id}
              className={`rounded-lg border p-3 ${c.resolved ? 'border-stone-100 bg-stone-50/60 opacity-75' : 'border-stone-200 bg-white'}`}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-stone-900">{c.author}</span>
                <RoleChip role={c.role} />
                <span className="text-[11px] text-stone-400" title={format(new Date(c.createdAt), 'd MMM yyyy, HH:mm')}>
                  {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
                </span>
                {c.resolved && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-stone-500">
                    <CheckCheck className="w-3.5 h-3.5 text-amber-600" aria-hidden /> Resolved
                  </span>
                )}
              </div>
              <p className={`mt-1 text-sm break-words ${c.resolved ? 'text-stone-500' : 'text-stone-700'}`}>{c.message}</p>
              {!c.resolved && canResolve && onResolve && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1.5 h-9 gap-1.5 text-stone-600 hover:text-stone-900"
                  disabled={resolvingId === c.id}
                  aria-label={`Mark comment by ${c.author} as resolved`}
                  onClick={async () => {
                    setResolvingId(c.id)
                    try {
                      await onResolve(c.id)
                    } finally {
                      setResolvingId(null)
                    }
                  }}
                >
                  {resolvingId === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <CheckCheck className="w-3.5 h-3.5" aria-hidden />}
                  Resolve
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Add form */}
      {onAdd && (
        <div className="space-y-2">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`Comment as ${defaultAuthor} (${defaultRole})…`}
            className="min-h-[72px] bg-white"
            aria-label={`Add a comment as ${defaultAuthor}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-stone-400">⌘/Ctrl + Enter to send</p>
            <Button
              size="sm"
              className="h-11 min-w-24 gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
              disabled={sending || !message.trim()}
              onClick={() => void submit()}
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Send className="w-4 h-4" aria-hidden />} Send
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export interface PhotoCommentsDialogProps extends Omit<CommentThreadProps, 'photo'> {
  open: boolean
  onOpenChange: (open: boolean) => void
  photo: CommentablePhoto
}

/** Dialog wrapper around CommentThread — drop-in for photo galleries. */
export function PhotoCommentsDialog({ open, onOpenChange, photo, ...threadProps }: PhotoCommentsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-stone-900">
            <MessageSquare className="w-5 h-5 text-amber-600" aria-hidden /> Photo comments
          </DialogTitle>
          <DialogDescription>Questions and answers pinned to this site photo.</DialogDescription>
        </DialogHeader>
        <CommentThread photo={photo} {...threadProps} />
      </DialogContent>
    </Dialog>
  )
}
