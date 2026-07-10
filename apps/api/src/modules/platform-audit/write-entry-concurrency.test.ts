import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { getDb, withPlatformOperatorContext } from '@project-vault/db'
import { platformAuditEvents } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'

const keyDir = mkdtempSync(join(tmpdir(), 'platform-audit-concurrency-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { initVault, zeroKeys, loadInitialVaultState } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { writePlatformAuditEntry } = await import('./write-entry.js')

const TEST_PASSPHRASE = 'test-passphrase-concurrency12'

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

describe.sequential('Story 9.4 AC-19: concurrent platform-audit writes', () => {
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

  it('50 concurrent writes each produce exactly one row — no lost writes, no duplicate ids', async () => {
    const userId = await createTestUser('platform-audit-concurrency')
    try {
      const CONCURRENCY = 50
      await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          getDb().transaction((tx) =>
            writePlatformAuditEntry(tx, {
              operatorId: userId,
              actionType: 'test.concurrent',
              payload: { i },
            })
          )
        )
      )

      const rows = await withPlatformOperatorContext((tx) =>
        tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.operatorId, userId))
      )
      expect(rows).toHaveLength(CONCURRENCY)
      const uniqueIds = new Set(rows.map((r) => r.id))
      expect(uniqueIds.size).toBe(CONCURRENCY)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })
})
