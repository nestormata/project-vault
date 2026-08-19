import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'

const extensionUrl = process.env['EXTENSION_DATABASE_URL']
const superuserUrl = process.env['SUPERUSER_DATABASE_URL']
const describeDatabase = extensionUrl && superuserUrl ? describe : describe.skip

describeDatabase('Story 23.5 extension role database boundary', () => {
  const extensionSql = postgres(extensionUrl as string, { max: 1 })
  const superuserSql = postgres(superuserUrl as string, { max: 1 })

  beforeAll(async () => {
    const [identity] = await extensionSql<{ current_user: string }[]>`SELECT current_user`
    expect(identity?.current_user).toBe('vault_extension')
  })

  afterAll(async () => {
    await extensionSql.end()
    await superuserSql.end()
  })

  it('denies every table operation and the approval artifact with SQLSTATE 42501', async () => {
    const statements = [
      extensionSql`SELECT 1 FROM credentials LIMIT 1`,
      extensionSql`INSERT INTO credentials DEFAULT VALUES`,
      extensionSql`UPDATE credentials SET updated_at = updated_at`,
      extensionSql`DELETE FROM credentials`,
      extensionSql`SELECT 1 FROM extension_db_scope_approvals LIMIT 1`,
      extensionSql`SELECT nextval('platform_audit_pending_seq')`,
    ]

    for (const statement of statements) {
      await expect(statement).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('cannot turn off RLS context or execute public functions as a bypass', async () => {
    await expect(
      extensionSql`SELECT set_config('app.current_org_id', '00000000-0000-0000-0000-000000000000', true)`
    ).resolves.toBeDefined()
    await expect(
      extensionSql`SELECT purge_expired_platform_audit_entries(now())`
    ).rejects.toMatchObject({ code: '42501' })

    const [row] = await superuserSql<{ function_name: string; extension_execute: boolean }[]>`
      SELECT
        p.proname AS function_name,
        has_function_privilege('vault_extension', p.oid, 'EXECUTE') AS extension_execute,
        has_schema_privilege('vault_extension', 'pg_catalog', 'USAGE') AS non_public_usage
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (
          SELECT 1
            FROM pg_depend d
            JOIN pg_extension e ON e.oid = d.refobjid
           WHERE d.classid = 'pg_proc'::regclass
             AND d.refclassid = 'pg_extension'::regclass
             AND d.objid = p.oid
             AND d.deptype = 'e'
             AND e.extname = 'pg_trgm'
        )
        AND has_function_privilege('vault_extension', p.oid, 'EXECUTE')
      LIMIT 1
    `
    expect(row).toBeUndefined()

    const [schema] = await superuserSql<{ nspname: string }[]>`
      SELECT nspname
        FROM pg_namespace
       WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema')
         AND has_schema_privilege('vault_extension', oid, 'USAGE')
       LIMIT 1
    `
    expect(schema).toBeUndefined()

    const [role] = await superuserSql<
      { rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean }[]
    >`
      SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
        FROM pg_roles
       WHERE rolname = 'vault_extension'
    `
    expect(role).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    })
  })
})
