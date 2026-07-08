import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { getDb, withPlatformOperatorContext } from '@project-vault/db'
import { platformAuditEvents } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'

const keyDir = mkdtempSync(join(tmpdir(), 'platform-audit-verify-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { initVault, unsealVault, zeroKeys, loadInitialVaultState, VaultSealedError } =
  await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { writePlatformAuditEntry } = await import('./write-entry.js')
const { verifyPlatformAuditRange, RangeTooLargeError } = await import('./verify.js')

const TEST_PASSPHRASE = 'test-passphrase-verify123456'
const TEST_TAMPERED_ACTION_TYPE = 'test.tampered'

async function tryDeleteTestUser(userId: string): Promise<void> {
  try {
    await deleteTestUser(userId)
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined
    const isFkViolation =
      Boolean(cause) && typeof cause === 'object' && (cause as { code?: string }).code === '23503'
    if (!isFkViolation) throw error
  }
}

describe.sequential('Story 9.4 AC-11/D11: verifyPlatformAuditRange', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    zeroKeys()
    await loadInitialVaultState()
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
  })

  afterAll(async () => {
    await resetVaultForTest()
    rmSync(keyDir, { recursive: true, force: true })
  })

  // Story 9.4 D11: unlike the org-scoped verify (tenant-isolated via RLS), this endpoint has NO
  // per-operator/org filter — it verifies every row platform-wide in the window. Since
  // platform_audit_events is a shared, permanently-accumulating, non-truncated table across every
  // test file (each of which unseals its OWN independently-keyed vault instance), a real
  // wall-clock window like "now ± 1 minute" risks picking up another file's genuinely-valid-under-
  // a-different-key rows and misreporting them as tampered here. Scoping the window tightly to
  // the exact row just written (via its own returned `createdAt`) avoids that cross-file flake.
  it('reports all rows verified when nothing has been tampered with', async () => {
    const userId = await createTestUser('platform-audit-verify-happy')
    try {
      await getDb().transaction((tx) =>
        writePlatformAuditEntry(tx, {
          operatorId: userId,
          actionType: 'settings.updated',
          payload: {},
        })
      )
      const [row] = await withPlatformOperatorContext((tx) =>
        tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.operatorId, userId))
      )
      expect(row).toBeDefined()
      const from = row?.createdAt as Date
      const to = new Date(from.getTime() + 1)

      const result = await withPlatformOperatorContext((tx) =>
        verifyPlatformAuditRange(tx, { from: from.toISOString(), to: to.toISOString() })
      )

      expect(result.failedCount).toBe(0)
      expect(result.rowsChecked).toBe(1)
      expect(result.passed).toBe(1)
      expect(result.summary).toMatch(/no tampering detected/)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  it('rejects a range exceeding 90 days', async () => {
    const from = new Date('2020-01-01T00:00:00Z')
    const to = new Date('2025-01-01T00:00:00Z')
    await expect(
      getDb().transaction((tx) =>
        verifyPlatformAuditRange(tx, { from: from.toISOString(), to: to.toISOString() })
      )
    ).rejects.toBeInstanceOf(RangeTooLargeError)
  })

  it('throws VaultSealedError before touching the DB when the vault is sealed', async () => {
    zeroKeys()
    try {
      await expect(
        getDb().transaction((tx) =>
          verifyPlatformAuditRange(tx, {
            from: new Date(Date.now() - 1000).toISOString(),
            to: new Date().toISOString(),
          })
        )
      ).rejects.toBeInstanceOf(VaultSealedError)
    } finally {
      await loadInitialVaultState()
      await unsealVault({ passphrase: TEST_PASSPHRASE })
    }
  })

  // Dev Notes test-isolation gotcha: platform_audit_events is append-only exactly like
  // audit_log_entries, and GET /platform/audit/verify has NO org filter (D11) — a permanently
  // tampered row (unlike the org-scoped precedent's accepted permanent-row pattern) would poison
  // every subsequent test that verifies a range including it. The forged INSERT and the verify
  // call both run inside the same transaction, which is then rolled back before the test ends.
  it('detects a tampered row (HMAC recompute mismatch) without permanently corrupting the table', async () => {
    const userId = await createTestUser('platform-audit-verify-tamper')
    const ROLLBACK_SENTINEL = '__rollback_test_transaction__'
    try {
      await expect(
        getDb().transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.platform_operator_verified', 'true', true)`)
          await tx.insert(platformAuditEvents).values({
            operatorId: userId,
            actionType: TEST_TAMPERED_ACTION_TYPE,
            keyVersion: 1,
            hmac: 'deadbeef'.repeat(8),
          })

          const result = await verifyPlatformAuditRange(tx, {
            from: new Date(Date.now() - 60_000).toISOString(),
            to: new Date(Date.now() + 60_000).toISOString(),
          })

          expect(result.failedCount).toBeGreaterThanOrEqual(1)
          expect(
            result.failed.some((entry) => entry.actionType === TEST_TAMPERED_ACTION_TYPE)
          ).toBe(true)

          throw new Error(ROLLBACK_SENTINEL)
        })
      ).rejects.toThrow(ROLLBACK_SENTINEL)

      const rows = await withPlatformOperatorContext((tx) =>
        tx
          .select()
          .from(platformAuditEvents)
          .where(eq(platformAuditEvents.actionType, TEST_TAMPERED_ACTION_TYPE))
      )
      expect(rows.length).toBe(0)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })
})
