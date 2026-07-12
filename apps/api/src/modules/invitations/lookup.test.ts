import { describe, expect, it } from 'vitest'
import type { ProjectInvitation } from '@project-vault/db/schema'
import { validateInvitationStatus } from './lookup.js'

const FUTURE = new Date(Date.now() + 60 * 60 * 1000)
const PAST = new Date(Date.now() - 60 * 60 * 1000)

function baseInvitation(overrides: Partial<ProjectInvitation> = {}): ProjectInvitation {
  return {
    id: 'inv-1',
    projectId: 'proj-1',
    orgId: 'org-1',
    email: 'invitee@example.com',
    roleToAssign: 'member',
    tokenHash: 'hash',
    revokedAt: null,
    acceptedAt: null,
    expiresAt: FUTURE,
    createdAt: new Date(),
    ...overrides,
  } as ProjectInvitation
}

describe('validateInvitationStatus', () => {
  it('returns invitation_not_found (404) for a null invitation', () => {
    expect(validateInvitationStatus(null)).toEqual({
      code: 'invitation_not_found',
      message: 'Invitation not found',
      statusCode: 404,
    })
  })

  it('returns invitation_revoked (410) when revokedAt is set', () => {
    const result = validateInvitationStatus(baseInvitation({ revokedAt: PAST }))
    expect(result).toMatchObject({ code: 'invitation_revoked', statusCode: 410 })
  })

  it('returns invitation_already_accepted (409) when acceptedAt is set', () => {
    const result = validateInvitationStatus(baseInvitation({ acceptedAt: PAST }))
    expect(result).toMatchObject({ code: 'invitation_already_accepted', statusCode: 409 })
  })

  it('returns invitation_expired (410) when expiresAt is in the past', () => {
    const result = validateInvitationStatus(baseInvitation({ expiresAt: PAST }))
    expect(result).toMatchObject({ code: 'invitation_expired', statusCode: 410 })
  })

  it('returns null (valid) for a non-revoked, non-accepted, non-expired invitation', () => {
    expect(validateInvitationStatus(baseInvitation())).toBeNull()
  })

  it('checks revoked before accepted before expired, in that priority order', () => {
    const revokedAndAccepted = baseInvitation({ revokedAt: PAST, acceptedAt: PAST })
    expect(validateInvitationStatus(revokedAndAccepted)?.code).toBe('invitation_revoked')

    const acceptedAndExpired = baseInvitation({ acceptedAt: PAST, expiresAt: PAST })
    expect(validateInvitationStatus(acceptedAndExpired)?.code).toBe('invitation_already_accepted')
  })
})
