import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { orgMemberships, rotations } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  createProjectViaApi as createProject,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootProjectRouteTestApp } from '../projects/project-route-test-bootstrap.js'
import { BLOCKING_ROTATION_STATUSES } from '../projects/archive-guards.js'
import {
  deactivateViaApi,
  membershipRow,
  rotationOwnership,
  startRotationViaApi,
} from './rotation-guard-test-helpers.js'

/**
 * Story 43-17 AC-8 (lock order: membership(deactivated user) -> membership(transfer target, FOR
 * SHARE) -> rotation try-locks). Racing "deactivate the transfer target Y" against "transfer X's
 * rotations to Y" must end with a rotation NEVER owned by a non-active user:
 *  - deactivation of Y commits first: the transfer is refused (422 invalid_transfer_target);
 *  - the transfer commits first: Y's own deactivation is then blocked (409 active_rotations).
 * Each order is forced deterministically: a raw transaction holds one side's row lock while the
 * other HTTP request is fired, the test waits until pg_stat_activity shows it blocked, and only
 * then commits the held transaction (same technique as deactivation-rotation-race.test.ts).
 */

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'transfer-race',
  orgNamePrefix: 'Transfer Race',
})

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

async function waitForMembershipLockWait(
  lockClause: 'for share' | 'for update',
  settled: Promise<unknown>
): Promise<boolean> {
  let done = false
  void settled.finally(() => {
    done = true
  })
  for (let attempt = 0; attempt < 200 && !done; attempt += 1) {
    const rows = await getDb().execute(
      sql`SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND query ILIKE ${'%org_memberships%'}
            AND query ILIKE ${`%${lockClause}%`}`
    )
    if (((rows[0] as { waiting: number } | undefined)?.waiting ?? 0) > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

describe('Story 43-17 AC-8: transfer vs. deactivation of the transfer target', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  async function fixture(label: string) {
    const owner = await registerOwner(app, `${label}-owner`)
    const x = await addUserToOrg(app, owner.orgId, `${label}-x`, { orgRole: 'admin' })
    const y = await addUserToOrg(app, owner.orgId, `${label}-y`, { orgRole: 'admin' })
    const projectId = await createProject(app, owner.cookies, `${label}-project`)
    const { rotationId } = await startRotationViaApi(app, x.cookies, projectId)
    return { owner, x, y, rotationId }
  }

  /** The invariant: no blocking rotation has an effective owner whose membership is not active. */
  async function orphanedBlockingRotations(orgId: string): Promise<string[]> {
    const rows = await withOrg(orgId, (tx) =>
      tx
        .select({
          id: rotations.id,
          owner: sql<string | null>`COALESCE(${rotations.ownerUserId}, ${rotations.initiatedBy})`,
        })
        .from(rotations)
        .where(
          and(eq(rotations.orgId, orgId), inArray(rotations.status, BLOCKING_ROTATION_STATUSES))
        )
    )
    const inactive = await Promise.all(
      rows.map(async (row) => {
        const member = row.owner ? await membershipRow(orgId, row.owner) : undefined
        return member?.status === 'active' ? null : row.id
      })
    )
    const orphaned = inactive.filter((id): id is string => id !== null)
    return orphaned
  }

  it('Y deactivation commits first: the transfer is refused, nothing is orphaned', async () => {
    const { owner, x, y, rotationId } = await fixture('target-first')
    const commitT1 = gate()
    const t1Locked = gate()
    const t1 = withOrg(owner.orgId, async (tx) => {
      await tx
        .select({ status: orgMemberships.status })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, owner.orgId), eq(orgMemberships.userId, y.userId)))
        .for('update')
      await tx
        .update(orgMemberships)
        .set({ status: 'deactivated' })
        .where(and(eq(orgMemberships.orgId, owner.orgId), eq(orgMemberships.userId, y.userId)))
      t1Locked.open()
      await commitT1.wait
    })
    await t1Locked.wait

    const transfer = deactivateViaApi(app, owner.cookies, x.userId, {
      rotationHandling: 'transfer',
      transferToUserId: y.userId,
    })
    const blocked = await waitForMembershipLockWait('for share', transfer)
    commitT1.open()
    await t1
    const res = await transfer

    expect(blocked).toBe(true)
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'invalid_transfer_target' })
    expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('active')
    expect((await rotationOwnership(owner.orgId, rotationId)).ownerUserId).toBeNull()
    expect(await orphanedBlockingRotations(owner.orgId)).toEqual([])
  })

  it('transfer holds Y first: Y deactivation waits, then is blocked by active_rotations', async () => {
    const { owner, x, y, rotationId } = await fixture('transfer-first')
    const commitT2 = gate()
    const t2Locked = gate()
    const t2 = withOrg(owner.orgId, async (tx) => {
      // What the transfer request does to Y's row (KD-5) and then to the rotation (KD-4).
      await tx
        .select({ status: orgMemberships.status })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, owner.orgId), eq(orgMemberships.userId, y.userId)))
        .for('share')
      await tx.update(rotations).set({ ownerUserId: y.userId }).where(eq(rotations.id, rotationId))
      t2Locked.open()
      await commitT2.wait
    })
    await t2Locked.wait

    const deactivationOfY = deactivateViaApi(app, owner.cookies, y.userId)
    const blocked = await waitForMembershipLockWait('for update', deactivationOfY)
    commitT2.open()
    await t2
    const res = await deactivationOfY

    expect(blocked).toBe(true)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'active_rotations', rotationIds: [rotationId] })
    expect((await membershipRow(owner.orgId, y.userId))?.status).toBe('active')
    expect(await orphanedBlockingRotations(owner.orgId)).toEqual([])
    expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('active')
  })

  it('a real transfer request blocks Y deactivation while it holds Y FOR SHARE (end to end)', async () => {
    const { owner, x, y } = await fixture('e2e-order')

    const [transfer, deactivation] = await Promise.all([
      deactivateViaApi(app, owner.cookies, x.userId, {
        rotationHandling: 'transfer',
        transferToUserId: y.userId,
      }),
      deactivateViaApi(app, owner.cookies, y.userId),
    ])

    // Whichever interleaving the database picked, no rotation is owned by a non-active user.
    expect(await orphanedBlockingRotations(owner.orgId)).toEqual([])
    // Exactly two serial orders exist: transfer first (then Y's deactivation is blocked), or
    // Y's deactivation first (then the transfer is refused).
    expect([
      [200, 409],
      [422, 200],
    ]).toContainEqual([transfer.statusCode, deactivation.statusCode])
  })
  it('locks both memberships in user-id order: the deactivated user is not locked while waiting on a lower-id target (no deadlock)', async () => {
    const label = 'lock-order'
    const owner = await registerOwner(app, `${label}-owner`)
    const a = await addUserToOrg(app, owner.orgId, `${label}-a`, { orgRole: 'admin' })
    const b = await addUserToOrg(app, owner.orgId, `${label}-b`, { orgRole: 'admin' })
    // The transfer target has the LOWER id: the request must lock it first, before the
    // deactivated (higher-id) user, so it can never hold the higher row while waiting on the lower.
    const [target, deactivated] = [a, b].sort((l, r) => (l.userId < r.userId ? -1 : 1)) as [
      typeof a,
      typeof a,
    ]
    const projectId = await createProject(app, owner.cookies, `${label}-project`)
    await startRotationViaApi(app, deactivated.cookies, projectId)

    const commitHold = gate()
    const held = gate()
    const hold = withOrg(owner.orgId, async (tx) => {
      await tx
        .select({ status: orgMemberships.status })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, owner.orgId), eq(orgMemberships.userId, target.userId)))
        .for('update')
      held.open()
      await commitHold.wait
    })
    await held.wait

    const request = deactivateViaApi(app, owner.cookies, deactivated.userId, {
      rotationHandling: 'transfer',
      transferToUserId: target.userId,
    })
    const waiting = await waitForMembershipLockWait('for share', request)
    let deactivatedRowFree = false
    if (waiting) {
      // NOWAIT throws (55P03) if the blocked request already holds the higher-id row.
      await withOrg(owner.orgId, async (tx) => {
        await tx
          .select({ status: orgMemberships.status })
          .from(orgMemberships)
          .where(
            and(
              eq(orgMemberships.orgId, owner.orgId),
              eq(orgMemberships.userId, deactivated.userId)
            )
          )
          .for('update', { noWait: true })
        deactivatedRowFree = true
      })
    }
    commitHold.open()
    await hold
    const res = await request

    expect(waiting).toBe(true)
    expect(deactivatedRowFree).toBe(true)
    expect(res.statusCode).toBe(200)
  })
})
