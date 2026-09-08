// SHARED FLAG-FAMILY GATE (W3-1, security issue "S1") — ONE table, TWO routes.
//
// Before W3-1 the FLAGGED_ACTION_FAMILIES table below lived as a local const
// in src/backend/api/actions.ts, so only POST /api/actions enforced it: the
// offline sync drain (POST /api/sync) applied the very same action types with
// NO flag gate — a contractor session (or any non-admin session that reaches
// sync, the offline PWA's primary mutation path) could flush payment.* /
// wallet.* / land.* / supply.* items while the wallet / land_verification /
// marketplace flags were OFF. A flag OFF did not actually close its feature.
//
// This module is the ONE definition both routes import:
//   · POST /api/actions — route-level: a denied request answers 403 (the
//     NextResponse from actionFlagGate) before the idempotency replay;
//   · POST /api/sync    — per-item: a denied outbox item fails with the SAME
//     message (actionFlagGateMessage) before any pre-check, before
//     applyAction and before the idempotency record is written — batch
//     semantics, other items continue, nothing is applied.
//
// The gate stays server-safe and import-cycle-free: `session` is taken
// STRUCTURALLY (same shape discipline as requireFlagOn in
// modules/intel/flags.ts — { user?: { role?: unknown } } | null) so this file
// never imports guard.ts; the flag module only imports next/server + db.
// Non-flagged action types short-circuit to "allowed" WITHOUT reading the
// flag table — the gate is free for the milestone/attendance/task families.
//
// Admin sessions bypass exactly as everywhere else (FLAG_BYPASS_ROLES in
// modules/intel/flags.ts) so a flag can be toggled and exercised before
// rollout. The honest boundaries — what each flag deliberately does NOT gate
// (the escrow/milestone release ladder, invoice.*, professionals, delivery
// expense posting, the verified Daraja webhook) — stay documented in
// src/backend/modules/intel/flags.ts.

import type { NextResponse } from 'next/server'
import { requireFlagOn, type FlagKey } from '@/backend/modules/intel/flags'
import { WALLET_ACTIONS } from '@/backend/actions/wallet'
import { LAND_ACTIONS } from '@/backend/actions/land'
import { SUPPLY_ACTIONS } from '@/backend/actions/supply'

export const FLAGGED_ACTION_FAMILIES: ReadonlyArray<{ actions: readonly string[]; flag: FlagKey }> = [
  // wallet: the user-facing wallet & payment-request actions (money tab +
  //   API clients). Internal ledger postings by other flows are NOT here.
  { actions: WALLET_ACTIONS, flag: 'wallet' },
  // land_verification: the parcels + title-search ladder only.
  { actions: LAND_ACTIONS, flag: 'land_verification' },
  // marketplace: the whole Finder supply loop (invoice.* is a separate
  //   module that shares the tab and stays open).
  { actions: SUPPLY_ACTIONS, flag: 'marketplace' },
]

/** Structural session shape — deliberately NOT guard.ts's GuardSession (no import cycle). */
export type FlagGateSession = { user?: { role?: unknown } } | null | undefined

/**
 * The flag gate for ONE action type: null when the action is allowed (flag
 * on, non-flagged family, or an admin bypass session), otherwise the uniform
 * 403 `Feature disabled by feature flag (<key>)` response.
 */
export async function actionFlagGate(type: string, session: FlagGateSession): Promise<NextResponse | null> {
  for (const family of FLAGGED_ACTION_FAMILIES) {
    if (family.actions.includes(type)) return requireFlagOn(family.flag, session)
  }
  return null
}

/**
 * Per-item variant for /api/sync's batch result shape: null when the item is
 * allowed, otherwise the denial MESSAGE (read back out of the very response
 * actionFlagGate builds — one copy of the error text, zero drift between the
 * two routes). Sync renders it as { id, ok: false, error } without writing
 * anything: no idempotency record, no apply, no audit event.
 */
export async function actionFlagGateMessage(type: string, session: FlagGateSession): Promise<string | null> {
  const denied = await actionFlagGate(type, session)
  if (!denied) return null
  const body = (await denied.json()) as { error?: unknown }
  return typeof body.error === 'string' ? body.error : 'Feature disabled'
}
