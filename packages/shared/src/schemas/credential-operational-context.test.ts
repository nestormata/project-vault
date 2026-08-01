import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CredentialOperationalContextResponseSchema } from './credentials.js'

const ID = randomUUID()

describe('CredentialOperationalContextResponseSchema', () => {
  it('accepts the closed v1 metadata-only operational-context envelope', () => {
    expect(
      CredentialOperationalContextResponseSchema.parse({
        data: {
          contractVersion: 1,
          credential: {
            id: ID,
            projectId: ID,
            name: 'Production login',
            credentialType: 'login',
            account: { status: 'not_available', fieldKeys: ['username', 'password'] },
            rotationSchedule: null,
            expiresAt: null,
            cacheable: false,
            currentVersion: { number: 2, schemaVersion: 2 },
          },
          rotation: {
            state: 'staged',
            id: ID,
            initiatedAt: '2026-08-01T00:00:00.000Z',
            completedAt: null,
            targetFields: ['password'],
          },
          usage: {
            activeDependencyCount: 1,
            locations: {
              items: [
                {
                  dependencyId: ID,
                  systemName: 'Production API',
                  systemType: 'service',
                  fieldKey: 'password',
                },
              ],
              nextCursor: null,
            },
          },
        },
      })
    ).toMatchObject({ data: { contractVersion: 1 } })
  })

  it('rejects values and unknown keys from the closed v1 contract', () => {
    expect(() =>
      CredentialOperationalContextResponseSchema.parse({
        data: {
          contractVersion: 1,
          credential: {
            id: ID,
            projectId: ID,
            name: 'Production login',
            credentialType: 'login',
            account: { status: 'not_available', fieldKeys: [], value: 'leak' },
            rotationSchedule: null,
            expiresAt: null,
            cacheable: false,
            currentVersion: null,
          },
          rotation: {
            state: 'none',
            id: null,
            initiatedAt: null,
            completedAt: null,
            targetFields: null,
          },
          usage: { activeDependencyCount: 0, locations: { items: [], nextCursor: null } },
        },
      })
    ).toThrow()
  })
})
