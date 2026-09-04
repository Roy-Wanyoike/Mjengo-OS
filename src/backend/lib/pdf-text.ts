// PDF text-layer extraction (issue #42 — docs-intel without client ocrTextHint).
//
// A compact, ZERO-DEPENDENCY, best-effort PDF text extractor for the
// document-intelligence pipeline (documents/service.ts extractDocument):
// it decodes a PDF's TEXT LAYER and returns plain text that then flows
// through the exact same LLM parse path a client-supplied ocrTextHint
// would. It exists so a PDF upload is no longer a hard error in this
// sandbox — while staying honest about what it can and cannot do.
//
// COVERAGE (deliberate, pinned in tests/unit/pdf-text.test.ts):
//   · Text-layer PDFs with classic OR compressed (xref-stream /
//     object-stream) structures — objects are located by a linear scan of
//     `N G obj` markers (the "damaged PDF" trick) plus /ObjStm expansion,
//     so a broken or missing xref table does not stop extraction.
//   · FlateDecode content streams (node:zlib — the one stdlib dep).
//   · Tj / TJ / ' / " text-showing operators; literal strings with PDF
//     escapes (\( \) \\ \n \r \t \b \f \ooo octal, line continuation),
//     hex strings <...>; BT/ET + Td/TD/T*/Tm emit line breaks.
//   · TJ kern numbers: a displacement <= -100 (thousandths of text space)
//     inserts a space; smaller displacements join without one (heuristic —
//     the same class of guess pdftotext-style tools make).
//
// HONEST LIMITS (no OCR, ever):
//   · Scanned / image-only PDFs have no text layer → ok:true with empty
//     text; the CALLER turns that into its own honest error (the route
//     does). Extracted-anything-else is never faked.
//   · CID/Type0 fonts are decoded as Latin-1 bytes — best-effort only;
//     /ToUnicode CMaps are NOT applied (that needs font-program parsing).
//     Latin-script business paperwork is the target domain.
//   · /Encrypt PDFs are refused up front (reason 'encrypted'), never
//     half-read.
//   · Text inside Form XObjects is only found by the fallback scanner
//     (broken page tree); the ordered page-tree walk reads /Contents
//     streams only. No inline images (BI…EI), LZW or DCTDecode.
//   · Output is capped at PDF_MAX_TEXT_CHARS (mirrors the route's
//     ocrTextHint cap); input at PDF_MAX_INPUT_BYTES (mirrors the
//     document upload cap).
//
// CONTRACT: extractPdfText NEVER throws — every failure mode returns
// { ok: false, reason }. Callers treat ok:true + empty text as "valid
// PDF, nothing to extract". Pure JS + node:zlib → runs in the Next server
// runtime and in vitest unchanged.

import { inflateSync, inflateRawSync } from 'node:zlib'

/** Input cap — mirrors documents/types MAX_DOCUMENT_BYTES (8 MB uploads). */
export const PDF_MAX_INPUT_BYTES = 8 * 1024 * 1024

/** Output cap — mirrors the /api/ai/extract-document ocrTextHint limit. */
export const PDF_MAX_TEXT_CHARS = 100_000

export type PdfTextResult =
  | { ok: true; text: string; pages: number }
  | { ok: false; reason: string }

/** TJ displacement (thousandths of text space) at/below which we emit a space. */
const TJ_SPACE_THRESHOLD = -100

// ---------------------------------------------------------------- object scan

interface RawObject {
  num: number
  gen: number
  /** Object body as Latin-1 text — for streams this is the DICT only. */
  body: string
  /** Raw (still encoded) stream bytes when this object is a stream. */
  stream: Buffer | null
  /** File offset for ordering (object-stream members share the host offset). */
  offset: number
}

/**
 * Locate every `N G obj … endobj` in the raw bytes by linear scan (xref
 * tables are NOT trusted — this also repairs damaged files). Matches that
 * land inside a previous object's stream DATA are skipped: compressed
 * bytes can contain the literal text "obj". Later occurrences win, which
 * is correct for incremental updates that redefine an object later in
 * the file.
 */
