import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS } from '../lib/migration-safety.js'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0080_security_definer_function_grants.sql'
)
const migration = (() => {
  try {
    return readFileSync(MIGRATION_PATH, 'utf8')
  } catch {
    return ''
  }
})()

const PURGE_FUNCTIONS = [
  'purge_expired_audit_log_entries(uuid, timestamptz)',
  'purge_expired_platform_audit_entries(timestamptz)',
]
const TRIGGER_FUNCTIONS = [
  'prevent_audit_log_mutation()',
  'prevent_pseudonym_reversal()',
  'update_updated_at_column()',
  'vault_state_immutable()',
  'prevent_platform_audit_mutation()',
]
const normalizedMigration = migration.replace(/\s+/g, ' ').toLowerCase()

describe('Story 24.5a migration 0080 static contract', () => {
  it('revokes PUBLIC EXECUTE by full signature on all seven functions', () => {
    expect(migration).not.toBe('')
    for (const signature of [...PURGE_FUNCTIONS, ...TRIGGER_FUNCTIONS]) {
      expect(normalizedMigration).toContain(
        `revoke execute on function ${signature.toLowerCase()} from public`
      )
    }
    expect(migration).not.toMatch(
      /REVOKE[\s\S]*ON ALL FUNCTIONS IN SCHEMA public[\s\S]*FROM PUBLIC/i
    )
  })

  it('re-grants only the two purge functions to vault_app and narrows future defaults', () => {
    expect(normalizedMigration.match(/grant execute on function/g)).toHaveLength(4)
    for (const signature of PURGE_FUNCTIONS) {
      expect(normalizedMigration).toContain(
        `grant execute on function ${signature.toLowerCase()} to vault_app`
      )
    }
    expect(normalizedMigration).toContain(
      'alter default privileges in schema public revoke execute on functions from public'
    )
    const grantStatements = migration
      .split('\n')
      .filter((line) => /^\s*GRANT\b/i.test(line))
      .join('\n')
    expect(grantStatements).not.toMatch(/\bTO\s+PUBLIC/i)
    expect(migration).not.toMatch(/vault_extension/i)
  })

  it('contains only ACL/default-privilege work and no function body or data operation', () => {
    expect(normalizedMigration).not.toContain('create function')
    expect(normalizedMigration).not.toContain('create or replace function')
    for (const forbiddenFragment of [
      'delete from',
      'drop table',
      'drop column',
      'drop constraint',
      'truncate',
      'alter column',
    ]) {
      expect(normalizedMigration).not.toContain(forbiddenFragment)
    }
    expect(migration).toMatch(/this connection cannot revoke/i)
    expect(migration).toMatch(/ROLLBACK|intentionally not rolled back/i)
    expect(KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS).toHaveProperty(
      '0080_security_definer_function_grants'
    )
  })

  it('records both corrected applied-migration comments and the caller-enforcement boundary', () => {
    const migration0036 = readFileSync(
      resolve(import.meta.dirname, '../migrations/0036_audit_search_export_forwarding.sql'),
      'utf8'
    )
    const migration0042 = readFileSync(
      resolve(import.meta.dirname, '../migrations/0042_platform_audit_retention_purge.sql'),
      'utf8'
    )
    const combined = `${migration0036}\n${migration0042}`
    expect(combined).not.toMatch(/keeps this broad EXECUTE grant safe/i)
    expect(migration0036).toMatch(/caller-supplied values|consistency check/i)
    expect(migration0042).toMatch(/caller-enforced|no internal guard/i)
    expect(migration0042).toMatch(/function.*EXECUTE.*ACL.*who may call/i)
  })
})

const appUrl = process.env['DATABASE_URL']
const privilegedUrl = process.env['SUPERUSER_DATABASE_URL'] ?? process.env['ADMIN_DATABASE_URL']
const describeDatabase = appUrl && privilegedUrl ? describe : describe.skip

if (!appUrl || !privilegedUrl) {
  // eslint-disable-next-line no-console -- make the intentional integration-test skip visible
  console.warn(
    'Story 24.5a privilege integration tests skipped: DATABASE_URL and SUPERUSER_DATABASE_URL (or ADMIN_DATABASE_URL) are required'
  )
}

