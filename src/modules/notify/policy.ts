// Notifications module — role permissions.
//
// Working rules:
//   everyone (incl. share clients) · view notifications addressed to their role
//   everyone with a project surface · mark own notifications read (client
//                                     allowlist covers share clients; signed-in
//                                     users go through /api/notifications)
//   contractor / admin              · trigger digest/risk events (notify.emit
//                                     is a server-side concern, listed for
//                                     completeness)
//
// Scoping: notifications are per-project. A share client sees the project's
// notifications via the share-scoped payload — the same rows, no extra data.

export type NotifyRole = 'contractor' | 'supervisor' | 'client' | 'finance' | 'admin' | 'share_client'
export type NotifyAction = 'notification.view' | 'notification.read' | 'notification.readAll' | 'notify.emit'

const MATRIX: Record<NotifyRole, NotifyAction[]> = {
  contractor: ['notification.view', 'notification.read', 'notification.readAll', 'notify.emit'],
  admin: ['notification.view', 'notification.read', 'notification.readAll', 'notify.emit'],
  supervisor: ['notification.view', 'notification.read', 'notification.readAll'],
  client: ['notification.view', 'notification.read', 'notification.readAll'],
  finance: ['notification.view', 'notification.read', 'notification.readAll'],
  share_client: ['notification.view', 'notification.read', 'notification.readAll'],
}

/** Role permission matrix — implemented per the rules above. */
export function notifyCan(role: NotifyRole, action: NotifyAction): boolean {
  return MATRIX[role]?.includes(action) ?? false
}
