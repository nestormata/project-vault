import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { orgMemberships } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import { resolveActiveOrgRole } from '../plugins/authenticate.js'
import { roleRank } from './secure-route.js'
import { checkOrgAuthorization } from './org-authorization.js'
import { runWithRequestContext } from './request-context.js'

type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'
const NOT_A_MEMBER = { outcome: 'denied', reasonCode: 'not-a-member' } as const
// Fixed placeholder org id — deliberately never a real row, not a real secret/credential.
const NONEXISTENT_ORG_ID = ['00000000', '0000', '0000', '0000', '000000000000'].join('-')

async function insertMembership(
  orgId: string,
  userId: string,
  role: OrgRole,
  status: 'active' | 'deactivated' = 'active'
): Promise<void> {
  await withOrg(orgId, (tx) => tx.insert(orgMemberships).values({ orgId, userId, role, status }))
}

/**
 * Story 23.9 AC2 — the no-drift test: independently resolve via `resolveActiveOrgRole()` (Task
 * 1's shared query, also used by `authenticate.ts`'s `loadOrgRole()`) and `roleRank()`
 * (`secure-route.ts`), then assert `checkOrgAuthorization()`'s outcome is consistent with that
 * independently resolved role for the same inputs — not against a native endpoint's HTTP
 * response, since no native endpoint returns a comparable value-shaped result.
 */
async function assertConsistentWithIndependentResolution(
  orgId: string,
  userId: string,
  minimumRole: OrgRole
): Promise<void> {
  const [independentRole, outcome] = await Promise.all([
    resolveActiveOrgRole(userId, orgId),
    runWithRequestContext({ orgId, userId }, () =>
      checkOrgAuthorization({ viewerIdentityId: userId, minimumRole })
    ),
  ])

  if (independentRole === null) {
    expect(outcome).toEqual(NOT_A_MEMBER)
    return
  }

  if (roleRank(independentRole) >= roleRank(minimumRole)) {
    expect(outcome).toEqual({ outcome: 'authorized' })
  } else {
    expect(outcome.outcome).toBe('denied')
  }
}

describe('checkOrgAuthorization — AC2 no-drift (integration, real DB)', () => {
  it('an active owner is consistent with independently resolved role/rank for every minimumRole', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('org-authz-owner')
      try {
        await insertMembership(orgId, userId, 'owner')
        for (const minimumRole of ['owner', 'admin', 'member', 'viewer'] as const) {
          await assertConsistentWithIndependentResolution(orgId, userId, minimumRole)
        }
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('an active viewer is consistent with independently resolved role/rank for every minimumRole', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('org-authz-viewer')
      try {
        await insertMembership(orgId, userId, 'viewer')
        for (const minimumRole of ['owner', 'admin', 'member', 'viewer'] as const) {
          await assertConsistentWithIndependentResolution(orgId, userId, minimumRole)
        }
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('AC3: a deactivated membership row resolves the same as no row at all', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('org-authz-deactivated')
      try {
        await insertMembership(orgId, userId, 'admin', 'deactivated')
        await assertConsistentWithIndependentResolution(orgId, userId, 'viewer')

        const outcome = await runWithRequestContext({ orgId, userId }, () =>
          checkOrgAuthorization({ viewerIdentityId: userId, minimumRole: 'viewer' })
        )
        expect(outcome).toEqual(NOT_A_MEMBER)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('AC3: a user with no membership row at all is denied/not-a-member', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('org-authz-no-row')
      try {
        await assertConsistentWithIndependentResolution(orgId, userId, 'viewer')
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  it('AC3: a non-existent organizationId is denied/not-a-member, never an error', async () => {
    const userId = await createTestUser('org-authz-no-org')
    try {
      const outcome = await runWithRequestContext({ orgId: NONEXISTENT_ORG_ID, userId }, () =>
        checkOrgAuthorization({ viewerIdentityId: userId, minimumRole: 'viewer' })
      )
      expect(outcome).toEqual(NOT_A_MEMBER)
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('AC5: reflects a real membership status change between two consecutive calls, never a stale cached result', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('org-authz-downgrade')
      try {
        await insertMembership(orgId, userId, 'admin')
        const before = await runWithRequestContext({ orgId, userId }, () =>
          checkOrgAuthorization({ viewerIdentityId: userId, minimumRole: 'admin' })
        )
        expect(before).toEqual({ outcome: 'authorized' })

        await withOrg(orgId, (tx) =>
          tx
            .update(orgMemberships)
            .set({ status: 'deactivated' })
            .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
        )

        const after = await runWithRequestContext({ orgId, userId }, () =>
          checkOrgAuthorization({ viewerIdentityId: userId, minimumRole: 'admin' })
        )
        expect(after).toEqual(NOT_A_MEMBER)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })
})
