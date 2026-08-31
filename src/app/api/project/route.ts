import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getProjectPayload } from '@/lib/mjengo'
import { getSessionFromReq, unauthorized } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * Owner project payload. Requires a session; a VALID ?share=<token> is also
 * accepted so share-link components that hit this route keep working with no login.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromReq(req)
    if (!session) {
      const share = req.nextUrl.searchParams.get('share')
      if (!share) return unauthorized()
      const project = share
        ? await db.project.findUnique({ where: { shareToken: share } })
        : null
      if (!project) return unauthorized()
    }
    const projectId = req.nextUrl.searchParams.get('projectId')
    const payload = await getProjectPayload(projectId)
    if (!payload) {
      return NextResponse.json({ error: projectId ? 'Project not found' : 'No project found' }, { status: 404 })
    }
    return NextResponse.json(payload)
  } catch (e) {
    console.error('[api/project]', e)
    return NextResponse.json({ error: 'Failed to load project' }, { status: 500 })
  }
}
