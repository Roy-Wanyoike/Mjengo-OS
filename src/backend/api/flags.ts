import { NextResponse } from 'next/server'
import { route, genericError } from '@/backend/lib/route-kit'
import { FLAG_KEYS, getFlags, setFlag, type FlagKey } from '@/backend/modules/intel/flags'

// Feature-flag toggles (spec §81) — src/app/api/flags/route.ts is the shim.
//
// GET returns the current flag map; POST { key, enabled } persists one
// toggle. POST is admin only (the header popover is the single writer); GET
// is admin + contractor — the owner-app roles whose UI surfaces the flags
// popover. (W-BACKEND 4c: GET was previously open to every signed-in role
// while the popover is an owner surface — qs/finance/procurement/client
// sessions now get 403, matching the UI instead of oversharing.)
//
// Body validation is deliberately loose ('throw' mode): the historical
// contract answers with the flag-specific 400 messages below, not zod copy.

export const GET = route(
  {
    scope: 'api/flags GET',
    roles: ['admin', 'contractor'],
    onError: genericError(500, 'Could not read flags'),
  },
  async () => {
    return NextResponse.json({ ok: true, flags: await getFlags(), keys: FLAG_KEYS })
  },
)

export const POST = route(
  {
    scope: 'api/flags POST',
    roles: ['admin'],
    // Rate limit (S-SEC): 10 toggles/min — admin-only mutation, but flags gate
    // product behavior for everyone.
    rateLimit: { bucket: 'flags.post', limit: 10, windowMs: 60_000 },
    body: { onParseError: 'throw' },
    onError: genericError(500, 'Could not save flag'),
  },
  async (_req, _session, body) => {
    const { key, enabled } = body as { key?: string; enabled?: boolean }
    if (typeof key !== 'string' || !(FLAG_KEYS as readonly string[]).includes(key)) {
      return NextResponse.json(
        { error: `Unknown flag key — expected one of ${FLAG_KEYS.join(', ')}` },
        { status: 400 },
      )
    }
    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
    }
    const flags = await setFlag(key as FlagKey, enabled)
    return NextResponse.json({ ok: true, key, enabled, flags })
  },
)
