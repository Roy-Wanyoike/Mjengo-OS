/**
 * Notification channel invariants (src/backend/modules/notify/{channels,service}.ts).
 *
 * notify() writes an honest in-app row first; a real SMS delivery is only
 * attempted when the caller passes opts.sms AND a provider is configured —
 * the webhook (NOTIFY_SMS_WEBHOOK_URL, precedence FIRST) or the Africa's
 * Talking pair (AT_API_KEY + AT_USERNAME; partial pair = null, fail-closed).
 * This file swaps @/backend/lib/db for a tiny in-memory stub and global
 * fetch for a vi.fn(), then pins:
 *  · no provider env → fetch NEVER called, row stays 'logged' (fail-closed);
 *  · webhook + AT both set → the webhook wins (backwards compatible);
 *  · provider + 2xx → row 'sent', deliveredAt stamped, ref + honest detail
 *    (webhook { id } body; AT SMSMessageData.Recipients[0].messageId);
 *  · provider + non-2xx → row 'failed' with the HTTP status in the detail;
 *  · fetch throws / times out → row 'failed', never thrown into the caller,
 *    and the detail leaks nothing (error class only — no URLs, no keys);
 *  · request shapes: webhook JSON { to, text, metadata } with a bearer
 *    header ONLY when a token is set; AT form-urlencoded
 *    { username, to, message, from? } with the apiKey header — both with
 *    an 8s AbortSignal;
 *  · markDelivered() records deliveryDetail without stamping deliveredAt
 *    unless the status is 'sent' (the seam providers report through).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub: just enough of db.notification for notify() +
// markDelivered(). __state exposes the table for assertions.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    notifications: new Map<string, Record<string, unknown>>(),
    reset() {
      state.notifications.clear()
      state.seq = 0
    },
  }
  const notification = {
    async create({ data }: { data: Record<string, unknown> }) {
      const row: Record<string, unknown> = {
        id: `notif_${++state.seq}`,
        read: false,
        readAt: null,
        deliveredAt: null,
        deliveryDetail: null,
        ...data,
      }
      state.notifications.set(row.id as string, row)
      return { ...row }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const row = state.notifications.get(where.id)
      if (!row) throw new Error(`stub: notification ${where.id} not found`)
      Object.assign(row, data)
      return { ...row }
    },
  }
  const db = { notification, __state: state }
  return { db }
})

import { db } from '@/backend/lib/db'
import { AtSmsProvider, getSmsProvider, WebhookSmsProvider } from '@/backend/modules/notify/channels'
import { markDelivered, notify } from '@/backend/modules/notify/service'

const state = (db as unknown as { __state: ReturnType<typeof getState> }).__state
function getState() {
  return undefined as unknown as {
    notifications: Map<string, Record<string, unknown>>
    reset: () => void
  }
}

const fetchMock = vi.fn()

const ENV_KEYS = [
  'NOTIFY_SMS_WEBHOOK_URL',
  'NOTIFY_SMS_WEBHOOK_TOKEN',
  'AT_API_KEY',
  'AT_USERNAME',
  'AT_SENDER_ID',
  'AT_ENV',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  state.reset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.unstubAllGlobals()
})

const row = (id: string) => state.notifications.get(id) as Record<string, unknown>

const ok = (body = '') => new Response(body, { status: 200 })

/** A 2xx Africa's Talking response body, the real REST shape. */
const atOk = (messageId?: string) =>
  new Response(
    JSON.stringify({
      SMSMessageData: {
        Recipients: messageId ? [{ messageId, number: '+254700000001', status: 'Success', statusCode: 101 }] : [],
        Message: 'Sent to 1/1 Total Cost: KES 0.80',
      },
    }),
    { status: 200 },
  )

describe('getSmsProvider — env resolution is fail-closed', () => {
  it('returns null when NOTIFY_SMS_WEBHOOK_URL is unset', () => {
    expect(getSmsProvider({})).toBeNull()
    expect(getSmsProvider()).toBeNull() // live env was scrubbed in beforeEach
  })

  it('returns null for a blank/whitespace-only URL', () => {
    expect(getSmsProvider({ NOTIFY_SMS_WEBHOOK_URL: '   ' })).toBeNull()
    expect(getSmsProvider({ NOTIFY_SMS_WEBHOOK_URL: '' })).toBeNull()
  })

  it('returns the WebhookSmsProvider when the URL is set', () => {
    const p = getSmsProvider({ NOTIFY_SMS_WEBHOOK_URL: 'https://sms.example/send' })
    expect(p).toBeInstanceOf(WebhookSmsProvider)
    expect(p?.id).toBe('webhook-sms')
    expect(p?.label).toBeTruthy()
  })
})

