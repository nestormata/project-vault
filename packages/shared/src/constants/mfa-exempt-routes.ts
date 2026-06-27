export const MFA_ENROLLMENT_EXEMPT_ROUTES = [
  'GET /api/v1/org/security-alerts',
  'POST /api/v1/auth/mfa/enroll',
  'POST /api/v1/auth/mfa/verify-enrollment',
  'POST /api/v1/auth/mfa/regenerate-recovery-codes',
  'GET /api/v1/auth/me',
] as const

export type MfaExemptRoute = (typeof MFA_ENROLLMENT_EXEMPT_ROUTES)[number]
