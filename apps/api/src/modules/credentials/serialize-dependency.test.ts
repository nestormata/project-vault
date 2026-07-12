import { describe, expect, it } from 'vitest'
import { credentialDependencies } from '@project-vault/db/schema'
import { serializeDependency } from './dependencies-service.js'

function row(
  overrides: Partial<typeof credentialDependencies.$inferSelect> = {}
): typeof credentialDependencies.$inferSelect {
  return {
    id: 'dep-1',
    credentialId: 'cred-1',
    systemName: 'CI Pipeline',
    systemType: 'ci_pipeline',
    notes: null,
    createdBy: 'user-1',
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  } as typeof credentialDependencies.$inferSelect
}

describe('serializeDependency', () => {
  it('serializes a valid systemType and formats archivedAt as null when unset', () => {
    const result = serializeDependency(row({ archivedAt: null }))
    expect(result.systemType).toBe('ci_pipeline')
    expect(result.archivedAt).toBeNull()
  })

  it('formats archivedAt as ISO when the dependency is archived', () => {
    const result = serializeDependency(row({ archivedAt: new Date('2026-02-01T00:00:00.000Z') }))
    expect(result.archivedAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('throws for a row with a systemType outside the enum (defensive DB-corruption guard)', () => {
    expect(() => serializeDependency(row({ systemType: 'not_a_real_type' }))).toThrow(
      /invalid credential dependency systemType/
    )
  })
})