describe('notify() with no provider configured — default behavior unchanged', () => {
  it('no env + sms requested → fetch never called, row stays logged, honest skip note', async () => {
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(row(id).deliveryStatus).toBe('logged')
    expect(row(id).deliveredAt).toBeNull()
    expect(String(row(id).deliveryDetail)).toContain('no provider configured')
    expect(String(row(id).deliveryDetail)).toContain('nothing sent')
  })

  it('no env + no sms opt → row is exactly as today (logged, no detail, no fetch)', async () => {
    const { id } = await notify('proj-1', 'Delivery received', 'Cement 50 bags', { kind: 'delivery.dispatched' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(row(id).deliveryStatus).toBe('logged')
    expect(row(id).deliveryDetail).toBeNull()
    expect(row(id).deliveredAt).toBeNull()
    expect(row(id).channel).toBe('in_app')
  })

  it('provider configured + no sms opt → SMS is opt-in: fetch never called', async () => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
    await notify('proj-1', 'Recap', 'Day 47 — 37% complete', { kind: 'recap' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('notify() with provider configured — honest send outcomes', () => {
  beforeEach(() => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
  })

  it('2xx with an { id } body → sent, deliveredAt stamped, ref in detail', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'gw-42' }), { status: 200 }))
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
    expect(String(row(id).deliveryDetail)).toContain('accepted')
    expect(String(row(id).deliveryDetail)).toContain('gw-42')
    // in-app row semantics unchanged by the SMS attempt
    expect(row(id).title).toBe('Milestone released')
    expect(row(id).kind).toBe('milestone')
  })

  it('2xx with empty body → sent, plain accepted detail', async () => {
    fetchMock.mockResolvedValueOnce(ok())
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveryDetail).toBe('SMS gateway accepted')
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
  })

  it('2xx with a providerRef key → recorded as the ref', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ providerRef: 'AT-9981' }), { status: 200 }))
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(row(id).deliveryStatus).toBe('sent')
    expect(String(row(id).deliveryDetail)).toContain('AT-9981')
  })

  it('non-2xx (500) → failed with the HTTP status, no deliveredAt, row intact', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    const { id } = await notify('proj-1', 'Delivery discrepancy', 'Short by 5 bags', {
      kind: 'delivery.discrepancy',
      sms: { to: '+254700000001' },
    })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveryDetail).toBe('SMS gateway responded HTTP 500')
    expect(row(id).deliveredAt).toBeNull()
    expect(row(id).title).toBe('Delivery discrepancy') // in-app row survived
  })

  it('fetch throws (network) → failed, never throws into the caller, no URL leak', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed http://10.0.0.5:9200/secret-path'))
    const res = await notify('proj-1', 'Budget pace 92%', 'Spend ahead of plan', {
      kind: 'budget.alert',
      sms: { to: '+254700000001' },
    })
    expect(res).toEqual({ id: 'notif_1' }) // resolved, not rejected
    expect(row(res.id).deliveryStatus).toBe('failed')
    expect(row(res.id).deliveryDetail).toBe('SMS gateway unreachable (TypeError)')
    expect(String(row(res.id).deliveryDetail)).not.toContain('10.0.0.5')
    expect(String(row(res.id).deliveryDetail)).not.toContain('secret-path')
  })

  it('fetch times out (TimeoutError DOMException) → failed with honest timeout detail', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveryDetail).toBe('SMS gateway timed out after 8s')
  })
})

describe('provider request shape (the webhook contract)', () => {
  it('POSTs { to, text: title + \\n\\n + body, metadata } with bearer token when set', async () => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
    process.env.NOTIFY_SMS_WEBHOOK_TOKEN = 'tok-123'
    fetchMock.mockResolvedValueOnce(ok())
    await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254712345678' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://sms.example/send')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers.authorization).toBe('Bearer tok-123')
    expect(JSON.parse(init.body as string)).toEqual({
      to: '+254712345678',
      text: 'Milestone released\n\nKSh 1.2M released',
      metadata: { projectId: 'proj-1', kind: 'milestone' },
    })
    expect(init.signal).toBeInstanceOf(AbortSignal) // 8s timeout cap travels with the call
  })

  it('no token → no authorization header at all', async () => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
    fetchMock.mockResolvedValueOnce(ok())
    await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(init.headers.authorization).toBeUndefined()
    expect(init.headers['content-type']).toBe('application/json')
  })
})

