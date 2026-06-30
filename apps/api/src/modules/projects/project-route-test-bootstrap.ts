import type { createApp } from '../../app.js'
import { initVaultForTest } from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

type InitVault = Parameters<typeof initVaultForTest>[0]

export const PROJECT_ROUTE_TEST_PASSPHRASE = 'project-routes-passphrase'

export async function bootProjectRouteTestApp(createAppFn: typeof createApp, initVault: InitVault) {
  await resetVaultForTest()
  await initVaultForTest(initVault, PROJECT_ROUTE_TEST_PASSPHRASE)
  return createAppFn({ logger: false, vaultGuardEnabled: true })
}
