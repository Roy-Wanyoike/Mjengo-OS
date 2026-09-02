import { NextRequest, NextResponse } from 'next/server'
import { withGuard } from '@/backend/lib/guard'
import { enforceRateLimit } from '@/backend/lib/rate-limit'
import { FLAG_KEYS, getFlags, setFlag, type FlagKey } from '@/backend/modules/intel/flags'

// Feature-flag toggles (spec §81). GET returns the current flag map; POST
// { key, enabled } persists one toggle. Admin only — flags are a controlled
// rollout tool, and the header popover is the single writer.

export const dynamic = 'force-dynamic'

export const GET = withGuard(async () => {
  try {
    return NextResponse.json({ ok: true, flags: await getFlags(), keys: FLAG_KEYS })
  } catch (e) {
    console.error('[api/flags GET]', e)
    return NextResponse.json({ error: 'Could not read flags' }, { status: 500 })
  }
})

export const POST = withGuard(
  async (req: NextRequest) => {
    // Rate limit (S-SEC): 10 toggles/min — admin-only mutation, but flags gate
    // product behavior for everyone.
    const limited = await enforceRateLimit(req, 'flags.post', 10, 60_000)
    if (limited) return limited

    try {
      const { key, enabled } = (await req.json()) as { key?: string; enabled?: boolean }
      if (typeof key !== 'string' || !(FLAG_KEYS as readonly string[]).includes(key)) {
        return NextResponse.json({ error: `Unknown flag key — expected one of ${FLAG_KEYS.join(', ')}` }, { status: 400 })
      }
      if (typeof enabled !== 'boolean') {
        return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
      }
      const flags = await setFlag(key as FlagKey, enabled)
      return NextResponse.json({ ok: true, key, enabled, flags })
    } catch (e) {
      console.error('[api/flags POST]', e)
      return NextResponse.json({ error: 'Could not save flag' }, { status: 500 })
    }
  },
  { roles: ['admin'] },
)