describe('markDelivered — the seam providers report through', () => {
  it('failed + detail → records the detail, never stamps deliveredAt', async () => {
    const { id } = await notify('proj-1', 't', 'b', {})
    await markDelivered(id, 'failed', 'SMS gateway responded HTTP 502')
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveryDetail).toBe('SMS gateway responded HTTP 502')
    expect(row(id).deliveredAt).toBeNull()
  })

  it('sent without detail → stamps deliveredAt and leaves the existing detail alone', async () => {
    const { id } = await notify('proj-1', 't', 'b', {})
    await markDelivered(id, 'failed', 'SMS gateway responded HTTP 502')
    const out = await markDelivered(id, 'sent')
    expect(out).toEqual({ id, deliveryStatus: 'sent', deliveryDetail: 'SMS gateway responded HTTP 502' })
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
    expect(row(id).deliveryDetail).toBe('SMS gateway responded HTTP 502')
  })

  it('unknown id → null (row gone — same honest swallow as before)', async () => {
    expect(await markDelivered('gone', 'sent', 'detail')).toBeNull()
  })
})

describe("getSmsProvider — Africa's Talking resolution (webhook keeps precedence)", () => {
  it('AT pair set, no webhook → the AtSmsProvider', () => {
    const p = getSmsProvider({ AT_API_KEY: 'at-key', AT_USERNAME: 'mjengo' })
    expect(p).toBeInstanceOf(AtSmsProvider)
    expect(p?.id).toBe('at-sms')
    expect(p?.label).toBeTruthy()
  })

  it('PARTIAL AT pair → null (fail-closed: never a provider that 401s on every send)', () => {
    expect(getSmsProvider({ AT_API_KEY: 'at-key' })).toBeNull()
    expect(getSmsProvider({ AT_USERNAME: 'mjengo' })).toBeNull()
    expect(getSmsProvider({ AT_API_KEY: '   ', AT_USERNAME: 'mjengo' })).toBeNull()
    expect(getSmsProvider({ AT_API_KEY: 'at-key', AT_USERNAME: '' })).toBeNull()
  })

  it('webhook + AT both set → webhook wins (backwards compatible, resolution level)', () => {
    const p = getSmsProvider({
      NOTIFY_SMS_WEBHOOK_URL: 'https://sms.example/send',
      AT_API_KEY: 'at-key',
      AT_USERNAME: 'mjengo',
    })
    expect(p).toBeInstanceOf(WebhookSmsProvider)
    expect(p?.id).toBe('webhook-sms')
  })

  it('webhook + AT both set → the WEBHOOK receives the call (notify() end-to-end)', async () => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
    process.env.AT_API_KEY = 'at-key'
    process.env.AT_USERNAME = 'mjengo'
    fetchMock.mockResolvedValueOnce(ok())
    await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://sms.example/send') // NOT the AT endpoint
    expect(init.headers['content-type']).toBe('application/json') // the webhook JSON contract
  })
})

