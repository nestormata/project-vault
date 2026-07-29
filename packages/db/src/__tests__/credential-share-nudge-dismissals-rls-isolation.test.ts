import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb, withOrg, type Tx } from '../index.js'
import { credentialShareNudgeDismissals } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'
import { createCredentialTestProject, insertTestCredential } from './credential-test-helpers.js'

// `dismissedBy` is `onDelete: 'restrict'` (AC-10's exact column spec) — `withTestOrg`'s org
// cleanup doesn't cascade-delete credentials (org_id has no ON DELETE action), so a row this
// test inserted would otherwise still reference the test user and block `deleteTestUser`'s own
// cleanup in each test's `finally`. Explicit, org-scoped teardown here (RLS blocks an unscoped
// `getDb()` delete from matching any row at all) — mirroring the org-cleanup swallow behavior
// already accepted elsewhere in this test-helper module.
async function deleteDismissalsInOrg(tx: Tx, userId: string): Promise<void> {
  await tx
    .delete(credentialShareNudgeDismissals)
    .where(eq(credentialShareNudgeDismissals.dismissedBy, userId))
}

// Story 17.3 AC-10/Task 1.4: org-scoping via the standard RLS test suite pattern used elsewhere,
// plus confirmation that an empty/whitespace-only `reason` is NOT rejected at the DB layer (that
// enforcement lives at the API layer per AC-15 — a redundant DB-level CHECK would produce a
// confusing 500 instead of a clean 422).
describe('credential_share_nudge_dismissals RLS cross-org isolation', () => {
  it('isolates dismissal rows by org', async () => {
    const userId = await createTestUser('nudge-dismiss')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          const projectAId = await createCredentialTestProject(orgAId, userId, 'proj-a')
          const projectBId = await createCredentialTestProject(orgBId, userId, 'proj-b')
          const credentialAId = await insertTestCredential(orgAId, projectAId, userId, 'Cred A')
          const credentialBId = await insertTestCredential(orgBId, projectBId, userId, 'Cred B')

          await withOrg(orgAId, (tx) =>
            tx.insert(credentialShareNudgeDismissals).values({
              orgId: orgAId,
              credentialId: credentialAId,
              fieldKey: null,
              dismissedBy: userId,
              reason: 'rotated manually',
            })
          )
          await withOrg(orgBId, (tx) =>
            tx.insert(credentialShareNudgeDismissals).values({
              orgId: orgBId,
              credentialId: credentialBId,
              fieldKey: null,
              dismissedBy: userId,
              reason: 'false alarm',
            })
          )

          const orgARows = await withOrg(orgAId, (tx) =>
            tx.select().from(credentialShareNudgeDismissals)
          )
          expect(orgARows).toHaveLength(1)
          expect(orgARows[0]?.orgId).toBe(orgAId)

          const orgBRows = await withOrg(orgBId, (tx) =>
            tx.select().from(credentialShareNudgeDismissals)
          )
          expect(orgBRows).toHaveLength(1)
          expect(orgBRows[0]?.orgId).toBe(orgBId)

          const bareRows = await getDb().select().from(credentialShareNudgeDismissals)
          expect(bareRows).toHaveLength(0)

          await withOrg(orgBId, (tx) => deleteDismissalsInOrg(tx, userId))
          await withOrg(orgAId, (tx) => deleteDismissalsInOrg(tx, userId))
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('rejects cross-org writes via RLS WITH CHECK default', async () => {
    const userId = await createTestUser('nudge-dismiss-write')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          const projectAId = await createCredentialTestProject(orgAId, userId, 'proj-write-a')
          const credentialAId = await insertTestCredential(orgAId, projectAId, userId, 'Cred')

          await expect(
            withOrg(orgAId, (tx) =>
              tx.insert(credentialShareNudgeDismissals).values({
                orgId: orgBId,
                credentialId: credentialAId,
                fieldKey: null,
                dismissedBy: userId,
                reason: 'cross-org',
              })
            )
          ).rejects.toThrow()
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('does not reject an empty-string reason at the DB layer (enforced at the API layer instead)', async () => {
    const userId = await createTestUser('nudge-dismiss-empty-reason')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-empty-reason')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'Cred')

        const [row] = await withOrg(orgId, (tx) =>
          tx
            .insert(credentialShareNudgeDismissals)
            .values({
              orgId,
              credentialId,
              fieldKey: null,
              dismissedBy: userId,
              reason: '',
            })
            .returning()
        )
        expect(row?.reason).toBe('')

        await withOrg(orgId, (tx) => deleteDismissalsInOrg(tx, userId))
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
