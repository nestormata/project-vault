import { describe, expect, it } from 'vitest'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'
import { webauthnCredentials, webauthnRegistrationChallenges } from './index.js'

describe('webauthn schema (Story 46.1)', () => {
  it('stores public key and sign count and has no private key column', () => {
    expect(webauthnCredentials.credentialId).toBeDefined()
    expect(webauthnCredentials.publicKey).toBeDefined()
    expect(webauthnCredentials.signCount).toBeDefined()
    expect(webauthnCredentials.name).toBeDefined()
    expect(Object.keys(webauthnCredentials)).not.toContain('privateKey')
    expect(Object.keys(webauthnCredentials)).not.toContain('orgId')
  })

  it('keeps one pending challenge per user', () => {
    expect(webauthnRegistrationChallenges.userId).toBeDefined()
    expect(webauthnRegistrationChallenges.challenge).toBeDefined()
    expect(webauthnRegistrationChallenges.expiresAt).toBeDefined()
    expect(Object.keys(webauthnRegistrationChallenges)).not.toContain('orgId')
  })

  it('documents both tables as identity-scoped RLS exceptions', () => {
    expect(EXCLUDED_TABLES.has('webauthn_credentials')).toBe(true)
    expect(EXCLUDED_TABLES.has('webauthn_registration_challenges')).toBe(true)
  })
})
