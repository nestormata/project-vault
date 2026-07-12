import { describe, expect, it } from 'vitest'
import type { credentials } from '@project-vault/db/schema'
import { serializeCredentialDetail } from './service.js'

function row(
  overrides: Partial<typeof credentials.$inferSelect> = {}
): typeof credentials.$inferSelect {
  return {
    id: 'cred-1',
    orgId: 'org-1',
    projectId: 'proj-1',
    name: 'API Key',
    description: null,
    tags: [],
    expiresAt: null,
    alertLeadDays: [30, 7, 1],
    notifiedLeadDays: [],
    rotationSchedule: null,
    retentionCount: 3,
    createdBy: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  } as typeof credentials.$inferSelect
}

describe('serializeCredentialDetail', () => {
  it('formats expiresAt as null when unset', () => {
    const result = serializeCredentialDetail(row({ expiresAt: null }), 1)
    expect(result.expiresAt).toBeNull()
  })

  it('formats expiresAt as ISO when set', () => {
    const result = serializeCredentialDetail(
      row({ expiresAt: new Date('2026-06-01T00:00:00.000Z') }),
      1
    )
    expect(result.expiresAt).toBe('2026-06-01T00:00:00.000Z')
  })

  it('includes the passed-in currentVersionNumber alongside the row fields', () => {
    const result = serializeCredentialDetail(row(), 7)
    expect(result.currentVersionNumber).toBe(7)
    expect(result.id).toBe('cred-1')
    expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })
})
