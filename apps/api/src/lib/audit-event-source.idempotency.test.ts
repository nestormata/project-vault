import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { eq, sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  auditStorageQuotaConfig,
  extensionAuditIdempotencyKeys,
} from '@project-vault/db/schema'
import { withTestOrg, withTwoTestOrgs } from '@project-vault/db/test-helpers'
import { EXTENSION_API_VERSION } from '@project-vault/extension-api'
import type { ExtensionManifest } from '@project-vault/extension-api'
import { SUPERUSER_DATABASE_URL } from '../__tests__/db-urls.js'

// Story 71.1 AC-8 — real-Postgres suite for the idempotent writeAuditEvent path. Both audit gates
// are ENABLED so the quota-on-first-write and replay-not-rate-limited cases exercise the real
// gates. Same vault bootstrap as modules/audit/write-entry-concurrency.test.ts.
const keyDir = mkdtempSync(join(tmpdir(), 'audit-event-source-idempotency-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'true'
process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = 'true'

const { initVault, zeroKeys, loadInitialVaultState } =
  await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')
const {
  writeExtensionAuditEventForManifest,
  getAuditEventSourceCounters,
  __resetAuditEventSourceCountersForTests,
  __resetAuditEventSourceRateLimitForTests,
  ExtensionAuditIdempotencyConflictError,
  ExtensionAuditIdempotencyKeyInvalidError,
} = await import('./audit-event-source.js')
const { verifyAuditRange } = await import('../modules/audit/verify.js')

const TEST_PASSPHRASE = 'test-passphrase-idempotency-71'
const adminSql = postgres(SUPERUSER_DATABASE_URL)

const MANIFEST: ExtensionManifest = {
  name: 'com.acme.fixture',
  apiVersion: EXTENSION_API_VERSION,
  capabilities: ['audit-event-source'],
}
const OTHER_MANIFEST: ExtensionManifest = { ...MANIFEST, name: 'com.acme.other' }
const EVENT = 'ext.com.acme.fixture.thing_happened'
const OTHER_EVENT = 'ext.com.acme.other.thing_happened'
const CONFLICT_KEY = 'conflict-key'

function keyed(orgId: string, idempotencyKey: string, payload: Record<string, unknown> = { a: 1 }) {
  return { eventType: EVENT, orgId, payload, idempotencyKey }
}

async function auditRowCount(orgId: string): Promise<number> {
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({ id: auditLogEntries.id })
      .from(auditLogEntries)
      .where(eq(auditLogEntries.orgId, orgId))
  )
  return rows.length
}

async function keyRowCount(orgId: string): Promise<number> {
  const rows = await withOrg(orgId, (tx) => tx.select().from(extensionAuditIdempotencyKeys))
  return rows.filter((row) => row.orgId === orgId).length
}

async function chainHead(orgId: string): Promise<string | undefined> {
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({ hmac: auditLogEntries.hmac })
      .from(auditLogEntries)
      .where(eq(auditLogEntries.orgId, orgId))
      .orderBy(sql`chain_seq DESC`)
      .limit(1)
  )
  return rows[0]?.hmac
}

async function setQuota(orgId: string, quotaBytes: number | null): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx
      .insert(auditStorageQuotaConfig)
      .values({ orgId, quotaBytes, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: auditStorageQuotaConfig.orgId,
        set: { quotaBytes, updatedAt: new Date() },
      })
  )
}

async function setRateCap(orgId: string, writeRatePerMinute: number | null): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx
      .insert(auditStorageQuotaConfig)
      .values({ orgId, writeRatePerMinute, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: auditStorageQuotaConfig.orgId,
        set: { writeRatePerMinute, updatedAt: new Date() },
      })
  )
}

