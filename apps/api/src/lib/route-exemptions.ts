export type PublicRouteExemption = {
  route: string
  reason: string
  securityOwner: string
  compensatingControls: string[]
  expiresAfterStory: string | null
  revisitBy?: string
  temporary?: boolean
}

export type RouteActionClassification = {
  action: 'read' | 'sensitive-read' | 'mutation' | 'security-action'
  auditEvent?: string
  sameTransactionAuditService?: string
  auditOmissionReason?: string
  reviewer?: string
}

export type DirectDbAccessClassification = {
  path: string
  classification: 'public-route-support' | 'platform-job' | 'identity-cleanup-job'
  reason: string
  reviewer: string
}

const SECURITY_OWNER = 'api-security-reviewer'
const IP_RATE_LIMIT = 'ip-rate-limit'
const FAILED_AUTH_RECORDING = 'failed-auth-recording'
const SECURITY_ACTION = 'security-action'
const SESSION_REVOKED = 'SESSION_REVOKED'
const IDENTITY_CLEANUP_JOB = 'identity-cleanup-job'
const WRITE_CREDENTIAL_AUDIT_OR_FAIL_CLOSED = 'writeCredentialAuditOrFailClosed'
const PLATFORM_JOB = 'platform-job'

export const PUBLIC_ROUTE_EXEMPTIONS: PublicRouteExemption[] = [
  {
    route: 'GET /health',
    reason:
      'Public liveness endpoint exposes no tenant data and is required for service monitoring.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: ['no-data-access', 'vault-guard-aware-response'],
    expiresAfterStory: null,
  },
  {
    route: 'GET /ready',
    reason:
      'Public readiness endpoint exposes no tenant data and is required for orchestration checks.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: ['no-data-access', 'vault-guard-aware-response'],
    expiresAfterStory: null,
  },
  {
    route: 'GET /metrics',
    reason:
      'Public metrics endpoint exposes operational counters only and is controlled by deployment binding.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: ['operational-only-data', 'metrics-bind-host'],
    expiresAfterStory: null,
  },
  {
    route: 'POST /api/v1/auth/register',
    reason: 'Public account bootstrap endpoint; guarded by input validation and IP rate limiting.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: [IP_RATE_LIMIT, 'input-validation', 'registration-toggle'],
    expiresAfterStory: null,
  },
  {
    route: 'POST /api/v1/auth/login',
    reason:
      'Public credential exchange endpoint; guarded by failed-auth recording and rate limits.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: [IP_RATE_LIMIT, FAILED_AUTH_RECORDING, 'generic-auth-errors'],
    expiresAfterStory: null,
  },
  {
    route: 'POST /api/v1/auth/refresh',
    reason:
      'Public refresh-token exchange endpoint; validates opaque refresh cookie before renewal.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: ['refresh-token-validation', 'cookie-only-token', IP_RATE_LIMIT],
    expiresAfterStory: null,
  },
  {
    route: 'POST /api/v1/auth/mfa/recover',
    reason: 'Public MFA recovery exchange endpoint; guarded by IP and email-specific rate limits.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: [IP_RATE_LIMIT, 'email-rate-limit', FAILED_AUTH_RECORDING],
    expiresAfterStory: null,
  },
  {
    route: 'POST /api/v1/auth/mfa/verify-login',
    reason:
      'Public MFA second-factor endpoint; validates a short-lived hashed pending login token before issuing a session.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: [IP_RATE_LIMIT, 'pending-token-attempt-cap', FAILED_AUTH_RECORDING],
    expiresAfterStory: null,
  },
  {
    route: 'POST /api/v1/vault/init',
    reason: 'Vault bootstrap endpoint exists before user authentication is available.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: ['vault-guard', 'remote-init-policy', 'request-size-limit'],
    expiresAfterStory: null,
  },
  {
    route: 'POST /api/v1/vault/unseal',
    reason: 'Vault unseal endpoint must be available while the auth stack is sealed.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: ['vault-guard', IP_RATE_LIMIT, 'structured-redaction'],
    expiresAfterStory: null,
  },
]

export const HELPER_ROUTE_REGISTRATION_CLASSIFICATIONS = {
  secureRoute: 'secure',
  publicRoute: 'public-exempt',
  registerMethodNotAllowed: 'shell-only',
} as const

