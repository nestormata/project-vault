import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import postgres from 'postgres'
import {
  checkAuditActorTokenCoverage,
  AuditActorTokenCoverageGapError,
} from '../check-audit-actor-token-coverage.js'

// Unlike checkRlsCoverage (which only queries RLS-exempt catalog views: pg_policies /
// information_schema), checkAuditActorTokenCoverage queries live audit_log_entries rows, which
// ARE subject to the org-scoped audit_log_isolation RLS policy. A database-wide gate must see
// every org's rows, not just whichever single org happens to be set in app.current_org_id on a
// given connection — so this check (both here and in the Makefile's `ci` wiring) always runs
// against the Postgres superuser connection, which bypasses RLS entirely by design.
const adminConnectionString =
  process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://postgres:password@localhost:5432/project_vault'
const adminSql = postgres(adminConnectionString)

/** Sentinel thrown to force `adminSql.begin()` to roll back a test fixture — never a real failure. */
class RollbackTestTransaction extends Error {}

describe('checkAuditActorTokenCoverage', () => {
  it('resolves when every human-actor audit row has a non-null actor_token_id (AC-13)', async () => {
    await expect(checkAuditActorTokenCoverage(adminSql)).resolves.toBeUndefined()
  })

  it(
    'throws AuditActorTokenCoverageGapError for a human-actor row with a null actor_token_id ' +
      '(AC-14) without leaving the dirty row behind',
    async () => {
      let caught: unknown

      // AC-14's isolation requirement: audit_log_entries is append-only (withTestOrg's cleanup
      // never deletes from it), so a dirty row inserted outside a transaction would permanently
      // poison the "clean database" assertion above for every later run against this Postgres
      // instance. Wrap the insert AND the check in a transaction that is always rolled back.
      await adminSql
        .begin(async (tx) => {
          const orgId = randomUUID()
          await tx`
            INSERT INTO organizations (id, name, slug)
            VALUES (${orgId}, ${'coverage-gap-test'}, ${'coverage-gap-test-' + orgId.slice(0, 8)})
          `
          await tx`
            INSERT INTO audit_log_entries
              (org_id, actor_type, actor_token_id, event_type, key_version, hmac)
            VALUES
              (${orgId}, 'human', NULL, 'test.event', 1, ${'deadbeef'.repeat(8)})
          `

          try {
            await checkAuditActorTokenCoverage(tx)
          } catch (error) {
            caught = error
          }

          throw new RollbackTestTransaction('AC-14 fixture rollback — not a real failure')
        })
        .catch((error) => {
          if (!(error instanceof RollbackTestTransaction)) throw error
        })

      expect(caught).toBeInstanceOf(AuditActorTokenCoverageGapError)
      expect((caught as AuditActorTokenCoverageGapError).gapCount).toBe(1)

      // The dirty row must not have survived the rollback — re-assert the clean-database case.
      await expect(checkAuditActorTokenCoverage(adminSql)).resolves.toBeUndefined()
    }
  )
})
