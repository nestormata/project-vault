#!/usr/bin/env tsx
import {
  checkAuditActorTokenCoverage,
  AuditActorTokenCoverageGapError,
} from '../packages/db/src/check-audit-actor-token-coverage.js'
import { runDbCheck } from './lib/run-db-check.js'

runDbCheck({
  check: checkAuditActorTokenCoverage,
  successMessage:
    'check-audit-actor-token-coverage: all human-actor audit rows reference a user_identity_token — OK',
  onError: (error) => {
    if (error instanceof AuditActorTokenCoverageGapError) {
      const noun = error.gapCount === 1 ? 'row' : 'rows'
      process.stderr.write(
        [
          `FATAL: audit actor-token coverage gap detected — ${error.gapCount} human-actor audit ${noun} has no actor_token_id`,
          "and cannot be pseudonymized under Story 8.3's GDPR erasure flow.",
          'Investigate the write path that produced this row before merging.',
          '',
        ].join('\n')
      )
    } else {
      process.stderr.write(`FATAL: Cannot connect to PostgreSQL: ${(error as Error).message}\n`)
    }
  },
})
