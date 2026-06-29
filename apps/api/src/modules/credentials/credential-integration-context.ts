import { bootstrapRouteIntegrationTest } from '../../__tests__/helpers/auth-test-helpers.js'

export const credentialIntegration = await bootstrapRouteIntegrationTest()

export type CredentialTestApp = Awaited<ReturnType<typeof credentialIntegration.createApp>>

export type CredentialRegisteredUser = {
  userId: string
  orgId: string
  cookies: Record<string, string>
}

export const CREDENTIAL_INTEGRATION_PASSWORD = 'correct-horse-battery-staple'
export const FORCED_AUDIT_FAILURE = 'forced audit failure'
