/**
 * Recipient-preference gating of the SMS channel (issue #36) —
 * src/backend/modules/notify/service.ts.
 *
 * User.notificationPrefs records per-kind opt-outs as JSON
 * { kind: { inApp: boolean } } (PUT /api/notifications — read-only here).
 * When an SMS attempt carries a userId, notify() consults those prefs FIRST:
 *
 *  · opted-out kind ({ inApp: false })  → NO fetch, row stays 'logged' with
 *    the honest skip reason in deliveryDetail (in-app row always written);
 *  · opted-in / kind not listed / no prefs at all / no userId → the attempt
 *    proceeds exactly as before (DEFAULT FAIL-OPEN — users who never opted
 *    out keep today's behavior);
 *  · lookup failure (db throws / user missing / prefs unreadable) → degrades
 *    to the current behavior with an honest note appended to the detail;
 *  · notify() NEVER throws because of the gate — same never-throw contract
 *    the channel seam already carries.
 *
 * Conventions follow tests/unit/notify-channels.test.ts: in-memory db stub
 * (here extended with a user table + lookup-failure knobs), vi.stubGlobal
 * fetch, NOTIFY_SMS_* env save/restore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    notifications: new Map<string, Record<string, unknown>>(),
    users: new Map<string, { id: string; notificationPrefs: string | null }>(),
    userLookups: 0,
    userError: null as Error | null, // when set, user.findUnique rejects
    reset() {
      state.notifications.clear()
      state.users.clear()
      state.seq = 0
      state.userLookups = 0
      state.userError = null
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
  const user = {
    async findUnique({ where }: { where: { id: string } }) {
      state.userLookups++
      if (state.userError) throw state.userError
      const u = state.users.get(where.id)
      return u ? { ...u } : null
    },
  }
  const db = { notification, user, __state: state }
  return { db }
})

import { db } from '@/backend/lib/db'
import { notify } from '@/backend/modules/notify/service'

const state = (db as unknown as {
  __state: {
    notifications: Map<string, Record<string, unknown>>
    users: Map<string, { id: string; notificationPrefs: string | null }>
    userLookups: number
    userError: Error | null
    reset: () => void
  }
}).__state

const fetchMock = vi.fn()

const ENV_KEYS = ['NOTIFY_SMS_WEBHOOK_URL', 'NOTIFY_SMS_WEBHOOK_TOKEN'] as const
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

const ok = () => new Response('', { status: 200 })

/** Register a recipient user with the given stored prefs JSON. */
function seedUser(id: string, notificationPrefs: string | null): void {
  state.users.set(id, { id, notificationPrefs })
}

