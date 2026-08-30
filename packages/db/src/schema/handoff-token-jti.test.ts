import { describe, expect, it } from 'vitest'
import { handoffTokenJti } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('handoff_token_jti schema (Story 30.2 AC1)', () => {
  it('exposes the replay-burn columns with no user_id/org_id FK', () => {
    expect(handoffTokenJti.jti).toBeDefined()
    expect(handoffTokenJti.expiresAt).toBeDefined()
    expect(handoffTokenJti.createdAt).toBeDefined()
    expect((handoffTokenJti as unknown as Record<string, unknown>)['userId']).toBeUndefined()
    expect((handoffTokenJti as unknown as Record<string, unknown>)['orgId']).toBeUndefined()
  })

  it('documents handoff_token_jti as an RLS coverage exception (no tenant known at burn time)', () => {
    expect(EXCLUDED_TABLES.has('handoff_token_jti')).toBe(true)
  })
})
