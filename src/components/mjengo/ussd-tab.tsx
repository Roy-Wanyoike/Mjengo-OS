'use client'

// USSD Muster Line — SIMULATION (M-8).
//
// A phone-frame simulation of the *384# feature-phone attendance flow
// MjengoOS would run on any Kenyan network. The demo is honest about being a
// simulation, but it dispatches REAL attendance records through the store's
// dispatch() — the same actions the Fundis tab uses:
//   · Present → 'attendance.checkin' { workerId, toggle: 'in', method: 'ussd' }
//     (the worker keyed their own PIN — worker evidence, verification
//     'verified', evidence ['ussd','device'], method 'ussd' → USSD badge)
//   · Absent  → 'attendance.record' { records, verification: 'reported',
//     recordedBy: 'USSD *384#' } (an absence is a statement, not evidence)
//
// PIN mapping (demo): the worker's kiosk PIN (Worker.pin) when set, otherwise
// the last 4 digits of their phone. Both are accepted for workers with a PIN.
//
// Offline story: when the store's online toggle is OFF the dispatch queues
// in the on-device outbox — the screen says so, visibly.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import type { WorkerWithAttendance } from '@/lib/mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Phone, PhoneCall, PhoneOff, Delete, Smartphone, WifiOff, Info } from 'lucide-react'
import { toast } from 'sonner'

// ---------------- LCD session types ----------------

type Screen = 'dial' | 'dialing' | 'menu' | 'pin' | 'worker' | 'confirm' | 'saving' | 'done' | 'ended'

type LcdTone = 'normal' | 'dim' | 'ok' | 'warn' | 'err'

interface LcdLine {
  text: string
  tone?: LcdTone
}

const TONE_CLASS: Record<LcdTone, string> = {
  normal: 'text-emerald-100/90',
  dim: 'text-emerald-200/40',
  ok: 'text-emerald-300 font-bold',
  warn: 'text-amber-300',
  err: 'text-red-400',
}

const MAX_PIN_TRIES = 3

/** Last 4 digits of a phone — the demo PIN for workers without a kiosk PIN. */
function phonePin(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '')
  return digits.slice(-4)
}

const KEYS: Array<{ main: string; sub?: string }> = [
  { main: '1' },
  { main: '2', sub: 'ABC' },
  { main: '3', sub: 'DEF' },
  { main: '4', sub: 'GHI' },
  { main: '5', sub: 'JKL' },
  { main: '6', sub: 'MNO' },
  { main: '7', sub: 'PQRS' },
  { main: '8', sub: 'TUV' },
  { main: '9', sub: 'WXYZ' },
  { main: '*', sub: '+' },
  { main: '0', sub: '␣' },
  { main: '#', sub: '⌗' },
]

const BOOT_LINES: LcdLine[] = [
  { text: 'MjengoOS sim ready.' },
  { text: 'Dial *384# then Call.', tone: 'dim' },
]

// ---------------- component ----------------

