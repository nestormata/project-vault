import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
  createCredentialViaApi,
} from '../credentials/credential-route-test-helpers.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'share-service',
  orgNamePrefix: 'Share Service Org',
})

describe('credential-share service normalization', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'credential-share-service-passphrase')
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('sorts normalized attribute keys alphabetically using locale-aware comparison', async () => {
    const sharer = await registerOwner(app, 'locale-order-sharer')
    const recipient = await addUserToOrg(app, sharer.orgId, 'locale-order-recipient', {
      orgRole: 'member',
    })
    const projectId = await createCredentialTestProject(app, sharer.cookies, 'locale-order')
    const credential = await createCredentialViaApi(app, sharer.cookies, projectId, {
      name: 'locale-order-credential',
      template: 'login',
      fields: [
        { key: 'z', value: 'z-value', sensitive: false },
        { key: 'a_b', value: 'underscore-value', sensitive: false },
        { key: 'a-b', value: 'hyphen-value', sensitive: false },
      ],
    } as unknown as { name: string; value: string })

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials/${credential.id}/shares`,
      headers: { cookie: cookieHeader(sharer.cookies) },
      payload: {
        recipientUserId: recipient.userId,
        attributeKeys: ['z', 'a_b', 'a-b'],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        singleUse: true,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json<{ data: { attributeKeys: string[] } }>().data.attributeKeys).toEqual([
      'a_b',
      'a-b',
      'z',
    ])
  })
})
