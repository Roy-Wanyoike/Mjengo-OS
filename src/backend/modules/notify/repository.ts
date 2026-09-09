// Notifications module — data access.
//
// loadNotifySlice(projectId) loads the project's recent notifications +
// unread count. The project payload already carries `notifications` (take 60);
// this loader exists for the notify service and any notification-center
// endpoint added later (kinds, filters, mark-read are actions, not queries).

import { db } from '@/backend/lib/db'
import type { NotifySlice } from './types'

export async function loadNotifySlice(projectId: string): Promise<NotifySlice> {
  const [notifications, unreadCount] = await Promise.all([
    db.notification.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    db.notification.count({ where: { projectId, read: false } }),
  ])
  return { notifications, unreadCount }
}
