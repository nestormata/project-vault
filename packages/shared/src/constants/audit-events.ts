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
  CREDENTIAL_BULK_IMPORT_INITIATED: 'credential.bulk_import_initiated',
  CREDENTIAL_BULK_IMPORT_CONFIRMED: 'credential.bulk_import_confirmed',
  ONBOARDING_COMPLETED: 'onboarding.completed',
  CREDENTIAL_SEARCH: 'credential.search',
  PROJECT_INVITATION_CREATED: 'project.invitation_created',
  PROJECT_INVITATION_ACCEPTED: 'project.invitation_accepted',
  PROJECT_INVITATION_REVOKED: 'project.invitation_revoked',
  ORG_USER_REMOVED: 'org.user_removed',
  PROJECT_MEMBER_ROLE_CHANGED: 'project.member_role_changed',
  PROJECT_MEMBER_REMOVED: 'project.member_removed',
  PROJECT_OWNERSHIP_TRANSFERRED: 'project.ownership_transferred',
  PROJECT_ARCHIVED: 'project.archived',
  PROJECT_UNARCHIVED: 'project.unarchived',
  ORG_USER_DEACTIVATED: 'org.user_deactivated',
  ACCOUNT_RECOVERY_REQUESTED: 'auth.recovery_requested',
  ACCOUNT_RECOVERY_LINK_SENT: 'auth.recovery_link_sent',
  ACCOUNT_RECOVERY_COMPLETED: 'auth.recovery_completed',
  ACCOUNT_RECOVERY_BLOCKED: 'auth.recovery_blocked_no_admin',
  ROTATION_INITIATED: 'rotation.initiated',
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
  | 'credential.bulk_import_initiated'
  | 'credential.bulk_import_confirmed'
  | 'onboarding.completed'
  | 'credential.search'
  | 'project.invitation_created'
  | 'project.invitation_accepted'
  | 'project.invitation_revoked'
  | 'org.user_removed'
  | 'project.member_role_changed'
  | 'project.member_removed'
  | 'project.ownership_transferred'
  | 'project.archived'
  | 'project.unarchived'
  | 'org.user_deactivated'
  | 'auth.recovery_requested'
  | 'auth.recovery_link_sent'
  | 'auth.recovery_completed'
  | 'auth.recovery_blocked_no_admin'
  | 'rotation.initiated'

export type AuditEvent = {
  type: AuditEventType
  actorId: string
  orgId: string
  resourceId?: string
  metadata?: Record<string, unknown>
  timestamp: string
}
