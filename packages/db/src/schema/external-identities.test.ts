import { describe, expect, it } from 'vitest'
import { externalIdentities } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('external_identities schema (Story 14.3)', () => {
  it('exposes the org-scoped identity-binding columns', () => {
    expect(externalIdentities.id).toBeDefined()
    expect(externalIdentities.orgId).toBeDefined()
    expect(externalIdentities.userId).toBeDefined()
    expect(externalIdentities.providerName).toBeDefined()
    expect(externalIdentities.externalSubject).toBeDefined()
    expect(externalIdentities.createdAt).toBeDefined()
  })

  it('is NOT excluded from RLS coverage (org-scoped, needs a policy)', () => {
    expect(EXCLUDED_TABLES.has('external_identities')).toBe(false)
  })
})
