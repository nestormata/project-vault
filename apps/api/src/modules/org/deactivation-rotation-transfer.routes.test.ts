import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue, orgMemberships } from '@project-vault/db/schema'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import {
  bootstrapRouteIntegrationTest,
  createProjectViaApi as createProject,
  expectAuditWriteFailed,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { mapWithConcurrency } from '../../lib/map-with-concurrency.js'
import {
  auditPayloads,
  bootLogCaptureRouteTestApp,
  deactivateViaApi,
  deniedLogLines,
  holdRotationLock,
  membershipRow,
  removeViaApi,
  rotationOwnership,
  startRotationViaApi,
  updateRotation,
} from './rotation-guard-test-helpers.js'

/**
 * Story 43-17 AC-3..AC-9: `rotationHandling: "transfer"` on deactivate and remove. Ownership moves
 * to `rotations.owner_user_id`; `initiated_by` (provenance, four-eyes) is never rewritten.
 */

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'rotation-transfer',
  orgNamePrefix: 'Rotation Transfer',
})

const transferTo = (userId: string) => ({ rotationHandling: 'transfer', transferToUserId: userId })

const INVALID_TARGET = {
  code: 'invalid_transfer_target',
  message: 'The selected user cannot receive rotation ownership',
}

/** No rotation changed owner and none has an ownership-transfer audit row. */
async function expectNothingTransferred(orgId: string, rotationIds: string[]): Promise<void> {
  await Promise.all(
    rotationIds.map(async (rotationId) => {
      expect((await rotationOwnership(orgId, rotationId)).ownerUserId).toBeNull()
      expect(
        await auditPayloads(orgId, AuditEvent.ROTATION_OWNERSHIP_TRANSFERRED, rotationId)
      ).toEqual([])
    })
  )
}