export function UssdTab() {
  const { data, dispatch, online, outbox, viewMode } = useMjengo()

  const [screen, setScreen] = useState<Screen>('dial')
  const [dialBuf, setDialBuf] = useState('*384#')
  const [pinBuf, setPinBuf] = useState('')
  const [pinTries, setPinTries] = useState(0)
  const [worker, setWorker] = useState<WorkerWithAttendance | null>(null)
  const [choice, setChoice] = useState<'present' | 'absent' | null>(null)
  const [log, setLog] = useState<LcdLine[]>(BOOT_LINES)

  const lcdRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)

  const isClient = viewMode === 'client'
  const busy = screen === 'dialing' || screen === 'saving'

  const activeWorkers = useMemo(
    () => (data?.workers ?? []).filter((w) => w.active !== false),
    [data],
  )

  // Auto-scroll the LCD to the newest line.
  useEffect(() => {
    const el = lcdRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  // Clear any pending transition timer on unmount.
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  function pushLog(lines: LcdLine[]) {
    setLog((prev) => [...prev, ...lines])
  }

  function resetSession() {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    setScreen('dial')
    setDialBuf('*384#')
    setPinBuf('')
    setPinTries(0)
    setWorker(null)
    setChoice(null)
    setLog(BOOT_LINES)
  }

  /** Begin the *384# dial sequence from the dial screen. */
  function beginDial() {
    setScreen('dialing')
    pushLog([{ text: 'Dialing *384# …', tone: 'dim' }])
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      pushLog([
        { text: 'Welcome to MjengoOS' },
        { text: 'Muster.' },
        { text: '1. Mark attendance' },
        { text: '2. Exit' },
      ])
      setScreen('menu')
    }, 900)
  }

  // ---------------- state machine ----------------

  function startDial() {
    if (screen === 'done' || screen === 'ended') {
      // "Dial again": fresh session that dials straight away.
      resetSession()
      beginDial()
      return
    }
    if (screen === 'dial') {
      if (dialBuf.trim() !== '*384#') {
        pushLog([{ text: 'Invalid code. Dial *384#.', tone: 'warn' }])
        return
      }
      beginDial()
      return
    }
    if (screen === 'pin') {
      if (pinBuf.length === 4) validatePin(pinBuf)
      return
    }
    if (screen === 'confirm') {
      void doRecord()
    }
  }

  function hangUp() {
    if (screen === 'dial' || screen === 'done' || screen === 'ended') {
      resetSession()
      return
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    pushLog([{ text: 'Call ended.', tone: 'dim' }])
    setScreen('ended')
  }

  function backspace() {
    if (screen === 'dial') setDialBuf((b) => b.slice(0, -1))
    if (screen === 'pin') setPinBuf((b) => b.slice(0, -1))
  }

  function validatePin(pin: string) {
    // Kiosk PIN match first, then phone last-4.
    const found =
      activeWorkers.find((w) => (w.pin ?? '') === pin && pin !== '') ??
      activeWorkers.find((w) => phonePin(w.phone) === pin && pin !== '')

    if (found) {
      setWorker(found)
      setScreen('worker')
      const lines: LcdLine[] = [
        { text: `Name: ${found.name}` },
        { text: `Role: ${found.role}` },
      ]
      if (found.todayStatus.status) {
        lines.push({ text: `Already today: ${found.todayStatus.status}`, tone: 'dim' })
      }
      lines.push({ text: '1. Present' }, { text: '2. Absent' })
      pushLog(lines)
      return
    }

    const tries = pinTries + 1
    setPinTries(tries)
    setPinBuf('')
    if (tries >= MAX_PIN_TRIES) {
      pushLog([
        { text: 'Too many attempts.', tone: 'err' },
        { text: 'Session ended. Kwaheri.' },
      ])
      setScreen('ended')
      return
    }
    pushLog([
      { text: 'PIN not recognised — try', tone: 'warn' },
      { text: `again. (${MAX_PIN_TRIES - tries} tries left)`, tone: 'warn' },
    ])
  }

  async function doRecord() {
    if (!worker || !choice) return
    if (isClient) {
      pushLog([
        { text: 'Read-only client view —', tone: 'err' },
        { text: 'records only from the site' },
        { text: 'team line.' },
      ])
      setScreen('ended')
      return
    }
    setScreen('saving')
    pushLog([{ text: 'Recording…', tone: 'dim' }])

    let ok = false
    if (choice === 'present') {
      // Worker-initiated USSD check-in — carries 'ussd' evidence.
      ok = await dispatch(
        'attendance.checkin',
        { workerId: worker.id, toggle: 'in', method: 'ussd' },
        `USSD check-in ${worker.name}`,
      )
    } else {
      // Absence is a reported statement from the line, not worker evidence.
      ok = await dispatch(
        'attendance.record',
        {
          records: JSON.stringify([{ workerId: worker.id, status: 'absent' }]),
          verification: 'reported',
          recordedBy: 'USSD *384#',
        },
        `USSD absent ${worker.name}`,
      )
    }

    setScreen(ok ? 'done' : 'ended')
    if (ok) {
      if (online) {
        pushLog([
          { text: 'Attendance recorded.', tone: 'ok' },
          { text: 'Asante!' },
        ])
        toast.success(`*384# — ${worker.name} ${choice === 'present' ? 'checked in' : 'marked absent'}`)
      } else {
        pushLog([
          { text: 'Saved to device — will', tone: 'warn' },
          { text: 'sync when network returns.', tone: 'warn' },
          { text: 'Attendance recorded.' },
        ])
        toast.info('Saved to device — will sync when network returns')
      }
      pushLog([{ text: 'Session ended.', tone: 'dim' }])
    } else {
      pushLog([
        { text: 'Could not record —', tone: 'err' },
        { text: 'check network and dial again.', tone: 'err' },
      ])
    }
  }

  function pressKey(key: string) {
    if (busy) return
    switch (screen) {
      case 'dial': {
        if (/^[0-9*#]$/.test(key)) setDialBuf((b) => (b.length < 16 ? b + key : b))
        break
      }
      case 'menu': {
        if (key === '1') {
          setScreen('pin')
          pushLog([{ text: 'Enter your PIN:' }])
        } else if (key === '2') {
          pushLog([{ text: 'Asante. Kwaheri.' }])
          setScreen('ended')
        }
        break
      }
      case 'pin': {
        if (!/^[0-9]$/.test(key)) return
        const next = (pinBuf + key).slice(0, 4)
        setPinBuf(next)
        if (next.length === 4) {
          // Feature-phone feel: short pause, then the network replies.
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null
            validatePin(next)
          }, 600)
        }
        break
      }
      case 'worker': {
        if (key === '1') {
          setChoice('present')
          setScreen('confirm')
          pushLog([
            { text: `Record as PRESENT?` },
            { text: '1. Yes, save' },
            { text: '2. No, cancel' },
          ])
        } else if (key === '2') {
          setChoice('absent')
          setScreen('confirm')
          pushLog([
            { text: `Record as ABSENT?` },
            { text: '1. Yes, save' },
            { text: '2. No, cancel' },
          ])
        }
        break
      }
      case 'confirm': {
        if (key === '1') void doRecord()
        else if (key === '2') {
          pushLog([{ text: 'Cancelled. Back to menu.', tone: 'dim' }])
          setChoice(null)
          setScreen('menu')
          pushLog([
            { text: '1. Mark attendance' },
            { text: '2. Exit' },
          ])
        }
        break
      }
      default:
        break
    }
  }

  // ---------------- input line (below the LCD) ----------------

  const inputLine = (() => {
    switch (screen) {
      case 'dial':
        return dialBuf || '—'
      case 'dialing':
        return 'calling…'
      case 'pin':
        return `PIN: ${'•'.repeat(pinBuf.length)}${'_'.repeat(4 - pinBuf.length)}`
      case 'menu':
        return 'Reply 1 or 2'
      case 'worker':
        return 'Reply 1 or 2'
      case 'confirm':
        return 'Reply 1 or 2'
      case 'saving':
        return 'sending…'
      case 'done':
        return 'Session ended'
      case 'ended':
        return 'Press Call to dial again'
      default:
        return ''
    }
  })()

  // ---------------- render ----------------

  if (!data) return null

  const pinRows = activeWorkers.slice(0, 8).map((w) => ({
    name: w.name,
    pin: w.pin && /^\d{4}$/.test(w.pin) ? w.pin : phonePin(w.phone),
    source: w.pin && /^\d{4}$/.test(w.pin) ? 'kiosk PIN' : 'phone',
  }))

  const callDisabled = busy

  return (
    <div className="space-y-6">
      <section aria-label="USSD Muster Line simulation">
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Phone className="w-4 h-4 text-stone-500" aria-hidden />
                USSD Muster Line — SIMULATION
              </CardTitle>
              <Badge className="bg-amber-100 text-amber-900 border-0 text-[10px] hover:bg-amber-100">
                Demo — real records
              </Badge>
              {isClient && (
                <Badge variant="outline" className="text-[10px] font-medium text-stone-500 border-stone-200">
                  Read-only client view
                </Badge>
              )}
            </div>
            <CardDescription>
              Demonstrates the *384# attendance flow MjengoOS would run on any phone — this demo
              dispatches real attendance records.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid gap-8 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] items-start justify-items-center lg:justify-items-start">
              {/* ---------- phone frame ---------- */}
              <div className="w-[300px] max-w-full">
                <div className="bg-stone-900 border border-stone-800 rounded-[2.2rem] p-3 shadow-xl">
                  {/* earpiece */}
                  <div className="mx-auto mb-3 w-16 h-1.5 rounded-full bg-stone-800" aria-hidden />

                  {/* screen */}
                  <div className="rounded-xl bg-stone-950 border border-stone-800 p-2 shadow-inner">
                    <div className="flex items-center justify-between px-1 pb-1 font-mono text-[9px] text-stone-600" aria-hidden>
                      <span>MjengoOS · KE</span>
                      <span className={online ? 'text-stone-500' : 'text-amber-500'}>
                        {online ? '▮▮▮▮ E' : '× OFFLINE'}
                      </span>
                    </div>
                    <p className="sr-only">
                      {online
                        ? 'Simulated network: online.'
                        : 'Simulated network: offline — dispatches queue on-device.'}
                    </p>

                    {/* LCD log */}
                    <div
                      ref={lcdRef}
                      role="log"
                      aria-live="polite"
                      aria-label="USSD session screen"
                      className="h-60 overflow-y-auto px-1.5 py-2 font-mono text-[11px] leading-relaxed break-words max-h-60 [scrollbar-width:thin]"
                    >
                      {log.map((line, i) => (
                        <p key={i} className={TONE_CLASS[line.tone ?? 'normal']}>
                          {line.text}
                        </p>
                      ))}
                    </div>

                    {/* input line */}
                    <div className="mt-1 border-t border-stone-800 px-1.5 py-1.5 min-h-7 font-mono text-[11px] text-amber-200 truncate" aria-label="Current input">
                      {inputLine}
                    </div>
                  </div>

                  {/* keypad */}
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {KEYS.map((k) => (
                      <button
                        key={k.main}
                        type="button"
                        onClick={() => pressKey(k.main)}
                        disabled={busy}
                        aria-label={k.sub ? `Key ${k.main}, ${k.sub}` : `Key ${k.main}`}
                        className="h-11 rounded-lg bg-stone-800 hover:bg-stone-700 active:bg-stone-600 disabled:opacity-50 disabled:hover:bg-stone-800 text-stone-100 font-mono text-sm leading-none flex flex-col items-center justify-center gap-0.5 focus-visible:outline-2 focus-visible:outline-amber-400 focus-visible:-outline-offset-2"
                      >
                        <span aria-hidden>{k.main}</span>
                        {k.sub && <span className="text-[8px] text-stone-500 leading-none" aria-hidden>{k.sub}</span>}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={backspace}
                      disabled={busy || (screen !== 'dial' && screen !== 'pin')}
                      aria-label="Delete last digit"
                      className="h-11 rounded-lg bg-stone-800 hover:bg-stone-700 active:bg-stone-600 disabled:opacity-40 text-stone-400 flex items-center justify-center focus-visible:outline-2 focus-visible:outline-amber-400 focus-visible:-outline-offset-2"
                    >
                      <Delete className="w-4 h-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={startDial}
                      disabled={callDisabled}
                      aria-label={screen === 'done' || screen === 'ended' ? 'Call — start a new session' : 'Call, send or confirm'}
                      className="h-11 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50 text-white font-semibold text-xs flex items-center justify-center gap-1.5 focus-visible:outline-2 focus-visible:outline-emerald-300 focus-visible:-outline-offset-2"
                    >
                      <PhoneCall className="w-4 h-4" aria-hidden />
                      Call
                    </button>
                    <button
                      type="button"
                      onClick={hangUp}
                      aria-label="End call"
                      className="h-11 rounded-lg bg-red-600 hover:bg-red-500 active:bg-red-700 text-white flex items-center justify-center focus-visible:outline-2 focus-visible:outline-red-300 focus-visible:-outline-offset-2"
                    >
                      <PhoneOff className="w-4 h-4" aria-hidden />
                    </button>
                  </div>
                </div>

                {/* live network note under the phone */}
                <p className={`mt-3 text-xs text-center flex items-center justify-center gap-1.5 ${online ? 'text-stone-500' : 'text-amber-700'}`}>
                  {online ? (
                    <>
                      <Smartphone className="w-3.5 h-3.5" aria-hidden />
                      Sim network online — records save straight to the project.
                    </>
                  ) : (
                    <>
                      <WifiOff className="w-3.5 h-3.5" aria-hidden />
                      Sim network offline (store toggle) — records queue on-device
                      {outbox.length > 0 && ` (${outbox.length} pending)`}.
                    </>
                  )}
                </p>
              </div>

              {/* ---------- explainer + demo PIN reference ---------- */}
              <div className="w-full space-y-4">
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <h3 className="text-sm font-semibold text-stone-900 mb-2">How the real line works</h3>
                  <ul className="list-disc pl-4 space-y-1.5 text-xs text-stone-600 leading-relaxed">
                    <li>
                      Any phone dials <code className="font-mono text-[11px] bg-stone-100 px-1 rounded">*384#</code> —
                      no smartphone, no data bundle, no app install.
                    </li>
                    <li>The worker keys their 4-digit PIN; the line resolves it to their crew record.</li>
                    <li>
                      Attendance lands in the same muster as the app — a <em>Present</em> reply is worker
                      evidence (USSD), not a manager&apos;s word.
                    </li>
                    <li>
                      Offline-first: with no network the record queues on-device and syncs when the
                      signal returns.
                    </li>
                  </ul>
                </div>

                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <h3 className="text-sm font-semibold text-amber-900 mb-2 flex items-center gap-1.5">
                    <Info className="w-4 h-4" aria-hidden />
                    Demo PINs — {data.project.name}
                  </h3>
                  {pinRows.length === 0 ? (
                    <p className="text-xs text-amber-800">
                      No crew on this project yet — add fundis in the Fundis tab first.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {pinRows.map((r) => (
                          <Badge
                            key={`${r.pin}-${r.name}`}
                            variant="outline"
                            className={`text-[10px] font-mono ${
                              r.source === 'kiosk PIN'
                                ? 'bg-white text-amber-900 border-amber-300'
                                : 'bg-amber-100/60 text-amber-800 border-amber-200'
                            }`}
                            title={r.source === 'kiosk PIN' ? 'Kiosk PIN' : 'Last 4 digits of phone'}
                          >
                            {r.pin} · {r.name}
                          </Badge>
                        ))}
                        {activeWorkers.length > 8 && (
                          <Badge variant="outline" className="text-[10px] bg-amber-100/60 text-amber-800 border-amber-200">
                            +{activeWorkers.length - 8} more
                          </Badge>
                        )}
                      </div>
                      <p className="mt-2 text-xs text-amber-800">
                        PIN = the worker&apos;s kiosk PIN when set, otherwise the last 4 digits of their
                        phone (both work for workers with a PIN). Wrong PIN retries 3 times, then the
                        line ends the session politely.
                      </p>
                    </>
                  )}
                </div>

                <p className="text-xs text-stone-400 leading-relaxed">
                  This is a faithful simulation of the session flow, not a live carrier line: MjengoOS
                  would provision *384# with a Kenyan network operator. Attendance recorded here is
                  real project data — check today&apos;s muster in the Fundis tab.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
