import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { getDb, withPlatformOperatorContext } from '@project-vault/db'
import {
  platformAuditEvents,
  platformAuditMaintenanceState,
  platformAuditPendingEntries,
} from '@project-vault/db/schema'
import { createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'

const keyDir = mkdtempSync(join(tmpdir(), 'audit-or-fail-closed-platform-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { initVault, unsealVault, zeroKeys, loadInitialVaultState } =
  await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')
const { activateMaintenanceMode } = await import('../modules/platform-audit/maintenance-mode.js')
const { writePlatformAuditEntryOrFailClosed, SameTransactionPlatformAuditWriteError } =
  await import('./audit-or-fail-closed.js')

const TEST_PASSPHRASE = 'test-passphrase-orfailclosed1'
const SETTINGS_UPDATED = 'settings.updated'

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

async function resetMaintenanceState(): Promise<void> {
  await getDb()
    .update(platformAuditMaintenanceState)
    .set({
      active: false,
      reason: null,
      activatedByUserId: null,
      activatedAt: null,
      deactivatedAt: null,
    })
    .where(eq(platformAuditMaintenanceState.id, 1))
  await getDb().delete(platformAuditPendingEntries)
}

describe.sequential('Story 9.4 AC-6/AC-15/AC-16: writePlatformAuditEntryOrFailClosed', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    zeroKeys()
    await loadInitialVaultState()
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
  })

  beforeEach(async () => {
    await resetMaintenanceState()
  })

  afterAll(async () => {
    await resetMaintenanceState()
    await resetVaultForTest()
    rmSync(keyDir, { recursive: true, force: true })
  })

  it('writes normally when the vault is unsealed', async () => {
    const userId = await createTestUser('or-fail-closed-happy')
    try {
      await getDb().transaction((tx) =>
        writePlatformAuditEntryOrFailClosed(tx, {
          operatorId: userId,
          actionType: SETTINGS_UPDATED,
          payload: { fieldsChanged: ['x'] },
        })
      )
      const rows = await withPlatformOperatorContext((tx) =>
        tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.operatorId, userId))
      )
      expect(rows.length).toBe(1)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  // AC-6 negative: write failure, maintenance mode NOT active — rethrows and the caller's
  // transaction rolls back (no row persisted anywhere, not even a pending one).
  it('rethrows SameTransactionPlatformAuditWriteError when the write fails and maintenance mode is inactive', async () => {
    const userId = await createTestUser('or-fail-closed-inactive-fail')
    try {
      zeroKeys() // simulate the vault becoming sealed mid-request

      await expect(
        getDb().transaction((tx) =>
          writePlatformAuditEntryOrFailClosed(tx, {
            operatorId: userId,
            actionType: SETTINGS_UPDATED,
            payload: {},
          })
        )
      ).rejects.toBeInstanceOf(SameTransactionPlatformAuditWriteError)

      const pending = await getDb().select().from(platformAuditPendingEntries)
      expect(pending.length).toBe(0)
    } finally {
      await loadInitialVaultState()
      await unsealVault({ passphrase: TEST_PASSPHRASE })
      await tryDeleteTestUser(userId)
    }
  })

  // AC-15: same failure, maintenance mode active — caught and queued, the wrapper resolves
  // (does not throw), so the caller's transaction/action commits normally.
  it('queues to platform_audit_pending_entries and resolves when maintenance mode is active', async () => {
    const userId = await createTestUser('or-fail-closed-active-queue')
    try {
      await getDb().transaction((tx) => activateMaintenanceMode(tx, { reason: 'r', userId }))
      zeroKeys()

      await expect(
        getDb().transaction((tx) =>
          writePlatformAuditEntryOrFailClosed(tx, {
            operatorId: userId,
            actionType: SETTINGS_UPDATED,
            payload: { fieldsChanged: ['x'] },
          })
        )
      ).resolves.toBeUndefined()

      const pending = await getDb().select().from(platformAuditPendingEntries)
      expect(pending.length).toBe(1)
    } finally {
      await loadInitialVaultState()
      await unsealVault({ passphrase: TEST_PASSPHRASE })
      await tryDeleteTestUser(userId)
    }
  })

  // AC-16: the NEXT successful write opportunistically drains any queued entries.
  it('drains queued pending entries on the next successful write', async () => {
    const userId = await createTestUser('or-fail-closed-drain')
    try {
      await getDb().transaction((tx) => activateMaintenanceMode(tx, { reason: 'r', userId }))
      zeroKeys()
      await getDb().transaction((tx) =>
        writePlatformAuditEntryOrFailClosed(tx, {
          operatorId: userId,
          actionType: SETTINGS_UPDATED,
          payload: {},
        })
      )
      const pendingBefore = await getDb().select().from(platformAuditPendingEntries)
      expect(pendingBefore.length).toBe(1)

      await loadInitialVaultState()
      await unsealVault({ passphrase: TEST_PASSPHRASE })

      await getDb().transaction((tx) =>
        writePlatformAuditEntryOrFailClosed(tx, {
          operatorId: userId,
          actionType: 'org.created',
          payload: {},
        })
      )

      const pendingAfter = await getDb().select().from(platformAuditPendingEntries)
      expect(pendingAfter.length).toBe(0)

      const rows = await withPlatformOperatorContext((tx) =>
        tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.operatorId, userId))
      )
      const actionTypes = rows.map((r) => r.actionType).sort()
      expect(actionTypes).toEqual(
        ['maintenance_mode.deactivated', 'org.created', SETTINGS_UPDATED].sort()
      )
    } finally {
      await tryDeleteTestUser(userId)
    }
  })
})
