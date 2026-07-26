import { describe, expect, it } from 'vitest'
import { ssoLoginStates } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('sso_login_states schema (Story 14.3)', () => {
  it('exposes the pre-auth CSRF-state columns', () => {
    expect(ssoLoginStates.id).toBeDefined()
    expect(ssoLoginStates.stateHash).toBeDefined()
    expect(ssoLoginStates.providerName).toBeDefined()
    expect(ssoLoginStates.expiresAt).toBeDefined()
    expect(ssoLoginStates.consumedAt).toBeDefined()
    expect(ssoLoginStates.createdAt).toBeDefined()
  })

  it('documents sso_login_states as an RLS coverage exception (no org known at mint time)', () => {
    expect(EXCLUDED_TABLES.has('sso_login_states')).toBe(true)
  })
})
