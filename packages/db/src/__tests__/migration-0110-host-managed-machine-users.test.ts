import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { DATABASE_URL, SUPERUSER_DATABASE_URL } from '../test-db-urls.js'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0110_host_managed_machine_users.sql'
)
const superSql = postgres(SUPERUSER_DATABASE_URL, { max: 1 })
const appSql = postgres(DATABASE_URL, { max: 1 })

const CHECK_VIOLATION = '23514'
const UNIQUE_VIOLATION = '23505'

type MachineUserInsert = {
  projectId: string | null
  createdBy: string | null
  hostManaged: boolean
  name?: string
}

// Story 73-9 (D1): a keyless, org-scoped, host-managed machine user lives in machine_users. The
// shape rules are database constraints, proved here as the app role under RLS.
describe('migration 0110 (host-managed machine users)', () => {
  const sqlText = readFileSync(MIGRATION_PATH, 'utf-8')
  const statements = sqlText.replaceAll(/^\s*--(?! statement-breakpoint).*$/gm, '')
  const orgId = randomUUID()
  const otherOrgId = randomUUID()
  const projectId = randomUUID()
  const userId = randomUUID()

  beforeAll(async () => {
    await superSql`INSERT INTO organizations (id, name, slug) VALUES
      (${orgId}, 'Migration 0110 org', ${`m0110-${orgId}`}),
      (${otherOrgId}, 'Migration 0110 other org', ${`m0110-${otherOrgId}`})`
    await superSql`INSERT INTO projects (id, org_id, name, slug)
      VALUES (${projectId}, ${orgId}, 'Migration 0110 project', ${`m0110-${projectId}`})`
    await superSql`INSERT INTO users (id, email, password_hash)
      VALUES (${userId}, ${`m0110-${userId}@invalid`}, 'not-a-real-hash')`
  })

  afterAll(async () => {
    await superSql`DELETE FROM organizations WHERE id IN (${orgId}, ${otherOrgId})`
    await superSql`DELETE FROM users WHERE id = ${userId}`
    await superSql.end()
    await appSql.end()
  })

  function insertAsApp(org: string, row: MachineUserInsert) {
    return appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${org}, true)`
      const [inserted] = await tx<{ id: string }[]>`
        INSERT INTO machine_users (org_id, project_id, name, role, created_by, host_managed)
        VALUES (${org}, ${row.projectId}, ${row.name ?? 'com.example.pack'}, 'viewer',
          ${row.createdBy}, ${row.hostManaged})
        RETURNING id`
      return inserted?.id
    })
  }

  async function sqlStateOf(attempt: Promise<unknown>): Promise<string | undefined> {
    const error: unknown = await attempt.then(
      () => undefined,
      (caught: unknown) => caught
    )
    return (error as { code?: string } | undefined)?.code
  }

  it('touches only machine_users and drops nothing but the project_id NOT NULL', () => {
    const alteredTables = [...statements.matchAll(/ALTER TABLE "?([a-z_]+)"?/g)].map((m) => m[1])
    expect(new Set(alteredTables)).toEqual(new Set(['machine_users']))
    const withoutNotNullDrop = statements.replace(/ALTER COLUMN "project_id" DROP NOT NULL/, '')
    expect(withoutNotNullDrop).not.toMatch(/DROP |RENAME|TRUNCATE|DELETE FROM|UPDATE /i)
  })

  it('is idempotent: re-running every statement on a migrated database does not fail', async () => {
    const results = await sqlText
      .split('--> statement-breakpoint')
      .filter((statement) => statement.replaceAll(/^\s*--.*$/gm, '').trim() !== '')
      .reduce<Promise<unknown[]>>(
        async (previous, statement) => [...(await previous), await superSql.unsafe(statement)],
        Promise.resolve([])
      )
    expect(results.length).toBeGreaterThan(0)
  })

  it('adds host_managed (not null, default false) and makes project_id nullable', async () => {
    const rows = await superSql<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'machine_users' AND column_name IN ('host_managed', 'project_id')`
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]))
    expect(byName.host_managed).toMatchObject({ is_nullable: 'NO', column_default: 'false' })
    expect(byName.project_id?.is_nullable).toBe('YES')
  })

  it('accepts an admin-provisioned row and a host-managed row as the app role', async () => {
    await expect(
      insertAsApp(orgId, { projectId, createdBy: userId, hostManaged: false, name: 'admin-row' })
    ).resolves.toEqual(expect.any(String))
    await expect(
      insertAsApp(orgId, { projectId: null, createdBy: null, hostManaged: true, name: 'hm-row' })
    ).resolves.toEqual(expect.any(String))
  })

  it.each([
    ['a host-managed row with a project', { projectId: 'project', createdBy: null }],
    ['a host-managed row with a human creator', { projectId: null, createdBy: 'user' }],
  ])('refuses %s', async (_label, shape) => {
    const row: MachineUserInsert = {
      projectId: shape.projectId === null ? null : projectId,
      createdBy: shape.createdBy === null ? null : userId,
      hostManaged: true,
      name: `refused-${randomUUID()}`,
    }
    expect(await sqlStateOf(insertAsApp(orgId, row))).toBe(CHECK_VIOLATION)
  })

  it('refuses an admin-provisioned row without a project', async () => {
    const row = { projectId: null, createdBy: userId, hostManaged: false }
    expect(await sqlStateOf(insertAsApp(orgId, row))).toBe(CHECK_VIOLATION)
  })

  it('allows one host-managed row per org and name, and keeps admin names non-unique', async () => {
    const name = `unique-${randomUUID()}`
    const hostManaged = { projectId: null, createdBy: null, hostManaged: true, name }
    await insertAsApp(orgId, hostManaged)
    expect(await sqlStateOf(insertAsApp(orgId, hostManaged))).toBe(UNIQUE_VIOLATION)
    await expect(insertAsApp(otherOrgId, hostManaged)).resolves.toEqual(expect.any(String))
    const admin = { projectId, createdBy: userId, hostManaged: false, name }
    await insertAsApp(orgId, admin)
    await expect(insertAsApp(orgId, admin)).resolves.toEqual(expect.any(String))
  })

  it('keeps machine_users under forced row-level security', async () => {
    const [table] = await superSql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'machine_users'`
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
  })
})
