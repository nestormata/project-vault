import { describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { orgMemberships, projectMemberships } from '@project-vault/db/schema'
import {
  createTestUser,
  deleteTestUser,
  insertTestProject,
  withTwoTestOrgs,
} from '@project-vault/db/test-helpers'
import { readEffectiveProjectAccess } from './project-authorization-effective-access.js'
import { runWithRequestContext } from './request-context.js'

type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

async function insertMembership(orgId: string, userId: string, role: OrgRole): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({ orgId, userId, role, status: 'active' })
  )
}

async function insertProjectRole(
  orgId: string,
  projectId: string,
  userId: string,
  role: OrgRole
): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(projectMemberships).values({ orgId, projectId, userId, role })
  )
}

describe('readEffectiveProjectAccess — live Postgres (Story 73.6)', () => {
  it('an org-admin caller sees the subject on every active project; a project-member caller sees only theirs', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const adminId = await createTestUser('epa-admin')
      const memberId = await createTestUser('epa-member')
      const subjectId = await createTestUser('epa-subject')
      try {
        await insertMembership(orgAId, adminId, 'admin')
        await insertMembership(orgAId, memberId, 'member')
        await insertMembership(orgAId, subjectId, 'admin')
        const projectA = await insertTestProject(orgAId, { userId: adminId, slug: 'epa-a' })
        const projectB = await insertTestProject(orgAId, { userId: adminId, slug: 'epa-b' })
        await insertProjectRole(orgAId, projectA.id, memberId, 'viewer')

        const asAdmin = await runWithRequestContext({ orgId: orgAId, userId: adminId }, () =>
          readEffectiveProjectAccess({ viewerIdentityId: subjectId }, { extensionName: 'epa-int' })
        )
        expect(asAdmin.outcome).toBe('ok')
        if (asAdmin.outcome === 'ok') {
          expect(asAdmin.groupGrantEvaluation).toBe('not_evaluated')
          expect(new Set(asAdmin.items.map((item) => item.projectId))).toEqual(
            new Set([projectA.id, projectB.id])
          )
          expect(asAdmin.items.every((item) => item.grantSource === 'role')).toBe(true)
        }

        const asMember = await runWithRequestContext({ orgId: orgAId, userId: memberId }, () =>
          readEffectiveProjectAccess({ viewerIdentityId: subjectId }, { extensionName: 'epa-int' })
        )
        expect(asMember).toEqual({
          outcome: 'ok',
          groupGrantEvaluation: 'not_evaluated',
          items: [{ projectId: projectA.id, effectiveRole: 'admin', grantSource: 'role' }],
        })
      } finally {
        await deleteTestUser(adminId)
        await deleteTestUser(memberId)
        await deleteTestUser(subjectId)
      }
    })
  })

  it('does not list org B projects from org A ambient context', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const userId = await createTestUser('epa-cross')
      try {
        await insertMembership(orgAId, userId, 'admin')
        await insertMembership(orgBId, userId, 'admin')
        const projectB = await insertTestProject(orgBId, { userId, slug: 'epa-b-only' })
        await insertTestProject(orgAId, { userId, slug: 'epa-a-only' })

        const outcome = await runWithRequestContext({ orgId: orgAId, userId }, () =>
          readEffectiveProjectAccess({ viewerIdentityId: userId }, { extensionName: 'epa-cross' })
        )
        expect(outcome.outcome).toBe('ok')
        if (outcome.outcome === 'ok') {
          expect(outcome.items.map((item) => item.projectId)).not.toContain(projectB.id)
        }
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('returns empty ok when the subject is not an active member of the ambient org', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const callerId = await createTestUser('epa-caller')
      const foreignId = await createTestUser('epa-foreign')
      try {
        await insertMembership(orgAId, callerId, 'owner')
        await insertMembership(orgBId, foreignId, 'member')
        await insertTestProject(orgAId, { userId: callerId, slug: 'epa-empty' })

        const outcome = await runWithRequestContext({ orgId: orgAId, userId: callerId }, () =>
          readEffectiveProjectAccess(
            { viewerIdentityId: foreignId },
            { extensionName: 'epa-empty' }
          )
        )
        expect(outcome).toEqual({
          outcome: 'ok',
          items: [],
          groupGrantEvaluation: 'not_evaluated',
        })
      } finally {
        await deleteTestUser(callerId)
        await deleteTestUser(foreignId)
      }
    })
  })
})