describe('pref-disabled → the SMS attempt is gated (no fetch, honest skip)', () => {
  beforeEach(() => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
  })

  it('opted-out kind → fetch NEVER called, row stays logged with the skip reason', async () => {
    seedUser('user-1', JSON.stringify({ milestone: { inApp: false } }))
    fetchMock.mockResolvedValueOnce(ok()) // would succeed — must never be reached
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001', userId: 'user-1' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(row(id).deliveryStatus).toBe('logged')
    expect(row(id).deliveredAt).toBeNull()
    expect(String(row(id).deliveryDetail)).toContain('skipped: recipient preference disables "milestone"')
    expect(String(row(id).deliveryDetail)).toContain('nothing sent')
    // the in-app row is ALWAYS written — prefs gate the channel, not the row
    expect(row(id).title).toBe('Milestone released')
    expect(row(id).kind).toBe('milestone')
    expect(row(id).read).toBe(false)
  })

  it('opted-out kind + NO provider configured → the pref skip reason wins (gate runs first)', async () => {
    seedUser('user-1', JSON.stringify({ milestone: { inApp: false } }))
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001', userId: 'user-1' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(row(id).deliveryStatus).toBe('logged')
    expect(String(row(id).deliveryDetail)).toContain('skipped')
    expect(String(row(id).deliveryDetail)).not.toContain('no provider configured')
  })

  it('opted-out for a DIFFERENT kind → attempt proceeds (the gate is per-kind)', async () => {
    seedUser('user-1', JSON.stringify({ recap: { inApp: false } }))
    fetchMock.mockResolvedValueOnce(ok())
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001', userId: 'user-1' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
  })

  it('default kind ("system") is gated by the "system" pref entry', async () => {
    seedUser('user-1', JSON.stringify({ system: { inApp: false } }))
    const { id } = await notify('proj-1', 'Plain event', 'No kind passed', {
      sms: { to: '+254700000001', userId: 'user-1' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(String(row(id).deliveryDetail)).toContain('"system"')
  })
})

describe('fail-open defaults — users who never opted out keep today\u2019s behavior', () => {
  beforeEach(() => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
  })

  it('user with NO recorded prefs (null) → attempt proceeds, clean detail', async () => {
    seedUser('user-1', null)
    fetchMock.mockResolvedValueOnce(ok())
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001', userId: 'user-1' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
    expect(row(id).deliveryDetail).toBe('SMS gateway accepted') // no note — gate was consulted and allowed
  })

  it('prefs recorded but the kind not listed → attempt proceeds (fail-open per kind)', async () => {
    seedUser('user-1', JSON.stringify({ recap: { inApp: true }, share: { inApp: false } }))
    fetchMock.mockResolvedValueOnce(ok())
    const { id } = await notify('proj-1', 'Delivery received', 'Cement 50 bags', {
      kind: 'delivery.dispatched',
      sms: { to: '+254700000001', userId: 'user-1' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
  })

  it('opted-in kind ({ inApp: true }) → fetch called, real state recorded', async () => {
    seedUser('user-1', JSON.stringify({ milestone: { inApp: true } }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'gw-77' }), { status: 200 }))
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001', userId: 'user-1' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
    expect(String(row(id).deliveryDetail)).toContain('gw-77')
  })

  it('empty prefs object "{}" → attempt proceeds', async () => {
    seedUser('user-1', '{}')
    fetchMock.mockResolvedValueOnce(ok())
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001', userId: 'user-1' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
  })

  it('sms WITHOUT userId → no pref lookup at all (recipient unknown — today\u2019s behavior)', async () => {
    fetchMock.mockResolvedValueOnce(ok())
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(state.userLookups).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveryDetail).toBe('SMS gateway accepted')
  })
})

describe('pref-lookup failures degrade honestly (fail-open + note)', () => {
  beforeEach(() => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
  })

  it('db lookup rejects → attempt proceeds with the honest note appended', async () => {
    state.userError = new Error('db down')
    fetchMock.mockResolvedValueOnce(ok())
    const { id } = await notify('proj-1', 't', 'b', {
      kind: 'milestone',
      sms: { to: '+254700000001', userId: 'user-1' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
    expect(String(row(id).deliveryDetail)).toContain('SMS gateway accepted')
    expect(String(row(id).deliveryDetail)).toContain('recipient preference lookup failed')
    expect(String(row(id).deliveryDetail)).toContain('fail-open')
  })

  it('user row not found → proceeds, notes the recipient was unknown', async () => {
    // 'user-gone' was never seeded → findUnique resolves null
    fetchMock.mockResolvedValueOnce(ok())
    const { id } = await notify('proj-1', 't', 'b', {
      kind: 'milestone',
      sms: { to: '+254700000001', userId: 'user-gone' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
    expect(String(row(id).deliveryDetail)).toContain('recipient user not found')
  })

  it('malformed prefs JSON → proceeds, notes the prefs were unreadable', async () => {
    seedUser('user-1', '{not json')
    fetchMock.mockResolvedValueOnce(ok())
    const { id } = await notify('proj-1', 't', 'b', {
      kind: 'milestone',
      sms: { to: '+254700000001', userId: 'user-1' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
    expect(String(row(id).deliveryDetail)).toContain('recipient preferences unreadable')
  })

  it('lookup failure + failed send → both honest parts land in the detail', async () => {
    state.userError = new Error('db down')
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    const { id } = await notify('proj-1', 'Delivery discrepancy', 'Short by 5 bags', {
      kind: 'delivery.discrepancy',
      sms: { to: '+254700000001', userId: 'user-1' },
    })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(String(row(id).deliveryDetail)).toContain('SMS gateway responded HTTP 500')
    expect(String(row(id).deliveryDetail)).toContain('recipient preference lookup failed')
    expect(row(id).deliveredAt).toBeNull()
  })
})

describe('never-throws + in-app row invariants under the gate', () => {
  beforeEach(() => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
  })

  it('lookup rejects AND fetch rejects → notify() still resolves, row records the failure', async () => {
    state.userError = new Error('db down')
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed http://10.0.0.5:9200/secret-path'))
    const res = await notify('proj-1', 'Budget pace 92%', 'Spend ahead of plan', {
      kind: 'budget.alert',
      sms: { to: '+254700000001', userId: 'user-1' },
    })
    expect(res).toEqual({ id: 'notif_1' }) // resolved, not rejected
    expect(row(res.id).deliveryStatus).toBe('failed')
    expect(String(row(res.id).deliveryDetail)).toContain('SMS gateway unreachable (TypeError)')
    expect(String(row(res.id).deliveryDetail)).not.toContain('10.0.0.5') // leak-free still holds
    expect(row(res.id).title).toBe('Budget pace 92%') // in-app row survived it all
  })

  it('skipped-by-pref row is still a perfectly ordinary in-app notification', async () => {
    seedUser('user-1', JSON.stringify({ 'budget.alert': { inApp: false } }))
    const { id } = await notify('proj-1', 't', 'b', {
      kind: 'budget.alert',
      sms: { to: '+254700000001', userId: 'user-1' },
    })
    expect(row(id).channel).toBe('in_app')
    expect(row(id).deliveryStatus).toBe('logged')
    expect(row(id).read).toBe(false)
    expect(row(id).deliveredAt).toBeNull()
  })
})
