import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { withOrg } from '../index.js'
import { orgMemberships, projectMemberships, projects } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'
import { createCredentialTestProject } from './credential-test-helpers.js'

/**
 * Story 4.5 AC-V7: reproduces `0044_project_membership_visibility_backfill.sql`'s exact
 * INSERT...SELECT statement, scoped to this test's own fresh org (via an explicit
 * `p.org_id = ${orgId}` filter) so it never touches unrelated data from other tests running
 * against the same shared dev database — mirroring migration 0043's own test precedent
 * (`migration-0043-tag-case-backfill.test.ts`) of reproducing rather than re-running the real
 * migration file, scoped narrowly for test isolation.
 */
async function runBackfillForOrg(orgId: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.execute(sql`
      INSERT INTO project_memberships (org_id, project_id, user_id, role)
      SELECT p.org_id, p.id, om.user_id, 'viewer'
      FROM projects p
      JOIN org_memberships om ON om.org_id = p.org_id
      WHERE om.role IN ('member', 'viewer') AND p.org_id = ${orgId}
      ON CONFLICT (project_id, user_id) DO NOTHING
    `)
  )
}

async function membershipRole(
  orgId: string,
  projectId: string,
  userId: string
): Promise<string | undefined> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ role: projectMemberships.role })
      .from(projectMemberships)
      .where(
        sql`${projectMemberships.projectId} = ${projectId} AND ${projectMemberships.userId} = ${userId}`
      )
  )
  return row?.role
}

describe('migration 0044 project-membership visibility backfill (AC-V7)', () => {
  it('backfills a viewer row for every (project, member/viewer) pair lacking one', async () => {
    await withTestOrg(async ({ orgId }) => {
      const ownerUserId = await createTestUser('migration-0044-owner')
      const memberUserId = await createTestUser('migration-0044-member')
      const viewerUserId = await createTestUser('migration-0044-viewer')
      try {
        await withOrg(orgId, (tx) =>
          tx.insert(orgMemberships).values([
            { orgId, userId: ownerUserId, role: 'owner' },
            { orgId, userId: memberUserId, role: 'member' },
            { orgId, userId: viewerUserId, role: 'viewer' },
          ])
        )
        const projectId = await createCredentialTestProject(
          orgId,
          ownerUserId,
          'proj-0044-backfill'
        )

        await runBackfillForOrg(orgId)

        expect(await membershipRole(orgId, projectId, memberUserId)).toBe('viewer')
        expect(await membershipRole(orgId, projectId, viewerUserId)).toBe('viewer')
      } finally {
        await deleteTestUser(viewerUserId)
        await deleteTestUser(memberUserId)
        await deleteTestUser(ownerUserId)
      }
    })
  })

  it('does not downgrade an existing explicit membership role (ON CONFLICT DO NOTHING)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const ownerUserId = await createTestUser('migration-0044-owner-2')
      const memberUserId = await createTestUser('migration-0044-real-member')
      try {
        await withOrg(orgId, (tx) =>
          tx.insert(orgMemberships).values([
            { orgId, userId: ownerUserId, role: 'owner' },
            { orgId, userId: memberUserId, role: 'member' },
          ])
        )
        const projectId = await createCredentialTestProject(
          orgId,
          ownerUserId,
          'proj-0044-real-membership'
        )
        // A real Story 4.1 invitation-acceptance membership, at a higher role than the backfill
        // would ever assign.
        await withOrg(orgId, (tx) =>
          tx
            .insert(projectMemberships)
            .values({ orgId, projectId, userId: memberUserId, role: 'member' })
        )

        await runBackfillForOrg(orgId)

        expect(await membershipRole(orgId, projectId, memberUserId)).toBe('member')
      } finally {
        await deleteTestUser(memberUserId)
        await deleteTestUser(ownerUserId)
      }
    })
  })

  it('backfills visibility for an archived project too (Open Question 2)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const ownerUserId = await createTestUser('migration-0044-owner-3')
      const viewerUserId = await createTestUser('migration-0044-archived-viewer')
      try {
        await withOrg(orgId, (tx) =>
          tx.insert(orgMemberships).values([
            { orgId, userId: ownerUserId, role: 'owner' },
            { orgId, userId: viewerUserId, role: 'viewer' },
          ])
        )
        const projectId = await createCredentialTestProject(
          orgId,
          ownerUserId,
          'proj-0044-archived'
        )
        await withOrg(orgId, (tx) =>
          tx
            .update(projects)
            .set({ archivedAt: new Date() })
            .where(sql`${projects.id} = ${projectId}`)
        )

        await runBackfillForOrg(orgId)

        expect(await membershipRole(orgId, projectId, viewerUserId)).toBe('viewer')
      } finally {
        await deleteTestUser(viewerUserId)
        await deleteTestUser(ownerUserId)
      }
    })
  })

  it('does not backfill a row for an org owner/admin (D1 bypass needs no row)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const ownerUserId = await createTestUser('migration-0044-owner-4')
      try {
        await withOrg(orgId, (tx) =>
          tx.insert(orgMemberships).values([{ orgId, userId: ownerUserId, role: 'owner' }])
        )
        const projectId = await createCredentialTestProject(
          orgId,
          ownerUserId,
          'proj-0044-owner-only'
        )

        await runBackfillForOrg(orgId)

        expect(await membershipRole(orgId, projectId, ownerUserId)).toBeUndefined()
      } finally {
        await deleteTestUser(ownerUserId)
      }
    })
  })
})
