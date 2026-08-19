#!/usr/bin/env tsx
import postgres from 'postgres'
import { runDbCheck } from './lib/run-db-check.js'

async function checkExtensionRole(sql: postgres.Sql): Promise<void> {
  const [role] = await sql<
    {
      rolsuper: boolean
      rolcreatedb: boolean
      rolcreaterole: boolean
      rolbypassrls: boolean
      rolinherit: boolean
    }[]
  >`
    SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit
      FROM pg_roles
     WHERE rolname = 'vault_extension'
  `
  if (!role) throw new Error('vault_extension role is missing')
  if (Object.values(role).some(Boolean)) {
    throw new Error('vault_extension has an unsafe role attribute')
  }

  const [defaultPrivilege] = await sql<{ detail: string }[]>`
    SELECT format('default ACL in %s grants %s', n.nspname, acl.privilege_type) AS detail
      FROM pg_default_acl d
      JOIN pg_roles grantee_role ON grantee_role.rolname = 'vault_extension'
      LEFT JOIN pg_namespace n ON n.oid = NULLIF(d.defaclnamespace, 0)
      CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
     WHERE acl.grantee = grantee_role.oid
     LIMIT 1
  `
  if (defaultPrivilege) throw new Error(defaultPrivilege.detail)

  const nonPublicSchema = await sql<{ nspname: string }[]>`
    SELECT nspname
      FROM pg_namespace
     WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema')
       AND has_schema_privilege('vault_extension', oid, 'USAGE')
  `
  if (nonPublicSchema.length > 0) {
    throw new Error(
      `vault_extension has non-public schema USAGE: ${nonPublicSchema.map((row) => row.nspname).join(', ')}`
    )
  }

  const [unsafeFunction] = await sql<{ identity: string }[]>`
    SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS identity
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
            AND e.extname IN ('pg_trgm')
       )
       AND has_function_privilege('vault_extension', p.oid, 'EXECUTE')
     LIMIT 1
  `
  if (unsafeFunction) throw new Error(`vault_extension can execute ${unsafeFunction.identity}`)

  const [unsafeOwner] = await sql<{ relname: string }[]>`
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles owner_role ON owner_role.oid = c.relowner
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND (
         owner_role.rolname = 'vault_extension'
         OR pg_has_role('vault_extension', c.relowner, 'USAGE')
       )
     LIMIT 1
  `
  if (unsafeOwner)
    throw new Error(`vault_extension owns or inherits ownership of ${unsafeOwner.relname}`)
}

runDbCheck({
  check: checkExtensionRole,
  successMessage:
    'check-extension-db-role: role, default ACL, function, schema, and ownership invariants — OK',
  onError: (error) => {
    process.stderr.write(
      `FATAL: extension role catalog invariant failed: ${(error as Error).message}\n`
    )
  },
})
