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
    linkUrl: null,
    createdBy: 'user-1',
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    fieldKey: null,
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

  // AC-1/AC-4: linkUrl is additive and passes through unchanged (null when unset).
  it('passes linkUrl through unchanged, including null', () => {
    expect(serializeDependency(row({ linkUrl: null })).linkUrl).toBeNull()
    expect(serializeDependency(row({ linkUrl: 'https://example.com/deploy' })).linkUrl).toBe(
      'https://example.com/deploy'
    )
  })

  // Story 13.5 AC-5/AC-6: fieldKey is additive and passes through unchanged (null when unset).
  it('passes fieldKey through unchanged, including null', () => {
    expect(serializeDependency(row({ fieldKey: null })).fieldKey).toBeNull()
    expect(serializeDependency(row({ fieldKey: 'password' })).fieldKey).toBe('password')
  })
})