function scanObjects(data: Buffer): Map<number, RawObject> {
  const objects = new Map<number, RawObject>()
  const text = data.toString('latin1')
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g
  let lastStreamEnd = -1
  let m: RegExpExecArray | null
  while ((m = objRe.exec(text)) !== null) {
    if (m.index < lastStreamEnd) continue // binary noise inside a stream
    const num = Number(m[1])
    const gen = Number(m[2])
    if (!Number.isFinite(num) || num <= 0) continue
    const bodyStart = m.index + m[0].length

    // A real stream: the dict's '>>' immediately followed by the 'stream'
    // keyword + EOL. Must sit before THIS object's 'endobj' (or the file
    // end for a truncated tail object).
    const endobjAt = text.indexOf('endobj', bodyStart)
    const streamRe = />>\s*stream(?:\r\n|\n|\r)/g
    streamRe.lastIndex = bodyStart
    const sm = streamRe.exec(text)
    const hasStream = sm !== null && (endobjAt < 0 || sm.index < endobjAt)

    if (hasStream && sm) {
      const dict = text.slice(bodyStart, sm.index + 2)
      const dataStart = sm.index + sm[0].length
      let end = text.indexOf('endstream', dataStart)
      if (end < 0) end = data.length
      // Prefer the dict's /Length when it is a direct integer AND it lands
      // on 'endstream' — binary data can contain the literal keyword.
      let usedLength = false
      const lenMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)
      if (lenMatch) {
        const len = Number(lenMatch[1])
        if (dataStart + len <= data.length && /^\s*endstream/.test(text.slice(dataStart + len, dataStart + len + 32))) {
          end = dataStart + len
          usedLength = true
        }
      }
      if (!usedLength) {
        // Keyword-found end: strip the EOL the spec allows before 'endstream'.
        while (end > dataStart && [13, 10, 32, 9, 0].includes(data[end - 1])) end--
      }
      const stream = end > dataStart ? data.subarray(dataStart, end) : Buffer.alloc(0)
      const endstreamAt = text.indexOf('endstream', dataStart)
      lastStreamEnd = Math.max(lastStreamEnd, (endstreamAt < 0 ? data.length : endstreamAt + 9))
      objects.set(num, { num, gen, body: dict, stream, offset: m.index })
    } else {
      const objEnd = endobjAt < 0 ? text.length : endobjAt
      lastStreamEnd = Math.max(lastStreamEnd, objEnd + 6)
      objects.set(num, { num, gen, body: text.slice(bodyStart, objEnd).trim(), stream: null, offset: m.index })
    }
  }
  return objects
}

/**
 * The stream's filter: null (none), 'FlateDecode', or 'Unsupported'
 * (LZW/DCT/ASCII chains beyond plain FlateDecode). Array chains are only
 * decodable when every entry is FlateDecode.
 */
