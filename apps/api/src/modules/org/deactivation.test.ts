import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { orgMemberships, rotations } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  createProjectViaApi as createProject,
  mintOrgSessionCookies,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootProjectRouteTestApp } from '../projects/project-route-test-bootstrap.js'
import { BLOCKING_ROTATION_STATUSES } from '../projects/archive-guards.js'
import {
  ABANDONABLE_ROTATION_STATUSES,
  HELD_ROTATION_STATUSES,
  UnhandledBlockingRotationStatusError,
  checkActiveRotationsForUser,
  partitionBlockingRotations,
} from './deactivation.js'
import { startRotationViaApi, updateRotation } from './rotation-guard-test-helpers.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'rotation-guard',
  orgNamePrefix: 'Rotation Guard',
})

function check(orgId: string, userId: string) {
  return withOrg(orgId, (tx) => checkActiveRotationsForUser(userId, orgId, tx))
}

describe('Story 43-15: checkActiveRotationsForUser', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  /** Owner + an org-admin initiator X, a project owned by the owner, one staged rotation by X. */
  async function stagedRotationFixture(label: string) {
    const owner = await registerOwner(app, `${label}-owner`)
    const x = await addUserToOrg(app, owner.orgId, `${label}-x`, { orgRole: 'admin' })
    const projectId = await createProject(app, owner.cookies, `${label}-project`)
    const rotation = await startRotationViaApi(app, x.cookies, projectId)
    return { owner, x, projectId, ...rotation }
  }

  it('AC-1: every blocking status blocks, reporting the rotation id', async () => {
    const { owner, x, rotationId } = await stagedRotationFixture('blocking')

    for (const status of BLOCKING_ROTATION_STATUSES) {
      await updateRotation(owner.orgId, rotationId, { status })
      expect(await check(owner.orgId, x.userId)).toEqual({
        blocked: true,
        rotationIds: [rotationId],
      })
    }
  })

  it('AC-1: retired/completed/abandoned/break_glass_complete never block', async () => {
    const { owner, x, rotationId } = await stagedRotationFixture('non-blocking')

    for (const status of ['retired', 'completed', 'abandoned', 'break_glass_complete']) {
      await updateRotation(owner.orgId, rotationId, { status })
      expect(await check(owner.orgId, x.userId)).toEqual({ blocked: false, rotationIds: [] })
    }
  })

  it('AC-1/KD-2: ownership is initiated_by only — another initiator, or NULL, never blocks X', async () => {
    const { owner, x, projectId } = await stagedRotationFixture('ownership')
    const y = await addUserToOrg(app, owner.orgId, 'ownership-y', { orgRole: 'admin' })
    const yRotation = await startRotationViaApi(app, y.cookies, projectId)

    // X is blocked only by X's own rotation, never by Y's.
    const xCheck = await check(owner.orgId, x.userId)
    expect(xCheck.rotationIds).not.toContain(yRotation.rotationId)
    expect(xCheck.rotationIds).toHaveLength(1)

    // A NULL initiator (project-export import, deleted user) matches nobody.
    await updateRotation(owner.orgId, yRotation.rotationId, { initiatedBy: null })
    expect(await check(owner.orgId, y.userId)).toEqual({ blocked: false, rotationIds: [] })
  })

  it('AC-1: rotationIds are sorted by initiated_at ASC, then id', async () => {
    const { owner, x, projectId, rotationId: r2 } = await stagedRotationFixture('ordering')
    const { rotationId: r3 } = await startRotationViaApi(app, x.cookies, projectId)
    await updateRotation(owner.orgId, r2, {
      status: 'promoted',
      initiatedAt: new Date('2026-09-27T10:00:00Z'),
    })
    await updateRotation(owner.orgId, r3, {
      status: 'stale_recovery',
      initiatedAt: new Date('2026-09-27T09:00:00Z'),
    })

    expect(await check(owner.orgId, x.userId)).toEqual({ blocked: true, rotationIds: [r3, r2] })
  })

  it('AC-3: a rotation X owns in another org never blocks — explicit predicate and RLS alike', async () => {
    const { owner: owner1, x, projectId: project1 } = await stagedRotationFixture('tenant')
    const owner2 = await registerOwner(app, 'tenant-owner-2')
    await withOrg(owner2.orgId, (tx) =>
      tx
        .insert(orgMemberships)
        .values({ orgId: owner2.orgId, userId: x.userId, role: 'admin', status: 'active' })
    )
    const xInOrg2 = await mintOrgSessionCookies(app, x.userId, owner2.orgId)
    const project2 = await createProject(app, owner2.cookies, 'tenant-project-2')
    const r9 = await startRotationViaApi(app, xInOrg2, project2)

    const org1Check = await check(owner1.orgId, x.userId)
    expect(org1Check.blocked).toBe(true)
    expect(org1Check.rotationIds).not.toContain(r9.rotationId)
    expect(project1).not.toBe(project2)

    // RLS-only proof: under Org 1's RLS context, R9 (Org 2) is invisible even to a query that
    // filters on initiated_by alone, with no org_id predicate at all.
    const visibleUnderOrg1 = await withOrg(owner1.orgId, (tx) =>
      tx.select({ id: rotations.id }).from(rotations).where(eq(rotations.initiatedBy, x.userId))
    )
    expect(visibleUnderOrg1.map((row) => row.id)).not.toContain(r9.rotationId)

    // Same user, Org 2: blocked by R9 only.
    expect(await check(owner2.orgId, x.userId)).toEqual({
      blocked: true,
      rotationIds: [r9.rotationId],
    })
  })
})

describe('Story 43-15 AC-8: partitionBlockingRotations', () => {
  const row = (status: string, id = status) => ({
    id,
    projectId: 'p',
    credentialId: 'c',
    status,
  })

  it('drift guard: ABANDONABLE ∪ HELD is exactly BLOCKING_ROTATION_STATUSES, and they are disjoint', () => {
    const union = [...ABANDONABLE_ROTATION_STATUSES, ...HELD_ROTATION_STATUSES]
    expect(new Set(union).size).toBe(union.length)
    expect([...union].sort()).toEqual([...BLOCKING_ROTATION_STATUSES].sort())
  })

  it('abandons staged/stale_recovery and holds promoted/in_progress', () => {
    const result = partitionBlockingRotations([
      row('staged'),
      row('promoted'),
      row('stale_recovery'),
      row('in_progress'),
    ])
    expect(result.abandonable.map((r) => r.id)).toEqual(['staged', 'stale_recovery'])
    expect(result.held.map((r) => r.id)).toEqual(['promoted', 'in_progress'])
  })

  it('throws on a blocking status neither list knows about (never silently mishandled)', () => {
    expect(() => partitionBlockingRotations([row('paused')])).toThrow(
      UnhandledBlockingRotationStatusError
    )
  })
})
