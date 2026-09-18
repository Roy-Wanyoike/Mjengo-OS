// /api/v1 keyset pagination helpers (issue #154 / audit API-3) — the #155
// convention hoisted for every route that queries its subresource directly.
//
// The v1 LIST routes that read their own table push limit + cursor INTO the
// findMany (the attendance route's issue-#155 shape), so each of them needs
// the same two pieces:
//   1. resolve the cursor row by id, refusing unknown AND out-of-scope ids
//      with pageOfKind's exact 400 ("the id of <noun> in this list") — the
//      route encodes its scope + filter predicates in the findFirst where,
//      so a foreign, filtered-out or unknown cursor all resolve null;
//   2. express "strictly after the cursor row" as a where fragment over the
//      list's (sortKey, id) total order.
// The routes that still slice a bounded window in memory (the suppliers
// directory) keep pageOfKind; both share the same cursor contract and the
// same 400 message, so a client cannot tell them apart.

import type { NextResponse } from 'next/server'
import { v1Err } from './respond'

/**
 * Resolve a keyset cursor (issue #154, the #155 attendance/getProjectsList
 * convention): `fetchCursorRow` returns the cursor row ONLY when it belongs
 * to this (possibly filtered) list — callers put the project scope and the
 * active filters in the findFirst where, so an unknown id, a foreign
 * project's row and a row the filter excludes all answer null and get the
 * same single-line 400 pageOfKind has always produced.
 */
export async function cursorRowOr400<Row>(
  fetchCursorRow: () => Promise<Row | null>,
  noun: string,
): Promise<{ ok: true; row: Row } | { ok: false; response: NextResponse }> {
  const row = await fetchCursorRow()
  if (!row) {
    return {
      ok: false,
      response: v1Err(400, `Unknown cursor — it must be the id of ${noun} in this list`, 'cursor'),
    }
  }
  return { ok: true, row }
}

/** (createdAt, id) keyset boundary — the pair the fragment below consumes. */
export interface CreatedAtIdBoundary {
  createdAt: Date
  id: string
}

/**
 * Where-fragment: rows strictly AFTER the boundary in the (createdAt, id)
 * total order — `asc` for the oldest-first lists (tasks, milestones,
 * parcels), `desc` for the newest-first ones (invoices). The attendance
 * route (#155) spells the same predicate inline; it lives here so the
 * direct-read routes of #154 cannot drift apart.
 */
export function afterCreatedAtId(boundary: CreatedAtIdBoundary, dir: 'asc' | 'desc') {
  return dir === 'asc'
    ? {
        OR: [
          { createdAt: { gt: boundary.createdAt } },
          { createdAt: boundary.createdAt, id: { gt: boundary.id } },
        ],
      }
    : {
        OR: [
          { createdAt: { lt: boundary.createdAt } },
          { createdAt: boundary.createdAt, id: { lt: boundary.id } },
        ],
      }
}

/**
 * Where-fragment: rows strictly AFTER the boundary in the (name, id) total
 * order — the workers roster (Worker has no createdAt column; the payload's
 * own roster order is name ASC with the id tiebreak the keyset needs).
 */
export function afterNameId(boundary: { name: string; id: string }) {
  return {
    OR: [{ name: { gt: boundary.name } }, { name: boundary.name, id: { gt: boundary.id } }],
  }
}