describe('Story 71.1: idempotent writeAuditEvent (real Postgres)', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    zeroKeys()
    await loadInitialVaultState()
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
  })

  beforeEach(() => {
    __resetAuditEventSourceCountersForTests()
    __resetAuditEventSourceRateLimitForTests()
  })

  afterAll(async () => {
    await resetVaultForTest()
    rmSync(keyDir, { recursive: true, force: true })
    await adminSql.end()
  })

  it('AC-2: a replay returns the original receipt, writes no row and does not advance the chain', async () => {
    await withTestOrg(async ({ orgId }) => {
      const first = await writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, 'cm-evt-1:v1'))
      const headAfterFirst = await chainHead(orgId)
      const replay = await writeExtensionAuditEventForManifest(
        MANIFEST,
        keyed(orgId, 'cm-evt-1:v1')
      )
      expect(replay).toEqual(first)
      expect(await auditRowCount(orgId)).toBe(1)
      expect(await keyRowCount(orgId)).toBe(1)
      expect(await chainHead(orgId)).toBe(headAfterFirst)
      expect(getAuditEventSourceCounters()).toEqual({
        writes: 2,
        succeeded: 1,
        rejected: 0,
        deduped: 1,
      })
    })
  })

  it('AC-2: 12 parallel duplicates produce exactly one audit row and one receipt for every caller', async () => {
    await withTestOrg(async ({ orgId }) => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, 'parallel-key'))
        )
      )
      expect(new Set(results.map((r) => r.id)).size).toBe(1)
      expect(new Set(results.map((r) => r.createdAt)).size).toBe(1)
      expect(await auditRowCount(orgId)).toBe(1)
      expect(await keyRowCount(orgId)).toBe(1)
      expect(getAuditEventSourceCounters()).toMatchObject({ succeeded: 1, deduped: 11 })
    })
  })

  it('AC-2: a quota-refused first write leaves no key row, and a retry with the same key writes fresh', async () => {
    await withTestOrg(async ({ orgId }) => {
      await setQuota(orgId, 1)
      await expect(
        writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, 'quota-key'))
      ).rejects.toMatchObject({ code: 'audit_quota_exhausted' })
      expect(await keyRowCount(orgId)).toBe(0)
      expect(await auditRowCount(orgId)).toBe(0)

      await setQuota(orgId, null)
      const retry = await writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, 'quota-key'))
      expect(retry.id).toBeTruthy()
      expect(await auditRowCount(orgId)).toBe(1)
      expect(await keyRowCount(orgId)).toBe(1)
    })
  })

  it('AC-3: same key with different content is a typed conflict that never writes or overwrites', async () => {
    await withTestOrg(async ({ orgId }) => {
      const first = await writeExtensionAuditEventForManifest(
        MANIFEST,
        keyed(orgId, CONFLICT_KEY, { a: 1 })
      )
      await expect(
        writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, CONFLICT_KEY, { a: 2 }))
      ).rejects.toBeInstanceOf(ExtensionAuditIdempotencyConflictError)
      expect(await auditRowCount(orgId)).toBe(1)
      const again = await writeExtensionAuditEventForManifest(
        MANIFEST,
        keyed(orgId, CONFLICT_KEY, { a: 1 })
      )
      expect(again).toEqual(first)
      expect(getAuditEventSourceCounters()).toEqual({
        writes: 3,
        succeeded: 1,
        rejected: 1,
        deduped: 1,
      })
    })
  })

  it('AC-3: payload key order only is not a conflict; null-vs-absent is', async () => {
    await withTestOrg(async ({ orgId }) => {
      const first = await writeExtensionAuditEventForManifest(
        MANIFEST,
        keyed(orgId, 'order-key', { a: 1, b: { x: 1, y: 2 } })
      )
      const reordered = await writeExtensionAuditEventForManifest(
        MANIFEST,
        keyed(orgId, 'order-key', { b: { y: 2, x: 1 }, a: 1 })
      )
      expect(reordered).toEqual(first)
      await expect(
        writeExtensionAuditEventForManifest(
          MANIFEST,
          keyed(orgId, 'order-key', { a: 1, b: { x: 1, y: 2 }, c: null })
        )
      ).rejects.toBeInstanceOf(ExtensionAuditIdempotencyConflictError)
    })
  })

  it('AC-3: a differing projectId is a content conflict', async () => {
    await withTestOrg(async ({ orgId }) => {
      const project = crypto.randomUUID()
      await writeExtensionAuditEventForManifest(MANIFEST, {
        ...keyed(orgId, 'project-key'),
        projectId: project,
      })
      await expect(
        writeExtensionAuditEventForManifest(MANIFEST, {
          ...keyed(orgId, 'project-key'),
          projectId: crypto.randomUUID(),
        })
      ).rejects.toBeInstanceOf(ExtensionAuditIdempotencyConflictError)
    })
  })

  it('AC-4: the same key under a different org or extension namespace is independent', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const a = await writeExtensionAuditEventForManifest(MANIFEST, keyed(orgAId, 'shared'))
      const b = await writeExtensionAuditEventForManifest(MANIFEST, keyed(orgBId, 'shared'))
      const other = await writeExtensionAuditEventForManifest(OTHER_MANIFEST, {
        eventType: OTHER_EVENT,
        orgId: orgAId,
        payload: { a: 1 },
        idempotencyKey: 'shared',
      })
      expect(new Set([a.id, b.id, other.id]).size).toBe(3)
      expect(await auditRowCount(orgAId)).toBe(2)
      expect(await auditRowCount(orgBId)).toBe(1)
      expect(await keyRowCount(orgAId)).toBe(2)
    })
  })

  it('AC-1: invalid keys are rejected before any write', async () => {
    await withTestOrg(async ({ orgId }) => {
      for (const key of ['', 'x'.repeat(129), 'a b', 'a/b']) {
        await expect(
          writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, key))
        ).rejects.toBeInstanceOf(ExtensionAuditIdempotencyKeyInvalidError)
      }
      expect(await auditRowCount(orgId)).toBe(0)
      expect(getAuditEventSourceCounters()).toMatchObject({ writes: 4, rejected: 4 })
    })
  })

  it('AC-1: omitting the key keeps two calls = two rows and records no key row', async () => {
    await withTestOrg(async ({ orgId }) => {
      const input = { eventType: EVENT, orgId, payload: { a: 1 } }
      const one = await writeExtensionAuditEventForManifest(MANIFEST, input)
      const two = await writeExtensionAuditEventForManifest(MANIFEST, input)
      expect(one.id).not.toBe(two.id)
      expect(await auditRowCount(orgId)).toBe(2)
      expect(await keyRowCount(orgId)).toBe(0)
    })
  })

  it('AC-7: a deduped replay is neither rate-limited nor storage-gated, but a fresh write still is', async () => {
    await withTestOrg(async ({ orgId }) => {
      await setRateCap(orgId, 1)
      const first = await writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, 'rate-key'))
      const replay = await writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, 'rate-key'))
      expect(replay).toEqual(first)
      await expect(
        writeExtensionAuditEventForManifest(MANIFEST, { eventType: EVENT, orgId, payload: {} })
      ).rejects.toMatchObject({ code: 'audit_rate_limited' })

      await setQuota(orgId, 1)
      const stillReplay = await writeExtensionAuditEventForManifest(
        MANIFEST,
        keyed(orgId, 'rate-key')
      )
      expect(stillReplay).toEqual(first)
    })
  })

  it('AC-5: integrity verification passes over a chain containing an idempotent write and its replay', async () => {
    await withTestOrg(async ({ orgId }) => {
      await writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, 'verify-1'))
      await writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, 'verify-1'))
      await writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, 'verify-2'))
      const from = new Date(Date.now() - 60_000).toISOString()
      const to = new Date(Date.now() + 60_000).toISOString()
      const result = await withOrg(orgId, (tx) => verifyAuditRange(tx, { orgId, from, to }))
      expect(result.failed).toEqual([])
      expect(result.rowsChecked).toBe(2)
    })
  })

  it('AC-6: a key lives exactly as long as its audit row (a purged row cascades its key away)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const first = await writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, 'purge-key'))
      await adminSql.begin(async (tx) => {
        await tx`SELECT set_config('app.audit_retention_purge', 'true', true)`
        await tx`DELETE FROM audit_log_entries WHERE id = ${first.id}`
      })
      expect(await keyRowCount(orgId)).toBe(0)
      const fresh = await writeExtensionAuditEventForManifest(MANIFEST, keyed(orgId, 'purge-key'))
      expect(fresh.id).not.toBe(first.id)
    })
  })
})
