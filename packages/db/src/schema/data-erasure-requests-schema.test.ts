import { describe, expect, it } from 'vitest'
import { dataErasureRequests } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('data_erasure_requests schema (Story 8.4)', () => {
  it('exposes org-scoped erasure-request columns', () => {
    expect(dataErasureRequests.id).toBeDefined()
    expect(dataErasureRequests.orgId).toBeDefined()
    expect(dataErasureRequests.userId).toBeDefined()
    expect(dataErasureRequests.requestedBy).toBeDefined()
    expect(dataErasureRequests.reason).toBeDefined()
    expect(dataErasureRequests.status).toBeDefined()
    expect(dataErasureRequests.originalEmailHash).toBeDefined()
    expect(dataErasureRequests.createdAt).toBeDefined()
    expect(dataErasureRequests.completedAt).toBeDefined()
  })

  // D1/AC-19: this table is org-scoped with a normal RLS policy, unlike the identity-scoped
  // tables in EXCLUDED_TABLES (mfa_recovery_codes, account_recovery_tokens, etc.).
  it('is subject to normal RLS coverage (not excluded)', () => {
    expect(EXCLUDED_TABLES.has('data_erasure_requests')).toBe(false)
  })
})
