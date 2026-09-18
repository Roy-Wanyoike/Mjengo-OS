/**
 * updateQuote line-rewrite atomicity (#147) — src/backend/modules/inventory/service.ts.
 *
 * The DB-2 class on the quote-editing path: updateQuote used to `deleteMany`
 * ALL of a quote's QuoteLine rows and recreate them one-by-one in a plain
 * loop — no transaction. A failure mid-loop left the quote with a PARTIAL
 * line set that read as a valid quote with fewer items (silent corruption
 * feeding supplier comparison and PO creation), and a concurrent reader
 * between the deleteMany and the loop saw an empty quote.
 *
 * Pins (mirroring tests/unit/inventory-atomicity.test.ts, the DB-2 suite):
 *  · a failure injected BETWEEN line creates rolls the WHOLE rewrite back —
 *    the original rows (same ids) and the original header survive;
 *  · a failure on the header update rolls back with the lines untouched;
 *  · a successful update replaces the lines atomically and keeps the
 *    documented response shape { id, validUntil, terms } exactly;
 *  · the legacy semantics that are NOT up for change stay pinned: no
 *    `lines` key → header-only edit; `lines: []` clears the set; a foreign
 *    (other-project) quote id is refused before any write.
 *
 * Same stub idiom as inventory-atomicity.test.ts: @/backend/lib/db is swapped
 * for an in-memory stub whose $transaction snapshots state and restores it on
 * throw — a rollback assertion here FAILS against code that writes outside a
 * transaction (the snapshot is only restored on $transaction's catch path).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub: just enough of quote / quoteLine / $transaction for
// the updateQuote path. __state exposes the tables for assertions;
// failOnNthQuoteLineCreate injects a write failure on the Nth (1-based)
// quoteLine.create call — the mid-rewrite failure injection; failOnQuoteUpdate
// fails the header update for the header-first rollback pin.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    quotes: new Map<string, Record<string, unknown>>(),
    quoteLines: new Map<string, Record<string, unknown>>(),
    failOnNthQuoteLineCreate: null as number | null,
    failOnQuoteUpdate: false,
    quoteUpdateCalls: 0,
    reset() {
      state.quotes.clear()
      state.quoteLines.clear()
      state.seq = 0
      state.failOnNthQuoteLineCreate = null
      state.failOnQuoteUpdate = false
      state.quoteUpdateCalls = 0
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`

  const quote = {
    // where: { id, request: { projectId } } — the stub models the request
    // join as a `projectId` column on the row.
    async findFirst({ where }: { where: { id: string; request?: { projectId: string } } }) {
      const row = state.quotes.get(where.id)
      if (!row) return null
      if (where.request && row.projectId !== where.request.projectId) return null
      return { ...row }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      state.quoteUpdateCalls++
      if (state.failOnQuoteUpdate) throw new Error('stub: simulated failure updating quote header')
      const existing = state.quotes.get(where.id)
      if (!existing) throw new Error('stub: quote row vanished')
      // Prisma semantics: undefined keys leave the column untouched.
      const patch: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v
      // Replace (never mutate in place) so $transaction snapshots restore cleanly.
      const updated = { ...existing, ...patch }
      state.quotes.set(updated.id as string, updated)
      return { ...updated }
    },
  }
  const quoteLine = {
    async deleteMany({ where }: { where: { quoteId: string } }) {
      let deleted = 0
      for (const [id, row] of state.quoteLines) {
        if (row.quoteId === where.quoteId) {
          state.quoteLines.delete(id)
          deleted++
        }
      }
      return { count: deleted }
    },
    async create({ data }: { data: Record<string, unknown> }) {
      if (state.failOnNthQuoteLineCreate !== null) {
        state.failOnNthQuoteLineCreate--
        if (state.failOnNthQuoteLineCreate <= 0) {
          state.failOnNthQuoteLineCreate = null
          throw new Error(`stub: simulated failure writing quote line "${String(data.name)}"`)
        }
      }
      const row: Record<string, unknown> = { id: nid('ql'), ...data }
      state.quoteLines.set(row.id as string, row)
      return { ...row }
    },
  }
  const db = {
    quote,
    quoteLine,
    async $transaction(fn: (tx: typeof db) => unknown) {
      const quotes = new Map(state.quotes)
      const quoteLines = new Map(state.quoteLines)
      try {
        return await fn(db)
      } catch (err) {
        state.quotes = quotes
        state.quoteLines = quoteLines
        throw err
      }
    },
    __state: state,
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { updateQuote } from '@/backend/modules/inventory/service'

type StubState = {
  quotes: Map<string, Record<string, unknown>>
  quoteLines: Map<string, Record<string, unknown>>
  failOnNthQuoteLineCreate: number | null
  failOnQuoteUpdate: boolean
  quoteUpdateCalls: number
  reset: () => void
}
const state = (db as unknown as { __state: StubState }).__state
const linesOf = (quoteId: string) =>
  [...state.quoteLines.values()].filter((l) => l.quoteId === quoteId)

const P = 'proj-1'
const ORIGINAL_VALID_UNTIL = new Date('2026-06-30T00:00:00.000Z')
const ORIGINAL_TERMS = '50% deposit, balance on delivery'

/** A quote with three original lines, in project P. */
async function seedQuote(): Promise<string> {
  const quoteId = `quote_${++state.seq}`
  state.quotes.set(quoteId, {
    id: quoteId,
    projectId: P,
    validUntil: new Date(ORIGINAL_VALID_UNTIL),
    terms: ORIGINAL_TERMS,
  })
  for (let i = 1; i <= 3; i++) {
    const id = `ql_orig_${i}`
    state.quoteLines.set(id, {
      id,
      quoteId,
      name: `Original ${i}`,
      unit: 'bag',
      qty: 10 + i,
      unitPrice: 65000,
      lineTotal: (10 + i) * 65000,
    })
  }
  return quoteId
}

