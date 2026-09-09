// Intel module — FEATURE FLAGS (spec §81, ownership-clean home for F-INSIGHT).
//
// Flags live in the FeatureFlag table (one row per key, default enabled),
// created lazily on first read so a fresh install needs no seed step. A 30s
// in-memory cache keeps the payload cheap; writes invalidate it immediately
// (a route gate may therefore serve a value up to 30s stale after a toggle —
// the documented tradeoff). NEXT_FLAGS_OFF (comma list) is an env override
// for local/CI runs that forces flags off regardless of the table.
//
// ENFORCEMENT (task 9-a, "every flag gates its feature or is honestly
// removed"): every flag below gates its feature SERVER-SIDE — a flag OFF
// makes the feature's API routes answer 403 `Feature disabled by feature
// flag (<key>)` for NON-ADMIN sessions (admins bypass so they can toggle and
// test), and the UI hides/disables the feature's entry point for non-admins
// (admins keep it, same rule — mirrored client-side in nav/tab-meta.ts and
// copilot-tab.tsx, keep in sync). The uniform helper is requireFlagOn(),
// exported at the bottom of this file.
//
// Per-flag enforcement map (keep in sync with the call sites):
//   · ai_progress       → POST /api/ai/analyze-photo (the Copilot photo-
//                         analysis route) + the Copilot "Analyze with vision
//                         AI" button. The button was always gated; the route
//                         was not — it is now.
//   · ai_voice          → POST /api/ai/voice-log (Swahili ASR → delivery log)
//                         + the voice panel's record/upload/sample buttons.
//                         /api/ai/parse-text is deliberately NOT gated by
//                         this flag: it is the typed-note path, not voice.
//   · wallet            → the USER-FACING wallet & payment-request surface:
//                         the WALLET_ACTIONS family on POST /api/actions
//                         (payment.request/decide/pay, wallet.create/deposit/
//                         withdraw/transfer, transaction.reverse,
//                         ledger.post — the money-tab actions and the API
//                         client surface) plus the whole /api/v1 wallets +
//                         payments REST family, plus the Money tab entry.
//                         BOUNDARY (honest): this flag does NOT gate internal
//                         ledger postings driven by other flows — invoice.pay
//                         (invoices module → provider seam → ledger), the
//                         escrow/milestone governance ladder (escrow.topup,
//                         milestone.*, variation.* — the client's release
//                         flow must survive), delivery.create expense posting
//                         and the verified Daraja webhook callback (a machine
//                         path, not a session) all keep posting while the
//                         flag is off. The share-link surface (/api/share)
//                         and the offline sync drain (/api/sync) dispatch some
//                         of the same action types through their own
//                         cross-cutting routes — outside this flag's
//                         enforcement; documented as a follow-up, not
//                         silently ignored.
//   · marketplace       → the Finder loop: the SUPPLY_ACTIONS family on
//                         POST /api/actions (supplier/catalog upserts,
//                         request/quote/order/delivery/rule lifecycle,
//                         supply.compare) + the Finder tab entry. invoice.*
//                         (the invoices module that shares the Finder tab)
//                         is NOT gated by this flag.
//   · land_verification → the land module ladder: the LAND_ACTIONS family
//                         on POST /api/actions (parcel.create/update/
//                         setStatus, parcelDoc.attach, search.request/
//                         receive/review) + the parcels section of the Land
//                         tab. The professionals directory
//                         (PROFESSIONALS_ACTIONS — a separate module that
//                         shares the Land tab) is NOT gated by this flag.
//
// REMOVED FLAG — low_data (decision, task 9-a): it gated nothing and had no
// coherent server-side behavior to gate. The real low-data feature is the
// per-device Data Saver preference (spec §74 — the header's data-mode
// selector + client-side photo downscaling in the copilot tab): a user
// preference stored in the browser, not an admin rollout switch. A server
// "compact payloads" mode would be a new API surface — a product feature,
// not a flag. Removed from FLAG_KEYS/FLAG_LABELS here, from the admin
// popover (header.tsx FLAG_ROWS), the intel seed (prisma/seed-extras/
// intel.ts) and EMPTY_INTEL_SLICE (intel/types.ts). A stale `low_data`
// FeatureFlag row in an existing database is inert: reads filter to
// FLAG_KEYS and setFlag rejects the key.

import { NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'

export const FLAG_KEYS = [
  'ai_progress',
  'ai_voice',
  'wallet',
  'marketplace',
  'land_verification',
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

// ---------------------------------------------------------------- enforcement

/**
 * Roles that bypass flag gating: admins can toggle flags, so they keep the
 * feature while it is off — otherwise a flag could never be exercised before
 * rollout. The client-side mirror (which tabs/buttons stay visible) reads the
 * same role the same way — keep the two in sync.
 */
export const FLAG_BYPASS_ROLES: readonly string[] = ['admin']

/**
 * The uniform 403 a gated route answers when its flag is off. Body shape
 * matches the shared guard's 401/403 contract ({ error }) so /api/v1,
 * /api/ai and /api/actions failures stay one family.
 */
export function featureDisabledResponse(key: FlagKey): NextResponse {
  return NextResponse.json(
    { error: `Feature disabled by feature flag (${key}) — an admin can re-enable it from the flags popover in the header` },
    { status: 403 },
  )
}

/**
 * Route-level flag gate (task 9-a): returns a 403 response when `key` is OFF
 * and the session is NOT a bypass role; null when the request may proceed
 * (flag on, or an admin session). `session` is any GuardSession-shaped
 * object, taken structurally so this file stays free of a guard.ts import
 * (no import cycle, no next-auth pull); null sessions (share-token callers)
 * are non-admins and are gated.
 *
 * Usage — the first check inside a guarded handler:
 *   const denied = await requireFlagOn('wallet', session)
 *   if (denied) return denied
 */
export async function requireFlagOn(
  key: FlagKey,
  session: { user?: { role?: unknown } } | null | undefined,
): Promise<NextResponse | null> {
  const role = session?.user?.role
  if (typeof role === 'string' && FLAG_BYPASS_ROLES.includes(role)) return null
  if (await isFlagOn(key)) return null
  return featureDisabledResponse(key)
}
