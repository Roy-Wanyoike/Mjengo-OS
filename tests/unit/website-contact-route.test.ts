/**
 * Website contact endpoint — rate limiting + retention cap (issue #131 /
 * audit WD-1). The marketing site's lead funnel is POST /api/contact
 * (both /contact and /signup submit there), and this file pins the two
 * layers introduced by the issue against the REAL route module:
 *
 *  · Default posture (TRUST_PROXY unset): the client-spoofable
 *    x-forwarded-for header is IGNORED for keying — all traffic shares ONE
 *    bucket — but that bucket is capped at the 200/hour GLOBAL backstop,
 *    not the old 5/hour, so a launch burst (many leads, one burst, even
 *    rotating spoofed XFF values) no longer 429s every visitor after five.
 *  · Per-visitor posture (TRUST_PROXY set, one appending proxy in front):
 *    5/hour keyed on the LAST x-forwarded-for entry (the proxy's view of
 *    the client — the main app's rate-limit.ts TRUST_PROXY pattern), so a
 *    spamming IP is limited alone while other visitors keep submitting,
 *    and seeding extra client-side XFF values cannot rotate the key.
 *  · Global backstop in BOTH postures: the 201st submission inside the
 *    hour is rejected with reason "rate_limited_global", an honest
 *    busy-message, and a visible console.warn (visible operability —
 *    `docker compose logs website`).
 *  · Retention cap: writing the 501st submission to a pre-seeded
 *    500-entry data/submissions.json evicts the OLDEST entry, keeps the
 *    store at 500, and logs the eviction warning with the count.
 *
 * Plus quick regression pins of the untouched hardening (MW-10 / PR #91):
 * same-site origin gate, honeypot, and the signup-role server validation.
 *
 * The route module is re-imported per test (vi.resetModules) so the
 * module-level REQUESTS map starts cold, and process.cwd() is moved to a
 * fresh temp dir so the real fs writes land in an isolated
 * data/submissions.json (no fs mocking — the persistence path runs for real).
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ROUTE_URL = 'http://localhost:3001/api/contact'

const VALID_SIGNUP = {
  source: 'signup',
  name: 'Amina Wanjiru',
  email: 'amina@example.com',
  role: 'Contractor',
}

let cwd: string
let tmp: string

beforeEach(async () => {
  vi.resetModules()
  delete process.env.TRUST_PROXY
  cwd = process.cwd()
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mjengo-contact-'))
  process.chdir(tmp)
})

afterEach(async () => {
  process.chdir(cwd)
  await fsp.rm(tmp, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function post(payload: Record<string, unknown>, xff?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (xff) headers['x-forwarded-for'] = xff
  return import('../../mjengoos-website/app/api/contact/route').then((route) =>
    route.POST(new Request(ROUTE_URL, { method: 'POST', headers, body: JSON.stringify(payload) })),
  )
}

async function readSubmissions(): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await fsp.readFile(path.join(tmp, 'data', 'submissions.json'), 'utf8'))
}

describe('website contact route — default posture (TRUST_PROXY unset)', () => {
  it('a burst of six submissions (the old killer) is fully accepted', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await post(VALID_SIGNUP)
      expect(res.status, `submission ${i + 1}`).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true })
    }
  })

  it('ignores x-forwarded-for for keying — rotating spoofed values share the one bucket', async () => {
    // Ten "different visitors" (distinct XFF values) — all must pass, and
    // none of them may get a private bucket: they all count toward the
    // same shared/global window.
    for (let i = 1; i <= 10; i++) {
      const res = await post(VALID_SIGNUP, `198.51.100.${i}`)
      expect(res.status).toBe(200)
    }
  })

  it('fails closed at the 200/hour global backstop with a distinguishable reason + warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 200; i++) {
      const res = await post(VALID_SIGNUP, `198.51.100.${(i % 250) + 1}`) // rotating XFF must NOT evade
      expect(res.status, `submission ${i + 1}`).toBe(200)
    }
    const res = await post(VALID_SIGNUP)
    expect(res.status).toBe(429)
    const json = (await res.json()) as { ok: boolean; reason: string; error: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toBe('rate_limited_global')
    expect(json.error).not.toContain('from this address') // honest busy message, not a blame
    // Visible operability: one warning, saying keying is OFF and how to turn it on.
    const msgs = warn.mock.calls.map((c) => c.join(' '))
    expect(msgs.some((m) => m.includes('global submission cap reached (200/hour)'))).toBe(true)
    expect(msgs.some((m) => m.includes('TRUST_PROXY unset'))).toBe(true)
  })
})

describe('website contact route — per-visitor posture (TRUST_PROXY set)', () => {
  beforeEach(() => {
    vi.stubEnv('TRUST_PROXY', '1')
  })

  it('limits only the offending visitor: 5 pass, the 6th 429s, a different IP still passes', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await post(VALID_SIGNUP, '203.0.113.10')
      expect(res.status, `submission ${i + 1}`).toBe(200)
    }
    const sixth = await post(VALID_SIGNUP, '203.0.113.10')
    expect(sixth.status).toBe(429)
    const json = (await sixth.json()) as { ok: boolean; reason: string }
    expect(json.reason).toBe('rate_limited_visitor')

    const other = await post(VALID_SIGNUP, '198.51.100.7')
    expect(other.status).toBe(200) // fresh bucket — the denial is per-visitor
  })

  it('keys on the LAST (proxy-appended) x-forwarded-for entry — client-seeded values cannot rotate the key', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await post(VALID_SIGNUP, `spoof-${i}.example, 203.0.113.10`)
      expect(res.status).toBe(200)
    }
    // Same proxy-appended client IP, differently "spoofed" prefix → same bucket.
    const res = await post(VALID_SIGNUP, 'totally-different-spoof, 203.0.113.10')
    expect(res.status).toBe(429)
    expect(((await res.json()) as { reason: string }).reason).toBe('rate_limited_visitor')
  })

  it('requests without any x-forwarded-for share the "anon" bucket at 5/hour', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post(VALID_SIGNUP)).status).toBe(200)
    }
    const sixth = await post(VALID_SIGNUP)
    expect(sixth.status).toBe(429)
    expect(((await sixth.json()) as { reason: string }).reason).toBe('rate_limited_visitor')
  })

  it('the global backstop still binds across distinct visitors, with the keying-ON warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 1; i <= 200; i++) {
      const res = await post(VALID_SIGNUP, `203.0.113.${i}`) // 200 distinct visitors, one hit each
      expect(res.status, `visitor ${i}`).toBe(200)
    }
    const flood = await post(VALID_SIGNUP, '203.0.113.999') // a brand-new IP — per-visitor bucket is fresh…
    expect(flood.status).toBe(429) // …but the global ceiling is tripped
    expect(((await flood.json()) as { reason: string }).reason).toBe('rate_limited_global')
    const msgs = warn.mock.calls.map((c) => c.join(' '))
    expect(msgs.some((m) => m.includes('per-visitor keying is ON'))).toBe(true)
  })
})

describe('website contact route — retention cap (500 entries)', () => {
  it('the 501st submission evicts the oldest entry AND logs the eviction warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await fsp.mkdir(path.join(tmp, 'data'), { recursive: true })
    const seed = Array.from({ length: 500 }, (_, i) => ({
      id: `sub_seed_${i}`,
      ts: new Date(Date.now() - (500 - i) * 1000).toISOString(),
      source: 'contact',
      name: `Seed ${i}`,
      email: `seed${i}@example.com`,
    }))
    await fsp.writeFile(path.join(tmp, 'data', 'submissions.json'), JSON.stringify(seed), 'utf8')

    const res = await post({ ...VALID_SIGNUP, source: 'contact', message: 'A perfectly valid message.' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; id: string }

    const stored = await readSubmissions()
    expect(stored).toHaveLength(500) // capped, not growing
    expect(stored.find((s) => s.id === 'sub_seed_0')).toBeUndefined() // oldest evicted…
    expect(stored.find((s) => s.id === 'sub_seed_1')).toBeDefined() // …only the oldest
    expect(stored[stored.length - 1].id).toBe(json.id) // newest is ours
    const msgs = warn.mock.calls.map((c) => c.join(' '))
    expect(msgs.some((m) => m.includes('submission cap reached') && m.includes('dropping 1 oldest'))).toBe(true)
  })

  it('warns on EVERY eviction when a burst writes past the cap (498 seeded + 5 = 3 lost)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await fsp.mkdir(path.join(tmp, 'data'), { recursive: true })
    // 498 on disk + a 5-submission signup burst: writes 1-2 fill to 500,
    // writes 3-5 each evict one more oldest entry — 3 leads lost, and each
    // loss gets its own warning line (count 1 per write: one submission per
    // POST means the cap is breached one entry at a time).
    const seed = Array.from({ length: 498 }, (_, i) => ({
      id: `sub_seed_${i}`,
      ts: new Date(Date.now() - (498 - i) * 1000).toISOString(),
      source: 'contact',
      name: `Seed ${i}`,
      email: `seed${i}@example.com`,
    }))
    await fsp.writeFile(path.join(tmp, 'data', 'submissions.json'), JSON.stringify(seed), 'utf8')
    for (let i = 0; i < 5; i++) {
      expect((await post(VALID_SIGNUP)).status).toBe(200)
    }
    const stored = await readSubmissions()
    expect(stored).toHaveLength(500)
    expect(stored.find((s) => s.id === 'sub_seed_0')).toBeUndefined()
    expect(stored.find((s) => s.id === 'sub_seed_2')).toBeUndefined()
    expect(stored.find((s) => s.id === 'sub_seed_3')).toBeDefined()
    const evictionWarnings = warn.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('submission cap reached'))
    expect(evictionWarnings).toHaveLength(3)
    expect(evictionWarnings.every((m) => m.includes('dropping 1 oldest entry'))).toBe(true)
  })
})

describe('website contact route — untouched hardening stays pinned (MW-10 / PR #91)', () => {
  it('rejects cross-site origins (403) but allows absent Origin/Referer (curl/tests)', async () => {
    const { POST } = await import('../../mjengoos-website/app/api/contact/route')
    const cross = await POST(
      new Request(ROUTE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify(VALID_SIGNUP),
      }),
    )
    expect(cross.status).toBe(403)
  })

  it('rejects a filled honeypot field (400)', async () => {
    const res = await post({ ...VALID_SIGNUP, companyWebsite: 'https://spam.example' })
    expect(res.status).toBe(400)
  })

  it('signup without a role stays a server-side 400 field error', async () => {
    const res = await post({ ...VALID_SIGNUP, role: '' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { errors: Record<string, string> }).errors.role).toContain('role')
  })

  it('contact without a message stays a server-side 400 field error', async () => {
    const res = await post({ ...VALID_SIGNUP, source: 'contact', role: '', message: 'short' })
    expect(res.status).toBe(400)
    const { errors } = (await res.json()) as { errors: Record<string, string> }
    expect(errors.message).toBeDefined()
  })
})
