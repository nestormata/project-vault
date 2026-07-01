import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { scanSearchIndexes } from './check-search-index.js'

const makeFixtureRoot = useFixtureRoots('project-vault-search-index-', [
  'packages/db/src/migrations',
  'packages/db/src/schema',
  'apps/api/src',
])

describe('check-search-index', () => {
  it('flags SQL and Drizzle indexes that reference credential value columns', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      'packages/db/src/migrations/0001_bad.sql',
      'CREATE INDEX bad ON credential_versions (encrypted_value);'
    )
    writeFixture(
      root,
      'packages/db/src/schema/bad.ts',
      "index('bad_encrypted_value_idx').on(t.encryptedValue)"
    )

    const violations = scanSearchIndexes(root)

    expect(violations.map((violation) => violation.file)).toEqual(
      expect.arrayContaining([
        'packages/db/src/migrations/0001_bad.sql',
        'packages/db/src/schema/bad.ts',
      ])
    )
  })

  it('flags runtime CREATE INDEX statements outside migrations', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      'apps/api/src/runtime-ddl.ts',
      'await db.execute(sql`CREATE INDEX runtime_idx ON credentials (name)`)'
    )

    const violations = scanSearchIndexes(root)

    expect(violations).toEqual([
      expect.objectContaining({
        file: 'apps/api/src/runtime-ddl.ts',
      }),
    ])
  })

  it('allows metadata-only credential indexes and non-value Drizzle indexes', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      'packages/db/src/migrations/0001_good.sql',
      [
        'CREATE INDEX idx_credentials_project_expires ON credentials (project_id, expires_at);',
        'CREATE INDEX idx_credentials_name ON credentials (name);',
      ].join('\n')
    )
    writeFixture(
      root,
      'packages/db/src/schema/good.ts',
      [
        "index('idx_credentials_project_expires').on(t.projectId, t.expiresAt),",
        "index('idx_credentials_tags').on(t.tags),",
        "index('idx_credentials_description').on(t.description),",
      ].join('\n')
    )

    expect(scanSearchIndexes(root)).toEqual([])
  })

  it('passes on the current repository tree', () => {
    expect(scanSearchIndexes(resolve(import.meta.dirname, '..'))).toEqual([])
  })

  it('allows safe trgm indexes on credential metadata columns', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      'packages/db/src/migrations/0020_good_trgm.sql',
      'CREATE INDEX idx_credentials_name_trgm ON credentials USING GIN (name gin_trgm_ops);'
    )
    expect(scanSearchIndexes(root)).toEqual([])
  })

  it('flags hypothetical credential value trgm indexes', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      'packages/db/src/migrations/0020_bad_trgm.sql',
      'CREATE INDEX idx_creds_value_trgm ON credentials USING GIN (value gin_trgm_ops);'
    )
    expect(scanSearchIndexes(root)).toHaveLength(1)
  })
})
