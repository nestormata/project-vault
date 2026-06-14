export type AuditEventType =
  | 'user.login'
  | 'user.logout'
  | 'secret.created'
  | 'secret.read'
  | 'secret.updated'
  | 'secret.deleted'

export type AuditEvent = {
  type: AuditEventType
  actorId: string
  orgId: string
  resourceId?: string
  metadata?: Record<string, unknown>
  timestamp: string
}
