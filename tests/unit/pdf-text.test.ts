/**
 * Server-side PDF text-layer extraction (issue #42) — the pure module
 * src/backend/lib/pdf-text.ts.
 *
 * All fixtures are REAL, valid PDFs built programmatically as string
 * buffers: a hand-authored object graph (catalog → pages → page →
 * content stream) with a computed classic xref table, exactly the byte
 * layout the module's scanner sees in the wild. One builder variant
 * Flate-compresses the content stream (node:zlib deflateSync), one packs
 * the page tree into a PDF 1.5 object stream (/ObjStm), and one strips
 * the xref/trailer to exercise the damaged-file fallback.
 *
 * Pins (mirroring the module header's honest coverage):
 *  · Tj / TJ / ' / " operators; Td / TD / Tm / ET line breaks;
 *    TJ kern numbers (<= -100 → space, small values join);
 *  · literal-string escapes (parens, backslash, \ooo octal, continuation)
 *    and hex strings <...>;
 *  · FlateDecode streams decoded; object-stream page trees resolved;
 *    xref/trailer-independent fallback (file-order sweep);
 *  · page count + page ORDER (walk, not just sweep);
 *  · honest failure modes: not-a-PDF, empty input, oversized input cap,
 *    encrypted refused, empty text layer (scanned) → ok:true + '' (the
 *    CALLER words that error), and NEVER a throw — including a fuzz
 *    loop of binary junk with a forged %PDF- header;
 *  · output cap mirrors the route's ocrTextHint limit.
 */
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  extractPdfText,
  PDF_MAX_INPUT_BYTES,
  PDF_MAX_TEXT_CHARS,
} from '@/backend/lib/pdf-text'

// ---------------------------------------------------------------- fixture builders

/** A minimal VALID PDF: classic xref, one content stream per page. */
function buildPdf(pageContents: string[], opts: { flate?: boolean } = {}): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  const offsets: number[] = []
  const push = (chunk: string | Buffer): void => {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1')
    parts.push(b)
    offset += b.length
  }

  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')

  const pageCount = pageContents.length
  const kids = pageContents.map((_, i) => `${3 + i * 2} 0 R`).join(' ')
  const fontNum = 3 + pageCount * 2
  // object 1 = catalog, 2 = pages; per page: page obj + content obj; last = font
  const bodies: Array<Array<string | Buffer>> = [
    [`<< /Type /Catalog /Pages 2 0 R >>`],
    [`<< /Type /Pages /Kids [ ${kids} ] /Count ${pageCount} >>`],
  ]
  pageContents.forEach((content, i) => {
    const pageNum = 3 + i * 2
    const contentNum = pageNum + 1
    bodies.push([
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
    ])
    const data = opts.flate
      ? deflateSync(Buffer.from(content, 'latin1'))
      : Buffer.from(content, 'latin1')
    bodies.push([
      `<< /Length ${data.length}${opts.flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`,
      data,
      '\nendstream',
    ])
  })
  bodies.push([`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`])

  bodies.forEach((pieces, idx) => {
    const num = idx + 1
    offsets[num] = offset
    push(`${num} 0 obj\n`)
    for (const piece of pieces) push(piece)
    push('\nendobj\n')
  })

  const xrefPos = offset
  const size = bodies.length + 1
  push(`xref\n0 ${size}\n0000000000 65535 f \n`)
  for (let num = 1; num < size; num++) {
    push(`${String(offsets[num]).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`)
  return Buffer.concat(parts)
}