describe("notify() with the AT provider configured — honest send outcomes", () => {
  beforeEach(() => {
    process.env.AT_API_KEY = 'at-key-123'
    process.env.AT_USERNAME = 'mjengo'
  })

  it("2xx with SMSMessageData.Recipients[0].messageId → sent, deliveredAt stamped, ref in detail", async () => {
    fetchMock.mockResolvedValueOnce(atOk('ATXid_1abc23'))
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
    expect(String(row(id).deliveryDetail)).toContain('accepted')
    expect(String(row(id).deliveryDetail)).toContain('ATXid_1abc23')
    // in-app row semantics unchanged by the SMS attempt
    expect(row(id).title).toBe('Milestone released')
    expect(row(id).kind).toBe('milestone')
  })

  it("provider-level: send() returns the messageId as providerRef (the seam result shape)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          SMSMessageData: {
            Recipients: [{ messageId: 'ATXid_9zyx87', number: '+254700000001', status: 'Success', statusCode: 101 }],
            Message: 'Sent to 1/1 Total Cost: KES 0.80',
          },
        }),
        { status: 200 },
      ),
    )
    const provider = getSmsProvider()
    expect(provider).toBeInstanceOf(AtSmsProvider)
    const result = await provider!.send({
      to: '+254700000001',
      title: 'Milestone released',
      body: 'KSh 1.2M released',
      projectId: 'proj-1',
      kind: 'milestone',
    })
    expect(result).toEqual({
      ok: true,
      status: 'sent',
      providerRef: 'ATXid_9zyx87',
      detail: "Africa's Talking accepted (messageId ATXid_9zyx87)",
    })
  })

  it('2xx with an empty/odd body → still sent, no ref (best-effort capture)', async () => {
    fetchMock.mockResolvedValueOnce(ok(''))
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveryDetail).toBe("Africa's Talking accepted")
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
  })

  it('non-2xx (401) → failed with status-only detail — body never echoed, row intact', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ statusCode: 401, status: 'InvalidApiKey' }] } }), {
        status: 401,
      }),
    )
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001' },
    })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveryDetail).toBe("Africa's Talking responded HTTP 401")
    expect(row(id).deliveredAt).toBeNull()
    expect(String(row(id).deliveryDetail)).not.toContain('InvalidApiKey') // no body content
    expect(String(row(id).deliveryDetail)).not.toContain('at-key-123') // no credential material
    expect(row(id).title).toBe('Milestone released') // in-app row survived
  })

  it('non-2xx (500) → failed with status-only detail', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveryDetail).toBe("Africa's Talking responded HTTP 500")
  })

  it('fetch throws (network) → failed, error class only — no key, no host in the detail', async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError('fetch failed https://api.africaistalking.com/version1/messaging key=at-key-123'),
    )
    const res = await notify('proj-1', 'Budget pace 92%', 'Spend ahead of plan', {
      kind: 'budget.alert',
      sms: { to: '+254700000001' },
    })
    expect(res).toEqual({ id: 'notif_1' }) // resolved, not rejected
    expect(row(res.id).deliveryStatus).toBe('failed')
    expect(row(res.id).deliveryDetail).toBe("Africa's Talking unreachable (TypeError)")
    expect(String(row(res.id).deliveryDetail)).not.toContain('at-key-123')
    expect(String(row(res.id).deliveryDetail)).not.toContain('africaistalking.com')
  })

  it('fetch times out (TimeoutError DOMException) → failed with honest timeout detail', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveryDetail).toBe("Africa's Talking timed out after 8s")
  })

  it("send() never throws into notify() — the in-app row survives EVERY failure mode", async () => {
    const arms = [
      () => fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 })),
      () => fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')),
      () => fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'TimeoutError')),
      () => fetchMock.mockRejectedValueOnce('not even an Error object'),
    ]
    let seq = 0
    for (const arm of arms) {
      arm()
      const res = await notify('proj-1', 'Row survives', 'every failure', {
        kind: 'milestone',
        sms: { to: '+254700000001' },
      })
      const r = row(res.id)
      expect(res.id).toBe(`notif_${++seq}`) // notify() resolved and created the row
      expect(r.title).toBe('Row survives')
      expect(r.deliveryStatus).toBe('failed') // every arm above is a failure mode
      expect(r.deliveredAt).toBeNull()
    }
  })
})

describe("AT provider request shape (the real AT REST contract)", () => {
  beforeEach(() => {
    process.env.AT_API_KEY = 'at-key-123'
    process.env.AT_USERNAME = 'mjengo'
  })

  it('POSTs form-urlencoded username/to/message with the apiKey header to the AT endpoint', async () => {
    fetchMock.mockResolvedValueOnce(atOk())
    await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254712345678' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://api.africaistalking.com/version1/messaging')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(init.headers.apikey).toBe('at-key-123') // AT's auth header
    const form = new URLSearchParams(init.body as string)
    expect(form.get('username')).toBe('mjengo')
    expect(form.get('to')).toBe('+254712345678')
    expect(form.get('message')).toBe('Milestone released\n\nKSh 1.2M released')
    expect(form.get('from')).toBeNull() // no AT_SENDER_ID → no from field at all
    expect(init.signal).toBeInstanceOf(AbortSignal) // 8s timeout cap travels with the call
  })

  it('AT_SENDER_ID set → the from field carries it', async () => {
    process.env.AT_SENDER_ID = 'MJENGOS'
    fetchMock.mockResolvedValueOnce(atOk())
    await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const form = new URLSearchParams(init.body as string)
    expect(form.get('from')).toBe('MJENGOS')
  })

  it('AT_ENV=sandbox → the sandbox host is used (credential testing without billing)', async () => {
    process.env.AT_ENV = 'sandbox'
    fetchMock.mockResolvedValueOnce(atOk())
    await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.sandbox.africaistalking.com/version1/messaging')
  })
})
