import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { credentialVersions, orgMemberships, rotations } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi as createProject,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootProjectRouteTestApp } from '../projects/project-route-test-bootstrap.js'
import { createCredentialViaApi } from '../credentials/credential-route-test-helpers.js'
import { initiateRotation } from '../rotation/service.js'
import { deactivateViaApi, membershipRow } from './rotation-guard-test-helpers.js'

/**
 * Story 43-15 AC-4: a rotation started while a deactivation is in flight can never be orphaned.
 * Both lock orders are forced deterministically: a raw transaction holds one side's membership row
 * lock while the other side's HTTP request is fired, the test waits until pg_stat_activity shows
 * that request blocked on the row lock, and only then commits the held transaction.
 */

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'rotation-race',
  orgNamePrefix: 'Rotation Race',
})

/** A deferred the held transaction awaits, so the test decides exactly when it commits. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

/** Waits until some backend is blocked on a row lock while running a statement matching the
 *  given `org_memberships` lock clause — or until `settled` resolves first (the request never
 *  blocked, which is itself the failure the assertions below then report). */
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

describe('Story 43-15 AC-4: deactivation vs. rotation initiation race', () => {
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
    const projectId = await createProject(app, owner.cookies, `${label}-project`)
    const credential = await createCredentialViaApi(app, x.cookies, projectId, {
      name: `Race key ${randomUUID()}`,
      value: `initial-${randomUUID()}`,
    })
    return { owner, x, projectId, credentialId: credential.id }
  }

  const membershipOf = (orgId: string, userId: string) =>
    and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId))

  it('deactivation locks first: the racing rotation gets 403 account_deactivated and writes nothing', async () => {
    const { owner, x, projectId, credentialId } = await fixture('deactivation-first')
    const versionsBefore = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ id: credentialVersions.id })
        .from(credentialVersions)
        .where(eq(credentialVersions.credentialId, credentialId))
    )
    const commitT1 = gate()
    const t1Locked = gate()
    const t1 = withOrg(owner.orgId, async (tx) => {
      await tx
        .select({ status: orgMemberships.status })
        .from(orgMemberships)
        .where(membershipOf(owner.orgId, x.userId))
        .for('update')
      await tx
        .update(orgMemberships)
        .set({ status: 'deactivated' })
        .where(membershipOf(owner.orgId, x.userId))
      t1Locked.open()
      await commitT1.wait
    })
    await t1Locked.wait

    const rotation = app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations`,
      headers: { cookie: cookieHeader(x.cookies) },
      payload: { newValue: `rotated-${randomUUID()}` },
    })
    const blocked = await waitForMembershipLockWait('for share', rotation)
    commitT1.open()
    await t1
    const res = await rotation

    expect(blocked).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'account_deactivated', message: 'Account is deactivated' })
    const owned = await withOrg(owner.orgId, (tx) =>
      tx.select({ id: rotations.id }).from(rotations).where(eq(rotations.initiatedBy, x.userId))
    )
    expect(owned).toHaveLength(0)
    const versionsAfter = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ id: credentialVersions.id })
        .from(credentialVersions)
        .where(eq(credentialVersions.credentialId, credentialId))
    )
    expect(versionsAfter).toHaveLength(versionsBefore.length)
  })

  it('rotation locks first: the racing deactivation waits, then sees the committed rotation (409)', async () => {
    const { owner, x, projectId, credentialId } = await fixture('rotation-first')
    const commitT2 = gate()
    const t2Inserted = gate()
    let rotationId: string | undefined
    const t2 = withOrg(owner.orgId, async (tx) => {
      const result = await initiateRotation(tx, {
        orgId: owner.orgId,
        projectId,
        credentialId,
        userId: x.userId,
        body: { newValue: `rotated-${randomUUID()}`, notes: null },
      })
      if (result.status !== 'initiated') throw new Error(`unexpected ${result.status}`)
      rotationId = result.rotation.id
      t2Inserted.open()
      await commitT2.wait
    })
    await t2Inserted.wait

    const deactivation = deactivateViaApi(app, owner.cookies, x.userId)
    const blocked = await waitForMembershipLockWait('for update', deactivation)
    commitT2.open()
    await t2
    const res = await deactivation

    expect(blocked).toBe(true)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'active_rotations', rotationIds: [rotationId] })
    expect((await membershipRow(owner.orgId, x.userId))?.status).toBe('active')
  })

  it('non-racing regression: an active initiator still gets 201', async () => {
    const { x, projectId, credentialId } = await fixture('regression')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations`,
      headers: { cookie: cookieHeader(x.cookies) },
      payload: { newValue: `rotated-${randomUUID()}` },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ data: { status: 'staged' } })
  })

  it('edge: a missing initiator membership row is treated as inactive — never inserts', async () => {
    const { owner, x, projectId, credentialId } = await fixture('missing-membership')

    await withOrg(owner.orgId, (tx) =>
      tx.delete(orgMemberships).where(membershipOf(owner.orgId, x.userId))
    )

    const outcome = await withOrg(owner.orgId, (tx) =>
      initiateRotation(tx, {
        orgId: owner.orgId,
        projectId,
        credentialId,
        userId: x.userId,
        body: { newValue: `rotated-${randomUUID()}`, notes: null },
      })
    )

    expect(outcome).toEqual({ status: 'initiator_inactive' })
    const owned = await withOrg(owner.orgId, (tx) =>
      tx.select({ id: rotations.id }).from(rotations).where(eq(rotations.initiatedBy, x.userId))
    )
    expect(owned).toEqual([])
  })
})
