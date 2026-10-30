import { describe, expect, it } from 'vitest'
import {
  CredentialSharingActingUserInvalidError,
  CredentialSharingActingUserMismatchError,
  CredentialSharingNotAuthorizedError,
  CredentialSharingStepUpRequiredError,
  CredentialSharingTotpEnrollmentRequiredError,
  type CredentialSharingShareRecord,
} from './credential-sharing.js'

// Story 65.6 and 72.21: the acting-user and step-up error classes (stable `code`s, messages that name only the method) and the
// `sharedBy` key on every share record.
describe('credential-sharing acting-user and step-up contract (Stories 65.6, 72.21)', () => {
  it.each([
    [CredentialSharingNotAuthorizedError, 'credential_sharing_not_authorized'],
    [CredentialSharingActingUserInvalidError, 'credential_sharing_acting_user_invalid'],
    [CredentialSharingActingUserMismatchError, 'credential_sharing_acting_user_mismatch'],
    [CredentialSharingStepUpRequiredError, 'credential_sharing_step_up_required'],
    [CredentialSharingTotpEnrollmentRequiredError, 'credential_sharing_totp_enrollment_required'],
  ])('%o has its stable code, an Error subclass name and a generic message', (ErrorClass, code) => {
    const error = new ErrorClass('revokeShare')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe(code)
    expect(error.name).toBe(ErrorClass.name)
    expect(error.message).toContain('HostServices.credentialSharing.revokeShare()')
    expect(error.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
  })

  it('a share record always carries sharedBy, string or null, and it survives JSON', () => {
    const record: CredentialSharingShareRecord = {
      id: 'share',
      orgId: 'org',
      credentialId: 'credential',
      fieldKey: null,
      attributeKeys: null,
      sharedBy: null,
      recipientType: 'external',
      recipientUserId: null,
      recipientEmail: null,
      singleUse: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      revokedAt: null,
      supersededAt: null,
      firstViewedAt: null,
      viewCount: 0,
      status: 'active',
    }
    expect(JSON.parse(JSON.stringify(record))).toHaveProperty('sharedBy', null)
    expect(Object.keys(record)).toContain('sharedBy')
  })
})
