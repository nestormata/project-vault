import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { CANONICAL_FUNCTION_EXECUTABILITY_SQL } from '../packages/db/src/function-executability.js'

const databaseUrl = process.env['SUPERUSER_DATABASE_URL'] ?? process.env['ADMIN_DATABASE_URL']
const sqlPath = resolve(import.meta.dirname, 'sql/check-function-executability.sql')
const repositoryRoot = resolve(import.meta.dirname, '..')
const cleanupClients: ReturnType<typeof postgres>[] = []

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error(
      'Story 24.5b SQL twin tests require SUPERUSER_DATABASE_URL or ADMIN_DATABASE_URL'
    )
  }
  return databaseUrl
}

afterEach(async () => {
  for (const client of cleanupClients.splice(0)) await client.end()
})

describe('Story 24.5b SQL-only psql twin', () => {
  it('uses ON_ERROR_STOP and the canonical query rather than a prose copy', () => {
    const sql = readFileSync(sqlPath, 'utf8')
    expect(sql).toMatch(/ON_ERROR_STOP/i)
    expect(sql).toContain('function_executability_violations')
    expect(CANONICAL_FUNCTION_EXECUTABILITY_SQL).toMatch(/CREATE TEMP TABLE/i)
  })

  it('is wired into the root command, Makefile ci-inner, and authoritative GitHub checks', () => {
    const packageJson = readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')
    const dbPackageJson = readFileSync(resolve(repositoryRoot, 'packages/db/package.json'), 'utf8')
    const makefile = readFileSync(resolve(repositoryRoot, 'Makefile'), 'utf8')
    const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8')
    const runbook = readFileSync(
      resolve(repositoryRoot, 'docs/runbooks/function-executability.md'),
      'utf8'
    )
    expect(packageJson).toContain(
      '"check-function-executability": "tsx scripts/check-function-executability.ts"'
    )
    expect(dbPackageJson).toContain(
      'cp src/sql/function-executability.sql dist/sql/function-executability.sql'
    )
    expect(makefile).toContain('check-function-executability:')
    expect(makefile).toContain('$(MAKE) check-function-executability')
    expect(workflow).toContain('Check function executability invariant (Story 24.5b)')
    expect(workflow).toContain('run: pnpm check-function-executability')
    expect(workflow).toContain(
      'pnpm vitest run --no-file-parallelism packages/db/src/function-executability.test.ts scripts/check-function-executability.test.ts'
    )
    expect(makefile).toContain(
      'pnpm vitest run --no-file-parallelism packages/db/src/function-executability.test.ts scripts/check-function-executability.test.ts'
    )
    expect(runbook).toContain('psql')
    expect(runbook).toContain('PUBLIC EXECUTE')
  })

  it('passes clean and fails non-zero with a redacted diagnostic for a violating fixture', async () => {
    const url = requireDatabaseUrl()
    const client = postgres(url, { max: 1 })
    cleanupClients.push(client)
    const functionName = `story_24_5b_psql_${Date.now().toString(36)}`
    const quotedName = `"${functionName}"`
    try {
      const clean = execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', sqlPath], {
        encoding: 'utf8',
        env: { ...process.env, PGPASSWORD: undefined },
      })
      expect(clean).toContain('function-executability-check: OK')

      await client.unsafe(
        `CREATE FUNCTION public.${quotedName}() RETURNS integer LANGUAGE SQL AS $$SELECT 1$$`
      )
      await client.unsafe(`GRANT EXECUTE ON FUNCTION public.${quotedName}() TO PUBLIC`)
      let failure: { status?: number; stdout?: string; stderr?: string } | undefined
      try {
        execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', sqlPath], {
          encoding: 'utf8',
          env: { ...process.env, PGPASSWORD: undefined },
        })
      } catch (error) {
        const result = error as { status?: number; stdout?: string; stderr?: string }
        failure = result
      }
      expect(failure?.status).not.toBe(0)
      const diagnostics = `${failure?.stdout ?? ''}\n${failure?.stderr ?? ''}`
      expect(diagnostics).toContain(functionName)
      expect(diagnostics).not.toContain(url)
      expect(diagnostics).not.toMatch(/password|postgresql:\/\//i)
    } finally {
      await client.unsafe(`DROP FUNCTION IF EXISTS public.${quotedName}()`)
    }
  })
})
