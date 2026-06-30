import { describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { orgMemberships } from '@project-vault/db/schema'
import { withTestOrg, createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import {
  getOrgRouting,
  putOrgRouting,
  resolveRoutingRecipients,
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
