import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'

const migrationSql = readFileSync(
  resolve(import.meta.dirname, '../migrations/0070_rls_ownership_and_force.sql'),
  'utf8'
)
const adminConnectionString = process.env['SUPERUSER_DATABASE_URL'] ?? ''
if (!adminConnectionString) {
  throw new Error('SUPERUSER_DATABASE_URL is required for Story 24.1 migration integration tests')
}
const adminSql = postgres(adminConnectionString)

const ROLE_NAME = 'vault_owner'

function databaseUrl(databaseName: string): string {
  return adminConnectionString.replace(/\/[^/]*$/, `/${databaseName}`)
}

async function withTemporaryDatabase<T>(fn: (databaseName: string) => Promise<T>): Promise<T> {
  const databaseName = `story24_1_role_${Date.now()}_${Math.floor(Math.random() * 1000)}`
  await adminSql.unsafe(`CREATE DATABASE ${databaseName}`)
  try {
    return await fn(databaseName)
  } finally {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`)
  }
}

async function ensureSafeOwnerRole(): Promise<boolean> {
  const rows = await adminSql<
    {
      rolsuper: boolean
      rolbypassrls: boolean
      rolcanlogin: boolean
      rolcreatedb: boolean
      rolcreaterole: boolean
      rolinherit: boolean
    }[]
  >`
    SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole, rolinherit
    FROM pg_roles
    WHERE rolname = ${ROLE_NAME}
  `
  if (rows[0]) {
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: true,
    })
    return false
  }
  await adminSql.unsafe(
    `CREATE ROLE ${ROLE_NAME} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT`
  )
  return true
}

async function restoreSafeOwnerRole(createdByTest: boolean): Promise<void> {
  if (createdByTest) {
    await adminSql.unsafe(`DROP ROLE ${ROLE_NAME}`)
  } else {
    await adminSql.unsafe(
      `ALTER ROLE ${ROLE_NAME} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT`
    )
  }
}

describe('migration 0070 vault_owner preflight', () => {
  afterAll(async () => {
    await adminSql.end()
  })

  it.each([
    ['LOGIN', `ALTER ROLE ${ROLE_NAME} LOGIN`],
    ['SUPERUSER', `ALTER ROLE ${ROLE_NAME} SUPERUSER`],
    ['BYPASSRLS', `ALTER ROLE ${ROLE_NAME} BYPASSRLS`],
  ])('fails clearly for a pre-existing %s vault_owner', async (_, makeUnsafe) => {
    const createdByTest = await ensureSafeOwnerRole()
    await adminSql.unsafe(makeUnsafe)
    try {
      await withTemporaryDatabase(async (databaseName) => {
        const databaseSql = postgres(databaseUrl(databaseName))
        try {
          await expect(databaseSql.unsafe(migrationSql)).rejects.toThrow(
            /pre-existing vault_owner|unsafe.*vault_owner|vault_owner.*must be/i
          )
        } finally {
          await databaseSql.end()
        }
      })
    } finally {
      await restoreSafeOwnerRole(createdByTest)
    }
  })

  it('fails clearly when a role is already a member of vault_owner', async () => {
    const memberRole = `story24_1_member_${Date.now()}_${Math.floor(Math.random() * 1000)}`
    await adminSql.unsafe(`CREATE ROLE ${memberRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await adminSql.unsafe(`GRANT vault_owner TO ${memberRole}`)
    try {
      await withTemporaryDatabase(async (databaseName) => {
        const databaseSql = postgres(databaseUrl(databaseName))
        try {
          await expect(databaseSql.unsafe(migrationSql)).rejects.toThrow(
            /vault_owner must have no role members|role members/i
          )
        } finally {
          await databaseSql.end()
        }
      })
    } finally {
      await adminSql.unsafe(`REVOKE vault_owner FROM ${memberRole}`)
      await adminSql.unsafe(`DROP ROLE ${memberRole}`)
    }
  })

  it('allows a safe pre-existing vault_owner and configures table and sequence defaults', async () => {
    const createdByTest = await ensureSafeOwnerRole()
    try {
      await withTemporaryDatabase(async (databaseName) => {
        const databaseSql = postgres(databaseUrl(databaseName))
        try {
          await expect(databaseSql.unsafe(migrationSql)).resolves.toBeDefined()
          const defaults = await databaseSql<{ object_type: string; privilege_type: string }[]>`
            SELECT CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' END AS object_type,
                   acl.privilege_type
            FROM pg_default_acl d
            JOIN pg_roles grantor ON grantor.oid = d.defaclrole
            JOIN pg_namespace n ON n.oid = d.defaclnamespace
            CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
            JOIN pg_roles grantee ON grantee.oid = acl.grantee
            WHERE grantor.rolname = ${ROLE_NAME}
              AND grantee.rolname = 'vault_app'
              AND n.nspname = 'public'
              AND d.defaclobjtype IN ('r', 'S')
          `
          expect(defaults).toEqual(
            expect.arrayContaining([
              { object_type: 'TABLES', privilege_type: 'SELECT' },
              { object_type: 'TABLES', privilege_type: 'INSERT' },
              { object_type: 'TABLES', privilege_type: 'UPDATE' },
              { object_type: 'TABLES', privilege_type: 'DELETE' },
              { object_type: 'SEQUENCES', privilege_type: 'USAGE' },
              { object_type: 'SEQUENCES', privilege_type: 'SELECT' },
            ])
          )
        } finally {
          await databaseSql.end()
        }
      })
    } finally {
      await restoreSafeOwnerRole(createdByTest)
    }
  })
})
