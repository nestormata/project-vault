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
  PROJECT_TAGS_UPDATED: 'project.tags_updated',
  CREDENTIAL_CREATED: 'credential.created',
  CREDENTIAL_VERSION_CREATED: 'credential.version_created',
  CREDENTIAL_VALUE_REVEALED: 'credential.value_revealed',
  CREDENTIAL_VERSION_PURGED: 'credential.version_purged',
  CREDENTIAL_TAGS_UPDATED: 'credential.tags_updated',
  CREDENTIAL_DEPENDENCY_ADDED: 'credential.dependency_added',
  CREDENTIAL_DEPENDENCY_ARCHIVED: 'credential.dependency_archived',
  CREDENTIAL_LIFECYCLE_UPDATED: 'credential.lifecycle_updated',
} as const

export type AuthAuditEventType = (typeof AuditEvent)[keyof typeof AuditEvent]

export type AuditEventType =
  | AuthAuditEventType
  | 'user.login'
  | 'user.logout'
  | 'project.created'
  | 'project.updated'
  | 'project.tags_updated'
  | 'credential.created'
  | 'credential.version_created'
  | 'credential.value_revealed'
  | 'credential.version_purged'
  | 'credential.tags_updated'
  | 'credential.dependency_added'
  | 'credential.dependency_archived'
  | 'credential.lifecycle_updated'

export type AuditEvent = {
  type: AuditEventType
  actorId: string
  orgId: string
  resourceId?: string
  metadata?: Record<string, unknown>
  timestamp: string
}
