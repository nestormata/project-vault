import { EXTENSION_API_VERSION } from '@project-vault/extension-api'
import type {
  AuthResult,
  AuthStrategy,
  ExtensionHooks,
  ExtensionManifest,
} from '@project-vault/extension-api'

/**
 * Story 14.3 AC-12 (Task 10): a self-contained, in-process mock external-IdP extension. Exists
 * solely so this story's `start` → callback → session-issuance plumbing can be exercised in CI
 * and by hand without a real third-party IdP account (Okta/Auth0/etc.) — see this package's
 * README for the full manual-QA runbook and the explicit "never in production config" warning.
 *
 * `onAuthenticate()` never makes an outbound network call — it maps a test-provided `credential`
 * string directly to a canned `AuthResult` via this in-memory lookup table, simulating "the IdP
 * already authenticated this user and handed back an assertion". This bypasses all real
 * redirect/assertion-verification mechanics by design.
 */
export const MOCK_PROVIDER_NAME = 'test.mock-sso-extension'

export const FIXTURE_IDENTITIES = {
  'linked-user': {
    externalSubject: 'fixture-subject-linked-user',
    email: 'linked-user@example.test',
  },
  'unlinked-user': {
    externalSubject: 'fixture-subject-unlinked-user',
    email: 'unlinked-user@example.test',
  },
  'invited-user': {
    externalSubject: 'fixture-subject-invited-user',
    email: 'invited-user@example.test',
  },
} as const

export type FixtureCredential = keyof typeof FIXTURE_IDENTITIES

function isFixtureCredential(value: string): value is FixtureCredential {
  return Object.hasOwn(FIXTURE_IDENTITIES, value)
}

const manifest: ExtensionManifest = {
  name: MOCK_PROVIDER_NAME,
  apiVersion: EXTENSION_API_VERSION,
  capabilities: ['auth-provider'],
}

const authStrategy: AuthStrategy = {
  async onAuthenticate(credential: string): Promise<AuthResult> {
    if (!isFixtureCredential(credential)) {
      throw new Error(
        `mock-sso-extension: unknown fixture credential "${credential}" — expected one of: ${Object.keys(FIXTURE_IDENTITIES).join(', ')}`
      )
    }
    const identity = FIXTURE_IDENTITIES[credential]
    return {
      externalSubject: identity.externalSubject,
      providerName: MOCK_PROVIDER_NAME,
      email: identity.email,
    }
  },
}

function hooksFactory(): ExtensionHooks {
  return { authStrategy }
}

export default { manifest, hooksFactory }
