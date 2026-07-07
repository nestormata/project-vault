import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { organizations } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'user-dormancy-settings',
  orgNamePrefix: 'User Dormancy Settings',
})

const PASSPHRASE = 'user-dormancy-settings-routes-passphrase'

describe('PATCH /api/v1/organizations/:orgId/user-dormancy-settings (D5/D8/AC-12)', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('updates the user dormancy threshold to an allowed value', async () => {
    const owner = await registerOwner(app, 'settings')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${owner.orgId}/user-dormancy-settings`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { userDormancyThresholdDays: 180 },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      data: { orgId: owner.orgId, userDormancyThresholdDays: 180 },
    })

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(organizations).where(eq(organizations.id, owner.orgId))
    )
    expect(row?.userDormancyThresholdDays).toBe(180)
  })

  it('rejects a value outside the 30/60/90/180 enum', async () => {
    const owner = await registerOwner(app, 'settings-invalid')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${owner.orgId}/user-dormancy-settings`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { userDormancyThresholdDays: 45 },
    })

    expect(res.statusCode).toBe(422)
  })

  it('rejects a non-admin caller', async () => {
    const owner = await registerOwner(app, 'settings-forbidden')
    const { addUserToOrg } = createMembershipTestHelpers({
      emailPrefix: 'user-dormancy-settings',
      orgNamePrefix: 'User Dormancy Settings',
    })
    const member = await addUserToOrg(app, owner.orgId, 'member-forbidden', { orgRole: 'member' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${owner.orgId}/user-dormancy-settings`,
      headers: { cookie: cookieHeader(member.cookies) },
      payload: { userDormancyThresholdDays: 60 },
    })

    expect(res.statusCode).toBe(403)
  })

  it('an existing org (pre-dating this migration) already has the default 90-day threshold', async () => {
    const owner = await registerOwner(app, 'settings-default')

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(organizations).where(eq(organizations.id, owner.orgId))
    )
    expect(row?.userDormancyThresholdDays).toBe(90)
  })
})