function streamFilter(dict: string): string | null {
  const direct = /\/Filter\s*\/([A-Za-z0-9#]+)/.exec(dict)
  if (direct) return direct[1]
  const arr = /\/Filter\s*\[([^\]]*)\]/.exec(dict)
  if (arr) {
    const names = [...arr[1].matchAll(/\/([A-Za-z0-9#]+)/g)].map((x) => x[1])
    if (names.length === 0) return null
    return names.every((n) => n === 'FlateDecode') ? 'FlateDecode' : 'Unsupported'
  }
  return null
}

/** Decode an object's stream to Latin-1 text; null = undecodable/empty. */
function decodeStream(obj: RawObject): string | null {
  if (!obj.stream || obj.stream.length === 0) return null
  const filter = streamFilter(obj.body)
  if (filter === 'Unsupported') return null
  if (filter === 'FlateDecode') {
    try {
      return inflateSync(obj.stream).toString('latin1')
    } catch {
      try {
        return inflateRawSync(obj.stream).toString('latin1') // raw-deflate oddballs
      } catch {
        return null
      }
    }
  }
  return obj.stream.toString('latin1')
}

/**
 * Expand /Type /ObjStm object streams (PDF 1.5+): payload = `N pairs of
 * (objnum offset)` then the embedded objects' bodies. Members are
 * registered in the map so page-tree refs that point INTO a compressed
 * object stream resolve. A member only replaces an existing scan hit
 * from an EARLIER offset (the ObjStm region is the newer revision).
 */
function expandObjectStreams(objects: Map<number, RawObject>): void {
  for (const outer of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm\b/.test(outer.body)) continue
    const decoded = decodeStream(outer)
    if (!decoded) continue
    const n = Number(/\/N\s+(\d+)/.exec(outer.body)?.[1] ?? 0)
    const first = Number(/\/First\s+(\d+)/.exec(outer.body)?.[1] ?? 0)
    if (!n || !Number.isFinite(first) || first < 0) continue
    const pairs: number[] = []
    const headerRe = /\d+/g
    let hm: RegExpExecArray | null
    while (pairs.length < n * 2 && (hm = headerRe.exec(decoded)) !== null && hm.index < first) {
      pairs.push(Number(hm[0]))
    }
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const num = pairs[i]
      const off = pairs[i + 1]
      const start = first + off
      const end = i + 2 < pairs.length ? first + pairs[i + 2] : decoded.length
      if (num <= 0 || start < 0 || end <= start || end > decoded.length) continue
      const existing = objects.get(num)
      if (!existing || existing.offset <= outer.offset) {
        objects.set(num, { num, gen: 0, body: decoded.slice(start, end).trim(), stream: null, offset: outer.offset })
      }
    }
    // The ObjStm container itself is never a text source.
    outer.stream = null
  }
}

/** Stream objects that are never page content (metadata, xref, fonts…). */
function isNonContentStream(obj: RawObject): boolean {
  return (
    /\/Type\s*\/(ObjStm|XRef|Metadata|OutputIntent|Font|FontDescriptor|FontFile\d*|Encoding|ExtGState|Pattern|Shading|ColorSpace|Pages|Page|Catalog)\b/.test(
      obj.body,
    ) || /\/Subtype\s*\/(Image|Type1|Type0|CIDFontType0|CIDFontType2)\b/.test(obj.body)
  )
}

// ---------------------------------------------------------------- text extraction

/**
 * Extract shown text from ONE decoded content stream. Token walk:
 * strings (literal + hex) accumulate; numbers only matter inside TJ
 * arrays; dict/name/other tokens are skipped; the text operators flush:
 *   Tj → last string;  TJ → last array (kern <= -100 → space);
 *   ' and " → line break + last string;  Td / TD / T-star / Tm / ET → line break.
 */
function extractTextFromContent(content: string): string {
  const out: string[] = []
  let lastString: string | null = null
  let lastArray: Array<string | number> | null = null
  let arrayItems: Array<string | number> | null = null

  const emit = (s: string): void => {
    if (s) out.push(s)
  }
  const emitNewline = (): void => {
    if (out.length && !out[out.length - 1].endsWith('\n')) out.push('\n')
  }

  let i = 0
  const iMax = content.length
  while (i < iMax) {
    const c = content[i]
    if (c === '%') {
      while (i < iMax && content[i] !== '\n' && content[i] !== '\r') i++
      continue
    }
    if (c === '(') {
      const s = parseLiteralString(content, i)
      lastString = s.value
      if (arrayItems) arrayItems.push(s.value)
      i = s.end
      continue
    }
    if (c === '<') {
      if (content[i + 1] === '<') {
        i = skipDict(content, i)
        continue
      }
      const s = parseHexString(content, i)
      lastString = s.value
      if (arrayItems) arrayItems.push(s.value)
      i = s.end
      continue
    }
    if (c === '[') {
      arrayItems = []
      i++
      continue
    }
    if (c === ']') {
      if (arrayItems) lastArray = arrayItems
      arrayItems = null
      i++
      continue
    }
    if (c === '/' || c === '{' || c === '}') {
      i++
      continue
    }
    if (c === '-' || (c >= '0' && c <= '9') || (c === '.' && (content[i + 1] ?? '') >= '0' && (content[i + 1] ?? '') <= '9')) {
      const num = readNumber(content, i)
      if (arrayItems && num.ok) arrayItems.push(num.value)
      i = num.end
      continue
    }
    if (/[A-Za-z'"*]/.test(c)) {
      const word = readWord(content, i)
      switch (word.value) {
        case 'TJ':
          if (lastArray) emit(joinTjArray(lastArray))
          lastArray = null
          break
        case 'Tj':
          if (lastString !== null) emit(lastString)
          lastString = null
          break
        case "'":
        case '"':
          emitNewline()
          if (lastString !== null) emit(lastString)
          lastString = null
          break
        case 'Td':
        case 'TD':
        case 'T*':
        case 'Tm':
        case 'ET':
          emitNewline()
          break
        default:
          break // Tf, cm, gs, q, Q, w, … — no text effect
      }
      i = word.end
      continue
    }
    i++ // whitespace / '>' / other delimiters
  }
  return out.join('')
}

/** `(…)` literal string with PDF escapes → value + index after ')'. */
function parseLiteralString(s: string, start: number): { value: string; end: number } {
  const bytes: number[] = []
  let i = start + 1
  let depth = 1
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      const n = s[i + 1]
      if (n === 'n') { bytes.push(10); i += 2; continue }
      if (n === 'r') { bytes.push(13); i += 2; continue }
      if (n === 't') { bytes.push(9); i += 2; continue }
      if (n === 'b') { bytes.push(8); i += 2; continue }
      if (n === 'f') { bytes.push(12); i += 2; continue }
      if (n === '(') { bytes.push(40); i += 2; continue }
      if (n === ')') { bytes.push(41); i += 2; continue }
      if (n === '\\') { bytes.push(92); i += 2; continue }
      if (n === '\r') { i += 2; if (s[i] === '\n') i++; continue } // line continuation
      if (n === '\n') { i += 2; continue }
      if (n >= '0' && n <= '7') {
        let oct = ''
        let j = i + 1
        while (j < s.length && oct.length < 3 && s[j] >= '0' && s[j] <= '7') {
          oct += s[j]
          j++
        }
        bytes.push(parseInt(oct, 8) & 0xff)
        i = j
        continue
      }
      bytes.push((n ? n.charCodeAt(0) : 0) & 0xff)
      i += 2
      continue
    }
    if (c === '(') { depth++; bytes.push(40); i++; continue }
    if (c === ')') {
      depth--
      if (depth === 0) return { value: Buffer.from(bytes).toString('latin1'), end: i + 1 }
      bytes.push(41)
      i++
      continue
    }
    bytes.push(c.charCodeAt(0) & 0xff)
    i++
  }
  // Unterminated string — take what we have (never throw).
  return { value: Buffer.from(bytes).toString('latin1'), end: i }
}

/** `<hex>` string → bytes (odd digit count pads with 0, per the spec). */
function parseHexString(s: string, start: number): { value: string; end: number } {
  let hex = ''
  let i = start + 1
  while (i < s.length && s[i] !== '>') {
    const c = s[i]
    if (/[0-9a-fA-F]/.test(c)) hex += c
    i++
  }
  if (hex.length % 2 === 1) hex += '0'
  const value = hex ? Buffer.from(hex, 'hex').toString('latin1') : ''
  return { value, end: i < s.length ? i + 1 : i }
}

/** Skip a balanced `<< … >>` dict (content streams embed resource dicts). */
function skipDict(s: string, start: number): number {
  let depth = 0
  let i = start
  while (i < s.length) {
    if (s[i] === '<' && s[i + 1] === '<') { depth++; i += 2; continue }
    if (s[i] === '>') {
      if (s[i + 1] === '>') {
        depth--
        i += 2
        if (depth <= 0) return i
        continue
      }
      i++
      continue
    }
    if (s[i] === '<') {
      // hex string inside the dict — jump past its closing '>'
      const close = s.indexOf('>', i)
      i = close < 0 ? s.length : close + 1
      continue
    }
    if (s[i] === '(') {
      i = parseLiteralString(s, i).end // strings may contain '>>'
      continue
    }
    i++
  }
  return i
}

function readNumber(s: string, start: number): { ok: boolean; value: number; end: number } {
  let i = start
  let sign = ''
  if (s[i] === '-' || s[i] === '+') {
    sign = s[i]
    i++
  }
  let digits = ''
  while (i < s.length && ((s[i] >= '0' && s[i] <= '9') || s[i] === '.')) {
    digits += s[i]
    i++
  }
  const value = Number(sign + digits) // the SIGN is part of the value (TJ kerns are negative)
  return { ok: digits !== '' && digits !== '.' && Number.isFinite(value), value, end: i > start ? i : start + 1 }
}

function readWord(s: string, start: number): { value: string; end: number } {
  let i = start
  while (i < s.length && /[A-Za-z'"*]/.test(s[i])) i++
  return { value: s.slice(start, i), end: i }
}

/** Join a TJ operand array: strings concat; a big-negative kern → space. */
function joinTjArray(items: Array<string | number>): string {
  let text = ''
  for (const item of items) {
    if (typeof item === 'number') {
      if (item <= TJ_SPACE_THRESHOLD && text.length > 0 && !text.endsWith(' ')) text += ' '
    } else {
      text += item
    }
  }
  return text
}

// ---------------------------------------------------------------- page tree

/** Resolve the object numbers a dict key references (direct or array). */
function refsIn(body: string, key: string): number[] {
  const out: number[] = []
  const direct = new RegExp(`\\/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`).exec(body)
  if (direct) out.push(Number(direct[1]))
  const arr = new RegExp(`\\/${key}\\s*\\[([^\\]]*)\\]`).exec(body)
  if (arr) {
    const refRe = /(\d+)\s+(\d+)\s+R/g
    let am: RegExpExecArray | null
    while ((am = refRe.exec(arr[1])) !== null) out.push(Number(am[1]))
  }
  return out
}

/**
 * Walk Root → /Pages → /Kids recursively; returns content-stream object
 * numbers in PAGE ORDER plus the page count. Loop-safe (visited set).
 * Missing or non-page kids are skipped (damaged tree → partial order),
 * but zero pages found → null so the caller can fall back.
 */
function walkPageTree(objects: Map<number, RawObject>, rootNum: number): { contents: number[]; pages: number } | null {
  const visited = new Set<number>()
  const contents: number[] = []
  let pages = 0

  const visitNode = (num: number): void => {
    if (visited.has(num)) return // loop guard
    visited.add(num)
    const obj = objects.get(num)
    if (!obj) return
    const isPages = /\/Type\s*\/Pages\b/.test(obj.body)
    const isPage = /\/Type\s*\/Page\b/.test(obj.body)
    if (isPage) {
      pages++
      for (const c of refsIn(obj.body, 'Contents')) contents.push(c)
      return
    }
    if (isPages) {
      for (const kid of refsIn(obj.body, 'Kids')) visitNode(kid)
    }
  }

  const root = objects.get(rootNum)
  if (!root) return null
  const pagesRef = refsIn(root.body, 'Pages')[0]
  if (!pagesRef) return null
  const pagesObj = objects.get(pagesRef)
  if (!pagesObj || !/\/Type\s*\/Pages\b/.test(pagesObj.body)) return null
  visitNode(pagesRef)
  if (pages === 0) return null
  const count = Number(/\/Count\s+(\d+)/.exec(pagesObj.body)?.[1] ?? 0)
  return { contents, pages: count > 0 ? count : pages }
}

// ---------------------------------------------------------------- public entry

/**
 * Extract the text layer from PDF bytes. Synchronous, pure, never throws.
 * Strategy: page-tree walk (correct reading order) first; when the tree
 * is unusable, fall back to every decodable content stream in FILE order.
 * `pages` is the best-effort page count (0 when unknown).
 */
export function extractPdfText(input: Buffer | Uint8Array): PdfTextResult {
  try {
    const data = Buffer.isBuffer(input) ? input : Buffer.from(input)
    if (data.length === 0) {
      return { ok: false, reason: 'empty input' }
    }
    if (data.length > PDF_MAX_INPUT_BYTES) {
      return { ok: false, reason: `PDF exceeds the ${PDF_MAX_INPUT_BYTES} byte extraction cap` }
    }
    const head = data.subarray(0, Math.min(1024, data.length)).toString('latin1')
    if (head.indexOf('%PDF-') < 0) {
      return { ok: false, reason: 'not a PDF (no %PDF- header)' }
    }

    const objects = scanObjects(data)
    if (objects.size === 0) {
      return { ok: false, reason: 'no readable objects (malformed PDF)' }
    }
    expandObjectStreams(objects)

    // Encrypted? Classic trailer dict or any xref-stream object dict.
    // Reading ciphered strings would yield noise — refuse up front.
    const fullText = data.toString('latin1')
    const lastTrailerAt = fullText.lastIndexOf('trailer')
    const trailerSlice = lastTrailerAt >= 0 ? fullText.slice(lastTrailerAt, lastTrailerAt + 2048) : ''
    const encryptRe = /\/Encrypt\s+\d+\s+\d+\s+R/
    if (encryptRe.test(trailerSlice)) {
      return { ok: false, reason: 'encrypted PDFs are not supported' }
    }
    for (const obj of objects.values()) {
      if (/\/Type\s*\/XRef\b/.test(obj.body) && encryptRe.test(obj.body)) {
        return { ok: false, reason: 'encrypted PDFs are not supported' }
      }
    }

    // Reading order: the LAST /Root in the file wins (incremental updates).
    const rootRe = /\/Root\s+(\d+)\s+(\d+)\s+R/g
    let rootNum = -1
    let rm: RegExpExecArray | null
    while ((rm = rootRe.exec(fullText)) !== null) rootNum = Number(rm[1])

    let text = ''
    let pages = 0
    let fellBack = true
    if (rootNum > 0) {
      const walk = walkPageTree(objects, rootNum)
      if (walk) {
        const chunks: string[] = []
        for (const num of walk.contents) {
          const obj = objects.get(num)
          if (!obj) continue
          const decoded = decodeStream(obj)
          if (decoded === null) continue
          chunks.push(extractTextFromContent(decoded))
        }
        text = chunks.join('\n')
        pages = walk.pages
        fellBack = false
      }
    }
    if (fellBack) {
      // Broken/missing page tree: sweep every decodable content stream in
      // file order (xref/metadata/object-stream/image dicts excluded).
      const ordered = [...objects.values()].sort((a, b) => a.offset - b.offset)
      const chunks: string[] = []
      let contentStreams = 0
      for (const obj of ordered) {
        if (obj.stream === null || obj.stream.length === 0 || isNonContentStream(obj)) continue
        const decoded = decodeStream(obj)
        if (decoded === null) continue
        const chunk = extractTextFromContent(decoded)
        if (chunk.trim()) contentStreams++
        chunks.push(chunk)
      }
      text = chunks.join('\n')
      const pageHits = fullText.match(/\/Type\s*\/Page\b/g)?.length ?? 0
      pages = pageHits > 0 ? pageHits : contentStreams
    }

    const cleaned = text.replace(/\n{3,}/g, '\n\n').trim()
    return {
      ok: true,
      text: cleaned.length > PDF_MAX_TEXT_CHARS ? cleaned.slice(0, PDF_MAX_TEXT_CHARS) : cleaned,
      pages,
    }
  } catch (e) {
    // Never throw into a route — degrade to an honest reason.
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: `unexpected parser failure: ${msg.slice(0, 200)}` }
  }
}
