import { describe, expect, it, vi, beforeEach } from 'vitest'

const getRotationMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/rotations.js', () => ({
  getRotation: getRotationMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const rotationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function makeEvent() {
  return {
    params: { projectId, credentialId, rotationId },
    fetch: vi.fn(),
    locals: { user: { orgRole: 'admin' } },
  } as unknown as Parameters<typeof load>[0]
}

describe('/rotations/[rotationId] +page.server.ts', () => {
  beforeEach(() => {
    getRotationMock.mockReset()
  })

  it('AC-7: returns the rotation detail and orgRole', async () => {
    getRotationMock.mockResolvedValue({ id: rotationId, status: 'in_progress', checklistItems: [] })

    const result = await load(makeEvent())

    expect(result.rotation?.id).toBe(rotationId)
    expect(result.orgRole).toBe('admin')
    expect(result.notFound).toBe(false)
  })

  it('AC-7 edge: returns notFound on a 404', async () => {
    getRotationMock.mockRejectedValue(new ApiClientError(404, null, 'not found'))

    const result = await load(makeEvent())

    expect(result.notFound).toBe(true)
    expect(result.rotation).toBeNull()
  })

  // AC-3: getRotation is vault-guarded — a sealed vault 503s it. The existing 404 branch's
  // `error instanceof ApiClientError` pattern is preserved, only extended with a sibling 503
  // branch (checked before the fallthrough throw).
  it('AC-3: returns vaultSealed: true (and notFound: false) on a 503, distinct from the 404 case', async () => {
    getRotationMock.mockRejectedValue(
      new ApiClientError(
        503,
        { status: 'sealed', message: 'Vault not initialized' },
        'Vault not initialized'
      )
    )

    const result = await load(makeEvent())

    expect(result.vaultSealed).toBe(true)
    expect(result.notFound).toBe(false)
    expect(result.rotation).toBeNull()
  })

  it('AC-3 edge: a non-404/503 ApiClientError still propagates unchanged', async () => {
    getRotationMock.mockRejectedValue(new ApiClientError(500, null, 'boom'))

    await expect(load(makeEvent())).rejects.toThrow('boom')
  })
})
