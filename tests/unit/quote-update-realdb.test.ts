/**
 * updateQuote atomicity against the REAL SQLite engine (#147) — the critical-
 * path companion of tests/unit/quote-atomicity.test.ts, in the tests/helpers/db
 * real-database idiom (issue #184 / audit register TEST-2).
 *
 * The stub suite proves the service-level rollback convention; this file
 * proves the SAME service code against the real engine — real interactive
 * $transaction, real rollback — with the failure injected by the ENGINE
 * itself, not a stub seam:
 *
 *  · mid-rewrite failure: the 3rd of 5 replacement lines carries a sub-cent
 *    unitPrice (700.5). QuoteLine.unitPrice is a BigInt CENTS column (issue
 *    #122), so the real Prisma client refuses that create mid-loop
 *    ("Expected BigInt, provided Float") AFTER the deleteMany and the first
 *    two creates have already run inside the transaction — the exact
 *    crash-mid-recreation window issue #147 describes. The pin: the WHOLE
 *    transaction rolls back; a raw-SQL oracle (better-sqlite3, bypassing
 *    Prisma) sees exactly the ORIGINAL rows and the ORIGINAL header.
 *  · the success path: the line set is replaced in one commit and the
 *    documented response shape { id, validUntil, terms } survives byte-for-
 *    byte.
 *  · scoping: a quote id from another project is refused before any write.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

import { disposeRealDb, getRealTestDb, seedProject } from '../helpers/db'
import { updateQuote } from '@/backend/modules/inventory/service'

const { prisma, sqlite } = getRealTestDb()
afterAll(disposeRealDb)

/** Raw-SQL oracle (BigInt-safe, bypasses Prisma — independent read). */
const rawLines = (quoteId: string): Array<{ name: string; qty: number; unitPrice: bigint; lineTotal: bigint }> =>
  sqlite
    .prepare('SELECT name, qty, unitPrice, lineTotal FROM QuoteLine WHERE quoteId = ? ORDER BY name')
    .all(quoteId) as Array<{ name: string; qty: number; unitPrice: bigint; lineTotal: bigint }>

let requestSeq = 0

/**
 * One project → material request → supplier → quote with THREE original
 * lines (cents literals — the #122 discipline), header validUntil/terms set.
 */
async function seedQuote(): Promise<{ projectId: string; quoteId: string }> {
  const project = await seedProject(prisma, { name: `#147 Quote Atomicity ${++requestSeq}`, client: 'Amina Hassan' })
  const request = await prisma.materialRequest.create({
    data: {
      projectId: project.id,
      requestCode: `MR-147-${requestSeq}`,
      requestedByRole: 'contractor',
      requestedByName: 'Site Manager',
    },
  })
  const supplier = await prisma.supplier.create({
    data: { businessName: `Bamburi #${requestSeq}`, county: 'Nairobi' },
  })
  const quote = await prisma.quote.create({
    data: {
      requestId: request.id,
      supplierId: supplier.id,
      unitPrice: 65_000n, // KSh 650 — cents (issue #122)
      totalLanded: 2_730_000n,
      validUntil: new Date('2026-06-30T00:00:00.000Z'),
      terms: '50% deposit, balance on delivery',
    },
  })
  for (let i = 1; i <= 3; i++) {
    await prisma.quoteLine.create({
      data: {
        quoteId: quote.id,
        name: `Original ${i}`,
        unit: 'bag',
        qty: 10 + i,
        unitPrice: 65_000n,
        lineTotal: BigInt(10 + i) * 65_000n,
      },
    })
  }
  return { projectId: project.id, quoteId: quote.id }
}

