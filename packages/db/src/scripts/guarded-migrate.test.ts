import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildMigrationLogEvent,
  buildRefusalMessage,
  decideMigrationAction,
  fetchLastAppliedMillis,
  readLocalMigrations,
  resolvePendingMigrations,
  scanPendingForDestructive,
} from './guarded-migrate.js'

const TAG_UNSAFE = '0001_unsafe'
const TAG_DROP_LEGACY = '0036_drop_legacy_column'
const TAG_NOTIFICATION_NONE = '0047_notification_preference_none_channel'
const TAG_MIXED_BATCH_A = '0010_a'
const TAG_MIXED_BATCH_B = '0011_b'
const SQL_CREATE_TABLE_A = 'CREATE TABLE a (id int);'
const FINDING_DROP_COLUMN_LINE_1 = 'DROP COLUMN (line 1)'
const FINDING_DROP_COLUMN_LEGACY_FIELD = 'DROP COLUMN "legacy_field" (line 3)'

const tempDirs: string[] = []

function makeFixtureMigrationsDir(entries: { tag: string; sql: string; when: number }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'guarded-migrate-fixture-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'meta'), { recursive: true })
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((e, idx) => ({
        idx,
        version: '7',
        when: e.when,
        tag: e.tag,
        breakpoints: true,
      })),
    })
  )
  for (const entry of entries) {
    writeFileSync(join(dir, `${entry.tag}.sql`), entry.sql)
  }
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('readLocalMigrations', () => {
  it('reads every migration file listed in the journal, in journal order', () => {
    const dir = makeFixtureMigrationsDir([
      { tag: '0000_first', sql: SQL_CREATE_TABLE_A, when: 100 },
      { tag: '0001_second', sql: 'CREATE TABLE b (id int);', when: 200 },
    ])

    const migrations = readLocalMigrations(dir)
    expect(migrations).toEqual([
      { tag: '0000_first', sql: SQL_CREATE_TABLE_A, folderMillis: 100 },
      { tag: '0001_second', sql: 'CREATE TABLE b (id int);', folderMillis: 200 },
    ])
  })
})

describe('resolvePendingMigrations', () => {
  const all = [
    { tag: '0000_first', sql: '', folderMillis: 100 },
    { tag: '0001_second', sql: '', folderMillis: 200 },
    { tag: '0002_third', sql: '', folderMillis: 300 },
  ]

  it('treats every migration as pending when nothing has been applied yet', () => {
    expect(resolvePendingMigrations(all, null)).toEqual(all)
  })

  it('returns only migrations newer than the last-applied timestamp', () => {
    expect(resolvePendingMigrations(all, 100)).toEqual([all[1], all[2]])
  })

  it('returns an empty array when everything is already applied', () => {
    expect(resolvePendingMigrations(all, 300)).toEqual([])
  })
})

describe('scanPendingForDestructive', () => {
  it('returns only the pending migrations that contain destructive statements', () => {
    const pending = [
      { tag: '0000_safe', sql: SQL_CREATE_TABLE_A, folderMillis: 100 },
      { tag: TAG_UNSAFE, sql: 'ALTER TABLE a DROP COLUMN id;', folderMillis: 200 },
    ]
    const result = scanPendingForDestructive(pending)
    expect(result).toHaveLength(1)
    expect(result[0]?.tag).toBe(TAG_UNSAFE)
    expect(result[0]?.findings[0]).toMatch(/DROP COLUMN/)
  })

  it('returns an empty array when no pending migration is destructive', () => {
    const pending = [{ tag: '0000_safe', sql: SQL_CREATE_TABLE_A, folderMillis: 100 }]
    expect(scanPendingForDestructive(pending)).toEqual([])
  })

  it('skips a migration tag in KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS, so a fresh-database install is never blocked by it', () => {
    // A brand-new self-hosted install's very first db:migrate run treats its entire local
    // history as "pending" (resolvePendingMigrations returns `all` when lastAppliedMillis is
    // null) — an unlisted already-reviewed migration here would block every fresh install, not
    // just in-place upgrades.
    const pending = [
      {
        tag: '0036_audit_search_export_forwarding',
        sql: 'DELETE FROM audit_log_entries WHERE org_id = $1;',
        folderMillis: 100,
      },
    ]
    expect(scanPendingForDestructive(pending)).toEqual([])
  })

  it('does not let the allowlist suppress an unrelated migration with a similar destructive statement', () => {
    const pending = [
      {
        tag: '0099_unrelated_delete',
        sql: 'DELETE FROM audit_log_entries;',
        folderMillis: 100,
      },
    ]
    const result = scanPendingForDestructive(pending)
    expect(result).toHaveLength(1)
    expect(result[0]?.tag).toBe('0099_unrelated_delete')
  })

  it('skips the reviewed notification none-channel widening migration, so in-place upgrades are not blocked by a safe check-constraint widen', () => {
    const pending = [
      {
        tag: TAG_NOTIFICATION_NONE,
        sql:
          'ALTER TABLE "notification_preferences"\n' +
          '  DROP CONSTRAINT "notification_preferences_channel_check";\n' +
          '\n' +
          'ALTER TABLE "notification_preferences"\n' +
          '  ADD CONSTRAINT "notification_preferences_channel_check"\n' +
          `  CHECK ("notification_preferences"."channel" IN ('email', 'slack', 'inbox', 'none'));`,
        folderMillis: 100,
      },
    ]

    expect(scanPendingForDestructive(pending)).toEqual([])
  })
})

