'use client'

// WhatsApp Field Line — SIMULATION (W4-3).
//
// A chat-frame simulation of the WhatsApp bi-directional bot MjengoOS would
// run through a WhatsApp Business relay (Meta Cloud API). The demo is honest
// about being a simulation, but it exercises the REAL webhook seam: the
// simulator POSTs { from, text, timestamp } straight to the public
// POST /api/whatsapp route (GET /api/whatsapp documents the contract) — the
// server resolves the worker by phone and dispatches through the same
// domain appliers the app, the *384# line and the offline sync all share:
//   PRESENT / ABSENT / HALF → attendance (checkin worker evidence, or a
//                             reported statement for absences)
//   BALANCE                → unpaid wage balance reply
//   HELP                   → usage text
//   anything else          → a note on the project's latest site photo
//
// Unlike the USSD simulation (which dispatches through the store and can
// queue on-device), this panel talks to the SERVER's webhook directly: the
// browser's offline toggle does not queue a WhatsApp message — a real relay
// would retry on its side. Replies come back as the plain text the relay
// would send to the handset, always footered "— MjengoOS sim".

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Input } from '@/frontend/ui/input'
import { MessageCircle, Send, Smartphone, Info, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'

// ---------------- chat model ----------------

interface ChatBubble {
  /** 'out' = sent from this simulator's phone; 'in' = the bot's reply. */
  dir: 'out' | 'in'
  text: string
}

const KEYWORDS = ['PRESENT', 'ABSENT', 'HALF', 'BALANCE', 'HELP'] as const

// ---------------- component ----------------

export function WhatsAppPanel() {
  const { data, viewMode, load } = useMjengo()
  const t = useT()

  const [phone, setPhone] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [chat, setChat] = useState<ChatBubble[]>([
    { dir: 'in', text: 'MjengoOS line ready. Reply HELP for keywords, or just send a note.' },
  ])

  const chatRef = useRef<HTMLDivElement>(null)

  const isClient = viewMode === 'client'

  const activeWorkers = useMemo(
    () => (data?.workers ?? []).filter((w) => w.active !== false),
    [data],
  )

  // Prefill with the first crew number once data arrives (like the USSD
  // dial buffer's '*384#' prefill).
  useEffect(() => {
    if (!phone && activeWorkers.length > 0) setPhone(activeWorkers[0].phone)
  }, [activeWorkers, phone])

  // Auto-scroll the chat to the newest message.
  useEffect(() => {
    const el = chatRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat])

  function pushBubbles(bubbles: ChatBubble[]) {
    setChat((prev) => [...prev, ...bubbles])
  }

  async function send() {
    const sender = phone.trim()
    const message = text.trim()
    if (!sender || !message || busy) return

    pushBubbles([{ dir: 'out', text: message }])
    setText('')
    setBusy(true)
    try {
      const res = await fetch('/api/whatsapp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: sender, text: message, timestamp: new Date().toISOString() }),
      })
      // The gateway replies plain text (the relay would send it back to the
      // handset); error statuses carry JSON { error } — show it honestly.
      const reply = res.ok
        ? await res.text()
        : `${t('wa.chat.error')} (${res.status}: ${await res
            .json()
            .then((b) => (b as { error?: string }).error ?? '')
            .catch(() => '')})`
      pushBubbles([{ dir: 'in', text: reply }])
      // A 200 text reply means the server may have written rows (attendance,
      // photo note) — pull the project payload so the app reflects them.
      if (res.ok) void load()
    } catch {
      toast.error(t('wa.chat.network'))
      pushBubbles([{ dir: 'in', text: t('wa.chat.network') }])
    } finally {
      setBusy(false)
    }
  }

  if (!data) return null

  const phoneRows = activeWorkers.slice(0, 8).map((w) => ({ name: w.name, phone: w.phone }))

  return (
    <section aria-label={t('wa.aria')}>
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageCircle className="w-4 h-4 text-stone-500" aria-hidden />
              {t('wa.title')}
            </CardTitle>
            <Badge className="bg-emerald-100 text-emerald-900 border-0 text-[10px] hover:bg-emerald-100">
              {t('wa.demo')}
            </Badge>
            {isClient && (
              <Badge variant="outline" className="text-[10px] font-medium text-stone-500 border-stone-200">
                {t('wa.readonly')}
              </Badge>
            )}
          </div>
          <CardDescription>{t('wa.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] items-start">
            {/* ---------- chat frame ---------- */}
            <div className="w-[340px] max-w-full">
              <div className="bg-[#0b141a] border border-stone-800 rounded-[1.6rem] p-2 shadow-xl">
                {/* WhatsApp-style header */}
                <div className="flex items-center gap-2 rounded-t-xl bg-[#202c33] px-3 py-2">
                  <div className="w-8 h-8 rounded-full bg-emerald-700 flex items-center justify-center text-white text-xs font-bold" aria-hidden>
                    M
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-white text-xs font-semibold truncate">MjengoOS</p>
                    <p className="text-emerald-200/60 text-[10px] truncate">{t('wa.chat.status')}</p>
                  </div>
                  <Smartphone className="w-3.5 h-3.5 text-stone-400" aria-hidden />
                </div>

                {/* chat log */}
                <div
                  ref={chatRef}
                  role="log"
                  aria-live="polite"
                  aria-label={t('wa.chat.aria')}
                  className="h-64 overflow-y-auto px-2 py-3 space-y-2 bg-[#0b141a] [scrollbar-width:thin]"
                  style={{ backgroundImage: 'radial-gradient(#1b2b33 1px, transparent 1px)', backgroundSize: '18px 18px' }}
                >
                  {chat.map((b, i) => (
                    <div key={i} className={`flex ${b.dir === 'out' ? 'justify-end' : 'justify-start'}`}>
                      <p
                        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-3 py-1.5 text-[12px] leading-relaxed shadow ${
                          b.dir === 'out'
                            ? 'bg-[#005c4b] text-white rounded-br-sm'
                            : 'bg-[#202c33] text-stone-100 rounded-bl-sm'
                        }`}
                      >
                        {b.text}
                      </p>
                    </div>
                  ))}
                  {busy && (
                    <div className="flex justify-start" aria-label={t('wa.chat.sending')}>
                      <p className="rounded-xl rounded-bl-sm bg-[#202c33] text-stone-400 text-[12px] px-3 py-1.5">
                        ···
                      </p>
                    </div>
                  )}
                </div>

                {/* composer: phone + text + send */}
                <div className="mt-1 space-y-1.5 rounded-b-xl bg-[#202c33] p-2">
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder={t('wa.chat.phone')}
                    aria-label={t('wa.chat.phone')}
                    disabled={busy || isClient}
                    inputMode="tel"
                    className="h-8 border-[#2a3942] bg-[#0b141a] text-stone-100 placeholder:text-stone-500 text-xs"
                  />
                  <form
                    className="flex gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void send()
                    }}
                  >
                    <Input
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={t('wa.chat.placeholder')}
                      aria-label={t('wa.chat.placeholder')}
                      disabled={busy || isClient}
                      maxLength={1000}
                      className="h-8 border-[#2a3942] bg-[#0b141a] text-stone-100 placeholder:text-stone-500 text-xs"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={busy || isClient || !phone.trim() || !text.trim()}
                      aria-label={t('wa.chat.send')}
                      className="h-8 px-3 bg-emerald-600 hover:bg-emerald-500"
                    >
                      <Send className="w-3.5 h-3.5" aria-hidden />
                    </Button>
                  </form>
                  {isClient && (
                    <p className="text-[10px] text-amber-400/80 flex items-center gap-1">
                      <WifiOff className="w-3 h-3" aria-hidden />
                      {t('wa.readonly.note')}
                    </p>
                  )}
                </div>
              </div>

              {/* keyword quick-reply chips */}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {KEYWORDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={busy || isClient}
                    onClick={() => setText(k)}
                    className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-0.5 text-[10px] font-mono text-stone-600 hover:bg-stone-100 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-emerald-400 focus-visible:-outline-offset-2"
                  >
                    {k}
                  </button>
                ))}
              </div>

              <p className="mt-3 text-xs text-center text-stone-500 flex items-center justify-center gap-1.5">
                <Smartphone className="w-3.5 h-3.5" aria-hidden />
                {t('wa.chat.note')}
              </p>
            </div>

            {/* ---------- explainer + demo phone reference ---------- */}
            <div className="w-full space-y-4">
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                <h3 className="text-sm font-semibold text-stone-900 mb-2">{t('wa.explainer.title')}</h3>
                <ul className="list-disc pl-4 space-y-1.5 text-xs text-stone-600 leading-relaxed">
                  <li>{t('wa.explainer.point1')}</li>
                  <li>{t('wa.explainer.point2')}</li>
                  <li>{t('wa.explainer.point3')}</li>
                  <li>{t('wa.explainer.point4')}</li>
                  <li>
                    {t('wa.explainer.point5')}{' '}
                    <code className="font-mono text-[11px] bg-stone-100 px-1 rounded">GET /api/whatsapp</code>.
                  </li>
                </ul>
              </div>

              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                <h3 className="text-sm font-semibold text-emerald-900 mb-2 flex items-center gap-1.5">
                  <Info className="w-4 h-4" aria-hidden />
                  {t('wa.phones.title')} — {data.project.name}
                </h3>
                {phoneRows.length === 0 ? (
                  <p className="text-xs text-emerald-800">{t('wa.phones.empty')}</p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {phoneRows.map((r) => (
                        <button
                          key={`${r.phone}-${r.name}`}
                          type="button"
                          onClick={() => setPhone(r.phone)}
                          title={t('wa.phones.pick')}
                          className="rounded-full border border-emerald-300 bg-white px-2.5 py-0.5 text-[10px] font-mono text-emerald-900 hover:bg-emerald-100 focus-visible:outline-2 focus-visible:outline-emerald-400 focus-visible:-outline-offset-2"
                        >
                          {r.phone} · {r.name}
                        </button>
                      ))}
                      {activeWorkers.length > 8 && (
                        <Badge variant="outline" className="text-[10px] bg-emerald-100/60 text-emerald-800 border-emerald-200">
                          +{activeWorkers.length - 8} more
                        </Badge>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-emerald-800">{t('wa.phones.desc')}</p>
                  </>
                )}
              </div>

              <p className="text-xs text-stone-400 leading-relaxed">{t('wa.honesty')}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
