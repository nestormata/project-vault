import { describe, it } from 'vitest'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  assertRoutesFailClosedWhileSealed,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { registerPlatformOperator } from '../../__tests__/helpers/platform-operator-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'

const { initVault, createApp } = await (async () => {
  const boot = await bootstrapRouteIntegrationTest()
  const { createApp: create } = await import('../../app.js')
  return { ...boot, createApp: create }
})()

const TEST_PASSPHRASE = 'platform-admin-sealed-guard-passphrase'
const PASSWORD = 'correct-horse-battery-staple'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

describe.sequential('Story 9.2 AC-26: sealed-vault guard applies to all five new routes', () => {
  suite.registerLifecycle()

  it('returns 503 { status: "sealed" } for GET/PUT settings, POST/GET orgs, GET resource-usage — no allow-list entry needed', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'sealed-guard-op',
      orgNamePrefix: 'Sealed Guard Op',
      password: PASSWORD,
    })
    const cookie = cookieHeader(operator.cookies)

    const sealedApp = await assertRoutesFailClosedWhileSealed(
      suite.app,
      () => createApp({ logger: false, vaultGuardEnabled: true }),
      [
        { method: 'GET', url: '/api/v1/admin/settings', headers: { cookie } },
        { method: 'PUT', url: '/api/v1/admin/settings', headers: { cookie }, payload: {} },
        {
          method: 'POST',
          url: '/api/v1/admin/orgs',
          headers: { cookie },
          payload: { name: 'x', ownerEmail: 'x@example.com' },
        },
        { method: 'GET', url: '/api/v1/admin/orgs', headers: { cookie } },
        { method: 'GET', url: '/api/v1/admin/resource-usage', headers: { cookie } },
      ]
    )
    await sealedApp.close()
  })
})
