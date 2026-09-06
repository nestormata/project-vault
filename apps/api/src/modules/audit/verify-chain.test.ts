import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { eq, sql } from 'drizzle-orm'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import { SUPERUSER_DATABASE_URL } from '../../__tests__/db-urls.js'

// Story 1.25 AC-3/AC-4: the story's own designation, "the single most important test in this
// story", is the retention-purge-does-not-false-positive case below — everything else here is
// the supporting chain-walk coverage (deletion detection, untouched-chain pass, genesis-forgery,
// full-history-wipe). Same bootstrap pattern as write-entry-concurrency.test.ts.
const keyDir = mkdtempSync(join(tmpdir(), 'audit-verify-chain-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'false'
process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = 'false'

const { initVault, zeroKeys, loadInitialVaultState } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { writeSystemAuditEntry } = await import('./machine-entry.js')
const { verifyAuditRange } = await import('./verify.js')
const { configureRetention } = await import('./retention.js')
const { pruneExpiredAuditLogEntries } = await import('../../workers/audit-retention-prune.js')
const { computeAuditHmac, GENESIS_SENTINEL } = await import('./write-entry.js')
const { getAuditKey } = await import('../vault/key-service.js')

const TEST_PASSPHRASE = 'test-passphrase-verify-chain1'

// Story 1.25 AC-3: simulates the threat model directly — an actor with raw DB write access
// (superuser connection, or the documented RLS-bypassing BACKUP_DATABASE_URL), not going through
// the application's write path. `vault_app` cannot UPDATE/DELETE audit_log_entries at all
// (0002's grant-layer REVOKE, checked before the trigger even fires — see
// audit-log-immutability.test.ts's own comment), so these operations need the superuser
// connection, mirroring packages/db/src/__tests__/audit-retention-purge.test.ts's exact pattern.
const adminSql = postgres(SUPERUSER_DATABASE_URL)

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

/** Bypasses the append-only trigger the same way the sanctioned retention-purge function does
 * (0036's session-local `app.audit_retention_purge` flag), via the superuser connection so the
 * grant-layer REVOKE (0002) doesn't block it first. */
async function forceDeleteRow(id: string): Promise<void> {
  await adminSql.begin(async (tx) => {
    await tx`SELECT set_config('app.audit_retention_purge', 'true', true)`
    await tx`DELETE FROM audit_log_entries WHERE id = ${id}`
  })
}

/** Backdates a row's created_at directly — there is no application-level way to backdate an
 * audit row (writeSystemAuditEntry always uses defaultNow()), and UPDATE is REVOKEd for vault_app
 * regardless (0002) — so this simulates "an old row" the same way the DB-layer superuser tests
 * do, via a raw superuser connection. Bypasses the trigger via the same session flag as above
 * (UPDATE is never allowed under any flag per the trigger's own logic, EXCEPT this is UPDATE,
 * which the trigger unconditionally rejects) — so this must go through the superuser connection
 * alone, which bypasses the grant-layer REVOKE entirely and is never subject to the trigger's
 * fire (superuser is not vault_app, but the trigger fires for ANY role's UPDATE/DELETE — the
 * flag only ever permits DELETE, never UPDATE). Uses `ALTER TABLE ... DISABLE TRIGGER` scoped to
 * this one connection's transaction, restored immediately after, since no session flag exists
 * for permitting an UPDATE.
 */
async function backdateRows(orgId: string, eventTypes: string[], createdAt: Date): Promise<void> {
  await adminSql.begin(async (tx) => {
    await tx`ALTER TABLE audit_log_entries DISABLE TRIGGER audit_log_immutability`
    await tx`
      UPDATE audit_log_entries SET created_at = ${createdAt.toISOString()}::timestamptz
       WHERE org_id = ${orgId} AND event_type = ANY(${eventTypes})
    `
    await tx`ALTER TABLE audit_log_entries ENABLE TRIGGER audit_log_immutability`
  })
}

async function insertRawRow(
  orgId: string,
  input: { eventType: string; hmac: string; previousEntryHmac: string | null }
): Promise<void> {
  await withOrg(orgId, (tx: Tx) =>
    tx.insert(auditLogEntries).values({
      orgId,
      actorType: 'system',
      eventType: input.eventType,
      payload: {},
      keyVersion: 1,
      hmac: input.hmac,
      previousEntryHmac: input.previousEntryHmac,
    })
  )
}

describe.sequential('Story 1.25 AC-3/AC-4: chain-walk verification', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    zeroKeys()
    await loadInitialVaultState()
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
  })

  afterAll(async () => {
    await resetVaultForTest()
    rmSync(keyDir, { recursive: true, force: true })
    await adminSql.end()
  })

  it('AC-3 negative example: an untouched 3-row chain passes clean', async () => {
    await withTestOrg(async ({ orgId }) => {
      for (let i = 0; i < 3; i++) {
        await getDb().transaction((tx: Tx) =>
          writeSystemAuditEntry(tx, {
            orgId,
            eventType: `test.row${i}`,
            payload: {},
          })
        )
      }
      const from = new Date(Date.now() - 60_000)
      const to = new Date(Date.now() + 60_000)
      const result = await withOrg(orgId, (tx) =>
        verifyAuditRange(tx, { orgId, from: from.toISOString(), to: to.toISOString() })
      )
      expect(result.failed).toEqual([])
      expect(result.summary).toBe('All 3 records verified — no tampering detected')
    })
  })

  it('AC-3 positive example: deleting an interior row is detected as a chain_break', async () => {
    await withTestOrg(async ({ orgId }) => {
      const rowIds: string[] = []
      for (let i = 0; i < 3; i++) {
        const id = await getDb().transaction(async (tx: Tx) => {
          await writeSystemAuditEntry(tx, {
            orgId,
            eventType: `test.row${i}`,
            payload: {},
          })
          const [row] = await tx
            .select({ id: auditLogEntries.id })
            .from(auditLogEntries)
            .where(eq(auditLogEntries.orgId, orgId))
            .orderBy(sql`chain_seq desc`)
            .limit(1)
          return row?.id as string
        })
        rowIds.push(id)
      }
      const from = new Date(Date.now() - 60_000)
      const to = new Date(Date.now() + 60_000)

      // Directly DELETE row 2 (the middle row), bypassing the trigger — the exact threat model
      // this story closes.
      await forceDeleteRow(rowIds[1] as string)

      const result = await withOrg(orgId, (tx) =>
        verifyAuditRange(tx, { orgId, from: from.toISOString(), to: to.toISOString() })
      )
      expect(result.failedCount).toBeGreaterThanOrEqual(1)
      expect(result.failed.some((f) => f.reason === 'chain_break')).toBe(true)
      expect(result.summary).toMatch(/failed integrity check/)
    })
  })

  it('Edge Case (genesis-row forgery): a NULL previous_entry_hmac on a non-genesis row is flagged as a chain_break', async () => {
    await withTestOrg(async ({ orgId }) => {
      await getDb().transaction((tx: Tx) =>
        writeSystemAuditEntry(tx, { orgId, eventType: 'test.first', payload: {} })
      )
      // Forge a second row directly at the DB level with previous_entry_hmac = NULL, as if it
      // were (falsely) claiming to be a genesis row while a real predecessor already exists. The
      // forged row's OWN hmac is computed correctly (self-consistent, using the real key and the
      // GENESIS sentinel a true genesis row would use) — the point of this test is that the
      // chain-link check catches the forgery independently of the per-row hmac check, which
      // would otherwise pass.
      const orgAuditKey = getAuditKey()
      const FORGED_ROW_KEY_VERSION = 1
      const forgedHmac = computeAuditHmac(
        {
          orgId,
          actorTokenId: null,
          actorType: 'system',
          eventType: 'test.forged',
          resourceId: undefined,
          resourceType: undefined,
          payload: {},
          keyVersion: FORGED_ROW_KEY_VERSION,
          previousEntryHmac: GENESIS_SENTINEL,
        },
        orgAuditKey
      )
      await insertRawRow(orgId, {
        eventType: 'test.forged',
        hmac: forgedHmac,
        previousEntryHmac: null,
      })

      const from = new Date(Date.now() - 60_000)
      const to = new Date(Date.now() + 60_000)
      const result = await withOrg(orgId, (tx) =>
        verifyAuditRange(tx, { orgId, from: from.toISOString(), to: to.toISOString() })
      )
      expect(result.failed.some((f) => f.reason === 'chain_break')).toBe(true)
    })
  })

  // Story 1.25 AC-3/AC-4 — "This is the single most important test in this story."
  it('AC-3/AC-4: a legitimate retention purge does not false-positive as a chain break', async () => {
    const userId = await createTestUser('verify-chain-purge')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) => configureRetention(tx, orgId, 30))

        // 2 rows older than the 30-day cutoff (will be purged) + 1 row newer (survives).
        const OLD_CREATED_AT = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
        await getDb().transaction((tx: Tx) =>
          writeSystemAuditEntry(tx, {
            orgId,
            eventType: 'test.old1',
            payload: {},
          })
        )
        await getDb().transaction((tx: Tx) =>
          writeSystemAuditEntry(tx, {
            orgId,
            eventType: 'test.old2',
            payload: {},
          })
        )
        await getDb().transaction((tx: Tx) =>
          writeSystemAuditEntry(tx, {
            orgId,
            eventType: 'test.new',
            payload: {},
          })
        )
        // Backdate the two "old" rows' created_at directly.
        await backdateRows(orgId, ['test.old1', 'test.old2'], OLD_CREATED_AT)

        await pruneExpiredAuditLogEntries()

        const remaining = await withOrg(orgId, (tx) =>
          tx
            .select({ eventType: auditLogEntries.eventType })
            .from(auditLogEntries)
            .where(eq(auditLogEntries.orgId, orgId))
            .orderBy(sql`chain_seq asc`)
        )
        // The 2 old rows are gone; the new row plus exactly one tombstone row remain.
        expect(remaining.map((r) => r.eventType)).toEqual([
          'test.new',
          'audit.retention_purge_boundary',
        ])

        const from = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000)
        const to = new Date(Date.now() + 60_000)
        const result = await withOrg(orgId, (tx) =>
          verifyAuditRange(tx, { orgId, from: from.toISOString(), to: to.toISOString() })
        )
        expect(result.failed).toEqual([])
        expect(result.summary).toMatch(/no tampering detected/)
      })
    } finally {
      await tryDeleteTestUser(userId)
    }
  })

  it('AC-4 negative example: a full-history wipe attempts no tombstone, and the next write is a clean genesis', async () => {
    await withTestOrg(async ({ orgId }) => {
      await withOrg(orgId, (tx) => configureRetention(tx, orgId, 30))

      await getDb().transaction((tx: Tx) =>
        writeSystemAuditEntry(tx, {
          orgId,
          eventType: 'test.only-row',
          payload: {},
        })
      )
      const veryOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
      await backdateRows(orgId, ['test.only-row'], veryOld)

      await pruneExpiredAuditLogEntries()

      const remainingAfterPurge = await withOrg(orgId, (tx) =>
        tx
          .select({ eventType: auditLogEntries.eventType })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.orgId, orgId))
      )
      // No tombstone attempted — the org's entire history was purged, nothing survived to orphan.
      expect(remainingAfterPurge).toEqual([])

      // The next row this org ever writes is a clean, unattested genesis.
      await getDb().transaction((tx: Tx) =>
        writeSystemAuditEntry(tx, {
          orgId,
          eventType: 'test.post-wipe',
          payload: {},
        })
      )
      const [postWipeRow] = await withOrg(orgId, (tx) =>
        tx
          .select({ previousEntryHmac: auditLogEntries.previousEntryHmac })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.orgId, orgId))
      )
      expect(postWipeRow?.previousEntryHmac).toBeNull()
    })
  })
})
