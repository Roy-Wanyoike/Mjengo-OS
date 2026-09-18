/**
 * OpenAPI cross-check (issue #165 / audit API-14 + §3) — the audit's MANUAL
 * "documented ⇔ implemented" verification, promoted to a CI invariant.
 *
 * ADR 0008 (docs/adr/0008-openapi-scope.md) records the scope decision: the
 * document covers the v1 family + three enumerated app reads; the app
 * mutation surface (actions/sync), the webapp-private reads and the external
 * gateways stay documented at their seams. What made that an HONEST close
 * rather than an omission is this file — the drift-by-silence risk the issue
 * named is only dead if "both sides are enumerated" is enforced by a test,
 * the way the audit had to do it by hand.
 *
 * Three invariants, all direction-aware:
 *   1. documented ⇒ implemented — every doc path maps to a real App Router
 *      route file exporting every documented method (no documented-but-missing);
 *   2. implemented ⇒ documented — every /api/v1 route file + exported HTTP
 *      method appears in the doc (no v1-implemented-but-undocumented). The
 *      reverse check is deliberately v1-ONLY: the other families are
 *      undocumented BY DESIGN (ADR 0008's pointer table), so a disk-walk there
 *      would contradict the decision it exists to enforce;
 *   3. the scope pin — the doc's path set is exactly the disk-walked v1
 *      family + the three ADR-enumerated app reads. Adding any other app path
 *      to the doc requires updating this pin (and the ADR) in the same PR —
 *      the "conscious update, never silent drift" rule.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GET as openapiGet } from '@/app/api/openapi.json/route'

const API_ROOT = fileURLToPath(new URL('../../src/app/api', import.meta.url))
const ADR_PATH = fileURLToPath(new URL('../../docs/adr/0008-openapi-scope.md', import.meta.url))

// The ADR-0008-enumerated app reads — the only non-v1 paths in the document.
const ADR_APP_READS = ['/api/audit', '/api/reports/budget-variance', '/api/ai/extract-document']

// Every method key OpenAPI 3.1 allows on a Path Item that maps to a route
// handler export (HEAD/OPTIONS are framework-generated, never documented).
const DOC_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const

type PathItem = Record<string, unknown>
type OpenApiDoc = { paths: Record<string, PathItem>; info: { description?: string } }

async function fetchDoc(): Promise<OpenApiDoc> {
  const res = await openapiGet()
  expect(res.status).toBe(200)
  return (await res.json()) as OpenApiDoc
}

// '/api/v1/wallets/{id}' → <apiRoot>/v1/wallets/[id]/route.ts (the App
// Router's directory convention: {param} templates are [param] folders).
function routeFileFor(docPath: string): string {
  return join(API_ROOT, docPath.replace(/^\/api\/?/, '').replace(/\{(\w+)\}/g, '[$1]'), 'route.ts')
}

// Which HTTP methods a route file ACTUALLY serves. Next's route-handler
// contract accepts three export shapes, all in this tree:
//   export async function GET(…)   ·   export const POST = …   ·
//   export { GET, POST } from '…'  ·   export { POSTUnsubscribe as POST } from '…'
// (\b keeps POSTUnsubscribe from matching POST; the aliased `as POST` does.)
function exportedMethods(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  return DOC_METHODS.filter((m) => {
    const M = m.toUpperCase()
    return (
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${M}\\b`).test(src) ||
      new RegExp(`export\\s+const\\s+${M}\\b`).test(src) ||
      new RegExp(`export\\s*\\{[^}]*\\b${M}\\b`).test(src)
    )
  })
}

// Every route file under /api/v1 on disk, as OpenAPI path templates.
function v1PathsOnDisk(): string[] {
  return readdirSync(join(API_ROOT, 'v1'), { recursive: true })
    .filter((f) => f.endsWith('route.ts'))
    .map((f) => '/api/v1/' + f.replace(/\/route\.ts$/, '').replace(/\[(\w+)\]/g, '{$1}'))
    .sort()
}

describe('GET /api/openapi.json — the ADR 0008 cross-check (documented ⇔ implemented)', () => {
  it('documented ⇒ implemented: every doc path maps to a real route file exporting every documented method', async () => {
    const doc = await fetchDoc()
    const docPaths = Object.keys(doc.paths)
    expect(docPaths.length).toBeGreaterThan(0)
    for (const path of docPaths) {
      const file = routeFileFor(path)
      expect(existsSync(file), `${path} is documented but ${file} does not exist`).toBe(true)
      const exported = exportedMethods(file)
      for (const method of Object.keys(doc.paths[path])) {
        expect(DOC_METHODS).toContain(method)
        expect(
          exported,
          `${path} documents ${method.toUpperCase()} but the route file does not export it`,
        ).toContain(method)
      }
    }
  })

  it('implemented ⇒ documented: every /api/v1 route file + exported HTTP method is in the doc (1:1, per method)', async () => {
    const doc = await fetchDoc()
    const onDisk = v1PathsOnDisk()
    expect(onDisk.length).toBe(27) // the ADR 0008 v1 census — a 28th route must join the doc
    for (const path of onDisk) {
      const item = doc.paths[path]
      expect(item, `${path} exists on disk but is missing from the doc (ADR 0008 scope)`).toBeDefined()
      for (const method of exportedMethods(routeFileFor(path))) {
        expect(
          item[method],
          `${path} exports ${method.toUpperCase()} but the doc does not document it`,
        ).toBeDefined()
      }
    }
  })

  it("the scope pin: doc paths == the disk-walked v1 family + exactly the three ADR-enumerated app reads (30 total)", async () => {
    const doc = await fetchDoc()
    expect(Object.keys(doc.paths).sort()).toEqual([...v1PathsOnDisk(), ...ADR_APP_READS].sort())
    // and the three app reads are exactly the non-v1 paths (no v1 path can hide in the pin)
    expect(Object.keys(doc.paths).filter((p) => !p.startsWith('/api/v1')).sort()).toEqual(
      [...ADR_APP_READS].sort(),
    )
  })

  it('info.description records the scope decision and links ADR 0008 — and the ADR exists with the revisit triggers', async () => {
    const doc = await fetchDoc()
    const description = doc.info.description ?? ''
    expect(description).toContain('ADR 0008')
    expect(description).toContain('docs/adr/0008-openapi-scope.md')
    // the ADR itself is in the repo and stays honest: accepted status, the
    // app-read trio it licenses, the API-10 dependency, revisit triggers
    expect(existsSync(ADR_PATH), 'docs/adr/0008-openapi-scope.md must exist (info.description links it)').toBe(true)
    const adr = readFileSync(ADR_PATH, 'utf8')
    expect(adr).toMatch(/Status:\*\* Accepted/)
    for (const read of ADR_APP_READS) expect(adr).toContain(read)
    expect(adr).toContain('API-10')
    expect(adr).toMatch(/## Revisit triggers/)
  })
})
