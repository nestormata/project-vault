import { describe, expect, it, vi } from 'vitest'
import { ApiClientError } from './client.js'
import {
  changeProjectRole,
  deactivateOrgUser,
  listOrgUsers,
  listProjectMembers,
  removeOrgUser,
  removeProjectMember,
  sendRecoveryLink,
  transferOwnership,
} from './org-users.js'
import { jsonResponse } from '$lib/test/json-response.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const PROJECT_ID = '00000000-0000-4000-8000-000000000010'

describe('org-users API helpers', () => {
  it('listOrgUsers returns the envelope data array', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            userId: USER_ID,
            email: 'alex@acme.example',
            displayName: 'alex@acme.example',
            orgRole: 'owner',
            status: 'active',
            projects: [{ projectId: PROJECT_ID, projectName: 'Payments API', role: 'owner' }],
          },
        ],
      })
    )

    const result = await listOrgUsers(fetchFn)
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/org/users', expect.objectContaining({}))
    expect(result[0]?.projects[0]?.projectName).toBe('Payments API')
    expect(result[0]?.status).toBe('active')
  })

  it('deactivateOrgUser posts to the deactivate endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { userId: USER_ID, revokedSessionCount: 2, revokedInvitationCount: 1 },
      })
    )

    const result = await deactivateOrgUser(fetchFn, USER_ID)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/org/users/${USER_ID}/deactivate`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(result).toEqual({ userId: USER_ID, revokedSessionCount: 2, revokedInvitationCount: 1 })
  })

  it('deactivateOrgUser surfaces already_deactivated as a catchable ApiClientError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { code: 'already_deactivated', message: 'Already deactivated' },
          { status: 409 }
        )
      )

    await expect(deactivateOrgUser(fetchFn, USER_ID)).rejects.toMatchObject({
      status: 409,
      code: 'already_deactivated',
    } satisfies Partial<ApiClientError>)
  })

  it('sendRecoveryLink posts to the recovery/send-link endpoint', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { userId: USER_ID, linkSent: true } }))

    const result = await sendRecoveryLink(fetchFn, USER_ID)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/org/users/${USER_ID}/recovery/send-link`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(result).toEqual({ userId: USER_ID, linkSent: true })
  })

  it('removeOrgUser issues a DELETE and returns the revoked count', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { userId: USER_ID, revokedSessionCount: 2 } }))

    const result = await removeOrgUser(fetchFn, USER_ID)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/org/users/${USER_ID}`,
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(result.revokedSessionCount).toBe(2)
  })

  it('changeProjectRole sends the role body via PUT', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { userId: USER_ID, projectId: PROJECT_ID, role: 'viewer' } })
      )

    await changeProjectRole(fetchFn, USER_ID, PROJECT_ID, 'viewer')
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/org/users/${USER_ID}/projects/${PROJECT_ID}/role`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ role: 'viewer' }) })
    )
  })

  it('surfaces sole_owner_of_projects as a catchable ApiClientError with the projects list', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 'sole_owner_of_projects',
          message: 'Transfer ownership first',
          projects: [{ projectId: PROJECT_ID, projectName: 'Payments API' }],
        },
        { status: 409 }
      )
    )

    await expect(removeOrgUser(fetchFn, USER_ID)).rejects.toMatchObject({
      status: 409,
      code: 'sole_owner_of_projects',
    } satisfies Partial<ApiClientError>)
  })

  it('listProjectMembers reads the project member list', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [{ userId: USER_ID, email: 'a@b.c', displayName: 'a@b.c', role: 'owner' }],
      })
    )

    const result = await listProjectMembers(fetchFn, PROJECT_ID)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${PROJECT_ID}/members`,
      expect.objectContaining({})
    )
    expect(result[0]?.role).toBe('owner')
  })

  it('removeProjectMember issues a DELETE to the member endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await removeProjectMember(fetchFn, PROJECT_ID, USER_ID)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${PROJECT_ID}/members/${USER_ID}`,
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  it('transferOwnership posts the newOwnerId', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { projectId: PROJECT_ID, previousOwnerId: USER_ID, newOwnerId: 'x' },
      })
    )
    await transferOwnership(fetchFn, PROJECT_ID, 'x')
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${PROJECT_ID}/transfer-ownership`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ newOwnerId: 'x' }) })
    )
  })
})
