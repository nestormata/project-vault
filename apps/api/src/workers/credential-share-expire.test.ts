import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialShares } from '@project-vault/db/schema'
import { withTestOrg, createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import {
  ensureWorkerTestEnv,
  seedWorkerCredential,
  seedWorkerProject,
  unsealWorkerTestVault,
} from './worker-test-helpers.js'

ensureWorkerTestEnv()

const { initVault } = await import('../modules/vault/key-service.js')
const { runCredentialShareExpireJob } = await import('./credential-share-expire.js')

const TEST_PASSPHRASE = 'credential-share-expire-passphrase'
const EXPIRED_EVENT = 'credential.share_expired'

function futureDate(ms: number): Date {
  return new Date(Date.now() + ms)
}
function pastDate(ms: number): Date {
  return new Date(Date.now() - ms)
}

async function seedShare(
  orgId: string,
  credentialId: string,
  sharedBy: string,
  overrides: Partial<{
    status: 'active' | 'viewed' | 'revoked' | 'expired' | 'superseded'
    expiresAt: Date
    fieldKey: string | null
  }> = {}
): Promise<string> {
  const [share] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialShares)
      .values({
        orgId,
        credentialId,
        fieldKey: overrides.fieldKey ?? null,
        sharedBy,
        recipientType: 'user',
        recipientUserId: sharedBy,
        recipientEmail: null,
        tokenHash: randomUUID(),
        expiresAt: overrides.expiresAt ?? futureDate(60 * 60 * 1000),
        status: overrides.status ?? 'active',
      })
      .returning({ id: credentialShares.id })
  )
  if (!share) throw new Error('expected test share to be inserted')
  return share.id
}

async function shareState(orgId: string, shareId: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(credentialShares).where(eq(credentialShares.id, shareId))
  )
  return row
}

async function expiredAuditCount(orgId: string, shareId: string): Promise<number> {
  const rows = await withOrg(orgId, (tx) =>
    tx.select().from(auditLogEntries).where(eq(auditLogEntries.eventType, EXPIRED_EVENT))
  )
  return rows.filter((row) => row.resourceId === shareId).length
}

// `sharedBy`/`recipientUserId` are `onDelete: 'restrict'` — `withTestOrg`'s org cleanup doesn't
// cascade-delete credentials (org_id has no ON DELETE action), so a share this test inserted
// would otherwise still reference the test user and block `deleteTestUser`'s own cleanup.
async function deleteSharesByUser(orgId: string, userId: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.delete(credentialShares).where(eq(credentialShares.sharedBy, userId))
  )
}

describe.sequential('runCredentialShareExpireJob', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await unsealWorkerTestVault(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('AC-7: transitions a past-due active share to expired and writes the audit event', async () => {
    const userId = await createTestUser('share-expire-sweep')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedWorkerProject(orgId, 'ShareExpireSweep')
        const credentialId = await seedWorkerCredential(orgId, projectId, 'ShareExpireSweep')
        const shareId = await seedShare(orgId, credentialId, userId, {
          expiresAt: pastDate(1000),
        })

        await runCredentialShareExpireJob()

        const state = await shareState(orgId, shareId)
        expect(state?.status).toBe('expired')
        expect(await expiredAuditCount(orgId, shareId)).toBe(1)
        await deleteSharesByUser(orgId, userId)
      })
    } finally {
      await deleteTestUser(userId)
    }
  }, 60_000)

  it('AC-7: is a no-op for a share whose expiresAt has not yet passed', async () => {
    const userId = await createTestUser('share-expire-not-due')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedWorkerProject(orgId, 'ShareExpireNotDue')
        const credentialId = await seedWorkerCredential(orgId, projectId, 'ShareExpireNotDue')
        const shareId = await seedShare(orgId, credentialId, userId, {
          expiresAt: futureDate(60 * 60 * 1000),
        })

        await runCredentialShareExpireJob()

        const state = await shareState(orgId, shareId)
        expect(state?.status).toBe('active')
        await deleteSharesByUser(orgId, userId)
      })
    } finally {
      await deleteTestUser(userId)
    }
  }, 60_000)

  it('AC-5/AC-7: never touches an already-terminal share (revoked/viewed/superseded) even if its expiresAt has passed', async () => {
    const userId = await createTestUser('share-expire-terminal')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedWorkerProject(orgId, 'ShareExpireTerminal')
        const credentialId = await seedWorkerCredential(orgId, projectId, 'ShareExpireTerminal')
        const revokedId = await seedShare(orgId, credentialId, userId, {
          status: 'revoked',
          expiresAt: pastDate(1000),
        })
        const viewedId = await seedShare(orgId, credentialId, userId, {
          status: 'viewed',
          expiresAt: pastDate(1000),
        })
        const supersededId = await seedShare(orgId, credentialId, userId, {
          status: 'superseded',
          expiresAt: pastDate(1000),
        })

        await runCredentialShareExpireJob()

        expect((await shareState(orgId, revokedId))?.status).toBe('revoked')
        expect((await shareState(orgId, viewedId))?.status).toBe('viewed')
        expect((await shareState(orgId, supersededId))?.status).toBe('superseded')
        expect(await expiredAuditCount(orgId, revokedId)).toBe(0)
        expect(await expiredAuditCount(orgId, viewedId)).toBe(0)
        expect(await expiredAuditCount(orgId, supersededId)).toBe(0)
        await deleteSharesByUser(orgId, userId)
      })
    } finally {
      await deleteTestUser(userId)
    }
  }, 60_000)

  it('AC-7: is idempotent — a second run against an already-swept share does not re-audit', async () => {
    const userId = await createTestUser('share-expire-idempotent')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedWorkerProject(orgId, 'ShareExpireIdempotent')
        const credentialId = await seedWorkerCredential(orgId, projectId, 'ShareExpireIdempotent')
        const shareId = await seedShare(orgId, credentialId, userId, {
          expiresAt: pastDate(1000),
        })

        await runCredentialShareExpireJob()
        expect(await expiredAuditCount(orgId, shareId)).toBe(1)

        await runCredentialShareExpireJob()
        expect(await expiredAuditCount(orgId, shareId)).toBe(1)
        await deleteSharesByUser(orgId, userId)
      })
    } finally {
      await deleteTestUser(userId)
    }
  }, 60_000)
})
