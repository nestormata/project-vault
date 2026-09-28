import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { orgMemberships } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi as createProject,
  expectAuditWriteFailed,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { tryAcquireRotationScopedLock } from '../../lib/rotation-locks.js'
import { bootProjectRouteTestApp } from '../projects/project-route-test-bootstrap.js'
import {
  auditPayloads,
  deactivateViaApi,
  membershipRow,
  removeViaApi,
  rotationStatusOf,
  rotationVersionState,
  startRotationViaApi,
  updateRotation,
} from './rotation-guard-test-helpers.js'

/**
 * Story 43-15 AC-8 (explicit `rotationHandling: "abandon"` orphan handling) and AC-9 (removal
 * parity). `abandonRotation` is wrapped so one test can force a non-`abandoned` outcome mid-loop;
 * every other call delegates to the real service.
 */
const abandonControl = vi.hoisted(() => ({ calls: 0, failOnCall: 0 }))

vi.mock('../rotation/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rotation/service.js')>()
  return {
    ...actual,
    abandonRotation: async (...args: Parameters<typeof actual.abandonRotation>) => {
      abandonControl.calls += 1
      if (abandonControl.calls === abandonControl.failOnCall) {
        return { outcome: 'concurrent_modification' as const, currentVersion: null }
      }
      return actual.abandonRotation(...args)
    },
  }
})

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'rotation-handling',
  orgNamePrefix: 'Rotation Handling',
})

const ABANDON = { rotationHandling: 'abandon' }

