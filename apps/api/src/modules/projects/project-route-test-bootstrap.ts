import type { createApp } from '../../app.js'
import { initVaultForTest } from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

type InitVault = Parameters<typeof initVaultForTest>[0]

export const PROJECT_ROUTE_TEST_VAULT_SECRET = 'project-routes-vault-secret'

export async function bootProjectRouteTestApp(createAppFn: typeof createApp, initVault: InitVault) {
  await resetVaultForTest()
  await initVaultForTest(initVault, PROJECT_ROUTE_TEST_VAULT_SECRET)
  return createAppFn({ logger: false, vaultGuardEnabled: true })
}
