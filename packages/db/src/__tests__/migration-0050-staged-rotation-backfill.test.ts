import { describe, it, expect } from 'vitest'
import { sql, eq, and, isNull, desc } from 'drizzle-orm'
import { withOrg } from '../index.js'
import { credentialVersions, rotations } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'
import { createCredentialTestProject, insertTestCredential } from './credential-test-helpers.js'

const FIXED_CREATED_AT = new Date('2026-01-01T00:00:00Z')
const DAY_5 = new Date('2026-01-05T00:00:00Z')
const DAY_2 = new Date('2026-01-02T00:00:00Z')

/**
 * Story 5.6 AC-7.7: reproduces migration 0050's exact backfill statements inline, scoped to a
 * fresh test org via withOrg — mirrors migration-0049-current-version-id-backfill.test.ts's
 * established pattern (never runs the real .sql file against the shared dev database).
 */
async function runBackfillForOrg(orgId: string): Promise<void> {
  await withOrg(orgId, async (tx) => {
    await tx.execute(sql`
      UPDATE credential_versions AS cv
      SET promoted_at = cv.created_at
      FROM rotations AS r
      WHERE r.new_version_id = cv.id
        AND r.status = 'in_progress'
        AND cv.promoted_at IS NULL
    `)
    await tx.execute(sql`
      UPDATE credential_versions
      SET promoted_at = created_at
      WHERE promoted_at IS NULL
    `)
    await tx.execute(sql`
      UPDATE rotations
      SET status = 'promoted', promoted_at = initiated_at
      WHERE status = 'in_progress'
    `)
  })
}

async function insertVersion(
  orgId: string,
  credentialId: string,
  versionNumber: number,
  createdAt: Date
): Promise<string> {
  const [version] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialVersions)
      .values({
        orgId,
        credentialId,
        versionNumber,
        createdAt,
        encryptedValue: { version: 1, iv: 'iv', ciphertext: `ct-${versionNumber}`, tag: 'tag' },
      })
      .returning({ id: credentialVersions.id })
  )
  if (!version) throw new Error('expected credential_versions row to be inserted')
  return version.id
}

async function insertRotation(
  orgId: string,
  params: {
    projectId: string
    credentialId: string
    newVersionId: string
    previousVersionId: string
    status: string
    initiatedAt: Date
  }
): Promise<string> {
  const [rotation] = await withOrg(orgId, (tx) =>
    tx
      .insert(rotations)
      .values({
        orgId,
        projectId: params.projectId,
        credentialId: params.credentialId,
        newVersionId: params.newVersionId,
        previousVersionId: params.previousVersionId,
        status: params.status,
        initiatedAt: params.initiatedAt,
      })
      .returning({ id: rotations.id })
  )
  if (!rotation) throw new Error('expected rotations row to be inserted')
  return rotation.id
}

async function currentVersionId(orgId: string, credentialId: string): Promise<string | null> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ id: credentialVersions.id })
      .from(credentialVersions)
      .where(
        and(
          eq(credentialVersions.credentialId, credentialId),
          sql`${credentialVersions.promotedAt} IS NOT NULL`,
          isNull(credentialVersions.purgedAt),
          isNull(credentialVersions.abandonedAt)
        )
      )
      .orderBy(desc(credentialVersions.promotedAt), desc(credentialVersions.versionNumber))
      .limit(1)
  )
  return row?.id ?? null
}

async function rotationRow(orgId: string, rotationId: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(rotations).where(eq(rotations.id, rotationId))
  )
  if (!row) throw new Error('expected rotation row to exist')
  return row
}

async function versionPromotedAt(orgId: string, versionId: string): Promise<Date | null> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ promotedAt: credentialVersions.promotedAt })
      .from(credentialVersions)
      .where(eq(credentialVersions.id, versionId))
  )
  if (!row) throw new Error('expected credential_versions row to exist')
  return row.promotedAt
}