describe('Story 43-15 AC-8/AC-9: rotationHandling "abandon" on deactivate and remove', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterEach(() => {
    abandonControl.calls = 0
    abandonControl.failOnCall = 0
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  /** Owner, admin initiator X, and one rotation by X per requested status (one credential each). */
  async function fixture(label: string, statuses: string[]) {
    const owner = await registerOwner(app, `${label}-owner`)
    const x = await addUserToOrg(app, owner.orgId, `${label}-x`, { orgRole: 'admin' })
    const projectId = await createProject(app, owner.cookies, `${label}-project`)
    const rotationIds: string[] = []
    for (const status of statuses) {
      const { rotationId } = await startRotationViaApi(app, x.cookies, projectId)
      if (status !== 'staged') await updateRotation(owner.orgId, rotationId, { status })
      rotationIds.push(rotationId)
    }
    return { owner, x, projectId, rotationIds }
  }

  describe('POST /api/v1/org/users/:userId/deactivate', () => {
    it('abandons staged/stale_recovery, holds promoted/in_progress, deactivates, and audits it all', async () => {
      const { owner, x, rotationIds } = await fixture('mixed', [
        'staged',
        'promoted',
        'stale_recovery',
        'in_progress',
      ])
      const [staged, promoted, stale, legacy] = rotationIds as [string, string, string, string]

      const res = await deactivateViaApi(app, owner.cookies, x.userId, ABANDON)

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: { userId: x.userId, abandonedRotationCount: 2, heldRotationCount: 2 },
      })
      expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('deactivated')
      expect(await rotationStatusOf(owner.orgId, staged)).toBe('abandoned')
      expect(await rotationStatusOf(owner.orgId, stale)).toBe('abandoned')
      expect(await rotationStatusOf(owner.orgId, promoted)).toBe('promoted')
      expect(await rotationStatusOf(owner.orgId, legacy)).toBe('in_progress')
      // abandonRotation's side effects — never a raw CAS that would leave the credential locked.
      expect(await rotationVersionState(owner.orgId, staged)).toEqual({
        previousLocked: false,
        newAbandoned: true,
      })
      for (const abandoned of [staged, stale]) {
        const rows = await auditPayloads(owner.orgId, AuditEvent.ROTATION_ABANDONED, abandoned)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          reason: 'initiator_deactivated',
          deactivatedUserId: x.userId,
        })
      }
      const [deactivated] = await auditPayloads(
        owner.orgId,
        AuditEvent.ORG_USER_DEACTIVATED,
        x.userId
      )
      expect(deactivated).toMatchObject({
        abandonedRotationIds: [staged, stale],
        heldRotationIds: [promoted, legacy],
      })
    })

    it('is harmless when the target owns no rotations (200, both counts 0)', async () => {
      const { owner, x } = await fixture('none', [])

      const res = await deactivateViaApi(app, owner.cookies, x.userId, ABANDON)

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: { abandonedRotationCount: 0, heldRotationCount: 0 },
      })
    })

    it('an empty body keeps the default block (409 active_rotations)', async () => {
      const { owner, x, rotationIds } = await fixture('empty-body', ['staged'])

      const res = await deactivateViaApi(app, owner.cookies, x.userId, {})

      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'active_rotations', rotationIds })
    })

    it('rejects any other handling value or an unknown key — no silent fallback', async () => {
      const { owner, x, rotationIds } = await fixture('invalid-body', ['staged'])

      const transfer = await deactivateViaApi(app, owner.cookies, x.userId, {
        rotationHandling: 'transfer',
      })
      const unknownKey = await deactivateViaApi(app, owner.cookies, x.userId, {
        handling: 'abandon',
      })

      for (const res of [transfer, unknownKey]) {
        expect(res.statusCode).toBe(422)
        expect(res.json()).toMatchObject({ code: 'validation_error' })
      }
      expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('active')
      expect(await rotationStatusOf(owner.orgId, rotationIds[0] as string)).toBe('staged')
    })

    it('a busy rotation lock → 409 rotation_busy with NOTHING abandoned (Phase 1 tries every lock first)', async () => {
      const { owner, x, rotationIds } = await fixture('busy', ['staged', 'staged'])
      const [first, second] = rotationIds as [string, string]
      let releaseHeld!: () => void
      const held = new Promise<void>((resolve) => {
        releaseHeld = resolve
      })
      let lockTaken!: () => void
      const locked = new Promise<void>((resolve) => {
        lockTaken = resolve
      })
      const holder = withOrg(owner.orgId, async (tx) => {
        expect(await tryAcquireRotationScopedLock(tx, owner.orgId, second)).toBe(true)
        lockTaken()
        await held
      })
      await locked

      try {
        const res = await deactivateViaApi(app, owner.cookies, x.userId, ABANDON)

        expect(res.statusCode).toBe(409)
        expect(res.json()).toEqual({
          code: 'rotation_busy',
          message: 'A rotation for this user is being modified; retry shortly.',
        })
      } finally {
        releaseHeld()
        await holder
      }
      expect(await rotationStatusOf(owner.orgId, first)).toBe('staged')
      expect(await rotationStatusOf(owner.orgId, second)).toBe('staged')
      expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('active')
    })

    it('a non-abandoned outcome mid-loop rolls back the earlier abandon (409 rotation_busy)', async () => {
      const { owner, x, rotationIds } = await fixture('mid-loop', ['staged', 'staged'])
      abandonControl.failOnCall = 2

      const res = await deactivateViaApi(app, owner.cookies, x.userId, ABANDON)

      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'rotation_busy' })
      for (const rotationId of rotationIds) {
        expect(await rotationStatusOf(owner.orgId, rotationId)).toBe('staged')
        expect(await auditPayloads(owner.orgId, AuditEvent.ROTATION_ABANDONED, rotationId)).toEqual(
          []
        )
      }
      expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('active')
    })

    it('an abandon audit-write failure fails closed and rolls everything back (503)', async () => {
      const { owner, x, rotationIds } = await fixture('audit-fail', ['staged'])
      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error('forced audit failure'))
      try {
        const res = await deactivateViaApi(app, owner.cookies, x.userId, ABANDON)
        expectAuditWriteFailed(res)
      } finally {
        auditSpy.mockRestore()
      }
      expect(await rotationStatusOf(owner.orgId, rotationIds[0] as string)).toBe('staged')
      expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('active')
    })

    it('hierarchy, self and already_deactivated still win before anything is abandoned', async () => {
      const owner = await registerOwner(app, 'precedence-owner')
      const admin = await addUserToOrg(app, owner.orgId, 'precedence-admin', { orgRole: 'admin' })
      const projectId = await createProject(app, owner.cookies, 'precedence-project')
      const ownerRotation = await startRotationViaApi(app, owner.cookies, projectId)
      const adminRotation = await startRotationViaApi(app, admin.cookies, projectId)

      expect((await deactivateViaApi(app, admin.cookies, owner.userId, ABANDON)).statusCode).toBe(
        403
      )
      expect((await deactivateViaApi(app, owner.cookies, owner.userId, ABANDON)).statusCode).toBe(
        403
      )
      await withOrg(owner.orgId, (tx) =>
        tx
          .update(orgMemberships)
          .set({ status: 'deactivated' })
          .where(
            and(eq(orgMemberships.orgId, owner.orgId), eq(orgMemberships.userId, admin.userId))
          )
      )
      const already = await deactivateViaApi(app, owner.cookies, admin.userId, ABANDON)
      expect(already.statusCode).toBe(409)
      expect(already.json()).toMatchObject({ code: 'already_deactivated' })
      expect((await deactivateViaApi(app, owner.cookies, randomUUID(), ABANDON)).statusCode).toBe(
        404
      )

      expect(await rotationStatusOf(owner.orgId, ownerRotation.rotationId)).toBe('staged')
      expect(await rotationStatusOf(owner.orgId, adminRotation.rotationId)).toBe('staged')
    })
  })

  describe('DELETE /api/v1/org/users/:userId (AC-9 parity)', () => {
    it('refuses removal with the identical 409 and mutates nothing (membership, sessions)', async () => {
      const { owner, x, rotationIds } = await fixture('remove-block', ['staged'])

      const res = await removeViaApi(app, owner.cookies, x.userId)

      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'active_rotations', rotationIds })
      expect(await membershipRow(owner.orgId, x.userId)).toMatchObject({ status: 'active' })
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: cookieHeader(x.cookies) },
      })
      expect(me.statusCode).toBe(200)
      expect(await auditPayloads(owner.orgId, AuditEvent.ORG_USER_REMOVED, x.userId)).toEqual([])
    })

    it('abandons/holds with rotationHandling "abandon", then removes the user', async () => {
      const { owner, x, rotationIds } = await fixture('remove-abandon', ['staged', 'promoted'])
      const [staged, promoted] = rotationIds as [string, string]

      const res = await removeViaApi(app, owner.cookies, x.userId, ABANDON)

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: { userId: x.userId, abandonedRotationCount: 1, heldRotationCount: 1 },
      })
      expect(await membershipRow(owner.orgId, x.userId)).toBeUndefined()
      expect(await rotationStatusOf(owner.orgId, staged)).toBe('abandoned')
      expect(await rotationStatusOf(owner.orgId, promoted)).toBe('promoted')
      const [abandonAudit] = await auditPayloads(owner.orgId, AuditEvent.ROTATION_ABANDONED, staged)
      expect(abandonAudit).toMatchObject({ reason: 'initiator_removed', removedUserId: x.userId })
      const [removed] = await auditPayloads(owner.orgId, AuditEvent.ORG_USER_REMOVED, x.userId)
      expect(removed).toMatchObject({ abandonedRotationIds: [staged], heldRotationIds: [promoted] })
    })

    it('the structural sole_owner_of_projects 409 is explained before active_rotations', async () => {
      const owner = await registerOwner(app, 'remove-sole-owner')
      const x = await addUserToOrg(app, owner.orgId, 'remove-sole-x', { orgRole: 'admin' })
      const ownProject = await createProject(app, x.cookies, 'remove-sole-project')
      await startRotationViaApi(app, x.cookies, ownProject)

      const res = await removeViaApi(app, owner.cookies, x.userId)

      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'sole_owner_of_projects' })
    })
  })
})
