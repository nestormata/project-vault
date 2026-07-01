export const MFA_ENROLLMENT_EXEMPT_ROUTES = [
  'GET /api/v1/org/security-alerts',
  'GET /api/v1/projects/:projectId/credentials/:credentialId/access',
  'POST /api/v1/projects/:projectId/credentials/import',
  'POST /api/v1/projects/:projectId/credentials/import/confirm',
  'POST /api/v1/auth/mfa/enroll',
  'POST /api/v1/auth/mfa/verify-enrollment',
  'POST /api/v1/auth/mfa/regenerate-recovery-codes',
  'GET /api/v1/auth/me',
  'GET /api/v1/users/me',
  'GET /api/v1/notifications/inbox',
  'POST /api/v1/notifications/inbox/:id/read',
  'POST /api/v1/notifications/inbox/read-all',
  'DELETE /api/v1/notifications/inbox/:id',
  'PATCH /api/v1/projects/:projectId',
  'GET /api/v1/users/me/notification-preferences',
  'PUT /api/v1/users/me/notification-preferences',
  'PATCH /api/v1/users/me/notification-preferences',
  // Invite creation enforces a *stricter* MFA gate than requireMfaEnrollment() — it calls
  // requireMfaEnrollmentStrict() manually inside the handler so grace-period owner/admins are
  // still blocked (D2, Story 4.1). This exemption registry only recognizes the standard gate,
  // so the strict check would otherwise be (incorrectly) flagged as "no MFA check at all".
  'POST /api/v1/projects/:projectId/invitations',
  'GET /api/v1/projects/:projectId/invitations',
  'DELETE /api/v1/projects/:projectId/invitations/:id',
] as const

export type MfaExemptRoute = (typeof MFA_ENROLLMENT_EXEMPT_ROUTES)[number]
