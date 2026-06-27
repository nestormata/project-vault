import { describe, expect, it } from 'vitest'
import { MFA_ENROLLMENT_EXEMPT_ROUTES } from './mfa-exempt-routes.js'

describe('MFA_ENROLLMENT_EXEMPT_ROUTES', () => {
  it('documents the Story 1.9 MFA-exempt owner/admin and enrollment routes', () => {
    expect(MFA_ENROLLMENT_EXEMPT_ROUTES).toEqual([
      'GET /api/v1/org/security-alerts',
      'POST /api/v1/auth/mfa/enroll',
      'POST /api/v1/auth/mfa/verify-enrollment',
      'POST /api/v1/auth/mfa/regenerate-recovery-codes',
      'GET /api/v1/auth/me',
    ])
  })
})
