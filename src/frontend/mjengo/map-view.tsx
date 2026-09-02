'use client'

// Schematic Kenya map (spec §51) — an honest SVG projection, NOT survey-grade
// cartography. Kenya's bounding box (lat -4.7..5.0, lng 33.9..41.9) maps to
// the viewBox with a subtle grid and a handful of county labels for
// orientation. REAL markers are plotted from recorded coordinates:
//   · suppliers — colored by their verification ladder level (0-5)
//   · land parcels — colored by record status (searching / verified / flagged)
// Native SVG <title> tooltips carry name + county + verification/status.
// The caption states exactly what this is: schematic positions from recorded
// coordinates — not survey-grade.

import { useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Map } from 'lucide-react'

export interface MapSupplier {
  id: string
  businessName: string
  county: string
  town: string | null
  lat: number | null
  lng: number | null
  verificationState: number
}

export interface MapParcel {
  id: string
  plotNumber: string
  county: string
  town: string | null
  lat: number | null
  lng: number | null
  status: string
}

// Kenya bounding box → viewBox (lng span 8°, lat span 9.7° — near-square at
// the equator, so the aspect follows the degree spans directly).
const LAT_MIN = -4.7
const LAT_MAX = 5.0
const LNG_MIN = 33.9
const LNG_MAX = 41.9
const VB_W = 440
const VB_H = Math.round((VB_W * (LAT_MAX - LAT_MIN)) / (LNG_MAX - LNG_MIN)) // 539

function projectX(lng: number): number {
  return ((lng - LNG_MIN) / (LNG_MAX - LNG_MIN)) * VB_W
}
function projectY(lat: number): number {
  return ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * VB_H
}

/** A few well-known county towns for orientation (schematic, ~real centers). */
const COUNTY_ANCHORS: Array<{ name: string; lat: number; lng: number }> = [
  { name: 'Nairobi', lat: -1.29, lng: 36.82 },
  { name: 'Kiambu', lat: -1.15, lng: 36.83 },
  { name: 'Machakos', lat: -1.52, lng: 37.27 },
  { name: 'Kajiado', lat: -2.10, lng: 36.78 },
  { name: 'Nakuru', lat: -0.30, lng: 36.07 },
  { name: 'Mombasa', lat: -4.04, lng: 39.66 },
]

/** Supplier verification ladder colors (levels 0-5, labels match the Finder directory). */
const VERIFICATION_LABELS = ['Unverified', 'Registered', 'Identity verified', 'Business verified', 'Location verified', 'Transaction verified']
function verificationColor(level: number): string {
  if (level >= 4) return '#059669' // emerald-600 — location/transaction verified
  if (level === 3) return '#d97706' // amber-600 — business verified
  if (level >= 1) return '#a8a29e' // stone-400 — registered/identity
  return '#f87171' // red-400 — unverified
}

function parcelColor(status: string): string {
  if (status === 'verified') return '#059669'
  if (status === 'flagged') return '#dc2626'
  return '#f59e0b' // searching
}

const GRADES_CHIPS = [
  { label: 'Supplier · verification ≥4', color: '#059669' },
  { label: 'Supplier · level 3', color: '#d97706' },
  { label: 'Supplier · level 1-2', color: '#a8a29e' },
  { label: 'Parcel verified', color: '#059669' },
  { label: 'Parcel searching', color: '#f59e0b' },
  { label: 'Parcel flagged', color: '#dc2626' },
]