/** Catalog/pages/page compressed inside a PDF 1.5 /ObjStm; content stream outside. */
function buildObjStmPdf(content: string): Buffer {
  const entries: Array<[number, string]> = [
    [10, `<< /Type /Catalog /Pages 11 0 R >>`],
    [11, `<< /Type /Pages /Kids [12 0 R] /Count 1 >>`],
    [12, `<< /Type /Page /Parent 11 0 R /MediaBox [0 0 612 792] /Contents 13 0 R >>`],
  ]
  let header = ''
  const placed: Array<[number, number, string]> = []
  let off = 0
  for (const [num, body] of entries) {
    header += `${num} ${off} `
    placed.push([num, off, body])
    off += body.length + 1
  }
  const first = header.length
  const payload = header + placed.map(([, , b]) => b).join('\n')
  const flated = deflateSync(Buffer.from(payload, 'latin1'))

  const parts: Buffer[] = []
  parts.push(Buffer.from('%PDF-1.5\n', 'latin1'))
  parts.push(
    Buffer.from(
      `1 0 obj\n<< /Type /ObjStm /N 3 /First ${first} /Length ${flated.length} /Filter /FlateDecode >>\nstream\n`,
      'latin1',
    ),
  )
  parts.push(flated)
  parts.push(
    Buffer.from(
      `\nendstream\nendobj\n13 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n` +
        `trailer\n<< /Size 14 /Root 10 0 R >>\nstartxref\n0\n%%EOF\n`,
      'latin1',
    ),
  )
  return Buffer.concat(parts)
}

const INVOICE_PAGE = `BT /F1 12 Tf 72 720 Td (Karioke Hardware) Tj 0 -14 Td (Invoice #0042) Tj 0 -14 Td [(Cement bags) -350 (KES) 40 (45000)] TJ ET`
const ESCAPE_PAGE = `BT /F1 10 Tf 72 700 Td <48656C6C6F20 68657820 737472696E67> Tj 20 -20 Td (esc \\(parens\\) \\101\\102\\103 \\\\ and \\051) Tj ET`
const TWO_PAGE_PDF = buildPdf([INVOICE_PAGE, `BT /F1 12 Tf 72 720 Td (page two text) Tj ET`])

// ---------------------------------------------------------------- extraction

