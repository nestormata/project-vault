import { describe, expect, it } from 'vitest'
import { handoffNonces } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('handoff_nonces schema (Story 73.1)', () => {
  it('exposes the nonce-record columns with no user_id/org_id', () => {
    expect(handoffNonces.nonceHash.primary).toBe(true)
    expect(handoffNonces.expiresAt.notNull).toBe(true)
    expect(handoffNonces.consumedAt.notNull).toBe(false)
    expect(handoffNonces.createdAt.notNull).toBe(true)
    expect(Object.keys(handoffNonces)).not.toContain('userId')
    expect(Object.keys(handoffNonces)).not.toContain('orgId')
  })

  it('documents handoff_nonces as an RLS coverage exception (no tenant known at /auth/start)', () => {
    expect(EXCLUDED_TABLES.has('handoff_nonces')).toBe(true)
  })
})
