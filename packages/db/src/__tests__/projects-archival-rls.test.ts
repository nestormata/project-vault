import { describe, expect, it } from 'vitest'
import { eq, isNotNull } from 'drizzle-orm'
import { getDb, withOrg } from '../index.js'
import { projects } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg, withTwoTestOrgs } from '../test-helpers.js'

describe('projects archival RLS cross-org isolation (4.4 AC-9)', () => {
  it('an org-A update filtered by RLS touches 0 rows against an org-B project (archive path)', async () => {
    const userId = await createTestUser('archival-rls')
    try {
      await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
        const [projectB] = await withOrg(orgBId, (tx) =>
          tx
            .insert(projects)
            .values({
              orgId: orgBId,
              name: 'Org B Project',
              slug: 'org-b-project',
              createdBy: userId,
            })
            .returning({ id: projects.id })
        )
        if (!projectB) throw new Error('expected org B test project to be inserted')

        // Simulate the archive route's atomic UPDATE, but run under org A's RLS context against
        // org B's project id — this is exactly what a cross-org archive attempt would execute.
        const updated = await withOrg(orgAId, (tx) =>
          tx
            .update(projects)
            .set({ archivedAt: new Date() })
            .where(eq(projects.id, projectB.id))
            .returning({ id: projects.id })
        )
        expect(updated).toHaveLength(0)

        // The project in org B remains active — the cross-org attempt changed nothing.
        const stillActive = await withOrg(orgBId, (tx) =>
          tx
            .select({ archivedAt: projects.archivedAt })
            .from(projects)
            .where(eq(projects.id, projectB.id))
        )
        expect(stillActive[0]?.archivedAt).toBeNull()
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('archiving a project in org A does not change row visibility for org B', async () => {
    const userId = await createTestUser('archival-rls-visibility')
    try {
      await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
        const [projectA] = await withOrg(orgAId, (tx) =>
          tx
            .insert(projects)
            .values({
              orgId: orgAId,
              name: 'Org A Project',
              slug: 'org-a-project',
              createdBy: userId,
            })
            .returning({ id: projects.id })
        )
        const [projectB] = await withOrg(orgBId, (tx) =>
          tx
            .insert(projects)
            .values({
              orgId: orgBId,
              name: 'Org B Visible Project',
              slug: 'org-b-visible-project',
              createdBy: userId,
            })
            .returning({ id: projects.id })
        )
        if (!projectA || !projectB) throw new Error('expected test projects to be inserted')

        await withOrg(orgAId, (tx) =>
          tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectA.id))
        )

        const orgAArchived = await withOrg(orgAId, (tx) =>
          tx.select({ id: projects.id }).from(projects).where(isNotNull(projects.archivedAt))
        )
        expect(orgAArchived.map((row) => row.id)).toEqual([projectA.id])

        // Org B's view is untouched: its project is still active and org A's archived project
        // is never visible cross-org regardless of archival state.
        const orgBRows = await withOrg(orgBId, (tx) => tx.select().from(projects))
        expect(orgBRows).toHaveLength(1)
        expect(orgBRows[0]?.id).toBe(projectB.id)
        expect(orgBRows[0]?.archivedAt).toBeNull()
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('a bare update without org context affects 0 rows (RLS denies) — never assert success on a bare query', async () => {
    const userId = await createTestUser('archival-rls-bare')
    try {
      await withTestOrg(async ({ orgId }) => {
        const [project] = await withOrg(orgId, (tx) =>
          tx
            .insert(projects)
            .values({
              orgId,
              name: 'Bare Query Project',
              slug: 'bare-query-project',
              createdBy: userId,
            })
            .returning({ id: projects.id })
        )
        if (!project) throw new Error('expected test project to be inserted')

        const bareUpdate = await getDb()
          .update(projects)
          .set({ archivedAt: new Date() })
          .where(eq(projects.id, project.id))
          .returning({ id: projects.id })
        expect(bareUpdate).toHaveLength(0)

        const stillActive = await withOrg(orgId, (tx) =>
          tx
            .select({ archivedAt: projects.archivedAt })
            .from(projects)
            .where(eq(projects.id, project.id))
        )
        expect(stillActive[0]?.archivedAt).toBeNull()
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
