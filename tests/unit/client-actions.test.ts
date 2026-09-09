/**
 * Invariants of the CLIENT_ACTIONS allowlist (src/shared/client-actions.ts).
 *
 * This list is a SECURITY boundary, not a UX hint: /api/actions and /api/sync
 * 401/403 anything a client-role session (or a share-link visitor) tries to
 * dispatch that is NOT in it. So:
 *   · every entry must be a real, dispatchable action id (registry drift =
 *     a client UI that always 403s, or worse a typo that silently widens);
 *   · only decide/communicate/pay verbs belong here — creating, editing,
 *     deleting or releasing site-team records from a client surface would
 *     bypass the owner trust model (spec Doc A §24);
 *   · no duplicates (the route check is an Array.includes, idempotent, but a
 *     duplicate signals a sloppy edit that this suite should catch).
 *
 * The dispatcher registry is imported from the real src/backend/actions/*
 * arrays (db is stubbed — the arrays are plain data; nothing is dispatched),
 * plus the core action ids parsed out of the ActionType union in
 * src/backend/lib/mjengo.ts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// The action modules import { db } from '@/backend/lib/db' (Prisma). Nothing
// is dispatched in this file, so a bare stub keeps the import graph pure.
vi.mock('@/backend/lib/db', () => ({ db: {} }))

import { CLIENT_ACTIONS } from '@/shared/client-actions'
import { EVIDENCE_ACTIONS } from '@/backend/actions/evidence'
import { INTEL_ACTIONS } from '@/backend/actions/intel'
import { INVENTORY_ACTIONS } from '@/backend/actions/inventory'
import { INVOICE_ACTIONS } from '@/backend/actions/invoices'
import { LAND_ACTIONS } from '@/backend/actions/land'
import { MONEY_ACTIONS } from '@/backend/actions/money'
import { PROFESSIONALS_ACTIONS } from '@/backend/actions/professionals'
import { SUPPLY_ACTIONS } from '@/backend/actions/supply'
import { TRUST_ACTIONS } from '@/backend/actions/trust'
import { WALLET_ACTIONS } from '@/backend/actions/wallet'

/** Core (non-module) action ids, parsed from the ActionType union source. */
function coreActionIds(): string[] {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/backend/lib/mjengo.ts', import.meta.url)),
    'utf8',
  )
  const union = src.slice(
    src.indexOf('export type ActionType'),
    src.indexOf('export async function applyAction'),
  )
  return [...union.matchAll(/'([a-z]+[a-zA-Z]*\.[a-zA-Z]+)'/g)].map((m) => m[1])
}

const REGISTRY = new Set<string>([
  ...coreActionIds(),
  ...TRUST_ACTIONS, ...MONEY_ACTIONS, ...EVIDENCE_ACTIONS, ...LAND_ACTIONS,
  ...PROFESSIONALS_ACTIONS, ...SUPPLY_ACTIONS, ...INVOICE_ACTIONS,
  ...INTEL_ACTIONS, ...INVENTORY_ACTIONS, ...WALLET_ACTIONS,
])

describe('CLIENT_ACTIONS is a complete, dispatchable allowlist', () => {
  it('has no duplicate entries', () => {
    expect(new Set(CLIENT_ACTIONS).size).toBe(CLIENT_ACTIONS.length)
  })

  it('every entry is a real action id the dispatcher knows', () => {
    for (const action of CLIENT_ACTIONS) {
      expect(REGISTRY.has(action), `"${action}" is not a dispatchable action id`).toBe(true)
    }
  })

  it('is non-empty (an empty list would brick every share-link)', () => {
    expect(CLIENT_ACTIONS.length).toBeGreaterThan(0)
  })
})

describe('no owner-only mutation leaks into the client surface', () => {
  const CLIENT_VERBS = new Set(['decide', 'pay', 'add', 'read', 'readAll'])

  it('every entry is a decide/communicate/pay verb', () => {
    for (const action of CLIENT_ACTIONS) {
      const verb = action.slice(action.indexOf('.') + 1)
      expect(
        CLIENT_VERBS.has(verb),
        `"${action}" is not a client verb (decide/pay/comment/read) — owners only?`,
      ).toBe(true)
    }
  })

  it('never contains the classic owner-only mutation ids', () => {
    const ownerOnly = [
      'task.create', 'task.update', 'task.delete', 'task.assign',
      'phase.update', 'project.update', 'material.create',
      'worker.create', 'wages.pay', 'expense.create', 'transaction.delete',
      'team.add', 'team.update', 'team.remove',
      'delivery.create', 'consumption.create', 'share.regenerate',
      'photo.apply', 'alert.ack', 'attendance.override', 'payroll.approve',
    ]
    for (const id of ownerOnly) {
      expect(CLIENT_ACTIONS, `owner-only "${id}" leaked into CLIENT_ACTIONS`).not.toContain(id)
    }
  })

  it('never lets a client create/edit/submit invoices or payment requests', () => {
    // Finder spec §8-10: clients DECIDE submitted invoices and PAY them; the
    // draft work (create/update/submit) stays with the site team.
    const siteTeamOnly = [
      'invoice.create', 'invoice.update', 'invoice.submit', 'invoice.delete',
      'payment.create', 'payment.update', 'payment.submit',
      'request.create', 'request.update', 'request.submit',
      'milestone.create', 'variation.create',
    ]
    for (const id of siteTeamOnly) {
      expect(CLIENT_ACTIONS, `"${id}" must stay site-team-only`).not.toContain(id)
    }
  })

  it('never exposes wallet/escrow plumbing to a client', () => {
    for (const action of WALLET_ACTIONS) {
      if (action === 'payment.decide' || action === 'payment.pay') continue // the client payer-queue seam, by design
      expect(CLIENT_ACTIONS).not.toContain(action)
    }
    expect(CLIENT_ACTIONS).not.toContain('escrow.topup')
  })
})

describe('dispatcher registry hygiene (the arrays CLIENT_ACTIONS depends on)', () => {
  const MODULE_ARRAYS: [string, readonly string[]][] = [
    ['TRUST_ACTIONS', TRUST_ACTIONS], ['MONEY_ACTIONS', MONEY_ACTIONS],
    ['EVIDENCE_ACTIONS', EVIDENCE_ACTIONS], ['LAND_ACTIONS', LAND_ACTIONS],
    ['PROFESSIONALS_ACTIONS', PROFESSIONALS_ACTIONS],
    ['SUPPLY_ACTIONS', SUPPLY_ACTIONS], ['INVOICE_ACTIONS', INVOICE_ACTIONS],
    ['INTEL_ACTIONS', INTEL_ACTIONS], ['INVENTORY_ACTIONS', INVENTORY_ACTIONS],
    ['WALLET_ACTIONS', WALLET_ACTIONS],
  ]

  it('action arrays are pairwise disjoint (ambiguous dispatch hazard)', () => {
    for (let i = 0; i < MODULE_ARRAYS.length; i++) {
      for (let j = i + 1; j < MODULE_ARRAYS.length; j++) {
        const [nameA, arrA] = MODULE_ARRAYS[i]
        const [nameB, arrB] = MODULE_ARRAYS[j]
        const overlap = arrA.filter((a) => arrB.includes(a))
        expect(overlap, `${nameA} and ${nameB} overlap`).toEqual([])
      }
    }
  })

  it('no module array contains duplicates', () => {
    for (const [name, arr] of MODULE_ARRAYS) {
      expect(new Set(arr).size, `${name} has duplicates`).toBe(arr.length)
    }
  })
})
