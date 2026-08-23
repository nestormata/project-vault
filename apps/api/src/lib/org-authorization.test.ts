import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveActiveOrgRole } = vi.hoisted(() => ({
  resolveActiveOrgRole: vi.fn(),
}))
vi.mock('../plugins/authenticate.js', () => ({ resolveActiveOrgRole }))

import { checkOrgAuthorization } from './org-authorization.js'

const ORG_ID = 'org-1'
const VIEWER_ID = 'user-1'
const NOT_A_MEMBER = { outcome: 'denied', reasonCode: 'not-a-member' } as const

beforeEach(() => {
  vi.clearAllMocks()
})

describe('checkOrgAuthorization — AC3: denied, never error, never throws', () => {
  it('non-existent organization/identity (no membership row) returns denied/not-a-member', async () => {
    resolveActiveOrgRole.mockResolvedValue(null)

    const result = await checkOrgAuthorization({
      organizationId: ORG_ID,
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'viewer',
    })

    expect(result).toEqual(NOT_A_MEMBER)
    expect(resolveActiveOrgRole).toHaveBeenCalledWith(VIEWER_ID, ORG_ID)
  })

  it('a membership row that exists but is not status: active resolves to null upstream and is denied here too', async () => {
    // resolveActiveOrgRole() (Task 1) already filters to status = 'active' and returns null for
    // any non-active row — checkOrgAuthorization must map that the same way as "no row at all".
    resolveActiveOrgRole.mockResolvedValue(null)

    const result = await checkOrgAuthorization({
      organizationId: ORG_ID,
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'owner',
    })

    expect(result).toEqual(NOT_A_MEMBER)
  })

  it('an active member whose role is below minimumRole is denied, not errored', async () => {
    resolveActiveOrgRole.mockResolvedValue('viewer')

    const result = await checkOrgAuthorization({
      organizationId: ORG_ID,
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'admin',
    })

    expect(result.outcome).toBe('denied')
  })
})

describe('checkOrgAuthorization — AC4: genuine internal failure returns error, never throws', () => {
  it('a DB error during resolution resolves to { outcome: "error" }, not a rejected promise', async () => {
    resolveActiveOrgRole.mockRejectedValue(new Error('connection terminated unexpectedly'))

    await expect(
      checkOrgAuthorization({
        organizationId: ORG_ID,
        viewerIdentityId: VIEWER_ID,
        minimumRole: 'viewer',
      })
    ).resolves.toEqual({ outcome: 'error', reasonCode: expect.any(String) })
  })

  it('never throws synchronously either', () => {
    resolveActiveOrgRole.mockRejectedValue(new Error('boom'))

    expect(() =>
      checkOrgAuthorization({
        organizationId: ORG_ID,
        viewerIdentityId: VIEWER_ID,
        minimumRole: 'viewer',
      })
    ).not.toThrow()
  })
})

describe('checkOrgAuthorization — AC5: request-scoped, never cached across calls', () => {
  it('reflects a role downgrade between two consecutive calls for the same identity/org', async () => {
    resolveActiveOrgRole.mockResolvedValueOnce('admin')
    const first = await checkOrgAuthorization({
      organizationId: ORG_ID,
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'admin',
    })
    expect(first).toEqual({ outcome: 'authorized' })

    resolveActiveOrgRole.mockResolvedValueOnce('viewer')
    const second = await checkOrgAuthorization({
      organizationId: ORG_ID,
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'admin',
    })
    expect(second.outcome).toBe('denied')
    expect(resolveActiveOrgRole).toHaveBeenCalledTimes(2)
  })

  it('reflects membership removal between two consecutive calls', async () => {
    resolveActiveOrgRole.mockResolvedValueOnce('owner')
    const first = await checkOrgAuthorization({
      organizationId: ORG_ID,
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'owner',
    })
    expect(first).toEqual({ outcome: 'authorized' })

    resolveActiveOrgRole.mockResolvedValueOnce(null)
    const second = await checkOrgAuthorization({
      organizationId: ORG_ID,
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'owner',
    })
    expect(second).toEqual(NOT_A_MEMBER)
  })
})

describe('checkOrgAuthorization — AC7: unrecognized minimumRole returns error, never a silent pass/deny or throw', () => {
  it('an out-of-enum minimumRole value returns error/invalid-minimum-role without querying resolution', async () => {
    const result = await checkOrgAuthorization({
      organizationId: ORG_ID,
      viewerIdentityId: VIEWER_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately outside the compile-time union (AC7)
      minimumRole: 'super-admin' as any,
    })

    expect(result).toEqual({ outcome: 'error', reasonCode: 'invalid-minimum-role' })
    expect(resolveActiveOrgRole).not.toHaveBeenCalled()
  })

  it('does not throw for the out-of-enum value', async () => {
    await expect(
      checkOrgAuthorization({
        organizationId: ORG_ID,
        viewerIdentityId: VIEWER_ID,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately outside the compile-time union (AC7)
        minimumRole: '' as any,
      })
    ).resolves.toEqual({ outcome: 'error', reasonCode: 'invalid-minimum-role' })
  })
})

describe('checkOrgAuthorization — authorized path', () => {
  it('returns authorized when the resolved role meets minimumRole', async () => {
    resolveActiveOrgRole.mockResolvedValue('owner')

    const result = await checkOrgAuthorization({
      organizationId: ORG_ID,
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'member',
    })

    expect(result).toEqual({ outcome: 'authorized' })
  })

  it('returns authorized when the resolved role exactly equals minimumRole', async () => {
    resolveActiveOrgRole.mockResolvedValue('member')

    const result = await checkOrgAuthorization({
      organizationId: ORG_ID,
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'member',
    })

    expect(result).toEqual({ outcome: 'authorized' })
  })
})
