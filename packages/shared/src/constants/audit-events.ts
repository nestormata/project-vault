export const AuditEvent = {
  USER_REGISTERED: 'USER_REGISTERED',
  SESSION_CREATED: 'SESSION_CREATED',
  LOGIN_FAILED: 'LOGIN_FAILED',
} as const

export type AuthAuditEventType = (typeof AuditEvent)[keyof typeof AuditEvent]

export type AuditEventType =
  | AuthAuditEventType
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
