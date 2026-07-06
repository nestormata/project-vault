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
const WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED = 'writeMonitoringAuditOrFailClosed'
const WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED = 'writeHumanAuditEntryOrFailClosed'
const PLATFORM_JOB = 'platform-job'
const PUBLIC_ROUTE_SUPPORT = 'public-route-support'
const TOKEN_IS_CREDENTIAL = 'token-is-the-credential'
const MONITORING_LIST_READ_OMISSION_REASON =
  'List read returns operational metadata only; no secret values.'

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
    route: 'POST /api/v1/auth/recovery/request',
    reason:
      'Public account recovery request endpoint (org unknown until email resolves); guarded by IP and email-specific rate limits.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: [IP_RATE_LIMIT, 'email-rate-limit', TOKEN_IS_CREDENTIAL],
    expiresAfterStory: null,
  },
  {
    route: 'GET /api/v1/auth/recovery/:token',
    reason:
      'Public, non-mutating recovery-token peek used to route the web UI; reveals only a masked email and MFA-enrolled flag.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: [TOKEN_IS_CREDENTIAL, 'masked-email-response'],
    expiresAfterStory: null,
  },
  {
    route: 'POST /api/v1/auth/recovery/:token/mfa/start',
    reason:
      'Public recovery-token-authenticated MFA re-enrollment start; the 256-bit recovery token is itself the authorization credential.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: [TOKEN_IS_CREDENTIAL, 'pending-token-attempt-cap'],
    expiresAfterStory: null,
  },
  {
    route: 'POST /api/v1/auth/recovery/:token/complete',
    reason:
      'Public account recovery completion endpoint; guarded by an atomic single-use token claim and IP rate limiting.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: [IP_RATE_LIMIT, TOKEN_IS_CREDENTIAL, 'atomic-single-use-claim'],
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
  {
    route: 'POST /api/v1/auth/machine-token',
    reason:
      'Story 7.2 D2/D4 — pre-auth machine-user API key exchange endpoint; the caller has no session and no org context is resolvable until the key is looked up by hash via the admin connection.',
    securityOwner: SECURITY_OWNER,
    compensatingControls: [TOKEN_IS_CREDENTIAL, IP_RATE_LIMIT, 'per-key-lockout'],
    expiresAfterStory: null,
  },
  {
    route: 'GET /api/v1/machine/projects/:projectId/credentials/:name/value',
    reason:
      "Story 7.2 D4 — machine-authenticated credential retrieval. Registered with SecureRoute's requireAuth:false public path because the caller presents a machine JWT via Authorization: Bearer, not a human session cookie; the handler's first action is a manual verifyMachineRequest() call that re-verifies the JWT and live-rechecks the referenced api_keys row is still non-revoked.",
    securityOwner: SECURITY_OWNER,
    compensatingControls: [
      'machine-jwt-verification',
      'live-revocation-recheck',
      TOKEN_IS_CREDENTIAL,
    ],
    expiresAfterStory: null,
  },
  {
    route: 'POST /api/v1/machine/cache-activated',
    reason:
      "Story 7.2 D13 — machine-authenticated offline-agent cache-activation beacon. Registered with SecureRoute's requireAuth:false public path because the caller presents a machine JWT via Authorization: Bearer, not a human session cookie; the handler's first action is the same manual verifyMachineRequest() call as the credential-value route (D4).",
    securityOwner: SECURITY_OWNER,
    compensatingControls: [
      'machine-jwt-verification',
      'live-revocation-recheck',
      TOKEN_IS_CREDENTIAL,
    ],
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
  'GET /api/v1/org/audit/verify': {
    action: 'read',
    auditOmissionReason:
      'Integrity verification read returns pass/fail counts and event metadata only; never a secret or credential value.',
    reviewer: SECURITY_OWNER,
  },
  // Story 6.2 AC 18 (ADR-6.2-04's correction). The route delegates to dismissSecurityAlert(),
  // which calls writeHumanAuditEntryOrFailClosed() internally — the literal function name
  // called in the route itself is dismissSecurityAlert (see security-alerts.ts).
  'POST /api/v1/org/security-alerts/:securityAlertId/dismiss': {
    action: SECURITY_ACTION,
    auditEvent: 'security_alert.dismissed',
    sameTransactionAuditService: 'dismissSecurityAlert',
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
  'GET /api/v1/projects/:projectId/credentials/:credentialId': {
    action: 'read',
    auditOmissionReason:
      'Credential metadata read returns no secret value; detail page load path (ADR-2.8-05).',
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
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations': {
    action: 'mutation',
    auditEvent: 'rotation.initiated',
    sameTransactionAuditService: 'writeRotationAuditEntry',
  },
  'GET /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId': {
    action: 'read',
    auditOmissionReason: 'Rotation status read does not expose credential values.',
    reviewer: SECURITY_OWNER,
  },
  'GET /api/v1/projects/:projectId/credentials/:credentialId/rotations': {
    action: 'read',
    auditOmissionReason: 'Rotation history list does not expose credential values.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/confirm':
    {
      action: 'mutation',
      auditEvent: 'rotation.checklist_item_confirmed',
      sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
    },
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/fail':
    {
      action: 'mutation',
      auditEvent: 'rotation.checklist_item_failed',
      sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
    },
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/retry':
    {
      action: 'mutation',
      auditEvent: 'rotation.checklist_item_retried',
      sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
    },
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/complete': {
    action: 'mutation',
    auditEvent: 'rotation.completed',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'GET /api/v1/projects/:projectId/rotations/upcoming': {
    action: 'read',
    auditOmissionReason:
      'Upcoming-rotation schedule read is metadata-only; never exposes a credential value.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/break-glass': {
    action: 'mutation',
    auditEvent: 'rotation.break_glass_initiated',
    sameTransactionAuditService: 'writeRotationAuditEntry',
  },
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/resume': {
    action: 'mutation',
    auditEvent: 'rotation.resumed',
    sameTransactionAuditService: 'writeResolutionAuditOrThrow',
  },
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/abandon': {
    action: 'mutation',
    auditEvent: 'rotation.abandoned',
    sameTransactionAuditService: 'writeResolutionAuditOrThrow',
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
  'GET /api/v1/search': {
    action: 'read',
    auditEvent: 'credential.search',
    sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
  },
  'GET /api/v1/dashboard': {
    action: 'read',
    auditOmissionReason:
      'Org dashboard read is org-scoped and returns aggregate counts and expiry metadata only.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/admin/notifications/test': {
    action: 'mutation',
    auditOmissionReason:
      'Test notification sends to configured channels; does not mutate vault state or expose secrets. Operational verification only.',
    reviewer: SECURITY_OWNER,
  },
  'GET /api/v1/users/me/notification-preferences': {
    action: 'read',
    auditOmissionReason: 'User reads own notification preferences; no secrets exposed.',
    reviewer: SECURITY_OWNER,
  },
  'PUT /api/v1/users/me/notification-preferences': {
    action: 'mutation',
    auditOmissionReason:
      'User updates own notification preferences; no secrets mutated. Not a security-sensitive setting change.',
    reviewer: SECURITY_OWNER,
  },
  'PATCH /api/v1/users/me/notification-preferences': {
    action: 'mutation',
    auditOmissionReason: 'User partially updates own notification preferences.',
    reviewer: SECURITY_OWNER,
  },
  'GET /api/v1/org/notification-routing': {
    action: 'read',
    auditOmissionReason: 'Admin reads org routing config; no secret values.',
    reviewer: SECURITY_OWNER,
  },
  'PUT /api/v1/org/notification-routing': {
    action: 'mutation',
    auditOmissionReason:
      'Admin updates org routing config; organizational configuration change, not a security event.',
    reviewer: SECURITY_OWNER,
  },
  'GET /api/v1/users/me': {
    action: 'read',
    auditOmissionReason:
      'User reads own profile summary and unread notification count; no secrets exposed.',
    reviewer: SECURITY_OWNER,
  },
  'GET /api/v1/notifications/inbox': {
    action: 'read',
    auditOmissionReason:
      'User reads own notification inbox; no secrets exposed. High-frequency UI operation.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/notifications/inbox/:id/read': {
    action: 'mutation',
    auditOmissionReason: 'User marks own inbox entry read; no security-sensitive state change.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/notifications/inbox/read-all': {
    action: 'mutation',
    auditOmissionReason:
      'User marks all own inbox entries read; no security-sensitive state change.',
    reviewer: SECURITY_OWNER,
  },
  'DELETE /api/v1/notifications/inbox/:id': {
    action: 'mutation',
    auditOmissionReason:
      'User dismisses own inbox entry (soft delete); no credential or secret data removed.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/projects/:projectId/invitations': {
    action: 'mutation',
    auditEvent: 'project.invitation_created',
    sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
  },
  'GET /api/v1/projects/:projectId/invitations': {
    action: 'read',
    auditOmissionReason:
      'Pending invitation list is admin-scoped and never returns the invitation token.',
    reviewer: SECURITY_OWNER,
  },
  'DELETE /api/v1/projects/:projectId/invitations/:id': {
    action: 'mutation',
    auditEvent: 'project.invitation_revoked',
    sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
  },
  'GET /api/v1/invitations/:token': {
    action: 'read',
    auditOmissionReason:
      'Public non-mutating peek used to route the web UI to login vs. registration; reveals only the invited email/project/role to the token holder.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/invitations/:token/accept': {
    action: 'mutation',
    auditEvent: 'project.invitation_accepted',
    sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
  },
  'GET /api/v1/org/users': {
    action: 'read',
    auditOmissionReason: 'Org user list read is admin-scoped and does not reveal secret values.',
    reviewer: SECURITY_OWNER,
  },
  'GET /api/v1/projects/:projectId/members': {
    action: 'read',
    auditOmissionReason:
      'Project member list read is project-admin/org-admin-scoped and does not reveal secret values.',
    reviewer: SECURITY_OWNER,
  },
  'DELETE /api/v1/org/users/:userId': {
    action: SECURITY_ACTION,
    auditEvent: 'org.user_removed',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'PUT /api/v1/org/users/:userId/projects/:projectId/role': {
    action: 'mutation',
    auditEvent: 'project.member_role_changed',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'DELETE /api/v1/projects/:projectId/members/:userId': {
    action: 'mutation',
    auditEvent: 'project.member_removed',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'POST /api/v1/projects/:projectId/transfer-ownership': {
    action: SECURITY_ACTION,
    auditEvent: 'project.ownership_transferred',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'POST /api/v1/projects/:projectId/archive': {
    action: SECURITY_ACTION,
    auditEvent: 'project.archived',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'POST /api/v1/projects/:projectId/unarchive': {
    action: SECURITY_ACTION,
    auditEvent: 'project.unarchived',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'POST /api/v1/org/users/:userId/deactivate': {
    action: SECURITY_ACTION,
    auditEvent: 'org.user_deactivated',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'POST /api/v1/org/users/:userId/recovery/send-link': {
    action: SECURITY_ACTION,
    auditEvent: 'auth.recovery_link_sent',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  // Story 4.3: the three public /auth/recovery/* mutations self-manage their own transaction
  // (recovery.ts) instead of SecureRoute's org-scoped one — org context isn't resolvable before
  // the token/email is looked up. Audit rows are still written fail-closed inside that
  // transaction (see recovery.ts's writeRecoveryAuditPerOrg / writeHumanAuditEntryOrFailClosed
  // calls), just not through the secureCtx.tx shape this registry's opt-out check expects, so
  // these are documented as an omission here rather than declaring an auditEvent it can't verify.
  'POST /api/v1/auth/recovery/request': {
    action: SECURITY_ACTION,
    auditOmissionReason:
      'Public, pre-org-context endpoint (org unknown until email/user resolves). Audit rows (auth.recovery_requested / auth.recovery_blocked_no_admin, one per active org membership) are written fail-closed inside a hand-rolled transaction in recovery.ts, not through SecureRoute.',
    reviewer: SECURITY_OWNER,
  },
  'GET /api/v1/auth/recovery/:token': {
    action: 'read',
    auditOmissionReason:
      'Public non-mutating peek used to route the web UI before any mutation; reveals only a masked email + MFA-enrolled flag to the token holder (AC-13).',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/auth/recovery/:token/mfa/start': {
    action: SECURITY_ACTION,
    auditOmissionReason:
      'Only stages a pending TOTP secret (does not consume the token or change any confirmed credential state); the security-relevant event is recorded at /complete (auth.recovery_completed) when the enrollment is actually confirmed or the flow otherwise concludes.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/auth/recovery/:token/complete': {
    action: SECURITY_ACTION,
    auditOmissionReason:
      'Public, pre-org-context endpoint. Audit rows (auth.recovery_completed, one per active org membership) are written fail-closed inside a hand-rolled transaction in recovery.ts, not through SecureRoute.',
    reviewer: SECURITY_OWNER,
  },
  // Story 6.1 — services (payment_records), certificates (cert_records), domains (domain_records).
  'GET /api/v1/projects/:projectId/services': {
    action: 'read',
    auditOmissionReason: MONITORING_LIST_READ_OMISSION_REASON,
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/projects/:projectId/services': {
    action: 'mutation',
    auditEvent: 'payment_record.created',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'PATCH /api/v1/projects/:projectId/services/:serviceId': {
    action: 'mutation',
    auditEvent: 'payment_record.updated',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'DELETE /api/v1/projects/:projectId/services/:serviceId': {
    action: 'mutation',
    auditEvent: 'payment_record.deleted',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'GET /api/v1/projects/:projectId/certificates': {
    action: 'read',
    auditOmissionReason: MONITORING_LIST_READ_OMISSION_REASON,
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/projects/:projectId/certificates': {
    action: 'mutation',
    auditEvent: 'certificate.created',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'PATCH /api/v1/projects/:projectId/certificates/:certificateId': {
    action: 'mutation',
    auditEvent: 'certificate.updated',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'DELETE /api/v1/projects/:projectId/certificates/:certificateId': {
    action: 'mutation',
    auditEvent: 'certificate.deleted',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'GET /api/v1/projects/:projectId/domains': {
    action: 'read',
    auditOmissionReason: MONITORING_LIST_READ_OMISSION_REASON,
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/projects/:projectId/domains': {
    action: 'mutation',
    auditEvent: 'domain_record.created',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'PATCH /api/v1/projects/:projectId/domains/:domainId': {
    action: 'mutation',
    auditEvent: 'domain_record.updated',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'DELETE /api/v1/projects/:projectId/domains/:domainId': {
    action: 'mutation',
    auditEvent: 'domain_record.deleted',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  // Story 6.2 — service endpoints (service_endpoints), health history, monitoring alerts.
  'GET /api/v1/projects/:projectId/service-endpoints': {
    action: 'read',
    auditOmissionReason: MONITORING_LIST_READ_OMISSION_REASON,
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/projects/:projectId/service-endpoints': {
    action: 'mutation',
    auditEvent: 'service_endpoint.created',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'PATCH /api/v1/projects/:projectId/service-endpoints/:serviceEndpointId': {
    action: 'mutation',
    auditEvent: 'service_endpoint.updated',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'DELETE /api/v1/projects/:projectId/service-endpoints/:serviceEndpointId': {
    action: 'mutation',
    auditEvent: 'service_endpoint.deleted',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'GET /api/v1/projects/:projectId/service-endpoints/:serviceEndpointId/health-history': {
    action: 'read',
    auditOmissionReason:
      'Health-history read returns per-check status/latency metadata only; never request/response bodies.',
    reviewer: SECURITY_OWNER,
  },
  'GET /api/v1/projects/:projectId/alerts': {
    action: 'read',
    auditOmissionReason:
      'Monitoring-alert list read is project-member-scoped and reveals only alert metadata.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/projects/:projectId/alerts/:alertId/snooze': {
    action: 'mutation',
    auditEvent: 'monitoring_alert.snoozed',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'POST /api/v1/projects/:projectId/alerts/:alertId/dismiss': {
    action: SECURITY_ACTION,
    auditEvent: 'monitoring_alert.dismissed',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  // Story 6.3 — cross-project health dashboard (service_endpoints, ADR-6.3-02).
  'GET /api/v1/health-dashboard': {
    action: 'read',
    auditOmissionReason:
      'Cross-project health-status read is org-scoped and reveals only service_endpoints status/lastCheckedAt metadata, never secret values (mirrors GET /api/v1/dashboard).',
    reviewer: SECURITY_OWNER,
  },
  // Story 6.3 — public status page enable/regenerate/update/disable/get-config admin routes.
  'GET /api/v1/projects/:projectId/status-page': {
    action: 'read',
    auditOmissionReason:
      'Admin config read (AC 21) is project-owner-or-org-owner-scoped and never returns the plaintext token or tokenHash.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/projects/:projectId/status-page': {
    action: SECURITY_ACTION,
    auditEvent: 'status_page.enabled',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'POST /api/v1/projects/:projectId/status-page/regenerate': {
    action: SECURITY_ACTION,
    auditEvent: 'status_page.token_regenerated',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'PUT /api/v1/projects/:projectId/status-page': {
    action: 'mutation',
    auditEvent: 'status_page.updated',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  'DELETE /api/v1/projects/:projectId/status-page': {
    action: 'mutation',
    auditEvent: 'status_page.disabled',
    sameTransactionAuditService: WRITE_MONITORING_AUDIT_OR_FAIL_CLOSED,
  },
  // Story 6.3 AC 14/18 (ADR-6.3-05/09) — public, unauthenticated, high-frequency status page view.
  'GET /api/v1/status-pages/:token': {
    action: 'read',
    auditOmissionReason:
      'Public, unauthenticated, high-frequency status page view — auditing every view would create unbounded audit-log growth from external, non-actor traffic; see Known Scope Boundaries in 6-3 story file.',
    reviewer: SECURITY_OWNER,
  },
  // Story 7.1 — machine user identity and API key management.
  'POST /api/v1/projects/:projectId/machine-users': {
    action: 'mutation',
    auditEvent: 'machine_user.created',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'GET /api/v1/projects/:projectId/machine-users': {
    action: 'read',
    auditOmissionReason:
      'Machine-user list read is org-scoped and does not reveal API key secrets.',
    reviewer: SECURITY_OWNER,
  },
  'GET /api/v1/machine-users/:machineUserId': {
    action: 'read',
    auditOmissionReason:
      'Machine-user detail read is org-scoped and does not reveal API key secrets.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/machine-users/:machineUserId/api-keys': {
    action: SECURITY_ACTION,
    auditEvent: 'machine_user.api_key_issued',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'GET /api/v1/machine-users/:machineUserId/api-keys': {
    action: 'read',
    auditOmissionReason: 'API key list returns metadata only (AC-12) — never keyHash or plaintext.',
    reviewer: SECURITY_OWNER,
  },
  'DELETE /api/v1/machine-users/:machineUserId/api-keys/:keyId': {
    action: SECURITY_ACTION,
    auditEvent: 'machine_user.api_key_revoked',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  // Story 7.2 — machine user authentication and programmatic secret retrieval.
  'POST /api/v1/auth/machine-token': {
    action: 'read',
    auditOmissionReason:
      'Public pre-auth token exchange; no audit row is written here (no org context is resolvable yet). lastUsedAt is updated via the admin connection, not an audited mutation.',
    reviewer: SECURITY_OWNER,
  },
  'GET /api/v1/machine/projects/:projectId/credentials/:name/value': {
    action: 'sensitive-read',
    auditOmissionReason:
      "Machine-authenticated public route (D4) — org context is not resolvable until verifyMachineRequest() resolves the JWT, so the handler opens its own withOrg() transaction rather than SecureRoute's declarative one. A credential.value_revealed audit row (actorType: machine_user) is still written fail-closed via writeMachineAuditEntryOrFailClosed() inside that same transaction (AC-9), just not through the secureCtx.tx path this registry's opt-out check expects.",
    reviewer: SECURITY_OWNER,
  },
  'GET /api/v1/projects/:projectId/machine-users/active-keys': {
    action: 'read',
    auditOmissionReason:
      'Archival-guard read endpoint (AC-23) — returns only machineUserId/keyId pairs, never API key secrets.',
    reviewer: SECURITY_OWNER,
  },
  'POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/rotate': {
    action: SECURITY_ACTION,
    auditEvent: 'machine_user.api_key_rotated',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/emergency-revoke': {
    action: SECURITY_ACTION,
    auditEvent: 'machine_user.api_key_emergency_revoked',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/extend-dormancy': {
    action: SECURITY_ACTION,
    auditEvent: 'machine_user.dormancy_extended',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'POST /api/v1/security-alerts/:alertId/dismiss': {
    action: SECURITY_ACTION,
    auditEvent: 'security_alert.dismissed',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'PATCH /api/v1/organizations/:orgId/machine-key-settings': {
    action: 'mutation',
    auditEvent: 'organization.machine_key_settings_updated',
    sameTransactionAuditService: WRITE_HUMAN_AUDIT_OR_FAIL_CLOSED,
  },
  'POST /api/v1/machine/cache-activated': {
    action: 'mutation',
    auditOmissionReason:
      "Machine-authenticated public route (D13) — org context is not resolvable until verifyMachineRequest() resolves the JWT, so the handler opens its own withOrg() transaction rather than SecureRoute's declarative one. A machine_cache.activated audit row (actorType: machine_user) is still written fail-closed via writeMachineAuditEntryOrFailClosed() inside that same transaction (AC-15), just not through the secureCtx.tx path this registry's opt-out check expects.",
    reviewer: SECURITY_OWNER,
  },
}

export const DIRECT_DB_ACCESS_CLASSIFICATIONS: DirectDbAccessClassification[] = [
  {
    path: 'modules/auth/routes.ts',
    classification: PUBLIC_ROUTE_SUPPORT,
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
  {
    path: 'modules/invitations/token-routes.ts',
    classification: PUBLIC_ROUTE_SUPPORT,
    reason:
      'The public token-peek and pre-org-scope accept routes cannot know which org an invitation belongs to in advance, so the initial token lookup (in ./lookup.js) uses the admin connection for a single indexed point-lookup by the unique hashed-token index — the 256-bit token is itself the authorization credential, same trust model as the existing RLS exclusion for refresh_tokens/pending_mfa_sessions. Once the owning org is resolved, all further reads/writes on project_invitations go through an org-scoped withOrg()/secureCtx.tx like every other route.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'modules/auth/recovery-lookup.ts',
    classification: PUBLIC_ROUTE_SUPPORT,
    reason:
      'The public recovery-token peek, mfa/start, and complete routes cannot know which user/org a recovery token belongs to in advance, so findRecoveryTokenByHash uses the admin connection for a single indexed point-lookup by the unique hashed-token index — the 256-bit recovery token is itself the authorization credential, same trust model as modules/invitations/token-routes.ts. Once the token is resolved, further writes run through the caller-supplied transaction like every other route.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/notification-email.ts',
    classification: PLATFORM_JOB,
    reason:
      'Org-scoped notification delivery worker; catchup scans pending entries per org via withOrg().',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/notification-slack.ts',
    classification: PLATFORM_JOB,
    reason:
      'Org-scoped notification delivery worker; catchup scans pending entries per org via withOrg().',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/notification-backfill.ts',
    classification: PLATFORM_JOB,
    reason:
      'One-time backfill job uses fetchAllOrgIds() (getDb()) to scan PENDING_DELIVERY security alerts across all orgs.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/notification-deliver.ts',
    classification: PLATFORM_JOB,
    reason: 'Reads notification_queue channel via withOrg() to route delivery.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/notification-digest.ts',
    classification: PLATFORM_JOB,
    reason:
      'Fetches digest queue entries per org using getDb() DISTINCT org scan; writes via withOrg().',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/notification-inbox.ts',
    classification: PLATFORM_JOB,
    reason:
      'Inbox delivery worker uses withOrgAndUser() for per-user RLS; queue lookup via withOrg().',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/notification-inbox-purge.ts',
    classification: PLATFORM_JOB,
    reason:
      'Cross-org purge of expired inbox entries via getAdminDb(); bypasses per-user RLS for maintenance operation.',
    reviewer: SECURITY_OWNER,
  },
  {
    path: 'workers/monitoring-health-check.ts',
    classification: PLATFORM_JOB,
    reason:
      'Uses getDb() only for the transaction-scoped pg_try_advisory_xact_lock overlap guard (ADR-6.2-09) — no table data is read through it; the due-query and every alert/audit write use runOrgScopedJob for RLS-scoped access.',
    reviewer: SECURITY_OWNER,
  },
]
