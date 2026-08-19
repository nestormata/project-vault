#!/usr/bin/env tsx
import postgres from 'postgres'
import {
  assertFunctionExecutability,
  FunctionExecutabilityViolationError,
} from '../packages/db/src/function-executability.js'
import { runDbCheck } from './lib/run-db-check.js'

runDbCheck({
  check: (sql: postgres.Sql) => assertFunctionExecutability(sql),
  successMessage: 'function-executability-check: OK',
  onError: (error) => {
    if (error instanceof FunctionExecutabilityViolationError) {
      process.stderr.write(
        [
          'FATAL: function executability invariant failed',
          error.message.replace(/^function executability invariant failed\n/, ''),
          'Revoke PUBLIC EXECUTE from the reported full signature and rerun the check.',
          '',
        ].join('\n')
      )
      return
    }

    // Never echo a driver error: postgres.js may include a connection string or server detail.
    process.stderr.write('FATAL: Cannot inspect PostgreSQL function executability catalog\n')
  },
})
