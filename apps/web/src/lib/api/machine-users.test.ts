import { describe, expect, it, vi } from 'vitest'
import type { MachineUserDetail } from '@project-vault/shared'
import { jsonResponse } from '$lib/test/json-response.js'
import {
  createMachineUser,
  deactivateMachineUser,
  emergencyRevokeApiKey,
  extendKeyDormancy,
  getMachineUser,
  issueApiKey,
  listApiKeys,
  listMachineUsers,
  revokeApiKey,
  rotateApiKey,
} from './machine-users.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const machineUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const keyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const sampleDetail: MachineUserDetail = {
  id: machineUserId,
  projectId,
  name: 'ci-deploy-bot',
  description: null,
  role: 'member',
  createdBy: 'user-1',
  createdAt: '2026-07-01T00:00:00.000Z',
  deactivatedAt: null,
  scopeBoundary: { canAccess: ['x'], cannotAccess: ['y'] },
}

describe('machine-user API helpers', () => {
  it('listMachineUsers GETs the project-scoped list endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [], total: 0 } }))
    await listMachineUsers(fetchFn, projectId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/machine-users`,
      expect.objectContaining({ credentials: 'include' })
    )
  })

  it('createMachineUser POSTs name/role/description', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleDetail }, { status: 201 }))
    const result = await createMachineUser(fetchFn, projectId, {
      name: 'ci-deploy-bot',
      role: 'member',
      description: 'deploy pipeline',
    })
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/machine-users`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'ci-deploy-bot',
          role: 'member',
          description: 'deploy pipeline',
        }),
      })
    )
    expect(result).toEqual(sampleDetail)
  })

  it('getMachineUser GETs the flat detail endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleDetail }))
    const result = await getMachineUser(fetchFn, machineUserId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/machine-users/${machineUserId}`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result).toEqual(sampleDetail)
  })

  it('issueApiKey POSTs name/expiresAt to the api-keys endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: {
            id: keyId,
            machineUserId,
            name: 'prod-key',
            key: 'pk_plaintext',
            expiresAt: null,
            createdAt: '2026-07-01T00:00:00.000Z',
          },
        },
        { status: 201 }
      )
    )
    const result = await issueApiKey(fetchFn, machineUserId, { name: 'prod-key' })
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/machine-users/${machineUserId}/api-keys`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'prod-key' }) })
    )
    expect(result.key).toBe('pk_plaintext')
  })

  it('listApiKeys GETs the api-keys list endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [], total: 0 } }))
    await listApiKeys(fetchFn, machineUserId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/machine-users/${machineUserId}/api-keys`,
      expect.objectContaining({ credentials: 'include' })
    )
  })

  it('revokeApiKey issues a DELETE to the specific key', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { id: keyId, revokedAt: '2026-07-01T00:00:00.000Z' } })
      )
    await revokeApiKey(fetchFn, machineUserId, keyId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/machine-users/${machineUserId}/api-keys/${keyId}`,
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  it('rotateApiKey POSTs overlapMinutes to the rotate endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: {
            newKeyId: 'new-key',
            key: 'pk_new',
            oldKeyId: keyId,
            overlapExpiresAt: '2026-07-01T04:00:00.000Z',
          },
        },
        { status: 201 }
      )
    )
    await rotateApiKey(fetchFn, machineUserId, keyId, 240)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/machine-users/${machineUserId}/api-keys/${keyId}/rotate`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ overlapMinutes: 240 }),
      })
    )
  })

  it('emergencyRevokeApiKey POSTs to the emergency-revoke endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { revokedKeyId: keyId, newKey: 'pk_new', newKeyId: 'new-key' },
      })
    )
    await emergencyRevokeApiKey(fetchFn, machineUserId, keyId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/machine-users/${machineUserId}/api-keys/${keyId}/emergency-revoke`,
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('deactivateMachineUser POSTs to the deactivate endpoint', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { id: machineUserId, deactivatedAt: '2026-07-01T00:00:00.000Z' } })
      )
    const result = await deactivateMachineUser(fetchFn, machineUserId)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/machine-users/${machineUserId}/deactivate`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.deactivatedAt).toBe('2026-07-01T00:00:00.000Z')
  })

  it('extendKeyDormancy POSTs days to the extend-dormancy endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { keyId, dormancySnoozedUntil: '2026-08-01T00:00:00.000Z' },
      })
    )
    await extendKeyDormancy(fetchFn, machineUserId, keyId, 30)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/machine-users/${machineUserId}/api-keys/${keyId}/extend-dormancy`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ days: 30 }) })
    )
  })
})
