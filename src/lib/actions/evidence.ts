// Evidence & transparency actions — photo comments, site-map zones, notifications.
// Dispatched from lib/mjengo.ts; every success is auto-audited into the Bias-Free Ledger.

import { db } from '@/lib/db'

export const EVIDENCE_ACTIONS = [
  'comment.add', // { photoId, author, role: 'client'|'contractor'|'foreman', message }
  'comment.resolve', // { id }
  'zone.create', // { name, x, y, w?, h? } (percent coords 0-100)
  'zone.delete', // { id }
  'notification.read', // { id }
  'notification.readAll', // {}
  'photo.zone', // { id, zoneId | null } — tag/untag a photo to a zone
] as const

const COMMENT_ROLES = ['client', 'contractor', 'foreman']

const clampPct = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.max(0, Math.min(100, n))
}

export async function applyEvidenceAction(type: string, payload: any, projectId: string): Promise<any> {
  switch (type) {
    // ---------- Contextual photo commenting ----------
    case 'comment.add': {
      const { photoId, author, role, message } = payload ?? {}
      const text = typeof message === 'string' ? message.trim() : ''
      if (!photoId) throw new Error('photoId required')
      if (!text) throw new Error('Comment message cannot be empty')
      if (!COMMENT_ROLES.includes(role)) throw new Error(`role must be one of: ${COMMENT_ROLES.join(', ')}`)
      const photo = await db.sitePhoto.findUnique({ where: { id: String(photoId) } })
      if (!photo || photo.projectId !== projectId) throw new Error('Photo not found in this project')
      const comment = await db.photoComment.create({
        data: {
          photoId: photo.id,
          projectId,
          author: (typeof author === 'string' && author.trim()) || 'Anonymous',
          role,
          message: text,
        },
      })
      // Client questions ping the site team
      if (role === 'client') {
        await db.notification.create({
          data: {
            projectId,
            kind: 'comment',
            title: 'Client question on a site photo',
            body: text.slice(0, 120),
            channel: 'in_app',
            recipient: 'Site team',
          },
        })
      }
      return { id: comment.id }
    }

    case 'comment.resolve': {
      const { id } = payload ?? {}
      if (!id) throw new Error('comment id required')
      const existing = await db.photoComment.findUnique({ where: { id: String(id) } })
      if (!existing || existing.projectId !== projectId) throw new Error('Comment not found in this project')
      if (existing.resolved) return { id: existing.id } // already resolved — no-op
      const comment = await db.photoComment.update({ where: { id: existing.id }, data: { resolved: true } })
      return { id: comment.id }
    }

    // ---------- Interactive site map zones ----------
    case 'zone.create': {
      const { name, x, y, w, h } = payload ?? {}
      const zoneName = typeof name === 'string' ? name.trim() : ''
      if (!zoneName) throw new Error('Zone name required')
      if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error('x (number, percent) required')
      if (typeof y !== 'number' || !Number.isFinite(y)) throw new Error('y (number, percent) required')
      // SQLite lacks mode:'insensitive' — manual case-insensitive duplicate check
      const allZones = await db.siteZone.findMany({ where: { projectId }, select: { name: true } })
      if (allZones.some((z) => z.name.toLowerCase() === zoneName.toLowerCase())) {
        throw new Error(`Zone "${zoneName}" already exists on this site map`)
      }
      const zone = await db.siteZone.create({
        data: {
          projectId,
          name: zoneName,
          x: clampPct(x, 10),
          y: clampPct(y, 10),
          w: clampPct(w, 20),
          h: clampPct(h, 14),
        },
      })
      return { id: zone.id }
    }

    case 'zone.delete': {
      const { id } = payload ?? {}
      if (!id) throw new Error('zone id required')
      const zone = await db.siteZone.findUnique({ where: { id: String(id) } })
      if (!zone || zone.projectId !== projectId) throw new Error('Zone not found in this project')
      // Untag photos that point at this zone (SitePhoto.zoneId has no FK cascade)
      await db.sitePhoto.updateMany({ where: { zoneId: zone.id }, data: { zoneId: null } })
      await db.siteZone.delete({ where: { id: zone.id } })
      return { id: zone.id }
    }

    // ---------- Notification center ----------
    case 'notification.read': {
      const { id } = payload ?? {}
      if (!id) throw new Error('notification id required')
      const notification = await db.notification.update({ where: { id: String(id) }, data: { read: true } })
      return { id: notification.id }
    }

    case 'notification.readAll': {
      const result = await db.notification.updateMany({
        where: { projectId, read: false },
        data: { read: true },
      })
      return { count: result.count }
    }

    // ---------- Photo → zone tagging ----------
    case 'photo.zone': {
      const { id, zoneId } = payload ?? {}
      if (!id) throw new Error('photo id required')
      const photo = await db.sitePhoto.findUnique({ where: { id: String(id) } })
      if (!photo || photo.projectId !== projectId) throw new Error('Photo not found in this project')
      if (zoneId === null || zoneId === undefined || zoneId === '') {
        const updated = await db.sitePhoto.update({ where: { id: photo.id }, data: { zoneId: null } })
        return { id: updated.id }
      }
      const zone = await db.siteZone.findUnique({ where: { id: String(zoneId) } })
      if (!zone || zone.projectId !== projectId) throw new Error('Zone not found in this project')
      const updated = await db.sitePhoto.update({ where: { id: photo.id }, data: { zoneId: zone.id } })
      return { id: updated.id }
    }

    default:
      throw new Error(`Unknown evidence action: ${type}`)
  }
}
