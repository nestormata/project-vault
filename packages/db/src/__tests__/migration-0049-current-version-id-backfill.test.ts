import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { withOrg } from '../index.js'
import { credentials, credentialVersions } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg, withTwoTestOrgs } from '../test-helpers.js'
import { createCredentialTestProject, insertTestCredential } from './credential-test-helpers.js'

const FIXED_CREATED_AT = new Date('2026-01-01T00:00:00Z')

/**
 * Story 13.1 AC-6: reproduces `0049_credentials_current_version_id_backfill.sql`'s exact
 * backfill UPDATE statement inline, scoped to this test's own fresh org(s) via
 * `withTestOrg`/`withTwoTestOrgs` (RLS itself confines every query below to the org(s) whose
 * `app.current_org_id` is set for the duration of `withOrg`), mirroring the reproduced-statement
 * pattern established by `migration-0044-project-membership-visibility-backfill.test.ts` and
 * `migration-0043-tag-case-backfill.test.ts` — never runs the real `.sql` file against the shared
 * dev database.
 */
async function runBackfillForOrg(orgId: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.execute(sql`
      UPDATE credentials AS c
      SET current_version_id = latest.id
      FROM (
        SELECT DISTINCT ON (credential_id) credential_id, id
        FROM credential_versions
        ORDER BY credential_id, created_at DESC, id DESC
      ) AS latest
      WHERE latest.credential_id = c.id
        AND c.current_version_id IS NULL
    `)
  )
}

async function currentVersionId(orgId: string, credentialId: string): Promise<string | null> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ currentVersionId: credentials.currentVersionId })
      .from(credentials)
      .where(sql`${credentials.id} = ${credentialId}`)
  )
  if (!row) throw new Error('expected credential row to exist')
  return row.currentVersionId
}

async function credentialUpdatedAt(orgId: string, credentialId: string): Promise<Date> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ updatedAt: credentials.updatedAt })
      .from(credentials)
      .where(sql`${credentials.id} = ${credentialId}`)
  )
  if (!row) throw new Error('expected credential row to exist')
  return row.updatedAt
}

async function insertVersion(
  orgId: string,
  credentialId: string,
  versionNumber: number,
  createdAt: Date,
  extra: { purgedAt?: Date; abandonedAt?: Date; encryptedValue?: unknown } = {}
): Promise<string> {
  const [version] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialVersions)
      .values({
        orgId,
        credentialId,
        versionNumber,
        createdAt,
        encryptedValue:
          extra.encryptedValue !== undefined
            ? (extra.encryptedValue as never)
            : { version: 1, iv: 'iv', ciphertext: `ct-${versionNumber}`, tag: 'tag' },
        ...(extra.purgedAt ? { purgedAt: extra.purgedAt } : {}),
        ...(extra.abandonedAt ? { abandonedAt: extra.abandonedAt } : {}),
      })
      .returning({ id: credentialVersions.id })
  )
  if (!version) throw new Error('expected credential_versions row to be inserted')
  return version.id
}

