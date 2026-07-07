import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { scanMigrationCompatibility } from './migration-compatibility-check.js'

const makeFixtureRoot = useFixtureRoots('migration-compat-', ['packages/db/src/migrations'])

describe('scanMigrationCompatibility', () => {
  it('returns no violations for an all-additive migration set', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      'packages/db/src/migrations/0000_init.sql',
      'CREATE TABLE a (id int);\nALTER TABLE a ADD COLUMN "name" text;'
    )

    expect(scanMigrationCompatibility(root)).toEqual([])
  })

  it('flags a migration file containing a destructive statement, naming the file and finding', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      'packages/db/src/migrations/0001_oops.sql',
      'ALTER TABLE credentials DROP COLUMN notes;'
    )

    const violations = scanMigrationCompatibility(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe('packages/db/src/migrations/0001_oops.sql')
    expect(violations[0]?.findings[0]).toMatch(/DROP COLUMN/)
  })

  it('scans every migration file regardless of whether it has already been applied (full-history check)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, 'packages/db/src/migrations/0000_old.sql', 'DROP TABLE legacy;')
    writeFixture(root, 'packages/db/src/migrations/0001_new.sql', 'CREATE TABLE b (id int);')

    const violations = scanMigrationCompatibility(root)
    expect(violations.map((v) => v.file)).toEqual(['packages/db/src/migrations/0000_old.sql'])
  })

  it('does not scan non-.sql files under the migrations directory (e.g. meta/_journal.json)', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      'packages/db/src/migrations/meta/_journal.json',
      '{"entries":[{"tag":"DROP TABLE mentioned only in a journal filename, not SQL"}]}'
    )

    expect(scanMigrationCompatibility(root)).toEqual([])
  })

  it('returns an empty array when the migrations directory does not exist', () => {
    const root = makeFixtureRoot()
    expect(scanMigrationCompatibility(`${root}/does-not-exist`)).toEqual([])
  })
})

describe('scanMigrationCompatibility against the real repository (AC-4, AC-18)', () => {
  it('passes with zero findings against every migration currently committed', () => {
    expect(scanMigrationCompatibility(process.cwd())).toEqual([])
  })
})
