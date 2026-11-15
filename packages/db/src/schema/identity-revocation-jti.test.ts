import { describe, expect, it } from 'vitest'
import { identityRevocationJti } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('identity_revocation_jti schema (Story 73.4 D5)', () => {
  it('exposes the replay-burn columns with no user_id/org_id FK', () => {
    expect(identityRevocationJti.jti).toBeDefined()
    expect(identityRevocationJti.expiresAt).toBeDefined()
    expect(identityRevocationJti.createdAt).toBeDefined()
    expect((identityRevocationJti as unknown as Record<string, unknown>)['userId']).toBeUndefined()
    expect((identityRevocationJti as unknown as Record<string, unknown>)['orgId']).toBeUndefined()
  })

  it('documents identity_revocation_jti as an RLS coverage exception', () => {
    expect(EXCLUDED_TABLES.has('identity_revocation_jti')).toBe(true)
  })
})