describe('decideMigrationAction', () => {
  it('refuses when there are offending migrations and --allow-destructive was not passed', () => {
    const offending = [{ tag: TAG_UNSAFE, findings: [FINDING_DROP_COLUMN_LINE_1] }]
    expect(decideMigrationAction(offending, false)).toBe('refuse')
  })

  it('proceeds when --allow-destructive was passed, even with offending migrations', () => {
    const offending = [{ tag: TAG_UNSAFE, findings: [FINDING_DROP_COLUMN_LINE_1] }]
    expect(decideMigrationAction(offending, true)).toBe('proceed')
  })

  it('proceeds when there are no offending migrations regardless of the flag', () => {
    expect(decideMigrationAction([], false)).toBe('proceed')
    expect(decideMigrationAction([], true)).toBe('proceed')
  })
})

describe('buildRefusalMessage', () => {
  it('names every offending file and finding, and cross-references the runbook (AC-20)', () => {
    const message = buildRefusalMessage([
      { tag: TAG_DROP_LEGACY, findings: [FINDING_DROP_COLUMN_LEGACY_FIELD] },
    ])
    expect(message).toContain(TAG_DROP_LEGACY)
    expect(message).toContain(FINDING_DROP_COLUMN_LEGACY_FIELD)
    expect(message).toContain('docs/runbook.md § Upgrades')
    expect(message).toContain('--allow-destructive')
  })

  it('refuses the whole batch — lists every offending file when more than one is pending (mixed-batch example)', () => {
    const message = buildRefusalMessage([
      { tag: TAG_MIXED_BATCH_A, findings: ['TRUNCATE (line 1)'] },
      { tag: TAG_MIXED_BATCH_B, findings: ['DROP TABLE (line 1)'] },
    ])
    expect(message).toContain(TAG_MIXED_BATCH_A)
    expect(message).toContain(TAG_MIXED_BATCH_B)
  })
})

describe('buildMigrationLogEvent', () => {
  it('builds a migration.destructive_refused event naming the offending file(s) and statement(s)', () => {
    const event = buildMigrationLogEvent({
      kind: 'refused',
      offending: [{ tag: TAG_DROP_LEGACY, findings: [FINDING_DROP_COLUMN_LEGACY_FIELD] }],
    })
    expect(event).toMatchObject({
      event: 'migration.destructive_refused',
      level: 'error',
      files: [TAG_DROP_LEGACY],
      findings: [FINDING_DROP_COLUMN_LEGACY_FIELD],
    })
  })

  it('builds a migration.destructive_allowed event confirming --allow-destructive was passed', () => {
    const event = buildMigrationLogEvent({
      kind: 'allowed',
      offending: [{ tag: TAG_DROP_LEGACY, findings: [FINDING_DROP_COLUMN_LEGACY_FIELD] }],
    })
    expect(event).toMatchObject({
      event: 'migration.destructive_allowed',
      level: 'warn',
      files: [TAG_DROP_LEGACY],
      allowDestructive: true,
    })
  })

  it('builds a migration.applied event for the routine, non-destructive case', () => {
    const event = buildMigrationLogEvent({
      kind: 'applied',
      applied: [TAG_MIXED_BATCH_A, TAG_MIXED_BATCH_B],
    })
    expect(event).toMatchObject({
      event: 'migration.applied',
      level: 'info',
      files: [TAG_MIXED_BATCH_A, TAG_MIXED_BATCH_B],
    })
  })
})

// AC-1/AC-21.2: integration coverage against the real, already-migrated CI/dev Postgres
// instance — proves the DB-query half of pending-detection actually works against a live
// `drizzle.__drizzle_migrations` table, not just the pure in-memory logic above.
//
// Uses the *superuser* connection (ADMIN_DATABASE_URL), not the app's own DATABASE_URL: in real
// usage (docker-compose.yml's `migrate` service, CI's "Run database migrations" step,
// Makefile's `db-migrate` target) guarded-migrate.ts always runs as the Postgres superuser —
// drizzle-kit itself creates the `drizzle` schema under that role, and the `vault_app` app role
// is never granted access to it. Using the app role here would silently exercise the wrong
// permission context (a permission-denied error, swallowed by fetchLastAppliedMillis's
// intentionally-broad catch, masquerading as "nothing applied yet").
describe('fetchLastAppliedMillis (integration)', () => {
  const databaseUrl =
    process.env['ADMIN_DATABASE_URL'] ??
    'postgresql://postgres:password@localhost:5432/project_vault'

  it('returns a numeric timestamp once migrations have been applied', async () => {
    const lastApplied = await fetchLastAppliedMillis(databaseUrl)
    expect(typeof lastApplied).toBe('number')
  })

  it('resolves zero pending migrations against the real migrations/ directory (already fully applied)', async () => {
    const migrationsDir = resolve(__dirname, '../migrations')
    const all = readLocalMigrations(migrationsDir)
    const lastApplied = await fetchLastAppliedMillis(databaseUrl)
    const pending = resolvePendingMigrations(all, lastApplied)
    expect(pending).toEqual([])
  })

  it('returns null against a schema with no __drizzle_migrations table', async () => {
    const result = await fetchLastAppliedMillis(
      databaseUrl.replace('/project_vault', '/nonexistent_db_for_migration_safety_test')
    )
    expect(result).toBeNull()
  })
})