/** Five replacement lines (the payload that rewrites the quote). */
const replacementLines = () =>
  [1, 2, 3, 4, 5].map((i) => ({ name: `Replacement ${i}`, unit: 'bag', qty: 5, unitPrice: 700 }))

beforeEach(() => {
  state.reset()
})

describe('updateQuote — a mid-rewrite failure leaves NO partial state (#147)', () => {
  it('a failure between line creates rolls back to the ORIGINAL rows (same ids), header included', async () => {
    const quoteId = await seedQuote()
    const originalIds = linesOf(quoteId).map((l) => l.id).sort()
    state.failOnNthQuoteLineCreate = 3 // the 3rd of 5 creates dies mid-loop
    await expect(
      updateQuote(P, {
        id: quoteId,
        validUntil: '2027-03-01T00:00:00.000Z',
        terms: 'Net 30 — edited',
        lines: replacementLines(),
      }),
    ).rejects.toThrow('stub: simulated failure writing quote line "Replacement 3"')
    // The original three rows SURVIVE — same ids, i.e. the deleteMany was
    // rolled back too, not just the remaining creates skipped.
    const after = linesOf(quoteId)
    expect(after).toHaveLength(3)
    expect(after.map((l) => l.id).sort()).toEqual(originalIds)
    expect(after.map((l) => l.name)).toEqual(['Original 1', 'Original 2', 'Original 3'])
    // No replacement row ever persisted — the two creates before the failure
    // were rolled back with everything else.
    expect([...state.quoteLines.values()].filter((l) => String(l.name).startsWith('Replacement'))).toHaveLength(0)
    // The header edit rode the same transaction: validUntil/terms are the
    // ORIGINALS, not the (already-written) update.
    const header = state.quotes.get(quoteId)!
    expect(header.validUntil).toEqual(ORIGINAL_VALID_UNTIL)
    expect(header.terms).toBe(ORIGINAL_TERMS)
  })

  it('a failure on the FIRST create rolls the deleteMany back (no empty quote)', async () => {
    const quoteId = await seedQuote()
    state.failOnNthQuoteLineCreate = 1
    await expect(
      updateQuote(P, { id: quoteId, validUntil: '2027-03-01T00:00:00.000Z', lines: replacementLines() }),
    ).rejects.toThrow('simulated failure writing quote line "Replacement 1"')
    expect(linesOf(quoteId)).toHaveLength(3) // never an empty line set
  })

  it('a failure on the LAST create rolls every earlier create back', async () => {
    const quoteId = await seedQuote()
    state.failOnNthQuoteLineCreate = 5
    await expect(
      updateQuote(P, { id: quoteId, terms: 'edited', lines: replacementLines() }),
    ).rejects.toThrow('simulated failure writing quote line "Replacement 5"')
    expect(linesOf(quoteId).map((l) => l.name)).toEqual(['Original 1', 'Original 2', 'Original 3'])
    expect(state.quotes.get(quoteId)!.terms).toBe(ORIGINAL_TERMS)
  })

  it('a failure on the header update rolls back with the lines untouched', async () => {
    const quoteId = await seedQuote()
    state.failOnQuoteUpdate = true
    await expect(
      updateQuote(P, { id: quoteId, validUntil: '2027-03-01T00:00:00.000Z', lines: replacementLines() }),
    ).rejects.toThrow('simulated failure updating quote header')
    expect(state.quoteUpdateCalls).toBe(1)
    expect(linesOf(quoteId)).toHaveLength(3)
    expect([...state.quoteLines.values()].filter((l) => String(l.name).startsWith('Replacement'))).toHaveLength(0)
  })
})

