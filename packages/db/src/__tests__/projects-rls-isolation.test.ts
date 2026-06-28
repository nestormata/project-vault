import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb, withOrg } from '../index.js'
import { projectMemberships, projects } from '../schema/index.js'
import { withTestOrg } from '../test-helpers.js'

async function createTestUser(label: string): Promise<string> {
  const [user] = await getDb().execute(
    sql`INSERT INTO users (email, password_hash)
        VALUES (${`proj-rls-${label}-${crypto.randomUUID()}@example.com`}, 'x')
        RETURNING id`
  )
  return (user as { id: string }).id
}

async function deleteTestUser(userId: string): Promise<void> {
  await getDb().execute(sql`DELETE FROM users WHERE id = ${userId}`)
}

describe('projects RLS cross-org isolation', () => {
  it('isolates projects rows by org', async () => {
    const userId = await createTestUser('projects')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          const [projectA] = await withOrg(orgAId, (tx) =>
            tx
              .insert(projects)
              .values({
                orgId: orgAId,
                name: 'Project A',
                slug: 'project-a',
                createdBy: userId,
              })
              .returning({ id: projects.id })
          )
          const [projectB] = await withOrg(orgBId, (tx) =>
            tx
              .insert(projects)
              .values({
                orgId: orgBId,
                name: 'Project B',
                slug: 'project-b',
                createdBy: userId,
              })
              .returning({ id: projects.id })
          )
          if (!projectA || !projectB) throw new Error('expected test projects to be inserted')
          await withOrg(orgAId, (tx) =>
            tx.insert(projectMemberships).values({
              orgId: orgAId,
              projectId: projectA.id,
              userId,
              role: 'owner',
            })
          )
          await withOrg(orgBId, (tx) =>
            tx.insert(projectMemberships).values({
              orgId: orgBId,
              projectId: projectB.id,
              userId,
              role: 'owner',
            })
          )

          const orgARows = await withOrg(orgAId, (tx) => tx.select().from(projects))
          expect(orgARows).toHaveLength(1)
          expect(orgARows[0]?.orgId).toBe(orgAId)

          const orgBRows = await withOrg(orgBId, (tx) => tx.select().from(projects))
          expect(orgBRows).toHaveLength(1)
          expect(orgBRows[0]?.orgId).toBe(orgBId)

          const bareRows = await getDb().select().from(projects)
          expect(bareRows).toHaveLength(0)

          const orgAMemberships = await withOrg(orgAId, (tx) =>
            tx.select().from(projectMemberships)
          )
          expect(orgAMemberships).toHaveLength(1)
          expect(orgAMemberships[0]?.orgId).toBe(orgAId)

          const orgBMemberships = await withOrg(orgBId, (tx) =>
            tx.select().from(projectMemberships)
          )
          expect(orgBMemberships).toHaveLength(1)
          expect(orgBMemberships[0]?.orgId).toBe(orgBId)

          const bareMemberships = await getDb().select().from(projectMemberships)
          expect(bareMemberships).toHaveLength(0)
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('slug uniqueness is per org', async () => {
    const userId = await createTestUser('slug-unique')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          await withOrg(orgAId, (tx) =>
            tx
              .insert(projects)
              .values({ orgId: orgAId, name: 'API', slug: 'api', createdBy: userId })
          )

          await expect(
            withOrg(orgBId, (tx) =>
              tx
                .insert(projects)
                .values({ orgId: orgBId, name: 'API', slug: 'api', createdBy: userId })
            )
          ).resolves.not.toThrow()

          await expect(
            withOrg(orgAId, (tx) =>
              tx
                .insert(projects)
                .values({ orgId: orgAId, name: 'API 2', slug: 'api', createdBy: userId })
            )
          ).rejects.toThrow()
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
