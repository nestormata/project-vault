import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  getCredentialOperationalContext,
  parseOperationalContextQuery,
} from './operational-context-service.js'

const ID = randomUUID()

describe('operational credential context', () => {
  it('uses one metadata-only statement and classifies canonical template metadata', async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        credential_id: ID,
        project_id: ID,
        credential_name: 'Production login',
        rotation_schedule: '0 0 1 * *',
        expires_at: null,
        cacheable: false,
        version_number: 2,
        schema_version: 2,
        field_meta: [
          { key: 'username', sensitive: false, template: 'login' },
          { key: 'password', sensitive: true, template: 'login' },
        ],
        rotation_id: null,
        rotation_status: null,
        initiated_at: null,
        completed_at: null,
        target_fields: null,
        dependency_count: '1',
        locations: [
          {
            dependencyId: ID,
            systemName: 'Production API',
            systemType: 'service',
            fieldKey: 'password',
          },
        ],
      },
    ])

    const result = await getCredentialOperationalContext({ execute } as never, {
      orgId: ID,
      projectId: ID,
      credentialId: ID,
      limit: 50,
    })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      credential: { credentialType: 'login', account: { fieldKeys: ['username', 'password'] } },
      rotation: { state: 'none' },
      usage: { activeDependencyCount: 1, locations: { nextCursor: null } },
    })
    expect(JSON.stringify(result)).not.toContain('encryptedValue')
    expect(JSON.stringify(result)).not.toContain('visibleFieldValues')
  })

  it('rejects unknown, malformed, and out-of-range pagination input', () => {
    expect(parseOperationalContextQuery({ extra: 'no' })).toEqual({ ok: false })
    expect(parseOperationalContextQuery({ cursor: 'not-a-cursor' })).toEqual({ ok: false })
    expect(parseOperationalContextQuery({ limit: '101' })).toEqual({ ok: false })
    expect(parseOperationalContextQuery({ limit: '2' })).toEqual({
      ok: true,
      cursor: undefined,
      limit: 2,
    })
  })

  it('uses the stable cursor boundary and returns a cursor only when the extra row exists', async () => {
    const first = randomUUID()
    const second = randomUUID()
    const execute = vi.fn().mockResolvedValue([
      {
        credential_id: ID,
        project_id: ID,
        credential_name: 'Production login',
        rotation_schedule: null,
        expires_at: null,
        cacheable: true,
        version_number: 4,
        schema_version: 2,
        field_meta: [{ key: 'password', sensitive: true }],
        rotation_id: null,
        rotation_status: null,
        initiated_at: null,
        completed_at: null,
        target_fields: null,
        dependency_count: '2',
        locations: [
          { dependencyId: first, systemName: 'A service', systemType: 'service', fieldKey: null },
          { dependencyId: second, systemName: 'B service', systemType: 'service', fieldKey: null },
        ],
      },
    ])

    const result = await getCredentialOperationalContext({ execute } as never, {
      orgId: ID,
      projectId: ID,
      credentialId: ID,
      limit: 1,
    })

    expect(result?.usage.locations.items).toHaveLength(1)
    expect(result?.usage.locations.nextCursor).toEqual(expect.any(String))
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed stored metadata instead of returning an unvalidated partial response', async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        credential_id: ID,
        project_id: ID,
        credential_name: 'Malformed',
        rotation_schedule: null,
        expires_at: null,
        cacheable: true,
        version_number: 1,
        schema_version: 2,
        field_meta: [{ key: 'password', sensitive: 'not-a-boolean' }],
        rotation_id: null,
        rotation_status: null,
        initiated_at: null,
        completed_at: null,
        target_fields: null,
        dependency_count: 0,
        locations: [],
      },
    ])

    await expect(
      getCredentialOperationalContext({ execute } as never, {
        orgId: ID,
        projectId: ID,
        credentialId: ID,
        limit: 50,
      })
    ).rejects.toThrow('credential_operational_context_invalid_field_meta')
  })
})
