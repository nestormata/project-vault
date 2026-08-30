import { describe, expect, it } from 'vitest'
import { handoffPendingStates } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('handoff_pending_states schema (Story 30.2 Task 2)', () => {
  it('exposes the prepare-time pending-state columns', () => {
    expect(handoffPendingStates.id).toBeDefined()
    expect(handoffPendingStates.cookieHash).toBeDefined()
    expect(handoffPendingStates.jti).toBeDefined()
    expect(handoffPendingStates.providerName).toBeDefined()
    expect(handoffPendingStates.externalSubject).toBeDefined()
    expect(handoffPendingStates.organizationId).toBeDefined()
    expect(handoffPendingStates.claimsVersion).toBeDefined()
    expect(handoffPendingStates.expiresAt).toBeDefined()
    expect(handoffPendingStates.createdAt).toBeDefined()
  })

  it('documents handoff_pending_states as an RLS coverage exception (org untrusted until confirm)', () => {
    expect(EXCLUDED_TABLES.has('handoff_pending_states')).toBe(true)
  })
})
