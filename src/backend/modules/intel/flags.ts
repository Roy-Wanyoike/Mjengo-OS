// Intel module — FEATURE FLAGS (spec §81, ownership-clean home for F-INSIGHT).
//
// Flags live in the FeatureFlag table (one row per key, default enabled),
// created lazily on first read so a fresh install needs no seed step. A 30s
// in-memory cache keeps the payload cheap; writes invalidate it immediately.
// NEXT_FLAGS_OFF (comma list) is an env override for local/CI runs that forces
// flags off regardless of the table.
//
// The ONLY behavior currently gated on a flag is the Copilot photo-analysis
// button (ai_progress). Everything else is read-only state surfaced to the
// admin popover — honest, no dead toggles pretending to do something.

import { db } from '@/backend/lib/db'

export const FLAG_KEYS = [
  'ai_progress',
  'ai_voice',
  'wallet',
  'marketplace',
  'land_verification',
  'low_data',
] as const

export type FlagKey = (typeof FLAG_KEYS)[number]
export type FlagMap = Record<FlagKey, boolean>

/** Human labels for the admin popover (spec §81 names). */
export const FLAG_LABELS: Record<FlagKey, string> = {
  ai_progress: 'AI progress (photo analysis)',
  ai_voice: 'AI voice logging',
  wallet: 'Wallet & payment requests',
  marketplace: 'Supplier marketplace (Finder)',
  land_verification: 'Land verification ladder',
  low_data: 'Low-data mode option',
}

const CACHE_TTL_MS = 30_000

let cache: { at: number; flags: FlagMap } | null = null

function isFlagKey(v: string): v is FlagKey {
  return (FLAG_KEYS as readonly string[]).includes(v)
}

/** Create any missing flag rows (idempotent; default enabled). */
async function ensureRows(): Promise<void> {
  for (const key of FLAG_KEYS) {
    await db.featureFlag.upsert({
      where: { key },
      create: { key, enabled: true, description: FLAG_LABELS[key] },
      update: {},
    })
  }
}

/** Env override: NEXT_FLAGS_OFF="ai_progress,wallet" forces those flags off. */
function applyEnvOverride(flags: FlagMap): FlagMap {
  const off = (process.env.NEXT_FLAGS_OFF ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  for (const k of off) if (isFlagKey(k)) flags[k] = false
  return flags
}

/** All flags as a map (30s cache, lazy row creation, env override applied). */
export async function getFlags(): Promise<FlagMap> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.flags
  await ensureRows()
  const rows = await db.featureFlag.findMany({ where: { key: { in: [...FLAG_KEYS] } } })
  const flags = Object.fromEntries(FLAG_KEYS.map((k) => [k, rows.find((r) => r.key === k)?.enabled ?? true])) as FlagMap
  applyEnvOverride(flags)
  cache = { at: Date.now(), flags }
  return flags
}

/** Single flag check (server-side gating decisions). */
export async function isFlagOn(key: FlagKey): Promise<boolean> {
  return (await getFlags())[key] !== false
}

/** Persist a toggle (admin route) and return the fresh flag map. */
export async function setFlag(key: string, enabled: boolean): Promise<FlagMap> {
  if (!isFlagKey(key)) throw new Error(`Unknown flag key: ${key}`)
  await ensureRows()
  await db.featureFlag.update({ where: { key }, data: { enabled } })
  invalidateFlagCache()
  return getFlags()
}

/** Drop the in-memory cache so the next read hits the table (used after writes). */
export function invalidateFlagCache(): void {
  cache = null
}