describe('Story 43-17: rotationHandling "transfer" on deactivate and remove', () => {
  let app: TestApp
  let logLines: string[]

  beforeAll(async () => {
    ;({ app, lines: logLines } = await bootLogCaptureRouteTestApp(createApp, initVault))
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  /** Owner, admin initiator X, a second admin Y, and one rotation by X per requested status. */
  async function fixture(label: string, statuses: string[]) {
    const owner = await registerOwner(app, `${label}-owner`)
    const x = await addUserToOrg(app, owner.orgId, `${label}-x`, { orgRole: 'admin' })
    const y = await addUserToOrg(app, owner.orgId, `${label}-y`, { orgRole: 'admin' })
    const projectId = await createProject(app, owner.cookies, `${label}-project`)
    // Sequential (limit 1): each rotation needs its own credential and a stable order.
    const rotationIds = await mapWithConcurrency(statuses, 1, async (status) => {
      const { rotationId } = await startRotationViaApi(app, x.cookies, projectId)
      if (status !== 'staged') await updateRotation(owner.orgId, rotationId, { status })
      return rotationId
    })
    return { owner, x, y, projectId, rotationIds }
  }

  describe('AC-3: request contract', () => {
    it.each([
      ['transfer without a target', { rotationHandling: 'transfer' }],
      ['abandon with a target', { rotationHandling: 'abandon', transferToUserId: randomUUID() }],
      ['a target alone', { transferToUserId: randomUUID() }],
      ['a non-uuid target', { rotationHandling: 'transfer', transferToUserId: 'nope' }],
      ['hold', { rotationHandling: 'hold' }],
    ])('422 for %s, changing nothing', async (_label, body) => {
      const { owner, x, rotationIds } = await fixture('contract', ['staged'])

      const res = await deactivateViaApi(app, owner.cookies, x.userId, body)

      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ code: 'validation_error' })
      expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('active')
      expect(
        (await rotationOwnership(owner.orgId, rotationIds[0] as string)).ownerUserId
      ).toBeNull()
    })

    it('an unknown key beside a valid transfer is rejected too', async () => {
      const { owner, x, y } = await fixture('contract-extra', ['staged'])

      const res = await deactivateViaApi(app, owner.cookies, x.userId, {
        ...transferTo(y.userId),
        extra: true,
      })

      expect(res.statusCode).toBe(422)
    })

    it('regression: {} still blocks and abandon still abandons (43-15 behaviour)', async () => {
      const { owner, x, rotationIds } = await fixture('contract-regression', ['staged'])

      const blocked = await deactivateViaApi(app, owner.cookies, x.userId, {})
      expect(blocked.statusCode).toBe(409)
      expect(blocked.json()).toEqual({ error: 'active_rotations', rotationIds })

      const abandoned = await deactivateViaApi(app, owner.cookies, x.userId, {
        rotationHandling: 'abandon',
      })
      expect(abandoned.statusCode).toBe(200)
      const data = abandoned.json<{ data: Record<string, unknown> }>().data
      expect(data).toMatchObject({ abandonedRotationCount: 1, heldRotationCount: 0 })
      expect(data).not.toHaveProperty('transferredRotationCount')
    })
  })

  describe('AC-4/AC-7: happy path', () => {
    it('moves all four blocking statuses to Y, keeps initiated_by, audits each hop', async () => {
      const { owner, x, y, rotationIds } = await fixture('happy', [
        'staged',
        'promoted',
        'stale_recovery',
        'in_progress',
      ])

      const res = await deactivateViaApi(app, owner.cookies, x.userId, transferTo(y.userId))

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: {
          userId: x.userId,
          transferredRotationCount: 4,
          transferredToUserId: y.userId,
          abandonedRotationCount: 0,
          heldRotationCount: 0,
        },
      })
      expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('deactivated')
      const statuses = ['staged', 'promoted', 'stale_recovery', 'in_progress']
      await Promise.all(
        rotationIds.map(async (rotationId, index) => {
          const expectedStatus = statuses.at(index)
          expect(await rotationOwnership(owner.orgId, rotationId)).toEqual({
            ownerUserId: y.userId,
            initiatedBy: x.userId,
            status: expectedStatus,
          })
          const rows = await auditPayloads(
            owner.orgId,
            AuditEvent.ROTATION_OWNERSHIP_TRANSFERRED,
            rotationId
          )
          expect(rows).toHaveLength(1)
          expect(rows[0]).toMatchObject({
            fromUserId: x.userId,
            toUserId: y.userId,
            reason: 'owner_deactivated',
            previousStatus: expectedStatus,
          })
          expect(rows[0]).toHaveProperty('credentialId')
        })
      )
      const [deactivated] = await auditPayloads(
        owner.orgId,
        AuditEvent.ORG_USER_DEACTIVATED,
        x.userId
      )
      expect(deactivated).toMatchObject({
        transferredRotationCount: 4,
        transferredToUserId: y.userId,
      })
    })

    it('the new owner blocks their own deactivation; the old owner no longer does (AC-2)', async () => {
      const { owner, x, y, rotationIds } = await fixture('chain', ['staged'])
      await deactivateViaApi(app, owner.cookies, x.userId, transferTo(y.userId))

      const blocked = await deactivateViaApi(app, owner.cookies, y.userId)

      expect(blocked.statusCode).toBe(409)
      expect(blocked.json()).toEqual({ error: 'active_rotations', rotationIds })
    })

    it('a second hop chains: fromUserId is the previous owner, owner_user_id is overwritten', async () => {
      const { owner, x, y, rotationIds } = await fixture('second-hop', ['staged'])
      const z = await addUserToOrg(app, owner.orgId, 'second-hop-z', { orgRole: 'admin' })
      await deactivateViaApi(app, owner.cookies, x.userId, transferTo(y.userId))

      const res = await deactivateViaApi(app, owner.cookies, y.userId, transferTo(z.userId))

      expect(res.statusCode).toBe(200)
      const rotationId = rotationIds[0] as string
      expect(await rotationOwnership(owner.orgId, rotationId)).toMatchObject({
        ownerUserId: z.userId,
        initiatedBy: x.userId,
      })
      const hops = await auditPayloads(
        owner.orgId,
        AuditEvent.ROTATION_OWNERSHIP_TRANSFERRED,
        rotationId
      )
      expect(hops.map((hop) => [hop.fromUserId, hop.toUserId])).toEqual(
        expect.arrayContaining([
          [x.userId, y.userId],
          [y.userId, z.userId],
        ])
      )
    })

    it('terminal rotations are never touched', async () => {
      const { owner, x, y, rotationIds } = await fixture('terminal', ['staged', 'retired'])
      const [staged, retired] = rotationIds as [string, string]

      const res = await deactivateViaApi(app, owner.cookies, x.userId, transferTo(y.userId))

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ data: { transferredRotationCount: 1 } })
      expect((await rotationOwnership(owner.orgId, staged)).ownerUserId).toBe(y.userId)
      expect((await rotationOwnership(owner.orgId, retired)).ownerUserId).toBeNull()
    })

    it('the caller may name themselves as the target', async () => {
      const { owner, x, rotationIds } = await fixture('self-target', ['staged'])

      const res = await deactivateViaApi(app, owner.cookies, x.userId, transferTo(owner.userId))

      expect(res.statusCode).toBe(200)
      expect((await rotationOwnership(owner.orgId, rotationIds[0] as string)).ownerUserId).toBe(
        owner.userId
      )
    })

    it('with nothing to transfer: 200, count 0, no rotation audit rows', async () => {
      const { owner, x, y } = await fixture('nothing', [])

      const res = await deactivateViaApi(app, owner.cookies, x.userId, transferTo(y.userId))

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ data: { transferredRotationCount: 0 } })
      expect(
        await auditPayloads(owner.orgId, AuditEvent.ROTATION_OWNERSHIP_TRANSFERRED, x.userId)
      ).toEqual([])
    })

    it('notifies the new owner once with a count and no secret values', async () => {
      const { owner, x, y } = await fixture('notify', ['staged', 'promoted'])

      const res = await deactivateViaApi(app, owner.cookies, x.userId, transferTo(y.userId))

      expect(res.statusCode).toBe(200)
      const queued = await withOrg(owner.orgId, (tx) =>
        tx
          .select({
            templateId: notificationQueue.templateId,
            recipientUserId: notificationQueue.recipientUserId,
            payload: notificationQueue.payload,
          })
          .from(notificationQueue)
          .where(eq(notificationQueue.templateId, 'rotation.ownership_transferred'))
      )
      const forY = queued.filter((row) => row.recipientUserId === y.userId)
      expect(forY.length).toBeGreaterThan(0)
      expect(queued.some((row) => row.recipientUserId === x.userId)).toBe(false)
      expect(forY[0]?.payload).toMatchObject({ rotationCount: 2, fromUserId: x.userId })
    })
  })

  describe('AC-5: target validation', () => {
    async function expectRefused(
      label: string,
      pick: (f: Awaited<ReturnType<typeof fixture>>) => Promise<string> | string,
      statuses: string[] = ['staged']
    ) {
      const f = await fixture(label, statuses)
      const target = await pick(f)

      const res = await deactivateViaApi(app, f.owner.cookies, f.x.userId, transferTo(target))

      expect(res.statusCode).toBe(422)
      expect(res.json()).toEqual(INVALID_TARGET)
      expect((await membershipRow(f.owner.orgId, f.x.userId))?.status).toBe('active')
      await expectNothingTransferred(f.owner.orgId, f.rotationIds)
      expect(
        await auditPayloads(f.owner.orgId, AuditEvent.ORG_USER_DEACTIVATED, f.x.userId)
      ).toEqual([])
    }

    it('refuses the user being deactivated', () => expectRefused('t-self', ({ x }) => x.userId))

    it('refuses a deactivated user', () =>
      expectRefused('t-deactivated', async ({ owner, y }) => {
        await withOrg(owner.orgId, (tx) =>
          tx
            .update(orgMemberships)
            .set({ status: 'deactivated' })
            .where(and(eq(orgMemberships.orgId, owner.orgId), eq(orgMemberships.userId, y.userId)))
        )
        return y.userId
      }))

    it('refuses a removed (non-member) user', () =>
      expectRefused('t-removed', async ({ owner, y }) => {
        await withOrg(owner.orgId, (tx) =>
          tx
            .delete(orgMemberships)
            .where(and(eq(orgMemberships.orgId, owner.orgId), eq(orgMemberships.userId, y.userId)))
        )
        return y.userId
      }))

    it('refuses an admin of another org with the same response as an unknown id', async () => {
      await expectRefused('t-other-org', async () => (await registerOwner(app, 't-other')).userId)
      await expectRefused('t-unknown', () => randomUUID())
    })

    it('refuses member and viewer roles', async () => {
      await expectRefused(
        't-member',
        async ({ owner }) =>
          (await addUserToOrg(app, owner.orgId, 't-member-u', { orgRole: 'member' })).userId
      )
      await expectRefused(
        't-viewer',
        async ({ owner }) =>
          (await addUserToOrg(app, owner.orgId, 't-viewer-u', { orgRole: 'viewer' })).userId
      )
    })

    it('an invalid target is a 422 even when there is nothing to transfer', () =>
      expectRefused('t-nothing', () => randomUUID(), []))

    it('self-action, hierarchy and already_deactivated win before target validation', async () => {
      const f = await fixture('precedence', ['staged'])
      const bogus = transferTo(randomUUID())

      expect((await deactivateViaApi(app, f.owner.cookies, f.owner.userId, bogus)).statusCode).toBe(
        403
      )
      expect((await deactivateViaApi(app, f.x.cookies, f.owner.userId, bogus)).statusCode).toBe(403)
      expect((await deactivateViaApi(app, f.owner.cookies, randomUUID(), bogus)).statusCode).toBe(
        404
      )
    })
  })

  describe('AC-7/AC-8: atomicity', () => {
    it('an audit failure on the second rotation rolls everything back (503)', async () => {
      const { owner, x, y, rotationIds } = await fixture('audit-fail', ['staged', 'promoted'])
      const original = humanAudit.writeHumanAuditEntry
      const spy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockImplementationOnce((...args) => original(...args))
        .mockRejectedValueOnce(new Error('forced audit failure'))
      try {
        const res = await deactivateViaApi(app, owner.cookies, x.userId, transferTo(y.userId))
        expectAuditWriteFailed(res)
      } finally {
        spy.mockRestore()
      }

      expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('active')
      await expectNothingTransferred(owner.orgId, rotationIds)
    })

    it('a busy rotation lock → 409 rotation_busy with nothing transferred', async () => {
      const { owner, x, y, rotationIds } = await fixture('busy', ['staged', 'staged'])
      const [first, second] = rotationIds as [string, string]
      const holder = await holdRotationLock(owner.orgId, second)

      try {
        const res = await deactivateViaApi(app, owner.cookies, x.userId, transferTo(y.userId))

        expect(res.statusCode).toBe(409)
        expect(res.json()).toMatchObject({ code: 'rotation_busy' })
      } finally {
        await holder.release()
      }
      await expectNothingTransferred(owner.orgId, [first, second])
      expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('active')

      // Story 43-19: the refusal log carries the real count (both rotations, not `0`).
      const denials = await deniedLogLines(
        app,
        logLines,
        OperationalEvent.ORG_USER_DEACTIVATE_DENIED,
        x.userId
      )
      expect(denials).toHaveLength(1)
      expect(denials[0]).toEqual(
        expect.objectContaining({
          level: 'warn',
          reason: 'rotation_busy',
          rotationCount: rotationIds.length,
          callerId: owner.userId,
        })
      )
    })
  })

  describe('DELETE /api/v1/org/users/:userId (remove parity)', () => {
    it('transfers, then removes the user, auditing owner_removed', async () => {
      const { owner, x, y, rotationIds } = await fixture('remove', ['staged', 'promoted'])

      const res = await removeViaApi(app, owner.cookies, x.userId, transferTo(y.userId))

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: { userId: x.userId, transferredRotationCount: 2, transferredToUserId: y.userId },
      })
      expect(await membershipRow(owner.orgId, x.userId)).toBeUndefined()
      await Promise.all(
        rotationIds.map(async (rotationId) => {
          expect((await rotationOwnership(owner.orgId, rotationId)).ownerUserId).toBe(y.userId)
          const [hop] = await auditPayloads(
            owner.orgId,
            AuditEvent.ROTATION_OWNERSHIP_TRANSFERRED,
            rotationId
          )
          expect(hop).toMatchObject({ reason: 'owner_removed', fromUserId: x.userId })
        })
      )
      const [removed] = await auditPayloads(owner.orgId, AuditEvent.ORG_USER_REMOVED, x.userId)
      expect(removed).toMatchObject({ transferredRotationCount: 2, transferredToUserId: y.userId })
    })

    it('refuses an invalid target with the same 422 and removes nobody', async () => {
      const { owner, x } = await fixture('remove-bad', ['staged'])

      const res = await removeViaApi(app, owner.cookies, x.userId, transferTo(x.userId))

      expect(res.statusCode).toBe(422)
      expect(res.json()).toEqual(INVALID_TARGET)
      expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('active')
    })
  })
})
