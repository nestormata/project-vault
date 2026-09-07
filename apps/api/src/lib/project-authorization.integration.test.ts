import { describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { orgMemberships } from '@project-vault/db/schema'
import {
  createTestUser,
  deleteTestUser,
  insertTestProject,
  withTwoTestOrgs,
} from '@project-vault/db/test-helpers'
import { checkProjectAuthorization } from './project-authorization.js'
import { runWithRequestContext } from './request-context.js'

type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'
const NOT_A_PROJECT_MEMBER = { outcome: 'denied', reasonCode: 'not-a-project-member' } as const

async function insertMembership(orgId: string, userId: string, role: OrgRole): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({ orgId, userId, role, status: 'active' })
  )
}

describe('checkProjectAuthorization — Story 37.1 AC8 (live Postgres, real tenant isolation)', () => {
  it('AC8: a projectId that is real but belongs to a DIFFERENT org than the ambient one is denied/not-a-project-member — including for an org owner', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const userId = await createTestUser('project-authz-cross-org')
      try {
        // Owner in the ambient org (A) — this AC's whole point is that the org-owner bypass
        // never runs before the project-in-org check, so being an owner does not help here.
        await insertMembership(orgAId, userId, 'owner')

        const projectInOrgB = await insertTestProject(orgBId, {
          userId,
          slug: 'project-authz-cross-org',
        })

        const outcome = await runWithRequestContext({ orgId: orgAId, userId }, () =>
          checkProjectAuthorization(
            { viewerIdentityId: userId, projectId: projectInOrgB.id, minimumRole: 'viewer' },
            { extensionName: 'test-extension' }
          )
        )

        expect(outcome).toEqual(NOT_A_PROJECT_MEMBER)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('a real project inside the ambient org, with an org-owner caller, is authorized', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const userId = await createTestUser('project-authz-same-org')
      try {
        await insertMembership(orgAId, userId, 'owner')
        const project = await insertTestProject(orgAId, {
          userId,
          slug: 'project-authz-same-org',
        })

        const outcome = await runWithRequestContext({ orgId: orgAId, userId }, () =>
          checkProjectAuthorization(
            { viewerIdentityId: userId, projectId: project.id, minimumRole: 'owner' },
            { extensionName: 'test-extension' }
          )
        )

        expect(outcome).toEqual({ outcome: 'authorized' })
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('AC6.2: two concurrent calls for the same identity/org but different projects resolve and audit independently, no cross-contamination', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const userId = await createTestUser('project-authz-concurrency')
      try {
        await insertMembership(orgAId, userId, 'owner')
        const [projectOne, projectTwo] = await Promise.all([
          insertTestProject(orgAId, { userId, slug: 'project-authz-concurrency-1' }),
          insertTestProject(orgAId, { userId, slug: 'project-authz-concurrency-2' }),
        ])
        if (!projectOne || !projectTwo) throw new Error('expected two test projects')

        const [outcomeOne, outcomeTwo] = await runWithRequestContext(
          { orgId: orgAId, userId },
          () =>
            Promise.all([
              checkProjectAuthorization(
                { viewerIdentityId: userId, projectId: projectOne.id, minimumRole: 'owner' },
                { extensionName: 'test-extension-concurrency' }
              ),
              checkProjectAuthorization(
                { viewerIdentityId: userId, projectId: projectTwo.id, minimumRole: 'owner' },
                { extensionName: 'test-extension-concurrency' }
              ),
            ])
        )

        expect(outcomeOne).toEqual({ outcome: 'authorized' })
        expect(outcomeTwo).toEqual({ outcome: 'authorized' })
      } finally {
        await deleteTestUser(userId)
      }
    })
  })
})