describe('migration 0050 in-flight rotation backfill (AC-7.7)', () => {
  it('(a) an in_progress rotation migrates to promoted, new version stays "current" before and after', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0050-inprogress')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0050-a')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-0050-a')
        const v1 = await insertVersion(orgId, credentialId, 1, new Date('2026-01-01T00:00:00Z'))
        const v2 = await insertVersion(orgId, credentialId, 2, DAY_5)
        const rotationId = await insertRotation(orgId, {
          projectId,
          credentialId,
          newVersionId: v2,
          previousVersionId: v1,
          status: 'in_progress',
          initiatedAt: DAY_5,
        })

        await runBackfillForOrg(orgId)

        const rotation = await rotationRow(orgId, rotationId)
        expect(rotation.status).toBe('promoted')
        expect(rotation.promotedAt?.toISOString()).toBe(DAY_5.toISOString())
        // The "no silent value-serving regression" assertion: v2 is current before AND after,
        // since it was already the highest versionNumber pre-migration (old selection logic).
        expect(await currentVersionId(orgId, credentialId)).toBe(v2)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('(b) a completed rotation is left untouched', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0050-completed')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0050-b')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-0050-b')
        const v1 = await insertVersion(orgId, credentialId, 1, FIXED_CREATED_AT)
        const v2 = await insertVersion(orgId, credentialId, 2, DAY_2)
        const rotationId = await insertRotation(orgId, {
          projectId,
          credentialId,
          newVersionId: v2,
          previousVersionId: v1,
          status: 'completed',
          initiatedAt: FIXED_CREATED_AT,
        })

        await runBackfillForOrg(orgId)

        const rotation = await rotationRow(orgId, rotationId)
        expect(rotation.status).toBe('completed')
        expect(rotation.promotedAt).toBeNull()
        // Ordinary AC-1.3 blanket backfill still applies to its versions.
        expect(await versionPromotedAt(orgId, v2)).not.toBeNull()
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('(c) an abandoned rotation is left untouched', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0050-abandoned')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0050-c')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-0050-c')
        const v1 = await insertVersion(orgId, credentialId, 1, FIXED_CREATED_AT)
        const v2 = await insertVersion(orgId, credentialId, 2, DAY_2)
        const rotationId = await insertRotation(orgId, {
          projectId,
          credentialId,
          newVersionId: v2,
          previousVersionId: v1,
          status: 'abandoned',
          initiatedAt: FIXED_CREATED_AT,
        })

        await runBackfillForOrg(orgId)

        const rotation = await rotationRow(orgId, rotationId)
        expect(rotation.status).toBe('abandoned')
        expect(rotation.promotedAt).toBeNull()
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('(d) re-running the migration a second time is a no-op (idempotency)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0050-idempotent')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0050-d')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-0050-d')
        const v1 = await insertVersion(orgId, credentialId, 1, FIXED_CREATED_AT)
        const v2 = await insertVersion(orgId, credentialId, 2, DAY_2)
        const rotationId = await insertRotation(orgId, {
          projectId,
          credentialId,
          newVersionId: v2,
          previousVersionId: v1,
          status: 'in_progress',
          initiatedAt: DAY_2,
        })

        await runBackfillForOrg(orgId)
        const firstRotation = await rotationRow(orgId, rotationId)
        const firstV1PromotedAt = await versionPromotedAt(orgId, v1)
        const firstV2PromotedAt = await versionPromotedAt(orgId, v2)

        await runBackfillForOrg(orgId)
        const secondRotation = await rotationRow(orgId, rotationId)
        expect(secondRotation.status).toBe(firstRotation.status)
        expect(secondRotation.promotedAt?.toISOString()).toBe(
          firstRotation.promotedAt?.toISOString()
        )
        expect((await versionPromotedAt(orgId, v1))?.toISOString()).toBe(
          firstV1PromotedAt?.toISOString()
        )
        expect((await versionPromotedAt(orgId, v2))?.toISOString()).toBe(
          firstV2PromotedAt?.toISOString()
        )
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('(e) a credential with no rotation history still gets its single version backfilled', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0050-norotation')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0050-e')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-0050-e')
        const v1 = await insertVersion(orgId, credentialId, 1, FIXED_CREATED_AT)

        await runBackfillForOrg(orgId)

        expect((await versionPromotedAt(orgId, v1))?.toISOString()).toBe(
          FIXED_CREATED_AT.toISOString()
        )
        expect(await currentVersionId(orgId, credentialId)).toBe(v1)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })
})