export function MapView({ suppliers, parcels }: { suppliers: MapSupplier[]; parcels: MapParcel[] }) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null)

  const plottedSuppliers = useMemo(
    () => suppliers.filter((s) => s.lat !== null && s.lng !== null),
    [suppliers],
  )
  const plottedParcels = useMemo(
    () => parcels.filter((p) => p.lat !== null && p.lng !== null),
    [parcels],
  )
  const noCoords =
    plottedSuppliers.length === 0 && plottedParcels.length === 0

  // subtle grid every 2 degrees
  const gridLines = useMemo(() => {
    const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
    for (let lng = Math.ceil(LNG_MIN / 2) * 2; lng <= LNG_MAX; lng += 2) {
      const x = projectX(lng)
      if (x > 4 && x < VB_W - 4) lines.push({ x1: x, y1: 6, x2: x, y2: VB_H - 6 })
    }
    for (let lat = Math.ceil(LAT_MIN / 2) * 2; lat <= LAT_MAX; lat += 2) {
      const y = projectY(lat)
      if (y > 4 && y < VB_H - 4) lines.push({ x1: 6, y1: y, x2: VB_W - 6, y2: y })
    }
    return lines
  }, [])

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
          <Map className="h-5 w-5 text-amber-600" aria-hidden /> Supplier &amp; parcel map
        </CardTitle>
        <CardDescription>
          {plottedSuppliers.length} suppliers and {plottedParcels.length} land parcels plotted from recorded
          coordinates — hover a marker for details.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <svg
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            className="w-full h-auto rounded-lg border border-stone-200 bg-stone-50"
            role="img"
            aria-label={`Schematic Kenya map with ${plottedSuppliers.length} supplier and ${plottedParcels.length} parcel markers`}
          >
            {/* bounding frame + equator hint */}
            <rect x={3} y={3} width={VB_W - 6} height={VB_H - 6} rx={10} fill="none" stroke="#d6d3d1" strokeWidth={1.5} />
            <line x1={6} x2={VB_W - 6} y1={projectY(0)} y2={projectY(0)} stroke="#fcd34d" strokeWidth={0.6} strokeDasharray="4 4" opacity={0.7} />

            {/* subtle grid */}
            {gridLines.map((l, i) => (
              <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#e7e5e4" strokeWidth={0.5} />
            ))}

            {/* county anchors */}
            {COUNTY_ANCHORS.map((c) => (
              <g key={c.name}>
                <circle cx={projectX(c.lng)} cy={projectY(c.lat)} r={2} fill="#78716c" opacity={0.6} />
                <text
                  x={projectX(c.lng) + 5}
                  y={projectY(c.lat) + 3}
                  fontSize={9}
                  fill="#78716c"
                  fontFamily="ui-sans-serif, system-ui"
                >
                  {c.name}
                </text>
              </g>
            ))}

            {/* parcels — square markers */}
            {plottedParcels.map((p) => {
              const x = projectX(p.lng as number)
              const y = projectY(p.lat as number)
              const label = `${p.plotNumber} — ${[p.county, p.town].filter(Boolean).join(', ')} · ${p.status}`
              return (
                <rect
                  key={p.id}
                  x={x - 4}
                  y={y - 4}
                  width={8}
                  height={8}
                  rx={1.5}
                  fill={parcelColor(p.status)}
                  fillOpacity={0.85}
                  stroke="#ffffff"
                  strokeWidth={1}
                  onMouseEnter={() => setHover({ x, y, text: label })}
                  onMouseLeave={() => setHover(null)}
                >
                  <title>{label}</title>
                </rect>
              )
            })}

            {/* suppliers — circle markers, verification ladder color */}
            {plottedSuppliers.map((s) => {
              const x = projectX(s.lng as number)
              const y = projectY(s.lat as number)
              const label = `${s.businessName} — ${[s.county, s.town].filter(Boolean).join(', ')} · ${VERIFICATION_LABELS[s.verificationState] ?? `Level ${s.verificationState}`}`
              return (
                <circle
                  key={s.id}
                  cx={x}
                  cy={y}
                  r={5}
                  fill={verificationColor(s.verificationState)}
                  fillOpacity={0.9}
                  stroke="#ffffff"
                  strokeWidth={1.2}
                  onMouseEnter={() => setHover({ x, y, text: label })}
                  onMouseLeave={() => setHover(null)}
                >
                  <title>{label}</title>
                </circle>
              )
            })}
          </svg>

          {/* hover caption (mirrors the native <title> tooltip, more visible) */}
          {hover && (
            <div
              className="pointer-events-none absolute left-2 right-2 bottom-2 rounded-md bg-stone-900/90 px-2.5 py-1.5 text-xs text-stone-50 truncate"
              role="status"
            >
              {hover.text}
            </div>
          )}

          {noCoords && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="rounded-lg bg-white/90 border border-stone-200 px-4 py-3 text-sm text-stone-500 max-w-64 text-center">
                No recorded coordinates yet — suppliers and parcels appear here once lat/lng is on record.
              </p>
            </div>
          )}
        </div>

        {/* legend */}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Map legend">
          {GRADES_CHIPS.map((l) => (
            <span key={l.label} className="flex items-center gap-1.5 text-[11px] text-stone-500">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: l.color }} aria-hidden />
              {l.label}
            </span>
          ))}
        </div>

        <p className="mt-2 text-[11px] text-stone-400 italic">
          Schematic positions from recorded coordinates — not survey-grade.
        </p>
      </CardContent>
    </Card>
  )
}
