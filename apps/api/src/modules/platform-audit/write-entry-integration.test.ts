import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { getDb, withPlatformOperatorContext } from '@project-vault/db'
import { platformAuditEvents } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'

const keyDir = mkdtempSync(join(tmpdir(), 'platform-audit-write-entry-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { initVault, zeroKeys, loadInitialVaultState } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { writePlatformAuditEntry } = await import('./write-entry.js')

const TEST_PASSPHRASE = 'test-passphrase-writeentry12'

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

describe.sequential('Story 9.4 AC-6: writePlatformAuditEntry', () => {
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

  it('writes a row with a valid HMAC and no updated_at column', async () => {
    const operatorId = await createTestUser('platform-audit-write-entry')
    try {
      await getDb().transaction((tx) =>
        writePlatformAuditEntry(tx, {
          operatorId,
          actionType: 'settings.updated',
          payload: { fieldsChanged: ['smtp.host'] },
        })
      )

      const [row] = await withPlatformOperatorContext((tx) =>
        tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.operatorId, operatorId))
      )

      expect(row).toBeDefined()
      expect(row?.actionType).toBe('settings.updated')
      expect(row?.hmac).toBeTruthy()
      expect(row?.keyVersion).toBe(1)
      expect((row as unknown as { updatedAt?: unknown })?.updatedAt).toBeUndefined()
    } finally {
      await tryDeleteTestUser(operatorId)
    }
  })

  // AC-6 edge case: in non-production (this test process's NODE_ENV=test), a forbidden key in the
  // payload throws before ever reaching the INSERT — never persisted, not even redacted-then-
  // written. (Production's silent-strip-and-warn branch is covered by write-entry.test.ts's pure
  // unit test against redactPlatformAuditPayload directly, since overriding the cached env
  // singleton mid-process isn't practical here.)
  it('throws when the payload contains a forbidden key at write time (dev-time assertion) and never inserts a row', async () => {
    const operatorId = await createTestUser('platform-audit-write-entry-throw')
    try {
      await expect(
        getDb().transaction((tx) =>
          writePlatformAuditEntry(tx, {
            operatorId,
            actionType: 'test.redaction.throw',
            payload: { apiKey: 'should-never-be-written' },
          })
        )
      ).rejects.toThrow(/forbidden/i)

      const rows = await withPlatformOperatorContext((tx) =>
        tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.operatorId, operatorId))
      )
      expect(rows).toHaveLength(0)
    } finally {
      await tryDeleteTestUser(operatorId)
    }
  })
})