describe('#147: updateQuote line rewrite on the real engine', () => {
  it('an ENGINE-level failure mid-recreation rolls the whole rewrite back — original rows and header survive', async () => {
    const { projectId, quoteId } = await seedQuote()
    // Five replacement lines; the 3rd carries a sub-cent price the BigInt
    // cents column cannot represent. The engine refuses that create AFTER
    // the deleteMany + two creates already ran in-tx — the mid-loop crash
    // window of issue #147, injected with no stub seam at all.
    const lines = [1, 2, 3, 4, 5].map((i) => ({ name: `Replacement ${i}`, unit: 'bag', qty: 5, unitPrice: 700 }))
    lines[2].unitPrice = 700.5
    await expect(
      updateQuote(projectId, {
        id: quoteId,
        validUntil: '2027-03-01T00:00:00.000Z',
        terms: 'Net 30 — edited',
        lines,
      }),
    ).rejects.toThrow()
    // Raw-SQL oracle: EXACTLY the three original rows — no partial set, no
    // empty set, no replacement row committed.
    const rows = rawLines(quoteId)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.name)).toEqual(['Original 1', 'Original 2', 'Original 3'])
    expect(rows[0]).toEqual({ name: 'Original 1', qty: 11, unitPrice: 65_000n, lineTotal: 715_000n })
    const replacements = sqlite
      .prepare("SELECT COUNT(*) AS n FROM QuoteLine WHERE name LIKE 'Replacement %'")
      .get() as { n: bigint }
    expect(Number(replacements.n)).toBe(0)
    // The header edit rode the same transaction — the ORIGINAL window/terms.
    const header = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } })
    expect(header.validUntil?.toISOString()).toBe('2026-06-30T00:00:00.000Z')
    expect(header.terms).toBe('50% deposit, balance on delivery')
  })

  it('a clean rewrite replaces the set in ONE commit and keeps the response shape', async () => {
    const { projectId, quoteId } = await seedQuote()
    const r = await updateQuote(projectId, {
      id: quoteId,
      validUntil: '2027-03-01T00:00:00.000Z',
      terms: 'Net 30',
      lines: [
        { name: 'Cement', unit: 'bag', qty: 120, unitPrice: 650 },
        { name: 'Ballast', qty: '5', unitPrice: '1800' },
      ],
    })
    // Issue AC #3 — the documented response contract, byte-for-byte.
    expect(Object.keys(r).sort()).toEqual(['id', 'terms', 'validUntil'])
    expect(r.id).toBe(quoteId)
    expect(new Date(r.validUntil as unknown as string).toISOString()).toBe('2027-03-01T00:00:00.000Z')
    expect(r.terms).toBe('Net 30')
    // The old rows are gone; the new set is exactly the payload's (numeric
    // strings coerce — outbox replay semantics; lineTotal = qty × price).
    const rows = rawLines(quoteId)
    expect(rows).toHaveLength(2)
    expect(rows.map((x) => x.name)).toEqual(['Ballast', 'Cement'])
    expect(rows.find((x) => x.name === 'Cement')).toMatchObject({ qty: 120, unitPrice: 650n, lineTotal: 78_000n })
    expect(rows.find((x) => x.name === 'Ballast')).toMatchObject({ qty: 5, unitPrice: 1800n, lineTotal: 9000n })
    // Header persisted.
    const header = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } })
    expect(header.terms).toBe('Net 30')
  })

  it('payload without a lines key edits the header only — rows untouched (real engine)', async () => {
    const { projectId, quoteId } = await seedQuote()
    const r = await updateQuote(projectId, { id: quoteId, terms: 'Net 45' })
    expect(r.terms).toBe('Net 45')
    expect(rawLines(quoteId)).toHaveLength(3)
  })

  it('an explicit empty lines array clears the set — legacy semantics preserved on the real engine', async () => {
    const { projectId, quoteId } = await seedQuote()
    await updateQuote(projectId, { id: quoteId, lines: [] })
    expect(rawLines(quoteId)).toHaveLength(0)
  })

  it('a quote id from ANOTHER project is refused before any write (scoping unchanged)', async () => {
    const { quoteId } = await seedQuote()
    await expect(
      updateQuote('000000000000000000000000', { id: quoteId, terms: 'nope', lines: [{ name: 'x', qty: 1, unitPrice: 1 }] }),
    ).rejects.toThrow('Quote not found')
    expect(rawLines(quoteId)).toHaveLength(3)
  })
})
