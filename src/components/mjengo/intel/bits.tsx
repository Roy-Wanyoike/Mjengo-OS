'use client'

// Intel tab shared building blocks: severity chips, price delta chips, the
// inline SVG sparkline and the risk score ring. Kept dependency-free on
// purpose — no chart library, just tiny deterministic SVG.

import type { FindingSeverity } from '@/modules/intel/types'

/** Severity chip — info=stone, warning=amber, critical=red (house palette). */
export function SeverityChip({ severity }: { severity: FindingSeverity }) {
  const cls =
    severity === 'critical'
      ? 'bg-red-100 text-red-700 border-red-200'
      : severity === 'warning'
        ? 'bg-amber-100 text-amber-800 border-amber-200'
        : 'bg-stone-100 text-stone-600 border-stone-200'
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      {severity}
    </span>
  )
}

/** 30-day price delta chip — up=amber, down=green, flat/unknown=stone. */
export function DeltaChip({ deltaPct }: { deltaPct: number | null }) {
  if (deltaPct === null) {
    return <span className="inline-flex items-center rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-stone-500">new</span>
  }
  const up = deltaPct > 0
  const flat = deltaPct === 0
  const cls = flat
    ? 'bg-stone-100 text-stone-600'
    : up
      ? 'bg-amber-100 text-amber-800'
      : 'bg-emerald-100 text-emerald-700'
  const arrow = flat ? '→' : up ? '▲' : '▼'
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${cls}`}>
      <span aria-hidden>{arrow}</span>
      {up ? '+' : ''}{deltaPct.toFixed(1)}%
    </span>
  )
}

/**
 * Tiny polyline sparkline over the price points (no chart lib).
 * Up-trending series stroke amber, down-trending green — matching DeltaChip.
 */
export function Sparkline({ points, width = 76, height = 22 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) {
    return <span className="text-[10px] text-stone-400" aria-label="Not enough points yet">—</span>
  }
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const stepX = width / (points.length - 1)
  const coords = points
    .map((p, i) => `${(i * stepX).toFixed(1)},${(height - 2 - ((p - min) / span) * (height - 4)).toFixed(1)}`)
    .join(' ')
  const up = points[points.length - 1] >= points[0]
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={up ? 'Price trending up over the recorded points' : 'Price trending down over the recorded points'}
      className="shrink-0"
    >
      <polyline
        points={coords}
        fill="none"
        stroke={up ? '#d97706' : '#059669'}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Big risk score ring (deterministic 0–100, higher = calmer). */
export function ScoreRing({ score }: { score: number }) {
  const r = 46
  const circumference = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score))
  const color = score >= 75 ? '#059669' : score >= 50 ? '#d97706' : '#dc2626'
  const label = score >= 75 ? 'Steady' : score >= 50 ? 'Watch' : 'Attention'
  return (
    <div className="relative w-28 h-28 shrink-0" role="img" aria-label={`Risk score ${score} of 100 — ${label}`}>
      <svg viewBox="0 0 110 110" className="w-full h-full -rotate-90">
        <circle cx="55" cy="55" r={r} fill="none" stroke="#e7e5e4" strokeWidth="10" />
        <circle
          cx="55"
          cy="55"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold tabular-nums text-stone-900" aria-hidden>{score}</span>
        <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color }} aria-hidden>{label}</span>
      </div>
    </div>
  )
}
