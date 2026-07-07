import { describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { orgMemberships } from '@project-vault/db/schema'
import { withTestOrg, createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import {
  getOrgRouting,
  putOrgRouting,
  resolveRoutingRecipients,
  resolveUserDormancyRecipients,
  SecurityAlertRoutingError,
} from './routing.js'

describe('notification routing service', () => {
  it('resolveRoutingRecipients returns owners by default', async () => {
    const ownerId = await createTestUser('routing-owner')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          tx
            .insert(orgMemberships)
            .values({ orgId, userId: ownerId, role: 'owner', status: 'active' })
        )
        const recipients = await withOrg(orgId, (tx) =>
          resolveRoutingRecipients(orgId, 'security.failed_auth_threshold', tx)
        )
        expect(recipients).toContain(ownerId)
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  })

  it('falls back to owner when routing target role has zero members', async () => {
    const ownerId = await createTestUser('routing-fallback')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          tx
            .insert(orgMemberships)
            .values({ orgId, userId: ownerId, role: 'owner', status: 'active' })
        )
        await withOrg(orgId, (tx) =>
          putOrgRouting(orgId, [{ alertType: 'service.down', routeTo: 'admin' }], tx)
        )

        const logSpy = vi.spyOn(process.stdout, 'write')
        const recipients = await withOrg(orgId, (tx) =>
          resolveRoutingRecipients(orgId, 'service.down', tx)
        )
        expect(recipients).toContain(ownerId)
        expect(logSpy).toHaveBeenCalledWith(
          expect.stringContaining('notification.routing_fallback')
        )
        logSpy.mockRestore()
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  })

  it('rejects routing security alerts to all members', async () => {
    await withTestOrg(async ({ orgId }) => {
      await expect(
        withOrg(orgId, (tx) =>
          putOrgRouting(
            orgId,
            [{ alertType: 'security.failed_auth_threshold', routeTo: 'member' }],
            tx
          )
        )
      ).rejects.toBeInstanceOf(SecurityAlertRoutingError)
    })
  })

  it('getOrgRouting returns owner default for all alert types', async () => {
    await withTestOrg(async ({ orgId }) => {
      const routing = await withOrg(orgId, (tx) => getOrgRouting(orgId, tx))
      expect(routing.every((r) => r.routeTo === 'owner')).toBe(true)
    })
  })
})

/**
 * Story 8.3 D12/AC-16 (resolves finding-16): FR71 says dormant-user alerts go to "Organization
 * Admins" (the PRD's broader term covering both owner and admin roles), but epics.md's own AC
 * text narrows this to "org owners" — resolveUserDormancyRecipients reconciles the two by
 * defaulting to the UNION of owner+admin (unless an org has configured an explicit
 * org_notification_routing override for 'user.dormant', which is always honored as a single
 * role). This is a small, alert-type-scoped extension — every other alert type's
 * resolveRoutingRecipients() behavior (single target role, no union) is untouched.
 */
describe('resolveUserDormancyRecipients (D12/AC-16)', () => {
  it('defaults to the union of owner AND admin when no override is configured', async () => {
    const ownerId = await createTestUser('user-dormancy-owner')
    const adminId = await createTestUser('user-dormancy-admin')
    const memberId = await createTestUser('user-dormancy-member')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          tx.insert(orgMemberships).values([
            { orgId, userId: ownerId, role: 'owner', status: 'active' },
            { orgId, userId: adminId, role: 'admin', status: 'active' },
            { orgId, userId: memberId, role: 'member', status: 'active' },
          ])
        )

        const recipients = await withOrg(orgId, (tx) => resolveUserDormancyRecipients(orgId, tx))

        expect(recipients).toContain(ownerId)
        expect(recipients).toContain(adminId)
        expect(recipients).not.toContain(memberId)
        // Deduplicated union, not a naive concat — no repeated ids.
        expect(new Set(recipients).size).toBe(recipients.length)
      })
    } finally {
      await deleteTestUser(ownerId)
      await deleteTestUser(adminId)
      await deleteTestUser(memberId)
    }
  })

  it('honors an explicit owner-only override, not the union', async () => {
    const ownerId = await createTestUser('user-dormancy-override-owner')
    const adminId = await createTestUser('user-dormancy-override-admin')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          tx.insert(orgMemberships).values([
            { orgId, userId: ownerId, role: 'owner', status: 'active' },
            { orgId, userId: adminId, role: 'admin', status: 'active' },
          ])
        )
        await withOrg(orgId, (tx) =>
          putOrgRouting(orgId, [{ alertType: 'user.dormant', routeTo: 'owner' }], tx)
        )

        const recipients = await withOrg(orgId, (tx) => resolveUserDormancyRecipients(orgId, tx))

        expect(recipients).toContain(ownerId)
        expect(recipients).not.toContain(adminId)
      })
    } finally {
      await deleteTestUser(ownerId)
      await deleteTestUser(adminId)
    }
  })

  it('honors an explicit admin-only override, not the union', async () => {
    const ownerId = await createTestUser('user-dormancy-override-owner2')
    const adminId = await createTestUser('user-dormancy-override-admin2')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          tx.insert(orgMemberships).values([
            { orgId, userId: ownerId, role: 'owner', status: 'active' },
            { orgId, userId: adminId, role: 'admin', status: 'active' },
          ])
        )
        await withOrg(orgId, (tx) =>
          putOrgRouting(orgId, [{ alertType: 'user.dormant', routeTo: 'admin' }], tx)
        )

        const recipients = await withOrg(orgId, (tx) => resolveUserDormancyRecipients(orgId, tx))

        expect(recipients).toContain(adminId)
        expect(recipients).not.toContain(ownerId)
      })
    } finally {
      await deleteTestUser(ownerId)
      await deleteTestUser(adminId)
    }
  })
})
