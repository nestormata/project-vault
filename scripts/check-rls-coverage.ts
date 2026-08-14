#!/usr/bin/env tsx
import {
  checkRlsCoverage,
  RlsCoverageDriftError,
  RlsCoverageGapError,
} from '../packages/db/src/check-rls-coverage.js'
import { runDbCheck } from './lib/run-db-check.js'

runDbCheck({
  check: checkRlsCoverage,
  successMessage: 'check-rls-coverage: RLS policy, state, ownership, grants, and view checks — OK',
  onError: (error) => {
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
    } else if (error instanceof RlsCoverageDriftError) {
      process.stderr.write(`FATAL: ${error.dimension} drift detected:\n`)
      for (const gap of error.gaps) process.stderr.write(`  - ${gap}\n`)
    } else if ((error as Error).message === 'No tables found — run db:migrate first') {
      process.stderr.write('FATAL: No tables found — run db:migrate first\n')
    } else {
      process.stderr.write(`FATAL: Cannot connect to PostgreSQL: ${(error as Error).message}\n`)
    }
  },
})
