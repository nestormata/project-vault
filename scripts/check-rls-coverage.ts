#!/usr/bin/env tsx
import postgres from 'postgres'
import { checkRlsCoverage, RlsCoverageGapError } from '../packages/db/src/check-rls-coverage.js'

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) {
    process.stderr.write('FATAL: DATABASE_URL is not set\n')
    process.exit(1)
    return
  }

  const sql = postgres(databaseUrl)

  try {
    await checkRlsCoverage(sql)
    process.stdout.write('check-rls-coverage: all org_id tables have RLS policies — OK\n')
  } catch (error) {
    if (error instanceof RlsCoverageGapError) {
      process.stderr.write(
        'FATAL: RLS coverage gap detected — the following tables have org_id but no RLS policy:\n'
      )
      for (const table of error.gaps) {
        process.stderr.write(`  - ${table}\n`)
      }
      process.stderr.write(
        "\nFix:\n  ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;\n  CREATE POLICY <table>_isolation ON <table>\n    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);\n"
      )
    } else if ((error as Error).message === 'No tables found — run db:migrate first') {
      process.stderr.write('FATAL: No tables found — run db:migrate first\n')
    } else {
      process.stderr.write(`FATAL: Cannot connect to PostgreSQL: ${(error as Error).message}\n`)
    }
    process.exitCode = 1
  } finally {
    await sql.end()
  }
}

main()