describe('pdf-text — text operators', () => {
  it('extracts Tj strings; Td line moves become line breaks', () => {
    const r = extractPdfText(buildPdf([INVOICE_PAGE]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('Karioke Hardware\nInvoice #0042\nCement bags KES45000')
    expect(r.pages).toBe(1)
  })

  it('TJ kern numbers: <= -100 inserts a space, small values join; adjacent strings join', () => {
    const r = extractPdfText(buildPdf([`BT /F1 12 Tf 72 720 Td [(W) -20 (o) -20 (rld)] TJ 0 -14 Td [(A) -400 (B)] TJ ET`]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('World\nA B')
  })

  it("the ' and \" move-to-next-line operators emit a line break + the string", () => {
    const r = extractPdfText(buildPdf([`BT /F1 12 Tf 72 720 Td (one) ' 0 0 (two) " ET`]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('one\ntwo')
  })

  it('Tm (text matrix) starts a new line, like Td', () => {
    const r = extractPdfText(buildPdf([`BT /F1 12 Tf 1 0 0 1 72 720 Tm (alpha) Tj 1 0 0 1 72 700 Tm (beta) Tj ET`]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('alpha\nbeta')
  })

  it('literal escapes: \\( \\) \\\\ \\ooo octal; hex strings decode', () => {
    const r = extractPdfText(buildPdf([ESCAPE_PAGE]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // octal \101\102\103 = ABC, \051 = ), backslash-escape stays a backslash
    expect(r.text).toBe('Hello hex string\nesc (parens) ABC \\ and )')
  })

  it('unterminated literal string never throws — and an unshown string is not emitted (text needs an operator)', () => {
    const r = extractPdfText(buildPdf([`BT /F1 12 Tf 72 720 Td (dangling text`]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('')
  })

  it('comments (%) and resource dicts inside the content stream are skipped, not read as text', () => {
    const content = `BT % a comment with (fake parens)\n/F1 12 Tf << /Type /ExtGState /W 120 >> gs /F1 12 Tf 72 720 Td (real) Tj ET`
    const r = extractPdfText(buildPdf([content]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('real')
  })
})

describe('pdf-text — compression & structure', () => {
  it('FlateDecode content streams are inflated before extraction', () => {
    const r = extractPdfText(buildPdf([INVOICE_PAGE], { flate: true }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('Karioke Hardware\nInvoice #0042\nCement bags KES45000')
  })

  it('a PDF 1.5 object stream (/ObjStm) holding the page tree is expanded and resolved', () => {
    const r = extractPdfText(buildObjStmPdf(`BT /F1 12 Tf 72 720 Td (compressed tree page) Tj ET`))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('compressed tree page')
    expect(r.pages).toBe(1)
  })

  it('multi-page PDF: page order follows the /Kids order and pages is /Count', () => {
    const r = extractPdfText(TWO_PAGE_PDF)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('Karioke Hardware')
    expect(r.text.indexOf('Invoice #0042')).toBeLessThan(r.text.indexOf('page two text'))
    expect(r.pages).toBe(2)
  })

  it('damaged PDF (xref + trailer stripped) still extracts via the file-order fallback', () => {
    const damaged = TWO_PAGE_PDF.subarray(0, TWO_PAGE_PDF.length - 160)
    const r = extractPdfText(damaged)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('Karioke Hardware')
    expect(r.text).toContain('page two text')
  })

  it('an empty text layer (scanned/image-only PDF) is ok:true with empty text — the caller words the error', () => {
    const r = extractPdfText(buildPdf([`BT /F1 12 Tf 72 720 Td ET`]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('')
    expect(r.pages).toBe(1)
  })
})

describe('pdf-text — honest failure modes (never a throw, never a fake)', () => {
  it('not a PDF', () => {
    const r = extractPdfText(Buffer.from('hello world, definitely not a pdf'))
    expect(r).toEqual({ ok: false, reason: 'not a PDF (no %PDF- header)' })
  })

  it('empty input', () => {
    expect(extractPdfText(Buffer.alloc(0))).toEqual({ ok: false, reason: 'empty input' })
  })

  it('oversized input is refused before any parsing (cap mirrors the 8 MB upload limit)', () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.5\n', 'latin1'), Buffer.alloc(PDF_MAX_INPUT_BYTES + 1, 1)])
    const r = extractPdfText(big)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('extraction cap')
  })

  it('header garbage with no objects → malformed, not empty text', () => {
    const junk = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(2000, 7)])
    expect(extractPdfText(junk)).toEqual({ ok: false, reason: 'no readable objects (malformed PDF)' })
  })

  it('encrypted PDFs are refused up front, never half-read', () => {
    const encrypted = Buffer.from(
      buildPdf([INVOICE_PAGE]).toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R'),
      'latin1',
    )
    const r = extractPdfText(encrypted)
    expect(r).toEqual({ ok: false, reason: 'encrypted PDFs are not supported' })
  })

  it('fuzz: binary junk with a forged header never throws and always reports a reason', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const buf = Buffer.alloc(3000)
      for (let i = 0; i < buf.length; i++) buf[i] = (seed * 31 + i * 7) % 256
      buf.write('%PDF-1.4', 0, 'latin1')
      const r = extractPdfText(buf)
      if (r.ok) {
        expect(typeof r.text).toBe('string') // junk that parses yields SOME string, fine
        expect(r.text.length).toBeLessThanOrEqual(PDF_MAX_TEXT_CHARS)
      } else {
        expect(typeof r.reason).toBe('string')
        expect(r.reason.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('pdf-text — caps mirror the route contract', () => {
  it('extracted text is capped at the ocrTextHint limit (100,000 chars)', () => {
    const r = extractPdfText(buildPdf([`BT /F1 12 Tf 72 720 Td (${'A'.repeat(150_000)}) Tj ET`]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text.length).toBe(PDF_MAX_TEXT_CHARS)
  })
})