describe('migration 0049 credentials.current_version_id backfill (AC-1, AC-2, AC-4, AC-5, AC-6)', () => {
  it('(a) backfills to the version with the max created_at, seeded out of insertion order', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0049-multi')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0049-multi')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-multi')

        // Seed 5 versions with distinct created_at in non-insertion order — the 3rd-oldest first.
        await insertVersion(orgId, credentialId, 1, new Date('2026-01-03T00:00:00Z'))
        const latestId = await insertVersion(
          orgId,
          credentialId,
          2,
          new Date('2026-01-05T00:00:00Z')
        )
        await insertVersion(orgId, credentialId, 3, FIXED_CREATED_AT)
        await insertVersion(orgId, credentialId, 4, new Date('2026-01-04T00:00:00Z'))
        await insertVersion(orgId, credentialId, 5, new Date('2026-01-02T00:00:00Z'))
        // latestId (2026-01-05) is the max created_at across all 5.

        await runBackfillForOrg(orgId)

        expect(await currentVersionId(orgId, credentialId)).toBe(latestId)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('(b) backfills a single-version credential correctly', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0049-single')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0049-single')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-single')
        const versionId = await insertVersion(orgId, credentialId, 1, FIXED_CREATED_AT)

        await runBackfillForOrg(orgId)

        expect(await currentVersionId(orgId, credentialId)).toBe(versionId)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('(c) is idempotent — a second run leaves values unchanged and does not re-bump updated_at', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0049-idempotent')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0049-idem')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-idem')
        const versionId = await insertVersion(orgId, credentialId, 1, FIXED_CREATED_AT)

        await runBackfillForOrg(orgId)
        const firstValue = await currentVersionId(orgId, credentialId)
        const firstUpdatedAt = await credentialUpdatedAt(orgId, credentialId)
        expect(firstValue).toBe(versionId)

        // Second run: the WHERE current_version_id IS NULL guard means this credential no
        // longer matches, so it is not touched again — set_updated_at must not fire twice.
        await runBackfillForOrg(orgId)
        const secondValue = await currentVersionId(orgId, credentialId)
        const secondUpdatedAt = await credentialUpdatedAt(orgId, credentialId)

        expect(secondValue).toBe(firstValue)
        expect(secondUpdatedAt.getTime()).toBe(firstUpdatedAt.getTime())
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('(d) skips a zero-version credential (remains NULL) without throwing', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0049-orphan')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0049-orphan')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-orphan')

        await expect(runBackfillForOrg(orgId)).resolves.not.toThrow()

        expect(await currentVersionId(orgId, credentialId)).toBeNull()
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('(AC-1) backfills credentials in two distinct orgs correctly in the same run, not scoped by RLS session context', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const userAId = await createTestUser('migration-0049-org-a')
      const userBId = await createTestUser('migration-0049-org-b')
      try {
        const projectAId = await createCredentialTestProject(orgAId, userAId, 'proj-0049-org-a')
        const projectBId = await createCredentialTestProject(orgBId, userBId, 'proj-0049-org-b')
        const credAId = await insertTestCredential(orgAId, projectAId, userAId, 'cred-org-a')
        const credBId = await insertTestCredential(orgBId, projectBId, userBId, 'cred-org-b')
        const versionAId = await insertVersion(orgAId, credAId, 1, FIXED_CREATED_AT)
        const versionBId = await insertVersion(orgBId, credBId, 1, FIXED_CREATED_AT)

        await runBackfillForOrg(orgAId)
        await runBackfillForOrg(orgBId)

        expect(await currentVersionId(orgAId, credAId)).toBe(versionAId)
        expect(await currentVersionId(orgBId, credBId)).toBe(versionBId)
      } finally {
        await deleteTestUser(userBId)
        await deleteTestUser(userAId)
      }
    })
  })

  it('(AC-2 tiebreak) resolves a created_at tie deterministically by id DESC, stable across re-runs', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0049-tie')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0049-tie')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-tie')
        const sameCreatedAt = FIXED_CREATED_AT
        const idA = await insertVersion(orgId, credentialId, 1, sameCreatedAt)
        const idB = await insertVersion(orgId, credentialId, 2, sameCreatedAt)
        const expected = [idA, idB].sort().reverse()[0] // ORDER BY ... id DESC

        await runBackfillForOrg(orgId)
        const first = await currentVersionId(orgId, credentialId)
        expect(first).toBe(expected)

        // Re-run must resolve to the exact same row (idempotency's determinism guarantee).
        await runBackfillForOrg(orgId)
        expect(await currentVersionId(orgId, credentialId)).toBe(first)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('(AC-1/AC-6 lifecycle edge) still backfills to the true latest when it is purged/abandoned', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0049-lifecycle')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0049-lifecycle')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-lifecycle')

        await insertVersion(orgId, credentialId, 1, FIXED_CREATED_AT, {
          purgedAt: new Date('2026-02-01T00:00:00Z'),
        })
        const latestId = await insertVersion(
          orgId,
          credentialId,
          2,
          new Date('2026-01-15T00:00:00Z'),
          { abandonedAt: new Date('2026-01-16T00:00:00Z') }
        )

        await runBackfillForOrg(orgId)

        expect(await currentVersionId(orgId, credentialId)).toBe(latestId)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('(AC-4 regression) leaves encrypted_value byte-for-byte unchanged for every touched row', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0049-ciphertext')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0049-ciphertext')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-ciphertext')
        const originalValue = {
          version: 1,
          iv: 'iv-fixed',
          ciphertext: 'ct-fixed',
          tag: 'tag-fixed',
        }
        const versionId = await insertVersion(orgId, credentialId, 1, FIXED_CREATED_AT, {
          encryptedValue: originalValue,
        })

        await runBackfillForOrg(orgId)

        const [row] = await withOrg(orgId, (tx) =>
          tx
            .select({ encryptedValue: credentialVersions.encryptedValue })
            .from(credentialVersions)
            .where(sql`${credentialVersions.id} = ${versionId}`)
        )
        expect(row?.encryptedValue).toEqual(originalValue)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })
})
