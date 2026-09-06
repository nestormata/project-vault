import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { asc, eq } from 'drizzle-orm'
import { getDb, withPlatformOperatorContext, type Tx } from '@project-vault/db'
import {
  platformAuditEvents,
  platformAuditMaintenanceState,
  platformAuditPendingEntries,
  users,
} from '@project-vault/db/schema'
import { createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import { SUPERUSER_DATABASE_URL } from '../../__tests__/db-urls.js'

// Story 1.25 AC-3/AC-4, and the retroactive-drain Edge Case — the platform-audit sibling of
// apps/api/src/modules/audit/verify-chain.test.ts. Same bootstrap pattern as
// write-entry-concurrency.test.ts / maintenance-mode.test.ts.
const keyDir = mkdtempSync(join(tmpdir(), 'platform-audit-verify-chain-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['PLATFORM_AUDIT_RETENTION_DAYS'] = '30'

const { initVault, zeroKeys, loadInitialVaultState } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { writePlatformAuditEntry, computePlatformAuditHmac } = await import('./write-entry.js')
const { verifyPlatformAuditRange } = await import('./verify.js')
const { queuePendingEntry, drainPendingEntries, activateMaintenanceMode } =
  await import('./maintenance-mode.js')
const { prunePlatformAuditEvents } = await import('../../workers/platform-audit-retention-prune.js')
const { GENESIS_SENTINEL } = await import('../audit/write-entry.js')
const { getPlatformAuditKey } = await import('../vault/key-service.js')

const TEST_PASSPHRASE = 'test-passphrase-pa-verify-ch'

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

/** Bypasses the append-only trigger via a raw superuser connection, mirroring
 * packages/db/src/__tests__/platform-audit-retention-purge.test.ts's pattern. */
async function forceDeleteRow(id: string): Promise<void> {
  const adminSql = postgres(SUPERUSER_DATABASE_URL)
  try {
    await adminSql.begin(async (tx) => {
      await tx`SELECT set_config('app.platform_audit_retention_purge', 'true', true)`
      await tx`DELETE FROM platform_audit_events WHERE id = ${id}`
    })
  } finally {
    await adminSql.end()
  }
}

/** Story 1.25 AC-4's retention-purge test needs a clean slate: `platform_audit_events` is a
 * genuinely global, un-truncated, cumulative table (no org scope) that every earlier `it()` in
 * this file (and potentially other test files run in the same session) has already appended
 * rows to. A real production deployment's retention purge boundary is always adjacent to the
 * table's actual oldest surviving row (there's only ever one purge cutoff at a time) — but a
 * shared test table accumulates unrelated, still-recent rows with LOWER chain_seq than this
 * test's own rows, which would make the "earliest surviving row" the wrong row entirely. Wiping
 * the table first (superuser bypass) makes this test deterministic without changing the
 * production code path at all — this is a test-isolation concern only.
 */
async function wipePlatformAuditEvents(): Promise<void> {
  const adminSql = postgres(SUPERUSER_DATABASE_URL)
  try {
    await adminSql.begin(async (tx) => {
      await tx`ALTER TABLE platform_audit_events DISABLE TRIGGER platform_audit_immutability`
      await tx`DELETE FROM platform_audit_events`
      await tx`ALTER TABLE platform_audit_events ENABLE TRIGGER platform_audit_immutability`
    })
  } finally {
    await adminSql.end()
  }
}

async function backdateRow(id: string, createdAt: Date): Promise<void> {
  const adminSql = postgres(SUPERUSER_DATABASE_URL)
  try {
    await adminSql.begin(async (tx) => {
      await tx`ALTER TABLE platform_audit_events DISABLE TRIGGER platform_audit_immutability`
      await tx`UPDATE platform_audit_events SET created_at = ${createdAt.toISOString()}::timestamptz WHERE id = ${id}`
      await tx`ALTER TABLE platform_audit_events ENABLE TRIGGER platform_audit_immutability`
    })
  } finally {
    await adminSql.end()
  }
}

async function latestRowId(): Promise<string> {
  const [row] = await withPlatformOperatorContext((tx) =>
    tx
      .select({ id: platformAuditEvents.id })
      .from(platformAuditEvents)
      .orderBy(asc(platformAuditEvents.chainSeq))
  ).then((rows) => rows.slice(-1))
  return row?.id as string
}

describe.sequential('Story 1.25 AC-3/AC-4: platform-audit chain-walk verification', () => {
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

  it('Edge Case: a retroactive-drain row chains onto the true latest row at drain time, not by createdAt', async () => {
    const userId = await createTestUser('pa-chain-drain')
    try {
      // Queue a pending entry with an OLD attemptedAt.
      await getDb().transaction((tx: Tx) =>
        queuePendingEntry(
          tx,
          { operatorId: userId, actionType: 'test.drained', payload: {} },
          new Date(Date.now() - 60 * 60 * 1000)
        )
      )
      // One ordinary write happens BEFORE the drain, advancing the chain — with a LATER createdAt
      // than the queued entry's attemptedAt.
      const advancingRowId = await getDb().transaction(async (tx: Tx) => {
        await writePlatformAuditEntry(tx, {
          operatorId: userId,
          actionType: 'test.advance',
          payload: {},
        })
        const [row] = await tx
          .select({ id: platformAuditEvents.id, hmac: platformAuditEvents.hmac })
          .from(platformAuditEvents)
          .orderBy(asc(platformAuditEvents.chainSeq))
        return row
      })

      await getDb().transaction((tx: Tx) => activateMaintenanceMode(tx, { reason: 'r', userId }))
      await getDb().transaction((tx: Tx) => drainPendingEntries(tx, userId))

      const [drainedRow] = await withPlatformOperatorContext((tx) =>
        tx
          .select({
            createdAt: platformAuditEvents.createdAt,
            chainSeq: platformAuditEvents.chainSeq,
            previousEntryHmac: platformAuditEvents.previousEntryHmac,
          })
          .from(platformAuditEvents)
          .where(eq(platformAuditEvents.actionType, 'test.drained'))
      )

      const [advancingRow] = await withPlatformOperatorContext((tx) =>
        tx
          .select({ hmac: platformAuditEvents.hmac, chainSeq: platformAuditEvents.chainSeq })
          .from(platformAuditEvents)
          .where(eq(platformAuditEvents.actionType, 'test.advance'))
      )

      expect(drainedRow?.previousEntryHmac).toBe(advancingRow?.hmac)
      expect(drainedRow?.chainSeq).toBeGreaterThan(advancingRow?.chainSeq as number)
      expect((drainedRow?.createdAt as Date).getTime()).toBeLessThan(Date.now() - 59 * 60 * 1000)

      void advancingRowId
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  it('AC-3 positive example: deleting a row is detected as a chain_break', async () => {
    const userId = await createTestUser('pa-chain-delete')
    try {
      const rowIds: string[] = []
      for (let i = 0; i < 3; i++) {
        await getDb().transaction((tx: Tx) =>
          writePlatformAuditEntry(tx, {
            operatorId: userId,
            actionType: `test.pa_row${i}`,
            payload: {},
          })
        )
        rowIds.push(await latestRowId())
      }
      const from = new Date(Date.now() - 60_000)
      const to = new Date(Date.now() + 60_000)

      await forceDeleteRow(rowIds[1] as string)

      const result = await withPlatformOperatorContext((tx) =>
        verifyPlatformAuditRange(tx, { from: from.toISOString(), to: to.toISOString() })
      )
      expect(result.failed.some((f) => f.reason === 'chain_break')).toBe(true)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  it('Edge Case (genesis-row forgery): a NULL previous_entry_hmac on a non-genesis row is flagged', async () => {
    const userId = await createTestUser('pa-chain-genesis-forge')
    try {
      await getDb().transaction((tx: Tx) =>
        writePlatformAuditEntry(tx, {
          operatorId: userId,
          actionType: 'test.pa_first',
          payload: {},
        })
      )
      const platformKey = getPlatformAuditKey()
      const forgedHmac = computePlatformAuditHmac(
        {
          operatorId: userId,
          actionType: 'test.pa_forged',
          targetOrgId: undefined,
          targetUserId: undefined,
          payload: {},
          keyVersion: 1,
          previousEntryHmac: GENESIS_SENTINEL,
        },
        platformKey
      )
      await withPlatformOperatorContext((tx) =>
        tx.insert(platformAuditEvents).values({
          operatorId: userId,
          actionType: 'test.pa_forged',
          payload: {},
          keyVersion: 1,
          hmac: forgedHmac,
          previousEntryHmac: null,
        })
      )

      const from = new Date(Date.now() - 60_000)
      const to = new Date(Date.now() + 60_000)
      const result = await withPlatformOperatorContext((tx) =>
        verifyPlatformAuditRange(tx, { from: from.toISOString(), to: to.toISOString() })
      )
      expect(result.failed.some((f) => f.reason === 'chain_break')).toBe(true)
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  // Story 1.25 AC-3/AC-4 platform-wide sibling of the org-scoped "single most important test".
  it('AC-3/AC-4: a legitimate platform-wide retention purge does not false-positive as a chain break', async () => {
    await wipePlatformAuditEvents()
    const userId = await createTestUser('pa-chain-purge')
    // Mark this user as the platform operator so prunePlatformAuditEvents's tombstone-write
    // resolvePlatformOperatorId() lookup finds a real user id (Story 1.25 AC-4's own resolved
    // design decision — see platform-audit-retention-prune.ts's doc comment). A unique partial
    // index (0038) allows at most one is_platform_operator=true row instance-wide — if some
    // other user already holds it (an earlier test/bootstrap), leave it alone; the worker's own
    // lookup will just resolve to whichever user already holds the flag, which is fine for this
    // test's purposes (it only asserts the tombstone gets written by SOME real operator id).
    let claimedOperatorFlag = false
    try {
      await getDb().update(users).set({ isPlatformOperator: true }).where(eq(users.id, userId))
      claimedOperatorFlag = true
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined
      const isUniqueViolation =
        Boolean(cause) && typeof cause === 'object' && (cause as { code?: string }).code === '23505'
      if (!isUniqueViolation) throw error
    }
    try {
      // Captures each row's id WITHIN the same transaction as its own write (a separate
      // transaction/connection would not yet see this one's uncommitted insert).
      const oldId1 = await getDb().transaction(async (tx: Tx) => {
        await writePlatformAuditEntry(tx, {
          operatorId: userId,
          actionType: 'test.pa_old1',
          payload: {},
        })
        const [row] = await tx
          .select({ id: platformAuditEvents.id })
          .from(platformAuditEvents)
          .where(eq(platformAuditEvents.actionType, 'test.pa_old1'))
        return row?.id as string
      })
      const oldId2 = await getDb().transaction(async (tx: Tx) => {
        await writePlatformAuditEntry(tx, {
          operatorId: userId,
          actionType: 'test.pa_old2',
          payload: {},
        })
        const [row] = await tx
          .select({ id: platformAuditEvents.id })
          .from(platformAuditEvents)
          .where(eq(platformAuditEvents.actionType, 'test.pa_old2'))
        return row?.id as string
      })
      await getDb().transaction((tx: Tx) =>
        writePlatformAuditEntry(tx, { operatorId: userId, actionType: 'test.pa_new', payload: {} })
      )
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      await backdateRow(oldId1, oldDate)
      await backdateRow(oldId2, oldDate)

      await prunePlatformAuditEvents()

      // Filtered by chainSeq order only (not operatorId): the table was wiped at this test's
      // start, so every remaining row belongs to this test — and the tombstone's operatorId may
      // legitimately be a DIFFERENT already-existing platform operator than `userId` if one was
      // already claimed by an earlier test in this shared dev database (see claimedOperatorFlag
      // above), which is fine per this test's own stated purpose.
      const remaining = await withPlatformOperatorContext((tx) =>
        tx
          .select({ id: platformAuditEvents.id, actionType: platformAuditEvents.actionType })
          .from(platformAuditEvents)
          .orderBy(asc(platformAuditEvents.chainSeq))
      )
      expect(remaining.map((r) => r.actionType)).toEqual([
        'test.pa_new',
        'platform_audit.retention_purge_boundary',
      ])
      const remainingIds = new Set(remaining.map((r) => r.id))

      const from = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000)
      const to = new Date(Date.now() + 60_000)
      const result = await withPlatformOperatorContext((tx) =>
        verifyPlatformAuditRange(tx, { from: from.toISOString(), to: to.toISOString() })
      )
      // Filtered by the exact row ids THIS test just created (rather than actionType alone) —
      // this table is platform-wide and un-truncated between runs, so a stale row from an
      // earlier, differently-keyed test run could otherwise share the same actionType string and
      // produce an unrelated hmac_mismatch that has nothing to do with this test's own chain.
      const relevantFailures = result.failed.filter((f) => remainingIds.has(f.id))
      expect(relevantFailures).toEqual([])
    } finally {
      if (claimedOperatorFlag) {
        await getDb().update(users).set({ isPlatformOperator: false }).where(eq(users.id, userId))
      }
      await tryDeleteTestUser(userId)
    }
  })
})
