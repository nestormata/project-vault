import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { getDb, withPlatformOperatorContext } from '@project-vault/db'
import {
  platformAuditEvents,
  platformAuditMaintenanceState,
  platformAuditPendingEntries,
} from '@project-vault/db/schema'
import { createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'

const keyDir = mkdtempSync(join(tmpdir(), 'platform-audit-maintenance-mode-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { initVault, unsealVault, zeroKeys, loadInitialVaultState } =
  await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const {
  isMaintenanceModeActive,
  activateMaintenanceMode,
  deactivateMaintenanceMode,
  queuePendingEntry,
  drainPendingEntries,
  MaintenanceModeAlreadyActiveError,
  MaintenanceModeStillUnavailableError,
} = await import('./maintenance-mode.js')

const TEST_PASSPHRASE = 'test-passphrase-maintenance12'
const EMERGENCY_RECOVERY_REASON = 'emergency recovery'
const MAINTENANCE_MODE_ACTIVATED = 'maintenance_mode.activated'
const SETTINGS_UPDATED = 'settings.updated'
const RECORDED_RETROACTIVELY = 'recordedRetroactively'

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

describe.sequential('Story 9.4 D8: platform-audit maintenance mode', () => {
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

  it('isMaintenanceModeActive is false by default', async () => {
    const active = await getDb().transaction((tx) => isMaintenanceModeActive(tx))
    expect(active).toBe(false)
  })

  it('activateMaintenanceMode sets active/reason/activatedByUserId/activatedAt', async () => {
    const userId = await createTestUser('maintenance-activate')
    try {
      const result = await getDb().transaction((tx) =>
        activateMaintenanceMode(tx, { reason: EMERGENCY_RECOVERY_REASON, userId })
      )
      expect(result.active).toBe(true)
      expect(result.reason).toBe(EMERGENCY_RECOVERY_REASON)

      const [row] = await getDb()
        .select()
        .from(platformAuditMaintenanceState)
        .where(eq(platformAuditMaintenanceState.id, 1))
      expect(row?.active).toBe(true)
      expect(row?.reason).toBe(EMERGENCY_RECOVERY_REASON)
      expect(row?.activatedByUserId).toBe(userId)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  it('activateMaintenanceMode throws MaintenanceModeAlreadyActiveError when already active', async () => {
    const userId = await createTestUser('maintenance-activate-twice')
    try {
      await getDb().transaction((tx) => activateMaintenanceMode(tx, { reason: 'r1', userId }))
      await expect(
        getDb().transaction((tx) => activateMaintenanceMode(tx, { reason: 'r2', userId }))
      ).rejects.toBeInstanceOf(MaintenanceModeAlreadyActiveError)

      const [row] = await getDb()
        .select()
        .from(platformAuditMaintenanceState)
        .where(eq(platformAuditMaintenanceState.id, 1))
      expect(row?.reason).toBe('r1') // not clobbered by the rejected second activation
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  it('queuePendingEntry assigns strictly increasing sequence numbers', async () => {
    await getDb().transaction(async (tx) => {
      await queuePendingEntry(tx, { actionType: 'a' })
      await queuePendingEntry(tx, { actionType: 'b' })
    })
    const rows = await getDb()
      .select()
      .from(platformAuditPendingEntries)
      .orderBy(asc(platformAuditPendingEntries.sequenceNum))
    expect(rows).toHaveLength(2)
    expect(rows[1]?.sequenceNum).toBeGreaterThan(rows[0]?.sequenceNum ?? -1)
  })

  // AC-14 "proactive activation" example: maintenance mode can be activated pre-emptively while
  // the log is still perfectly healthy — nothing ever gets queued in that case, and the
  // opportunistic drain (triggered by every subsequent successful write elsewhere in the system)
  // must NOT auto-deactivate just because it happened to find `active: true` with nothing pending.
  it('drainPendingEntries is a no-op (does not deactivate) when active but nothing is pending', async () => {
    const userId = await createTestUser('maintenance-drain-noop')
    try {
      await getDb().transaction((tx) => activateMaintenanceMode(tx, { reason: 'r', userId }))

      const result = await getDb().transaction((tx) => drainPendingEntries(tx, userId))
      expect(result).toEqual({ drained: 0, remaining: 0, skipped: false, wasActive: true })

      const [state] = await getDb()
        .select()
        .from(platformAuditMaintenanceState)
        .where(eq(platformAuditMaintenanceState.id, 1))
      expect(state?.active).toBe(true)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  // AC-16: exact FIFO drain ordering with the activation event first, ending with a fresh
  // (non-queued) maintenance_mode.deactivated row.
  it('drainPendingEntries drains FIFO, marks recordedRetroactively, preserves attemptedAt, then deactivates', async () => {
    const userId = await createTestUser('maintenance-drain')
    try {
      await getDb().transaction((tx) => activateMaintenanceMode(tx, { reason: 'r', userId }))

      const activatedAt = new Date('2026-01-01T00:00:00.000Z')
      const settingsAt = new Date('2026-01-01T00:05:00.000Z')
      await getDb().transaction(async (tx) => {
        await queuePendingEntry(
          tx,
          { operatorId: userId, actionType: MAINTENANCE_MODE_ACTIVATED, payload: {} },
          activatedAt
        )
        await queuePendingEntry(
          tx,
          { operatorId: userId, actionType: SETTINGS_UPDATED, payload: { fieldsChanged: ['x'] } },
          settingsAt
        )
      })

      await getDb().transaction((tx) => drainPendingEntries(tx, userId))

      const rows = await withPlatformOperatorContext((tx) =>
        tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.operatorId, userId))
      )
      const sorted = rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

      expect(sorted.map((r) => r.actionType)).toEqual([
        MAINTENANCE_MODE_ACTIVATED,
        SETTINGS_UPDATED,
        'maintenance_mode.deactivated',
      ])
      const [activatedRow, settingsRow, deactivatedRow] = sorted
      expect(activatedRow).toBeDefined()
      expect(settingsRow).toBeDefined()
      expect(deactivatedRow).toBeDefined()
      expect(activatedRow?.createdAt.toISOString()).toBe(activatedAt.toISOString())
      expect((activatedRow?.payload as Record<string, unknown>)[RECORDED_RETROACTIVELY]).toBe(true)
      expect(settingsRow?.createdAt.toISOString()).toBe(settingsAt.toISOString())
      expect((settingsRow?.payload as Record<string, unknown>)[RECORDED_RETROACTIVELY]).toBe(true)
      // The fresh deactivation row is NOT retroactive.
      expect(
        (deactivatedRow?.payload as Record<string, unknown>)[RECORDED_RETROACTIVELY]
      ).toBeUndefined()

      const remainingPending = await getDb().select().from(platformAuditPendingEntries)
      expect(remainingPending).toHaveLength(0)

      const [state] = await getDb()
        .select()
        .from(platformAuditMaintenanceState)
        .where(eq(platformAuditMaintenanceState.id, 1))
      expect(state?.active).toBe(false)
      expect(state?.deactivatedAt).toBeTruthy()
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  it('drainPendingEntries with skipLocked returns skipped:true when another transaction holds the row lock', async () => {
    const userId = await createTestUser('maintenance-drain-concurrent')
    try {
      await getDb().transaction((tx) => activateMaintenanceMode(tx, { reason: 'r', userId }))

      const adminSql = postgres(
        process.env['DATABASE_URL'] ??
          'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
      )
      const reservation = adminSql.reserve()
      const conn = await reservation
      await conn`BEGIN`
      await conn`SELECT * FROM platform_audit_maintenance_state WHERE id = 1 FOR UPDATE`

      try {
        const result = await getDb().transaction((tx) =>
          drainPendingEntries(tx, userId, { skipLocked: true })
        )
        expect(result.skipped).toBe(true)
      } finally {
        await conn`ROLLBACK`
        conn.release()
        await adminSql.end()
      }
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  // AC-14 proactive-activation counterpart: an operator can still explicitly deactivate even
  // though nothing was ever queued (the log stayed healthy the whole time).
  it('deactivateMaintenanceMode succeeds even when nothing was ever queued', async () => {
    const userId = await createTestUser('maintenance-deactivate-nothing-pending')
    try {
      await getDb().transaction((tx) => activateMaintenanceMode(tx, { reason: 'r', userId }))

      const result = await deactivateMaintenanceMode(getDb(), userId)
      expect(result.active).toBe(false)

      const [state] = await getDb()
        .select()
        .from(platformAuditMaintenanceState)
        .where(eq(platformAuditMaintenanceState.id, 1))
      expect(state?.active).toBe(false)

      const rows = await withPlatformOperatorContext((tx) =>
        tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.operatorId, userId))
      )
      expect(rows.some((r) => r.actionType === 'maintenance_mode.deactivated')).toBe(true)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  // AC-16 edge case: operator-initiated deactivation while the log is still genuinely broken
  // fails closed with a distinct error the route maps to 503 — `active` remains true.
  it('deactivateMaintenanceMode rethrows as MaintenanceModeStillUnavailableError when the log is still unavailable', async () => {
    const userId = await createTestUser('maintenance-deactivate-still-broken')
    try {
      await getDb().transaction((tx) => activateMaintenanceMode(tx, { reason: 'r', userId }))
      await getDb().transaction((tx) =>
        queuePendingEntry(tx, {
          operatorId: userId,
          actionType: MAINTENANCE_MODE_ACTIVATED,
          payload: {},
        })
      )

      zeroKeys() // simulate vault still sealed — the log is still "unavailable"

      await expect(deactivateMaintenanceMode(getDb(), userId)).rejects.toBeInstanceOf(
        MaintenanceModeStillUnavailableError
      )

      const [state] = await getDb()
        .select()
        .from(platformAuditMaintenanceState)
        .where(eq(platformAuditMaintenanceState.id, 1))
      expect(state?.active).toBe(true)
    } finally {
      // Re-unseal for subsequent tests in this file.
      await loadInitialVaultState()
      await unsealVault({ passphrase: TEST_PASSPHRASE })
      await tryDeleteTestUser(userId)
    }
  })

  // Review finding (2026-07-11): a mixed queue of drainable + genuinely-poisoned entries must
  // not lose the drainable entries' work just because the overall deactivate call still reports
  // "still unavailable" for the poisoned one. Each entry drains in its own SAVEPOINT, but the
  // outer deactivate call used to throw MaintenanceModeStillUnavailableError from inside the same
  // transaction as the drain, rolling back every SAVEPOINT that had already been released —
  // silently dropping entries the code's own contract says are "never silently dropped".
  it('deactivateMaintenanceMode preserves a partial drain when the queue has a poisoned entry', async () => {
    const userId = await createTestUser('maintenance-partial-drain')
    try {
      await getDb().transaction((tx) => activateMaintenanceMode(tx, { reason: 'r', userId }))

      const firstAt = new Date('2026-01-01T00:00:00.000Z')
      const poisonedAt = new Date('2026-01-01T00:05:00.000Z')
      const lastAt = new Date('2026-01-01T00:10:00.000Z')
      await getDb().transaction(async (tx) => {
        await queuePendingEntry(
          tx,
          { operatorId: userId, actionType: SETTINGS_UPDATED, payload: { fieldsChanged: ['a'] } },
          firstAt
        )
        // Genuinely poisoned: a forbidden key in the payload makes writePlatformAuditEntry throw
        // every time it's retried, unlike a transient vault-sealed failure.
        await queuePendingEntry(
          tx,
          { operatorId: userId, actionType: SETTINGS_UPDATED, payload: { password: 'leaked' } },
          poisonedAt
        )
        await queuePendingEntry(
          tx,
          { operatorId: userId, actionType: SETTINGS_UPDATED, payload: { fieldsChanged: ['b'] } },
          lastAt
        )
      })

      await expect(deactivateMaintenanceMode(getDb(), userId)).rejects.toBeInstanceOf(
        MaintenanceModeStillUnavailableError
      )

      // The two drainable entries are durably gone from the queue and recorded as real
      // platform_audit_events rows, even though the overall call reported "still unavailable".
      const remainingPending = await getDb().select().from(platformAuditPendingEntries)
      expect(remainingPending).toHaveLength(1)
      expect((remainingPending[0]?.intendedFields as Record<string, unknown>)['payload']).toEqual({
        password: 'leaked',
      })

      const rows = await withPlatformOperatorContext((tx) =>
        tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.operatorId, userId))
      )
      const drainedTimestamps = rows.map((r) => r.createdAt.toISOString()).sort()
      expect(drainedTimestamps).toEqual([firstAt.toISOString(), lastAt.toISOString()])
      expect(
        rows.every((r) => (r.payload as Record<string, unknown>)['recordedRetroactively'])
      ).toBe(true)

      // Maintenance mode itself must remain active — the queue isn't fully drained yet.
      const [state] = await getDb()
        .select()
        .from(platformAuditMaintenanceState)
        .where(eq(platformAuditMaintenanceState.id, 1))
      expect(state?.active).toBe(true)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })
})
