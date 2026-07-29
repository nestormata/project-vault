import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { credentialShares } from '@project-vault/db/schema'
import { withTestOrg, createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { seedWorkerCredential, seedWorkerProject } from '../../workers/worker-test-helpers.js'
import { supersedeOutstandingSharesForRotation } from './service.js'

// Story 17.3 AC-12: unit-level coverage of the field-scoping rule in isolation from the full
// promote HTTP flow (covered separately, end-to-end, in rotation/rotation-promote-retire.test.ts)
// — this is the single most consequential correctness rule in the story's supersession scope.
function futureDate(ms = 60 * 60 * 1000): Date {
  return new Date(Date.now() + ms)
}

async function seedShare(
  orgId: string,
  credentialId: string,
  userId: string,
  overrides: Partial<{
    status: 'active' | 'viewed' | 'revoked' | 'expired' | 'superseded'
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
        sharedBy: userId,
        recipientType: 'user',
        recipientUserId: userId,
        recipientEmail: null,
        tokenHash: randomUUID(),
        expiresAt: futureDate(),
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

async function deleteSharesByUser(orgId: string, userId: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.delete(credentialShares).where(eq(credentialShares.sharedBy, userId))
  )
}

describe.sequential('supersedeOutstandingSharesForRotation', () => {
  beforeAll(async () => {
    await resetVaultForTest()
  })
  afterAll(async () => {
    await resetVaultForTest()
  })

  it('AC-12: whole-secret rotation (targetFields null) supersedes every outstanding share regardless of fieldKey', async () => {
    const userId = await createTestUser('supersede-whole-secret')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedWorkerProject(orgId, 'SupersedeWhole')
        const credentialId = await seedWorkerCredential(orgId, projectId, 'SupersedeWhole')
        const wholeCred = await seedShare(orgId, credentialId, userId, { fieldKey: null })
        const scopedField = await seedShare(orgId, credentialId, userId, {
          fieldKey: 'webhook_secret',
        })

        const superseded = await withOrg(orgId, (tx) =>
          supersedeOutstandingSharesForRotation(tx, {
            orgId,
            credentialId,
            targetFields: null,
            rotationId: randomUUID(),
          })
        )

        expect(superseded.map((s) => s.id).sort()).toEqual([wholeCred, scopedField].sort())
        expect((await shareState(orgId, wholeCred))?.status).toBe('superseded')
        expect((await shareState(orgId, wholeCred))?.supersededAt).not.toBeNull()
        expect((await shareState(orgId, scopedField))?.status).toBe('superseded')

        await deleteSharesByUser(orgId, userId)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('AC-12: field-scoped rotation supersedes only matching-field and whole-credential shares, leaves unrelated-field shares untouched', async () => {
    const userId = await createTestUser('supersede-field-scoped')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedWorkerProject(orgId, 'SupersedeScoped')
        const credentialId = await seedWorkerCredential(orgId, projectId, 'SupersedeScoped')
        const wholeCred = await seedShare(orgId, credentialId, userId, { fieldKey: null })
        const matchingField = await seedShare(orgId, credentialId, userId, {
          fieldKey: 'api_key',
        })
        const unrelatedField = await seedShare(orgId, credentialId, userId, {
          fieldKey: 'webhook_secret',
        })

        const superseded = await withOrg(orgId, (tx) =>
          supersedeOutstandingSharesForRotation(tx, {
            orgId,
            credentialId,
            targetFields: ['api_key'],
            rotationId: randomUUID(),
          })
        )

        expect(superseded.map((s) => s.id).sort()).toEqual([wholeCred, matchingField].sort())
        expect((await shareState(orgId, unrelatedField))?.status).toBe('active')

        await deleteSharesByUser(orgId, userId)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('AC-12: revoked/expired shares are left alone, not double-transitioned', async () => {
    const userId = await createTestUser('supersede-terminal')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedWorkerProject(orgId, 'SupersedeTerminal')
        const credentialId = await seedWorkerCredential(orgId, projectId, 'SupersedeTerminal')
        const revoked = await seedShare(orgId, credentialId, userId, { status: 'revoked' })
        const expired = await seedShare(orgId, credentialId, userId, { status: 'expired' })
        const viewed = await seedShare(orgId, credentialId, userId, { status: 'viewed' })

        const superseded = await withOrg(orgId, (tx) =>
          supersedeOutstandingSharesForRotation(tx, {
            orgId,
            credentialId,
            targetFields: null,
            rotationId: randomUUID(),
          })
        )

        expect(superseded.map((s) => s.id)).toEqual([viewed])
        expect((await shareState(orgId, revoked))?.status).toBe('revoked')
        expect((await shareState(orgId, expired))?.status).toBe('expired')

        await deleteSharesByUser(orgId, userId)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
