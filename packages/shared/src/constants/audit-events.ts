export const AuditEvent = {
  USER_REGISTERED: 'USER_REGISTERED',
  SESSION_CREATED: 'SESSION_CREATED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  MFA_ENROLLMENT_STARTED: 'MFA_ENROLLMENT_STARTED',
  MFA_ENROLLED: 'MFA_ENROLLED',
  MFA_LOGIN_VERIFIED: 'MFA_LOGIN_VERIFIED',
  MFA_RECOVERY_USED: 'MFA_RECOVERY_USED',
  MFA_RECOVERY_CODES_REGENERATED: 'MFA_RECOVERY_CODES_REGENERATED',
  SECURITY_FAILED_AUTH_THRESHOLD: 'security.failed_auth_threshold',
  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
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
  | 'project.created'
  | 'project.updated'

export type AuditEvent = {
  type: AuditEventType
  actorId: string
  orgId: string
  resourceId?: string
  metadata?: Record<string, unknown>
  timestamp: string
}