export const ROUTE_ACTION_CLASSIFICATIONS: Record<string, RouteActionClassification> = {
  'GET /api/v1/auth/me': {
    action: 'read',
    auditOmissionReason: 'Self auth-context read does not expose secrets or change state.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/auth/mfa/enroll': {
    action: SECURITY_ACTION,
    auditEvent: 'MFA_ENROLLMENT_STARTED',
    sameTransactionAuditService: 'enrollMfa',
  },
  'POST /api/v1/auth/mfa/verify-enrollment': {
    action: SECURITY_ACTION,
    auditEvent: 'MFA_ENROLLED',
    sameTransactionAuditService: 'verifyEnrollment',
  },
  'POST /api/v1/auth/mfa/regenerate-recovery-codes': {
    action: SECURITY_ACTION,
    auditEvent: 'MFA_RECOVERY_CODES_REGENERATED',
    sameTransactionAuditService: 'regenerateRecoveryCodes',
  },
  'GET /api/v1/auth/sessions': {
    action: 'read',
    auditOmissionReason: 'Session list read is non-mutating and scoped to the current account.',
    reviewer: SECURITY_OWNER,
  },
  'DELETE /api/v1/auth/sessions': {
    action: SECURITY_ACTION,
    auditEvent: SESSION_REVOKED,
    sameTransactionAuditService: 'revokeAllOtherSessions',
  },
  'DELETE /api/v1/auth/sessions/:sessionId': {
    action: SECURITY_ACTION,
    auditEvent: SESSION_REVOKED,
    sameTransactionAuditService: 'revokeSessionById',
  },
  'POST /api/v1/auth/logout': {
    action: SECURITY_ACTION,
    auditEvent: SESSION_REVOKED,
    sameTransactionAuditService: 'revokeSessionById',
  },
  'GET /api/v1/org/security-alerts': {
    action: 'read',
    auditOmissionReason:
      'Security alert list read is admin-scoped and does not reveal secret values.',
    reviewer: SECURITY_OWNER,
  },
  'DELETE /api/v1/org/users/:userId/sessions': {
    action: SECURITY_ACTION,
    auditEvent: SESSION_REVOKED,
    sameTransactionAuditService: 'revokeAllUserSessionsInOrg',
  },
  'POST /api/v1/projects': {
    action: 'mutation',
    auditEvent: 'project.created',
    sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
  },
  'GET /api/v1/projects': {
    action: 'read',
    auditOmissionReason: 'Project list read is org-scoped and does not reveal secret values.',
    reviewer: SECURITY_OWNER,
  },
  'GET /api/v1/projects/:projectId/dashboard': {
    action: 'read',
    auditOmissionReason: 'Dashboard read is org-scoped and returns only aggregate counts.',
    reviewer: SECURITY_OWNER,
  },
  'PATCH /api/v1/projects/:projectId': {
    action: 'mutation',
    auditEvent: 'project.updated',
    sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
  },
  'PUT /api/v1/projects/:projectId/tags': {
    action: 'mutation',
    auditEvent: 'project.tags_updated',
    sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
  },
  'POST /api/v1/projects/:projectId/credentials': {
    action: 'mutation',
    auditEvent: 'credential.created',
    sameTransactionAuditService: WRITE_CREDENTIAL_AUDIT_OR_FAIL_CLOSED,
  },
  'GET /api/v1/projects/:projectId/credentials': {
    action: 'read',
    auditOmissionReason:
      'Credential list/search returns metadata only; never any credential value (RS-E2a).',
    reviewer: SECURITY_OWNER,
  },
  'PUT /api/v1/projects/:projectId/credentials/:credentialId/tags': {
    action: 'mutation',
    auditEvent: 'credential.tags_updated',
    sameTransactionAuditService: WRITE_CREDENTIAL_AUDIT_OR_FAIL_CLOSED,
  },
  'PATCH /api/v1/projects/:projectId/credentials/:credentialId/tags': {
    action: 'mutation',
    auditEvent: 'credential.tags_updated',
    sameTransactionAuditService: WRITE_CREDENTIAL_AUDIT_OR_FAIL_CLOSED,
  },
  'POST /api/v1/projects/:projectId/credentials/:credentialId/versions': {
    action: 'mutation',
    auditEvent: 'credential.version_created',
    sameTransactionAuditService: WRITE_CREDENTIAL_AUDIT_OR_FAIL_CLOSED,
  },
  'GET /api/v1/projects/:projectId/credentials/:credentialId/value': {
    action: 'sensitive-read',
    auditEvent: 'credential.value_revealed',
    sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
  },
  'GET /api/v1/projects/:projectId/credentials/:credentialId/versions': {
    action: 'read',
    auditOmissionReason: 'Version history returns metadata only; never any credential value.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/projects/:projectId/credentials/:credentialId/dependencies': {
    action: 'mutation',
    auditEvent: 'credential.dependency_added',
    sameTransactionAuditService: WRITE_CREDENTIAL_AUDIT_OR_FAIL_CLOSED,
  },
  'GET /api/v1/projects/:projectId/credentials/:credentialId/dependencies': {
    action: 'read',
    auditOmissionReason:
      'Dependency list returns non-secret metadata only; never any credential value.',
    reviewer: SECURITY_OWNER,
  },
  'DELETE /api/v1/projects/:projectId/credentials/:credentialId/dependencies/:dependencyId': {
    action: 'mutation',
    auditEvent: 'credential.dependency_archived',
    sameTransactionAuditService: WRITE_CREDENTIAL_AUDIT_OR_FAIL_CLOSED,
  },
  'PATCH /api/v1/projects/:projectId/credentials/:credentialId': {
    action: 'mutation',
    auditEvent: 'credential.lifecycle_updated',
    sameTransactionAuditService: WRITE_CREDENTIAL_AUDIT_OR_FAIL_CLOSED,
  },
  'GET /api/v1/projects/:projectId/credentials/:credentialId/access': {
    action: 'read',
    auditOmissionReason:
      'Access list returns org-role metadata only; never any credential value (ADR-2.4-06).',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/projects/:projectId/credentials/import': {
    action: 'mutation',
    auditEvent: 'credential.bulk_import_initiated',
    sameTransactionAuditService: 'writeImportBatchAudit',
  },
  'POST /api/v1/projects/:projectId/credentials/import/confirm': {
    action: 'mutation',
    auditEvent: 'credential.bulk_import_confirmed',
    sameTransactionAuditService: 'writeImportBatchAudit',
  },
  'GET /api/v1/users/me/onboarding': {
    action: 'read',
    auditOmissionReason:
      'Onboarding status read is scoped to the current user and does not reveal secrets.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/users/me/onboarding': {
    action: 'mutation',
    auditEvent: 'onboarding.completed',
    sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
  },
}

export const DIRECT_DB_ACCESS_CLASSIFICATIONS: DirectDbAccessClassification[] = [
  {
    path: 'modules/auth/routes.ts',
    classification: 'public-route-support',
    reason: 'Public MFA recovery rate-limit buckets are identity/IP scoped and not org-scoped.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/check-failed-auth-threshold.ts',
    classification: PLATFORM_JOB,
    reason: 'Scans platform failed-auth aggregates and uses runOrgScopedJob for alert writes.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/prune-failed-auth-attempts.ts',
    classification: PLATFORM_JOB,
    reason: 'Prunes platform failed-auth attempt rows by retention window.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/prune-credential-versions.ts',
    classification: PLATFORM_JOB,
    reason:
      'Cryptographically purges expired credential versions per org via runOrgScopedJob; org-scoped writes.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/prune-totp-used-codes.ts',
    classification: IDENTITY_CLEANUP_JOB,
    reason: 'Prunes identity-scoped TOTP replay rows; table has no org scope.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/prune-revoked-tokens.ts',
    classification: IDENTITY_CLEANUP_JOB,
    reason: 'Prunes identity-scoped revoked-token rows by expiration.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/prune-mfa-pending.ts',
    classification: IDENTITY_CLEANUP_JOB,
    reason: 'Prunes identity-scoped stale MFA pending-enrollment rows; table has no org scope.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/prune-pending-mfa-sessions.ts',
    classification: IDENTITY_CLEANUP_JOB,
    reason: 'Prunes identity-scoped pending MFA login rows by expiration and attempt cap.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/import-cleanup.ts',
    classification: PLATFORM_JOB,
    reason:
      'Cross-org cleanup of expired pending_imports rows; no credential values are read — only metadata rows are deleted.',
    reviewer: SECURITY_OWNER,
  },
]
