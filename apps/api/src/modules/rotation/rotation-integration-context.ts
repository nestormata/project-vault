import { bootstrapRouteIntegrationTest } from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createDirectAuthenticatedUser,
  loginExistingUserInOrg,
} from '../../__tests__/helpers/org-role-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

export const rotationIntegration = await bootstrapRouteIntegrationTest()
export const { createApp, initVault, humanAudit } = rotationIntegration

export type RotationTestApp = Awaited<ReturnType<typeof createApp>>

export type RotationRegisteredUser = {
  userId: string
  orgId: string
  cookies: Record<string, string>
}

export const ROTATION_INTEGRATION_PASSWORD = 'correct-horse-battery-staple'
export const FORCED_AUDIT_FAILURE = 'forced audit failure'

export { createDirectAuthenticatedUser, loginExistingUserInOrg, resetVaultForTest }
