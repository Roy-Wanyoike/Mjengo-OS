// Notifications module — role permissions (stub, agent 2-e implements).
//
// Working rules:
//   everyone (incl. share clients) · view notifications addressed to their role
//   client / share client           · mark own notifications read (already
//                                     allowlisted: notification.read/readAll)
//   contractor / admin              · mark read; trigger digest/risk events
//
// Scoping: notifications are per-project. A share client sees the project's
// notifications via the share-scoped payload — the same rows, no extra data.

export type NotifyRole = 'contractor' | 'supervisor' | 'client' | 'finance' | 'admin' | 'share_client'
export type NotifyAction = 'notification.view' | 'notification.read' | 'notification.readAll' | 'notify.emit'

/** Role permission matrix — stub, agent 2-e implements the real checks. */
export function notifyCan(_role: NotifyRole, _action: NotifyAction): boolean {
  return false // deny-by-default until phase 2 implements the matrix
}
