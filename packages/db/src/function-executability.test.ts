import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import {
  CANONICAL_FUNCTION_EXECUTABILITY_SQL,
  FUNCTION_EXECUTABILITY_CONTRACT,
  inspectFunctionExecutability,
  type FunctionExecutabilityReport,
} from './function-executability.js'

const migrationDirectory = resolve(import.meta.dirname, 'migrations')
const appUrl = process.env['DATABASE_URL']
const adminUrl = process.env['SUPERUSER_DATABASE_URL'] ?? process.env['ADMIN_DATABASE_URL']

function requireDatabaseUrls(): { appUrl: string; adminUrl: string } {
  if (!appUrl || !adminUrl) {
    throw new Error(
      'Story 24.5b real-Postgres tests require DATABASE_URL and SUPERUSER_DATABASE_URL (or ADMIN_DATABASE_URL)'
    )
  }
  return { appUrl, adminUrl }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function migrationFunctionNames(): string[] {
  return readdirSync(migrationDirectory)
    .filter((file) => file.endsWith('.sql'))
    .flatMap((file) => {
      const source = readFileSync(resolve(migrationDirectory, file), 'utf8')
      return [
        ...source.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([\w"]+)\s*\(/gi),
      ].flatMap((match) => (match[1] ? [match[1].replaceAll('"', '')] : []))
    })
}

describe('Story 24.5b canonical function-executability contract', () => {
  it('contains one structural pg_proc/pg_depend/pg_extension predicate and privilege check', () => {
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(/pg_proc/i)
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(/pg_depend/i)
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(/pg_extension/i)
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(/deptype\s*=\s*'e'/i)
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(/has_function_privilege/i)
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(/prokind\s+IN\s*\('f',\s*'p'\)/i)
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(/pg_trgm/i)
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(/pg_get_function_identity_arguments/i)
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(/pg_default_acl/i)
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(
      /defaclnamespace\s*=\s*'public'::regnamespace/i
    )
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(/expected_migration_function_owner/i)
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(
      /identity text PRIMARY KEY[\s\S]*CHECK[\s\S]*position\('\(' in identity\)/i
    )
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(
      /reason text NOT NULL[\s\S]*CHECK[\s\S]*btrim\(reason\)/i
    )
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).not.toMatch(/proname\s+NOT\s+IN/i)
    expect(FUNCTION_EXECUTABILITY_CONTRACT.pinnedExtensionNames).toEqual(['pg_trgm'])
    expect(FUNCTION_EXECUTABILITY_CONTRACT.expectedMigrationFunctionOwnerRole).toBe('postgres')
    expect(FUNCTION_EXECUTABILITY_CONTRACT.reviewedPublicExecutableAllowlist).toEqual([])
    expect(FUNCTION_EXECUTABILITY_CONTRACT.sql).toBe(CANONICAL_FUNCTION_EXECUTABILITY_SQL)
  })
})

describe('Story 24.5b real-Postgres invariant', () => {
  const appSql = postgres(appUrl ?? 'postgresql://invalid', { max: 1 })
  const adminSql = postgres(adminUrl ?? 'postgresql://invalid', { max: 1 })
  let baseline: FunctionExecutabilityReport

  beforeAll(async () => {
    requireDatabaseUrls()
    baseline = await inspectFunctionExecutability(appSql)
  })

  afterAll(async () => {
    await appSql.end()
    await adminSql.end()
  })

  it('discovers the current hand-written functions and extension-owned functions dynamically', () => {
    expect(baseline.inScopeFunctionCount).toBeGreaterThanOrEqual(7)
    expect(baseline.extensionFunctionCount).toBeGreaterThan(0)
    expect(baseline.violations).toEqual([])
    expect(baseline.inScopeFunctionSignatures).toEqual(
      expect.arrayContaining([
        'public.purge_expired_audit_log_entries(uuid, timestamp with time zone)',
        'public.purge_expired_platform_audit_entries(timestamp with time zone)',
      ])
    )
  })

  it('cross-checks every migration CREATE FUNCTION name against the live catalog', async () => {
    const names = [...new Set(migrationFunctionNames())]
    const rows = await appSql<{ proname: string }[]>`
      SELECT DISTINCT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY(${appSql.array(names)})
    `
    expect(rows.map((row) => row.proname)).toEqual(expect.arrayContaining(names))
  })

  it('fails for a deliberate violating function, preserves overload identity, and recovers after revoke', async () => {
    requireDatabaseUrls()
    const suffix = Date.now().toString(36)
    const functionName = `story_24_5b_probe_${suffix}`
    const quotedName = quoteIdentifier(functionName)
    try {
      await adminSql.unsafe(
        `CREATE FUNCTION public.${quotedName}(integer) RETURNS integer LANGUAGE SQL AS $$SELECT $1$$`
      )
      await adminSql.unsafe(
        `CREATE FUNCTION public.${quotedName}(text) RETURNS text LANGUAGE SQL AS $$SELECT $1$$`
      )
      await adminSql.unsafe(`GRANT EXECUTE ON FUNCTION public.${quotedName}(integer) TO PUBLIC`)
      await adminSql.unsafe(`GRANT EXECUTE ON FUNCTION public.${quotedName}(text) TO PUBLIC`)

      const violating = await inspectFunctionExecutability(appSql)
      expect(violating.violations.filter((row) => row.kind === 'function')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            signature: `public.${functionName}(integer)`,
          }),
          expect.objectContaining({
            signature: `public.${functionName}(text)`,
          }),
        ])
      )

      await adminSql.unsafe(`REVOKE EXECUTE ON FUNCTION public.${quotedName}(integer) FROM PUBLIC`)
      await adminSql.unsafe(`REVOKE EXECUTE ON FUNCTION public.${quotedName}(text) FROM PUBLIC`)
      const recovered = await inspectFunctionExecutability(appSql)
      expect(recovered.violations.filter((row) => row.signature?.includes(functionName))).toEqual(
        []
      )
    } finally {
      await adminSql.unsafe(`DROP FUNCTION IF EXISTS public.${quotedName}(integer)`)
      await adminSql.unsafe(`DROP FUNCTION IF EXISTS public.${quotedName}(text)`)
    }
  })

  it('does not exclude an extension-like hand-written name and keeps pg_trgm exceptions structural', async () => {
    requireDatabaseUrls()
    const functionName = `gin_extract_query_trgm_story_24_5b_${Date.now().toString(36)}`
    try {
      await adminSql.unsafe(
        `CREATE FUNCTION public.${quoteIdentifier(functionName)}() RETURNS integer LANGUAGE SQL AS $$SELECT 1$$`
      )
      await adminSql.unsafe(
        `GRANT EXECUTE ON FUNCTION public.${quoteIdentifier(functionName)}() TO PUBLIC`
      )
      const report = await inspectFunctionExecutability(appSql)
      expect(report.violations).toContainEqual(
        expect.objectContaining({ signature: `public.${functionName}()` })
      )
      expect(
        report.extensionFunctionSignatures.some((signature) => signature.includes('trgm'))
      ).toBe(true)
    } finally {
      await adminSql.unsafe(`DROP FUNCTION IF EXISTS public.${quoteIdentifier(functionName)}()`)
    }
  })

  it('catches a default-ACL revoke re-keyed to a restoring role', async () => {
    requireDatabaseUrls()
    const [owner] = await appSql<{ owner: string }[]>`
      SELECT r.rolname AS owner
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname = 'public' AND p.proname = 'purge_expired_platform_audit_entries'
      LIMIT 1
    `
    const ownerName = owner?.owner
    expect(ownerName).toBeTruthy()
    if (!ownerName) throw new Error('expected a migration-created function owner')
    const restoringRole = `story_24_5b_restore_${Date.now().toString(36)}`
    try {
      await adminSql.unsafe(`CREATE ROLE ${quoteIdentifier(restoringRole)} NOLOGIN`)
      await adminSql.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(ownerName)} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`
      )
      await adminSql.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(restoringRole)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
      )

      const report = await inspectFunctionExecutability(appSql)
      expect(report.violations).toContainEqual(
        expect.objectContaining({
          kind: 'default_acl',
          detail: expect.stringContaining(ownerName),
        })
      )
    } finally {
      await adminSql.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(restoringRole)} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`
      )
      await adminSql.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(ownerName)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
      )
      await adminSql.unsafe(`DROP ROLE IF EXISTS ${quoteIdentifier(restoringRole)}`)
    }
  })

  it('catches a PUBLIC grant in the public-schema default ACL even when the global row is safe', async () => {
    requireDatabaseUrls()
    const ownerName = 'postgres'
    try {
      await adminSql.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(ownerName)} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC`
      )

      const report = await inspectFunctionExecutability(appSql)
      expect(report.violations).toContainEqual(
        expect.objectContaining({
          kind: 'default_acl',
          detail: expect.stringContaining('schema public'),
        })
      )
    } finally {
      await adminSql.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(ownerName)} IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
      )
    }
  })

  it('runs without tenant context and does not touch application or audit rows', async () => {
    const [before] = await appSql<{ org_setting: string | null; audit_count: string }[]>`
      SELECT current_setting('app.current_org_id', true) AS org_setting,
             (SELECT count(*)::text FROM audit_log_entries) AS audit_count
    `
    const report = await inspectFunctionExecutability(appSql)
    const [after] = await appSql<{ org_setting: string | null; audit_count: string }[]>`
      SELECT current_setting('app.current_org_id', true) AS org_setting,
             (SELECT count(*)::text FROM audit_log_entries) AS audit_count
    `
    expect(report.violations).toEqual([])
    expect(after).toEqual(before)
    expect(after?.org_setting).toBeNull()
  })
})
