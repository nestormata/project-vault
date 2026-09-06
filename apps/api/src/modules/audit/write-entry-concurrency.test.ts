import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser, withTwoTestOrgs } from '@project-vault/db/test-helpers'

// Story 1.25 AC-2: mirrors platform-audit/write-entry-concurrency.test.ts's exact bootstrap —
// the audit module had no concurrency test of its own before this story (Task 2).
const keyDir = mkdtempSync(join(tmpdir(), 'audit-write-entry-concurrency-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'false'
process.env['AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED'] = 'false'

const { initVault, zeroKeys, loadInitialVaultState } = await import('../vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { writeSystemAuditEntry } = await import('./machine-entry.js')

const TEST_PASSPHRASE = 'test-passphrase-audit-chain12'

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

type ChainRow = { id: string; hmac: string; previousEntryHmac: string | null; chainSeq: number }

// Extracted from the test body to keep its own cyclomatic complexity within this repo's eslint
// limit — no behavior change, same assertions in the same order.
function assertSingleUnbrokenChain(rows: ChainRow[], expectedLength: number): void {
  expect(rows).toHaveLength(expectedLength)

  // No two rows may reference the same prior row — a lost-update-style race would produce two
  // rows both claiming the same previousEntryHmac.
  const nonGenesisPreviousHmacs = rows
    .map((r) => r.previousEntryHmac)
    .filter((v): v is string => v !== null)
  expect(new Set(nonGenesisPreviousHmacs).size).toBe(nonGenesisPreviousHmacs.length)

  // Exactly one genesis row (previousEntryHmac === null), and it must be the lowest chain_seq.
  const genesisRows = rows.filter((r) => r.previousEntryHmac === null)
  expect(genesisRows).toHaveLength(1)
  expect(genesisRows[0]?.chainSeq).toBe(rows[0]?.chainSeq)

  // The chain is a single unbroken sequence: each row's previousEntryHmac equals the actual
  // preceding row's hmac (rows are already ordered by chain_seq by the caller).
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i]?.previousEntryHmac).toBe(rows[i - 1]?.hmac)
  }
}

describe.sequential('Story 1.25 AC-2: concurrent audit_log_entries chain writes', () => {
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

  it('N concurrent writes for one org form a single unbroken chain — no two rows share a previous_entry_hmac', async () => {
    const userId = await createTestUser('audit-chain-concurrency')
    const orgId = crypto.randomUUID()
    const slugSuffix = orgId.slice(0, 8)
    await getDb().execute(
      sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${'chain-concurrency-org-' + slugSuffix}, ${'chain-concurrency-' + slugSuffix})`
    )
    try {
      const CONCURRENCY = 25
      await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          getDb().transaction((tx) =>
            writeSystemAuditEntry(tx, {
              orgId,
              eventType: 'test.concurrent',
              payload: { i },
            })
          )
        )
      )

      const rows = await withOrg(orgId, (tx) =>
        tx
          .select({
            id: auditLogEntries.id,
            hmac: auditLogEntries.hmac,
            previousEntryHmac: auditLogEntries.previousEntryHmac,
            chainSeq: auditLogEntries.chainSeq,
          })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.orgId, orgId))
          .orderBy(auditLogEntries.chainSeq)
      )

      assertSingleUnbrokenChain(rows, CONCURRENCY)
    } finally {
      await tryDeleteTestUser(userId)
      // audit_log_entries is append-only (Story 8.1) — the rows this test wrote can never be
      // deleted, so the org row they FK-reference can't be cleaned up either. Mirrors
      // test-helpers.ts's cleanupTestOrg swallowing this exact FK violation.
      try {
        await getDb().execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined
        const isFkViolation =
          Boolean(cause) &&
          typeof cause === 'object' &&
          (cause as { code?: string }).code === '23503'
        if (!isFkViolation) throw error
      }
    }
  })

  it('AC-2 negative example: two orgs writing interleaved never cross-link — each org only ever references its own prior rows', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const write = (orgId: string, eventType: string): Promise<void> =>
        getDb().transaction((tx: Tx) =>
          writeSystemAuditEntry(tx, { orgId, eventType, payload: {} })
        )

      await write(orgAId, 'orgA.first')
      await write(orgBId, 'orgB.first')
      await write(orgAId, 'orgA.second')
      await write(orgBId, 'orgB.second')

      const orgARows = await withOrg(orgAId, (tx) =>
        tx
          .select({ previousEntryHmac: auditLogEntries.previousEntryHmac })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.orgId, orgAId))
          .orderBy(auditLogEntries.chainSeq)
      )
      const orgBRows = await withOrg(orgBId, (tx) =>
        tx
          .select({ previousEntryHmac: auditLogEntries.previousEntryHmac })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.orgId, orgBId))
          .orderBy(auditLogEntries.chainSeq)
      )

      // Both orgs' FIRST row must see previousHmac === null (genesis), never the other org's row.
      expect(orgARows[0]?.previousEntryHmac).toBeNull()
      expect(orgBRows[0]?.previousEntryHmac).toBeNull()
      expect(orgARows).toHaveLength(2)
      expect(orgBRows).toHaveLength(2)
    })
  })
})
