import { bootstrapRouteIntegrationTest } from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createDirectAuthenticatedUser,
  loginExistingUserInOrg,
} from '../../__tests__/helpers/org-role-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

export const credentialIntegration = await bootstrapRouteIntegrationTest()
export const { createApp, initVault, humanAudit } = credentialIntegration

export type CredentialTestApp = Awaited<ReturnType<typeof createApp>>

export type CredentialRegisteredUser = {
  userId: string
  orgId: string
  cookies: Record<string, string>
}

export const CREDENTIAL_INTEGRATION_LOGIN_SECRET = 'correct-horse-battery-staple'
export const FORCED_AUDIT_FAILURE = 'forced audit failure'
export const MONTHLY_ROTATION_CRON = '0 3 1 * *'

export { createDirectAuthenticatedUser, loginExistingUserInOrg, resetVaultForTest }