describeDatabase('Story 24.5a privilege integration', () => {
  const appSql = postgres(appUrl as string, { max: 1 })
  const adminSql = postgres(privilegedUrl as string, { max: 1 })
  let canManageRoles = false

  beforeAll(async () => {
    const [identity] = await adminSql<
      { current_user: string; rolsuper: boolean; rolcreaterole: boolean }[]
    >`
      SELECT current_user, r.rolsuper, r.rolcreaterole
      FROM pg_roles r
      WHERE r.rolname = current_user
    `
    canManageRoles = Boolean(identity?.rolsuper || identity?.rolcreaterole)
    if (!canManageRoles) {
      // eslint-disable-next-line no-console -- explain the required CI credential wiring
      console.warn(
        `Story 24.5a privilege denial test skipped: ${identity?.current_user ?? 'unknown'} cannot create/drop cluster roles; use SUPERUSER_DATABASE_URL`
      )
    }
  })

  afterAll(async () => {
    await appSql.end()
    await adminSql.end()
  })

  it('runs the catalog assertions as vault_app before checking ACLs', async () => {
    const [row] = await appSql<
      {
        current_user: string
        public_purge: boolean
        public_trigger: boolean
        app_purge: boolean
        public_create: boolean
        purge_owner: string
      }[]
    >`
      SELECT
        current_user,
        has_function_privilege('public', 'purge_expired_platform_audit_entries(timestamptz)', 'EXECUTE') AS public_purge,
        has_function_privilege('public', 'prevent_audit_log_mutation()', 'EXECUTE') AS public_trigger,
        has_function_privilege('vault_app', 'purge_expired_platform_audit_entries(timestamptz)', 'EXECUTE') AS app_purge,
        has_schema_privilege('vault_app', 'public', 'CREATE') AS public_create,
        (SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.proname = 'purge_expired_platform_audit_entries'
            AND p.pronamespace = 'public'::regnamespace
            AND oidvectortypes(p.proargtypes) = 'timestamp with time zone') AS purge_owner
    `
    expect(row?.current_user, 'privilege assertions must run as vault_app').toBe('vault_app')
    expect(row?.public_purge).toBe(false)
    expect(row?.public_trigger).toBe(false)
    expect(row?.app_purge).toBe(true)
    expect(row?.public_create).toBe(false)
    expect(row?.purge_owner).not.toBe('vault_app')
  })

  it('denies PUBLIC EXECUTE to a function newly created by the migration issuer', async () => {
    const functionName = `story245_default_probe_${Date.now()}`
    try {
      await adminSql.unsafe(
        `CREATE FUNCTION public.${functionName}() RETURNS integer LANGUAGE SQL AS $$SELECT 1$$`
      )
      const [row] = await adminSql<
        {
          current_user: string
          function_owner: string
          public_execute: boolean
          app_execute: boolean
        }[]
      >`
        SELECT
          current_user,
          owner.rolname AS function_owner,
          has_function_privilege('public', ${`public.${functionName}()`}, 'EXECUTE') AS public_execute,
          has_function_privilege('vault_app', ${`public.${functionName}()`}, 'EXECUTE') AS app_execute
        FROM pg_proc probe
        JOIN pg_roles owner ON owner.oid = probe.proowner
        WHERE probe.oid = ${`public.${functionName}()`}::regprocedure
      `
      expect(row?.current_user, 'default ACL assertion must identify its issuer').toBeTruthy()
      expect(row?.function_owner).toBe(row?.current_user)
      expect(row?.public_execute).toBe(false)
      expect(row?.app_execute).toBe(false)
    } finally {
      await adminSql.unsafe(`DROP FUNCTION IF EXISTS public.${functionName}()`)
    }
  })

  it('denies a separate connection with SQLSTATE 42501 and deletes nothing', async ({ skip }) => {
    if (!canManageRoles) {
      skip()
      return
    }
    const roleName = `pv_denytest_${Date.now()}_${Math.floor(Math.random() * 10000)}`
    const credentialValue = `pv_test_${Math.random().toString(36).slice(2)}`
    const lockKey = 245050080
    await adminSql`SELECT pg_advisory_lock(${lockKey})`
    let deniedSql: ReturnType<typeof postgres> | undefined
    const cleanupRole = async () => {
      try {
        await adminSql.unsafe(`DROP OWNED BY "${roleName}"`)
      } catch {
        // The role may not exist yet during setup.
      }
      await adminSql.unsafe(`DROP ROLE IF EXISTS "${roleName}"`)
    }
    try {
      await cleanupRole()
      await adminSql.unsafe(
        `CREATE ROLE "${roleName}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${credentialValue}'`
      )
      const roleUrl = new URL(privilegedUrl as string)
      roleUrl.username = roleName
      roleUrl.password = credentialValue
      deniedSql = postgres(roleUrl.toString(), { max: 1 })
      try {
        const [identity] = await deniedSql<{ current_user: string }[]>`SELECT current_user`
        expect(identity?.current_user, 'denial test must run as its throwaway role').toBe(roleName)
        const [before] = await adminSql<{ platform_count: string; org_count: string }[]>`
          SELECT
            (SELECT count(*) FROM platform_audit_events) AS platform_count,
            (SELECT count(*) FROM audit_log_entries) AS org_count
        `
        await expect(
          deniedSql`SELECT purge_expired_platform_audit_entries(now())`
        ).rejects.toMatchObject({ code: '42501' })
        await expect(
          deniedSql`SELECT purge_expired_audit_log_entries('00000000-0000-0000-0000-000000000000'::uuid, now())`
        ).rejects.toMatchObject({ code: '42501' })
        await deniedSql`SELECT set_config('app.current_org_id', '00000000-0000-0000-0000-000000000000', true)`
        await expect(
          deniedSql`SELECT purge_expired_audit_log_entries('00000000-0000-0000-0000-000000000000'::uuid, now())`
        ).rejects.toMatchObject({ code: '42501' })
        const [after] = await adminSql<{ platform_count: string; org_count: string }[]>`
          SELECT
            (SELECT count(*) FROM platform_audit_events) AS platform_count,
            (SELECT count(*) FROM audit_log_entries) AS org_count
        `
        expect(after).toEqual(before)
      } finally {
        await deniedSql.end()
        deniedSql = undefined
      }
    } finally {
      try {
        if (deniedSql) {
          await deniedSql.end()
        }
      } finally {
        try {
          await cleanupRole()
        } finally {
          await adminSql`SELECT pg_advisory_unlock(${lockKey})`
        }
      }
    }
  })
})
