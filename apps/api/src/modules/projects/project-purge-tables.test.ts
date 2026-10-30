import { afterAll, describe, expect, it } from 'vitest'
import { getTableName } from 'drizzle-orm'
import postgres from 'postgres'
import { PROJECT_PURGE_TABLES } from './project-lifecycle.js'

const superUrl = process.env['SUPERUSER_DATABASE_URL']
const sql = postgres(superUrl ?? 'postgresql://invalid', { max: 1, connect_timeout: 5 })

afterAll(async () => {
  await sql.end()
})

// Story 72-9: the purge deletes a project's data table by table (the row itself stays as a
// tombstone). A table added later with a foreign key to projects must be added to the list, or its
// rows would survive a purge. audit_log_entries is the one deliberate exception: it is append-only.
describe.skipIf(!superUrl)(
  'PROJECT_PURGE_TABLES covers every table that references projects',
  () => {
    it('lists exactly the tables with a foreign key to projects, minus the audit log', async () => {
      const rows = await sql<{ table_name: string }[]>`
      SELECT DISTINCT c.conrelid::regclass::text AS table_name
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid = 'projects'::regclass
        AND c.conrelid <> 'projects'::regclass`
      const referencing = rows
        .map((row) => row.table_name)
        .filter((name) => name !== 'audit_log_entries')
      expect(PROJECT_PURGE_TABLES.map(({ table }) => getTableName(table)).sort()).toEqual(
        referencing.sort()
      )
    })

    it('keeps the audit log out of the list', () => {
      expect(PROJECT_PURGE_TABLES.map(({ table }) => getTableName(table))).not.toContain(
        'audit_log_entries'
      )
    })
  }
)
