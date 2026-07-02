import { describe, expect, it } from 'vitest'
import { MFA_ENROLLMENT_EXEMPT_ROUTES } from './mfa-exempt-routes.js'

describe('MFA_ENROLLMENT_EXEMPT_ROUTES', () => {
  it('documents the Story 1.9 MFA-exempt owner/admin and enrollment routes', () => {
    expect(MFA_ENROLLMENT_EXEMPT_ROUTES).toEqual([
      'GET /api/v1/org/security-alerts',
      'GET /api/v1/org/users',
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
      'POST /api/v1/projects/:projectId/invitations',
      'GET /api/v1/projects/:projectId/invitations',
      'DELETE /api/v1/projects/:projectId/invitations/:id',
    ])
  })
})
