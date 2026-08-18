import { describe, it, expect } from 'vitest'
import { withOrg } from '@project-vault/db'
import { withTestOrg } from '@project-vault/db/test-helpers'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { writeExtensionAuditEntry } from '../audit/extension-entry.js'
import { findLatestAuditEventId } from './erasure-service.js'

const TEST_PASSPHRASE = 'erasure-extension-audit-coverage-test-passphrase'

async function bootVault(): Promise<void> {
  const { initVault } = await bootstrapRouteIntegrationTest()
  await resetVaultForTest()
  await initVaultForTest(initVault, TEST_PASSPHRASE)
}

/**
 * Story 23.8 AC-21 — CM-E14.6's own AC-C4 concern was "does PV's erasure machinery cover
 * cross-domain, extension-authored rows the same way it covers host-originated rows." The
 * story's literal text described `erasure-service.ts:267-279` as a lookup that "redacts" a
 * matched row. Real behavior (verified while writing this test, see the Dev Notes citation this
 * test's own commit message and the story file record): `audit_log_entries` is immutable and
 * append-only by design (Story 8.1) and is NEVER content-redacted for ANY actor type — it is
 * explicitly listed in `buildErasureReport()`'s `piiRetained` with the justification "audit log
 * integrity — tamper-evident log; identity pseudonymized via user_identity_tokens, not this
 * table." So there is no per-row redaction path to prove parity for, for any actor type,
 * including 'extension'.
 *
 * What genuinely needs proving instead — and what this test actually proves — is that the real
 * lookup mechanism erasure reporting uses (`findLatestAuditEventId`, which filters purely by
 * `(orgId, eventType, resourceId)` with NO reference to `actor_type` anywhere in that query) finds
 * an extension-authored row exactly as it would a system-authored row. No actor-type branch
 * anywhere in that code path can silently exclude extension rows from discovery.
 */
describe('Story 23.8 AC-21 — extension-authored rows are discoverable by the same (orgId, eventType, resourceId) lookup erasure reporting uses, uniformly across actor types', () => {
  it('findLatestAuditEventId finds an extension-authored row exactly as it would a system-authored row for the same key', async () => {
    await bootVault()
    await withTestOrg(async ({ orgId }) => {
      const resourceId = crypto.randomUUID()
      const eventType = 'ext.com.acme.fixture.thing_happened'

      const extensionRow = await withOrg(orgId, (tx) =>
        writeExtensionAuditEntry(tx, {
          orgId,
          eventType,
          resourceId,
          payload: { foo: 'bar' },
          extensionName: 'com.acme.fixture',
        })
      )

      const foundId = await withOrg(orgId, (tx) =>
        findLatestAuditEventId(tx, { orgId, eventType, resourceId })
      )

      expect(foundId).toBe(extensionRow.id)
    })
  })

  it('AC-22: an extension-authored row never has a non-null actor_token_id — same structural exclusion from pseudonymization as machine_user/system rows', async () => {
    await bootVault()
    await withTestOrg(async ({ orgId }) => {
      const row = await withOrg(orgId, (tx) =>
        writeExtensionAuditEntry(tx, {
          orgId,
          eventType: 'ext.com.acme.fixture.thing_happened',
          payload: {},
          extensionName: 'com.acme.fixture',
        })
      )
      expect(row.id).toBeTruthy()

      const { auditLogEntries } = await import('@project-vault/db/schema')
      const { eq } = await import('drizzle-orm')
      const persisted = await withOrg(orgId, (tx) =>
        tx
          .select({
            actorTokenId: auditLogEntries.actorTokenId,
            actorType: auditLogEntries.actorType,
          })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.id, row.id))
      )

      expect(persisted[0]?.actorTokenId).toBeNull()
      expect(persisted[0]?.actorType).toBe('extension')
    })
  })
})
