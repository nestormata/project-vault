import { bootstrapRouteIntegrationTest } from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createDirectAuthenticatedUser,
  loginExistingUserInOrg,
} from '../../__tests__/helpers/org-role-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

export const monitoringIntegration = await bootstrapRouteIntegrationTest()
export const { createApp, initVault, humanAudit } = monitoringIntegration

export type MonitoringTestApp = Awaited<ReturnType<typeof createApp>>

export const MONITORING_INTEGRATION_LOGIN_SECRET = 'correct-horse-battery-staple'
export const FORCED_AUDIT_FAILURE = 'forced audit failure'

export { createDirectAuthenticatedUser, loginExistingUserInOrg, resetVaultForTest }
