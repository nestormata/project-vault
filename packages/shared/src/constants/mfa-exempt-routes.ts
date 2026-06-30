export const MFA_ENROLLMENT_EXEMPT_ROUTES = [
  'GET /api/v1/org/security-alerts',
  'GET /api/v1/projects/:projectId/credentials/:credentialId/access',
  'POST /api/v1/projects/:projectId/credentials/import',
  'POST /api/v1/projects/:projectId/credentials/import/confirm',
  'POST /api/v1/auth/mfa/enroll',
  'POST /api/v1/auth/mfa/verify-enrollment',
  'POST /api/v1/auth/mfa/regenerate-recovery-codes',
  'GET /api/v1/auth/me',
  'PATCH /api/v1/projects/:projectId',
  'GET /api/v1/users/me/notification-preferences',
  'PUT /api/v1/users/me/notification-preferences',
  'PATCH /api/v1/users/me/notification-preferences',
] as const

export type MfaExemptRoute = (typeof MFA_ENROLLMENT_EXEMPT_ROUTES)[number]