describe('updateQuote — successful rewrites and the unchanged contract (#147)', () => {
  it('replaces the line set atomically and returns exactly { id, validUntil, terms }', async () => {
    const quoteId = await seedQuote()
    const r = await updateQuote(P, {
      id: quoteId,
      validUntil: '2027-03-01T00:00:00.000Z',
      terms: 'Net 30',
      lines: [
        { name: 'Cement', unit: 'bag', qty: 120, unitPrice: 650 },
        { name: 'Ballast', qty: '5', unitPrice: '1800' },
      ],
    })
    // Response shape pinned byte-for-byte (issue AC #3): exactly three keys.
    expect(Object.keys(r).sort()).toEqual(['id', 'terms', 'validUntil'])
    expect(r.id).toBe(quoteId)
    expect((r.validUntil as Date).toISOString()).toBe('2027-03-01T00:00:00.000Z')
    expect(r.terms).toBe('Net 30')
    // The OLD rows are gone; the new set is exactly the payload's.
    const rows = linesOf(quoteId)
    expect(rows).toHaveLength(2)
    expect(rows.map((l) => l.name)).toEqual(['Cement', 'Ballast'])
    // Coercion semantics unchanged: numeric strings coerce (outbox replay
    // semantics), lineTotal = qty × unitPrice. Prices are integer-representable
    // — the BigInt cents column (issue #122) refuses sub-cent floats at the
    // engine, which is exactly the injection the realdb companion suite uses
    // for its rollback pin.
    expect(rows[0]).toMatchObject({ unit: 'bag', qty: 120, unitPrice: 650, lineTotal: 78000 })
    expect(rows[1]).toMatchObject({ unit: 'unit', qty: 5, unitPrice: 1800, lineTotal: 9000 })
    // The header persisted the edit.
    expect(state.quotes.get(quoteId)!.terms).toBe('Net 30')
  })

  it('payload without a lines key edits the header only — the line set is untouched', async () => {
    const quoteId = await seedQuote()
    const before = linesOf(quoteId).map((l) => l.id).sort()
    const r = await updateQuote(P, { id: quoteId, terms: 'Net 45' })
    expect(r.terms).toBe('Net 45')
    expect(linesOf(quoteId).map((l) => l.id).sort()).toEqual(before)
    expect(state.quoteUpdateCalls).toBe(1)
  })

  it('an explicit empty lines array clears the set (legacy semantics preserved)', async () => {
    const quoteId = await seedQuote()
    await updateQuote(P, { id: quoteId, lines: [] })
    expect(linesOf(quoteId)).toHaveLength(0)
  })

  it('a quote from ANOTHER project is refused before any write', async () => {
    const quoteId = await seedQuote()
    await expect(updateQuote('proj-2', { id: quoteId, terms: 'nope', lines: replacementLines() })).rejects.toThrow(
      'Quote not found',
    )
    expect(linesOf(quoteId)).toHaveLength(3)
    expect(state.quoteUpdateCalls).toBe(0)
  })
})
